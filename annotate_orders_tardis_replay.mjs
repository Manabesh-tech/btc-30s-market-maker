import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { normalizeBookChanges, OrderBook, replayNormalized } from 'tardis-dev'

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

const THRESHOLD = Number(process.env.IMBALANCE_THRESHOLD || '0.7')
const PERSIST_SECONDS = Number(process.env.PERSIST_SECONDS || '3')

function topImbalance(book, depth = 10) {
  let bid = 0
  let ask = 0
  let i = 0
  for (const level of book.bids()) {
    bid += Number(level.price) * Number(level.amount)
    i += 1
    if (i >= depth) break
  }
  i = 0
  for (const level of book.asks()) {
    ask += Number(level.price) * Number(level.amount)
    i += 1
    if (i >= depth) break
  }
  if (bid + ask === 0) return 0
  return (bid - ask) / (bid + ask)
}

function signFor(imbalance, threshold) {
  if (imbalance >= threshold) return 1
  if (imbalance <= -threshold) return -1
  return 0
}

async function fetchOrders(client, startUtc, endUtc, durations) {
  const sql = `
    SELECT
      o.id,
      o.created_at,
      o.duration,
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
      AND o.duration = ANY($3::int[])
      AND o.created_at >= $1::timestamptz
      AND o.created_at < $2::timestamptz
      AND (o.account_id IS NULL OR o.account_id <> ALL($4::bigint[]))
    ORDER BY o.created_at
  `
  const res = await client.query(sql, [startUtc, endUtc, durations, EXCLUDED_ACCOUNTS.map(String)])
  return res.rows.map((r) => ({
    id: String(r.id),
    created_at: new Date(r.created_at),
    duration: Number(r.duration),
    side: Number(r.side),
    direction: Number(r.side) === 1 ? 1 : -1,
    usdt_value: Number(r.usdt_value),
    raw_platform_pnl: Number(r.raw_platform_pnl),
    user_pnl: Number(r.user_pnl)
  }))
}

async function main() {
  const apiKey = process.env.TARDIS_API_KEY
  if (!apiKey) throw new Error('TARDIS_API_KEY env var is required')

  const startUtc = new Date(process.env.ANALYSIS_START_UTC)
  const endUtc = new Date(process.env.ANALYSIS_END_UTC)
  const replayStartUtc = new Date(process.env.REPLAY_START_UTC)
  const outPath = process.env.OUT_PATH || path.join(ROOT, 'annotated_orders_tardis_today.json')
  const durations = (process.env.DURATIONS || '30,60').split(',').map((x) => Number(x.trim())).filter(Boolean)

  const client = new pg.Client(DB_CONFIG)
  await client.connect()
  try {
    const orders = await fetchOrders(client, startUtc, endUtc, durations)
    const book = new OrderBook()
    const messages = replayNormalized(
      {
        exchange: 'binance-futures',
        symbols: ['BTCUSDT'],
        from: replayStartUtc.toISOString(),
        to: endUtc.toISOString(),
        apiKey
      },
      normalizeBookChanges
    )

    let currentSign = 0
    let signChangedAt = null
    let currentImbalance = null
    let i = 0

    function annotateUntil(cutoff) {
      while (i < orders.length && orders[i].created_at < cutoff) {
        const order = orders[i]
        const persist = currentSign !== 0 && signChangedAt ? Math.max(0, (order.created_at - signChangedAt) / 1000) : 0
        order.book_sign = currentSign
        order.book_persist_seconds = persist
        order.book_imbalance = currentImbalance
        i += 1
      }
    }

    for await (const msg of messages) {
      if (msg.type !== 'book_change') continue
      const ts = new Date(msg.timestamp)
      annotateUntil(ts)
      book.update(msg)
      currentImbalance = topImbalance(book, 10)
      const sign = signFor(currentImbalance, THRESHOLD)
      if (sign !== currentSign) {
        currentSign = sign
        signChangedAt = ts
      }
    }
    annotateUntil(new Date('9999-12-31T00:00:00.000Z'))

    const out = {
      start_utc: startUtc.toISOString(),
      end_utc: endUtc.toISOString(),
      threshold: THRESHOLD,
      persist_seconds: PERSIST_SECONDS,
      durations,
      orders
    }
    fs.writeFileSync(outPath, JSON.stringify(out))
    console.log(JSON.stringify({ out_path: outPath, orders: orders.length }))
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
