import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { compute, computeBookSnapshots, normalizeBookChanges, replayNormalized } from 'tardis-dev'

const SG_OFFSET_HOURS = 8
const ROOT = process.cwd()

const DB_CONFIG = {
  host: 'aws-jp-tk-surf-pg-public.cluster-csteuf9lw8dv.ap-northeast-1.rds.amazonaws.com',
  port: 5432,
  database: 'replication_report',
  user: 'manabesh_kaj',
  password: 'dPL084;KF1spv,g',
  ssl: { rejectUnauthorized: false }
}

const EXCLUDED_ACCOUNTS = [
  453694342288766976n, 453694515379304448n, 453694698938824704n, 453694862751214592n,
  453695050429541376n, 453695193342061568n, 453695365094616064n, 453695502558735360n,
  453695682540514304n, 453696029954714624n, 453696169084319744n, 453696336118282240n,
  453696686250391552n, 453697277915691008n, 453699519179782144n, 453699716827622400n,
  453699871186398208n, 453700111754898432n, 453700307679226880n, 453700435928807424n,
  453700610797382656n, 453700888569706496n, 453701146590358528n, 453701519728225280n,
  453702299164473344n, 453702432149075968n, 453702550260676608n, 453702674143639552n,
  453702798844144640n, 453702945032416256n, 453703077790873600n, 453703248918476800n,
  453703393185410048n, 453703530045896704n, 453703669380675584n, 453703873949117440n,
  453704003112709120n, 453704125108582400n, 453704438963809280n, 453704565275621376n,
  453704592534055936n, 453704388053347328n, 453704128950564864n, 453703864487114752n,
  453703624296101888n, 453703375317675008n, 453703091472693248n, 453702829597128704n,
  453702382681454592n, 453702011816553472n
]

function toSg(date) {
  return new Date(date.getTime() + SG_OFFSET_HOURS * 3600 * 1000)
}

function formatSg(date) {
  const sg = toSg(date)
  const y = sg.getUTCFullYear()
  const m = String(sg.getUTCMonth() + 1).padStart(2, '0')
  const d = String(sg.getUTCDate()).padStart(2, '0')
  const hh = String(sg.getUTCHours()).padStart(2, '0')
  const mm = String(sg.getUTCMinutes()).padStart(2, '0')
  const ss = String(sg.getUTCSeconds()).padStart(2, '0')
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`
}

function floor30s(date) {
  return new Date(Math.floor(date.getTime() / 30000) * 30000)
}

function floor15m(date) {
  return new Date(Math.floor(date.getTime() / 900000) * 900000)
}

function sumNotional(levels) {
  return levels.reduce((acc, level) => acc + Number(level.price) * Number(level.amount), 0)
}

function imbalance(levelsBid, levelsAsk) {
  const bid = sumNotional(levelsBid)
  const ask = sumNotional(levelsAsk)
  if (bid + ask === 0) return 0
  return (bid - ask) / (bid + ask)
}

function mean(values) {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

function median(values) {
  if (values.length === 0) return null
  const arr = [...values].sort((a, b) => a - b)
  const mid = Math.floor(arr.length / 2)
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2
}

function pct(values, q) {
  if (values.length === 0) return null
  const arr = [...values].sort((a, b) => a - b)
  const idx = (arr.length - 1) * q
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return arr[lo]
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo)
}

function directionFromImbalance(x, threshold = 0) {
  if (x > threshold) return 1
  if (x < -threshold) return -1
  return 0
}

function isoDate(date) {
  return date.toISOString().slice(0, 10)
}

function parseEnvDate(name, fallback) {
  const raw = process.env[name]
  return raw ? new Date(raw) : fallback
}

async function fetchOrders(client, startUtc, endUtc) {
  const sql = `
    SELECT
      o.id,
      o.account_id::text AS account_id,
      o.created_at,
      o.side,
      o.usdt_value::float8 AS usdt_value,
      CASE
        WHEN o.coin_code IN (
          11001,11002,11003,11004,11005,11006,11007,11008,11009,11010,
          11011,11012,11013,11014,11015,11016,11017,11018,11019,11020
        ) AND o.realized_pnl < 0 THEN 0
        ELSE -(o.realized_pnl)
      END::float8 AS raw_platform_pnl,
      o.realized_pnl::float8 AS user_pnl
    FROM public.chain_predict_order o
    WHERE o.order_status IN ('Finished', 'Pending')
      AND o.pair_id = 6
      AND o.duration = 30
      AND o.created_at >= $1::timestamptz
      AND o.created_at < $2::timestamptz
      AND (o.account_id IS NULL OR o.account_id <> ALL($3::bigint[]))
    ORDER BY o.created_at
  `
  const res = await client.query(sql, [startUtc, endUtc, EXCLUDED_ACCOUNTS.map(String)])
  return res.rows.map((r) => {
    const createdAt = new Date(r.created_at)
    return {
      id: String(r.id),
      account_id: r.account_id,
      created_at: createdAt,
      created_at_sg: formatSg(createdAt),
      bucket_30s: floor30s(createdAt),
      bucket_15m: floor15m(createdAt),
      side: Number(r.side),
      direction: Number(r.side) === 1 ? 1 : -1,
      usdt_value: Number(r.usdt_value),
      raw_platform_pnl: Number(r.raw_platform_pnl),
      user_pnl: Number(r.user_pnl)
    }
  })
}

async function fetchOracleBuckets(client, startUtc, endUtc) {
  const sql = `
    WITH oracle_ticks AS (
      SELECT
        l.created_at AS ts_utc,
        l.final_price::float8 AS price,
        floor(extract(epoch FROM l.created_at) / 30) * 30 AS bucket_epoch
      FROM public.oracle_price_log_partition_v1 l
      WHERE l.pair_name = 'BTC/USDT'
        AND l.source_type = 0
        AND l.created_at >= ($1::timestamptz - interval '10 minutes')
        AND l.created_at < $2::timestamptz
        AND l.final_price::float8 > 0
    )
    SELECT
      bucket_epoch::bigint AS bucket_epoch,
      (array_agg(price ORDER BY ts_utc ASC))[1] AS open_price,
      (array_agg(price ORDER BY ts_utc DESC))[1] AS close_price
    FROM oracle_ticks
    GROUP BY 1
    ORDER BY 1
  `
  const res = await client.query(sql, [startUtc, endUtc])
  const rows = res.rows.map((r) => ({
    bucket_start: new Date(Number(r.bucket_epoch) * 1000),
    open_price: Number(r.open_price),
    close_price: Number(r.close_price)
  }))
  const byEpoch = new Map(rows.map((r) => [r.bucket_start.getTime(), r]))
  for (const row of rows) {
    const prev = byEpoch.get(row.bucket_start.getTime() - 30000)
    row.ret_30s_bps = prev ? ((row.close_price / prev.close_price) - 1) * 10000 : null
  }
  return rows
}

async function fetchTardisSnapshots(replayStartUtc, analysisStartUtc, analysisEndUtc) {
  const apiKey = process.env.TARDIS_API_KEY
  if (!apiKey) {
    throw new Error('TARDIS_API_KEY env var is required')
  }
  const messages = replayNormalized(
    {
      exchange: 'binance-futures',
      symbols: ['BTCUSDT'],
      from: replayStartUtc.toISOString(),
      to: analysisEndUtc.toISOString(),
      apiKey
    },
    normalizeBookChanges
  )
  const snapshots = compute(
    messages,
    computeBookSnapshots({
      depth: 10,
      interval: 1000,
      name: 'book10_1s'
    })
  )
  const out = []
  for await (const msg of snapshots) {
    if (msg.type !== 'book_snapshot') continue
    const ts = new Date(msg.timestamp)
    if (ts < analysisStartUtc || ts >= analysisEndUtc) continue
    const bids5 = msg.bids.slice(0, 5)
    const asks5 = msg.asks.slice(0, 5)
    const bids10 = msg.bids.slice(0, 10)
    const asks10 = msg.asks.slice(0, 10)
    const bestBid = bids10[0]?.price ?? null
    const bestAsk = asks10[0]?.price ?? null
    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null
    const spreadBps = mid ? ((bestAsk - bestBid) / mid) * 10000 : null
    out.push({
      ts,
      imbalance_top5: imbalance(bids5, asks5),
      imbalance_top10: imbalance(bids10, asks10),
      best_bid: bestBid,
      best_ask: bestAsk,
      spread_bps: spreadBps
    })
  }
  return out.sort((a, b) => a.ts - b.ts)
}

function addPersistence(snapshots, thresholds) {
  const state = new Map()
  for (const thr of thresholds) {
    state.set(thr, { sign: 0, run: 0 })
  }
  for (const snap of snapshots) {
    for (const thr of thresholds) {
      const sign = directionFromImbalance(snap.imbalance_top10, thr)
      const s = state.get(thr)
      if (sign === 0) {
        s.sign = 0
        s.run = 0
      } else if (sign === s.sign) {
        s.run += 1
      } else {
        s.sign = sign
        s.run = 1
      }
      snap[`sign_${String(thr).replace('.', '_')}`] = sign
      snap[`run_${String(thr).replace('.', '_')}`] = s.run
    }
  }
  return snapshots
}

function lastSnapshotBefore(snapshots, ts, cursor) {
  while (cursor + 1 < snapshots.length && snapshots[cursor + 1].ts <= ts) {
    cursor += 1
  }
  return { cursor, snap: cursor >= 0 ? snapshots[cursor] : null }
}

function snapshotsInRange(snapshots, startTs, endTs, startCursor) {
  let i = startCursor
  while (i < snapshots.length && snapshots[i].ts < startTs) i += 1
  const rows = []
  while (i < snapshots.length && snapshots[i].ts < endTs) {
    rows.push(snapshots[i])
    i += 1
  }
  return { nextIndex: i, rows }
}

function bucketKey(date) {
  return formatSg(date).slice(0, 16)
}

function summarizeBucket(bucket, rows, snaps) {
  const vol = rows.reduce((a, r) => a + r.usdt_value, 0)
  const pnl = rows.reduce((a, r) => a + r.raw_platform_pnl, 0)
  const userPnl = rows.reduce((a, r) => a + r.user_pnl, 0)
  const alignedStrong = rows.filter((r) => r.imbalance_sign_10 === r.direction && Math.abs(r.imbalance_top10 ?? 0) >= 0.15)
  const alignedAny = rows.filter((r) => r.imbalance_sign_10 === r.direction && r.imbalance_sign_10 !== 0)
  const contraStrong = rows.filter((r) => r.imbalance_sign_10 === -r.direction && Math.abs(r.imbalance_top10 ?? 0) >= 0.15)
  return {
    window_sg: bucket,
    trades: rows.length,
    volume: vol,
    platform_pnl: pnl,
    user_pnl: userPnl,
    avg_imbalance_top10: mean(snaps.map((s) => s.imbalance_top10)),
    med_imbalance_top10: median(snaps.map((s) => s.imbalance_top10)),
    p90_abs_imbalance_top10: pct(snaps.map((s) => Math.abs(s.imbalance_top10)), 0.9),
    avg_spread_bps: mean(snaps.map((s) => s.spread_bps).filter((x) => x != null)),
    aligned_strong_trades: alignedStrong.length,
    aligned_strong_platform_pnl: alignedStrong.reduce((a, r) => a + r.raw_platform_pnl, 0),
    aligned_any_trades: alignedAny.length,
    aligned_any_platform_pnl: alignedAny.reduce((a, r) => a + r.raw_platform_pnl, 0),
    contra_strong_trades: contraStrong.length,
    contra_strong_platform_pnl: contraStrong.reduce((a, r) => a + r.raw_platform_pnl, 0)
  }
}

function summarizeRowsBySide(rows) {
  const sides = [1, 2].map((side) => {
    const subset = rows.filter((r) => r.side === side)
    return {
      side,
      trades: subset.length,
      volume: subset.reduce((a, r) => a + r.usdt_value, 0),
      platform_pnl: subset.reduce((a, r) => a + r.raw_platform_pnl, 0),
      aligned_strong_trades: subset.filter((r) => r.strong_imbalance_align).length,
      aligned_strong_platform_pnl: subset.filter((r) => r.strong_imbalance_align).reduce((a, r) => a + r.raw_platform_pnl, 0)
    }
  })
  return sides
}

function skewScenarios() {
  return [
    { name: '75_85', threshold: 0.5, persistSeconds: 3, momentumPayout: 75, contraPayout: 85 },
    { name: '70_90', threshold: 0.7, persistSeconds: 3, momentumPayout: 70, contraPayout: 90 },
    { name: '65_95', threshold: 0.85, persistSeconds: 3, momentumPayout: 65, contraPayout: 95 }
  ]
}

function scenarioKey(threshold) {
  return String(threshold).replace('.', '_')
}

function applySkewCounterfactual(orders, scenario, filterFn = null) {
  const key = scenarioKey(scenario.threshold)
  let delta = 0
  let triggeredOrders = 0
  let triggeredVolume = 0
  let momentumWinningStake = 0
  let contraWinningStake = 0
  for (const order of orders) {
    if (filterFn && !filterFn(order)) continue
    const sign = order[`book_sign_${key}`] ?? 0
    const run = order[`book_run_${key}`] ?? 0
    if (sign === 0 || run < scenario.persistSeconds) continue
    triggeredOrders += 1
    triggeredVolume += order.usdt_value
    if (order.user_pnl > 0) {
      if (order.direction === sign) {
        const d = ((80 - scenario.momentumPayout) / 100) * order.usdt_value
        delta += d
        momentumWinningStake += order.usdt_value
      } else if (order.direction === -sign) {
        const d = -((scenario.contraPayout - 80) / 100) * order.usdt_value
        delta += d
        contraWinningStake += order.usdt_value
      }
    }
  }
  const original = orders.reduce((a, r) => a + r.raw_platform_pnl, 0)
  return {
    scenario: scenario.name,
    threshold: scenario.threshold,
    persist_seconds: scenario.persistSeconds,
    payouts: `${scenario.momentumPayout}/${scenario.contraPayout}`,
    original_platform_pnl: original,
    after_platform_pnl: original + delta,
    improvement: delta,
    triggered_orders: triggeredOrders,
    triggered_volume: triggeredVolume,
    momentum_winning_stake: momentumWinningStake,
    contra_winning_stake: contraWinningStake
  }
}

async function main() {
  const defaultStartUtc = new Date('2026-05-26T21:00:00.000Z')
  const defaultEndUtc = new Date('2026-05-26T22:00:00.000Z')
  const startUtc = parseEnvDate('ANALYSIS_START_UTC', defaultStartUtc)
  const endUtc = parseEnvDate('ANALYSIS_END_UTC', defaultEndUtc)
  const replayStartUtc = parseEnvDate(
    'REPLAY_START_UTC',
    new Date(`${isoDate(startUtc)}T00:00:00.000Z`)
  )
  const client = new pg.Client(DB_CONFIG)
  await client.connect()
  try {
    const [orders, oracleBuckets, snapshots] = await Promise.all([
      fetchOrders(client, startUtc, endUtc),
      fetchOracleBuckets(client, startUtc, endUtc),
      fetchTardisSnapshots(replayStartUtc, startUtc, endUtc)
    ])
    addPersistence(snapshots, [0.5, 0.7, 0.85])

    const oracleByBucket = new Map(oracleBuckets.map((r) => [r.bucket_start.getTime(), r]))

    let cursor = -1
    for (const order of orders) {
      const prior = lastSnapshotBefore(snapshots, order.created_at, cursor)
      cursor = prior.cursor
      const snap = prior.snap
      order.imbalance_top5 = snap?.imbalance_top5 ?? null
      order.imbalance_top10 = snap?.imbalance_top10 ?? null
      order.spread_bps = snap?.spread_bps ?? null
      order.imbalance_sign_10 = snap ? directionFromImbalance(snap.imbalance_top10, 0.05) : 0
      order.strong_imbalance_align = order.imbalance_sign_10 === order.direction && Math.abs(order.imbalance_top10 ?? 0) >= 0.15
      order.contra_strong_imbalance = order.imbalance_sign_10 === -order.direction && Math.abs(order.imbalance_top10 ?? 0) >= 0.15
      for (const thr of [0.5, 0.7, 0.85]) {
        const key = scenarioKey(thr)
        order[`book_sign_${key}`] = snap?.[`sign_${key}`] ?? 0
        order[`book_run_${key}`] = snap?.[`run_${key}`] ?? 0
      }
      const oracle = oracleByBucket.get(order.bucket_30s.getTime())
      order.ret_30s_bps = oracle?.ret_30s_bps ?? null
      order.chasing_last_30s = order.ret_30s_bps != null ? (order.direction * order.ret_30s_bps) > 0 : null
    }

    const overall = {
      start_sg: formatSg(startUtc),
      end_sg: formatSg(endUtc),
      trades: orders.length,
      volume: orders.reduce((a, r) => a + r.usdt_value, 0),
      raw_platform_pnl: orders.reduce((a, r) => a + r.raw_platform_pnl, 0),
      user_pnl: orders.reduce((a, r) => a + r.user_pnl, 0),
      aligned_strong_trades: orders.filter((r) => r.strong_imbalance_align).length,
      aligned_strong_platform_pnl: orders.filter((r) => r.strong_imbalance_align).reduce((a, r) => a + r.raw_platform_pnl, 0),
      aligned_strong_volume: orders.filter((r) => r.strong_imbalance_align).reduce((a, r) => a + r.usdt_value, 0),
      contra_strong_trades: orders.filter((r) => r.contra_strong_imbalance).length,
      contra_strong_platform_pnl: orders.filter((r) => r.contra_strong_imbalance).reduce((a, r) => a + r.raw_platform_pnl, 0),
      chasing_trades: orders.filter((r) => r.chasing_last_30s === true).length,
      chasing_platform_pnl: orders.filter((r) => r.chasing_last_30s === true).reduce((a, r) => a + r.raw_platform_pnl, 0),
      strong_align_and_chase_trades: orders.filter((r) => r.strong_imbalance_align && r.chasing_last_30s === true).length,
      strong_align_and_chase_platform_pnl: orders.filter((r) => r.strong_imbalance_align && r.chasing_last_30s === true).reduce((a, r) => a + r.raw_platform_pnl, 0)
    }

    const skew_today = skewScenarios().map((scenario) => applySkewCounterfactual(orders, scenario))
    const morningStart = new Date('2026-05-26T21:00:00.000Z')
    const morningEnd = new Date('2026-05-26T22:00:00.000Z')
    const morningOrders = orders.filter((o) => o.created_at >= morningStart && o.created_at < morningEnd)
    const skew_morning = skewScenarios().map((scenario) => applySkewCounterfactual(morningOrders, scenario))

    const buckets = [...new Set(orders.map((r) => bucketKey(r.bucket_15m)))].sort()
    let snapIdx = 0
    const bucketSummaries = []
    for (const bucket of buckets) {
      const [d, t] = bucket.split(' ')
      const bucketStartSg = new Date(`${d}T${t}:00.000Z`)
      const bucketStartUtc = new Date(bucketStartSg.getTime() - SG_OFFSET_HOURS * 3600 * 1000)
      const bucketEndUtc = new Date(bucketStartUtc.getTime() + 15 * 60 * 1000)
      const snapRows = snapshotsInRange(snapshots, bucketStartUtc, bucketEndUtc, snapIdx)
      snapIdx = Math.max(0, snapRows.nextIndex - 1)
      const orderRows = orders.filter((r) => bucketKey(r.bucket_15m) === bucket)
      const summary = summarizeBucket(bucket, orderRows, snapRows.rows)
      summary.by_side = summarizeRowsBySide(orderRows)
      bucketSummaries.push(summary)
    }

    const buckets30 = [...new Set(orders.map((r) => bucketKey(r.bucket_30s)))].sort()
    let snap30Idx = 0
    const bucket30Summaries = []
    for (const bucket of buckets30) {
      const [d, t] = bucket.split(' ')
      const bucketStartSg = new Date(`${d}T${t}:00.000Z`)
      const bucketStartUtc = new Date(bucketStartSg.getTime() - SG_OFFSET_HOURS * 3600 * 1000)
      const bucketEndUtc = new Date(bucketStartUtc.getTime() + 30 * 1000)
      const snapRows = snapshotsInRange(snapshots, bucketStartUtc, bucketEndUtc, snap30Idx)
      snap30Idx = Math.max(0, snapRows.nextIndex - 1)
      const orderRows = orders.filter((r) => bucketKey(r.bucket_30s) === bucket)
      const summary = summarizeBucket(bucket, orderRows, snapRows.rows)
      summary.by_side = summarizeRowsBySide(orderRows)
      bucket30Summaries.push(summary)
    }

    const topAccounts = Object.values(
      orders.reduce((acc, r) => {
        const key = r.account_id || 'null'
        acc[key] ??= { account_id: key, trades: 0, volume: 0, platform_pnl: 0, aligned_strong_trades: 0, aligned_strong_platform_pnl: 0 }
        acc[key].trades += 1
        acc[key].volume += r.usdt_value
        acc[key].platform_pnl += r.raw_platform_pnl
        if (r.strong_imbalance_align) {
          acc[key].aligned_strong_trades += 1
          acc[key].aligned_strong_platform_pnl += r.raw_platform_pnl
        }
        return acc
      }, {})
    ).sort((a, b) => a.platform_pnl - b.platform_pnl).slice(0, 10)

    const out = {
      overall,
      skew_today,
      skew_morning,
      bucket_summaries: bucketSummaries,
      bucket_30s_summaries: bucket30Summaries,
      top_accounts: topAccounts,
      sample_orders: orders
        .filter((r) => r.strong_imbalance_align || r.contra_strong_imbalance)
        .slice(0, 50)
        .map((r) => ({
          id: r.id,
          account_id: r.account_id,
          created_at_sg: r.created_at_sg,
          side: r.side,
          direction: r.direction,
          usdt_value: r.usdt_value,
          raw_platform_pnl: r.raw_platform_pnl,
          user_pnl: r.user_pnl,
          imbalance_top10: r.imbalance_top10,
          spread_bps: r.spread_bps,
          strong_imbalance_align: r.strong_imbalance_align,
          contra_strong_imbalance: r.contra_strong_imbalance,
          chasing_last_30s: r.chasing_last_30s,
          ret_30s_bps: r.ret_30s_bps
        }))
    }

    const outPath = path.join(ROOT, `tardis_orderbook_${formatSg(startUtc).slice(0, 10)}.json`)
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2))
    console.log(JSON.stringify(out, null, 2))
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
