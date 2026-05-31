import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const HOSTED_DASHBOARD_PATH = path.join(ROOT, "hosted_market_maker_dashboard.html");
const THREE_MIN_DASHBOARD_PATH = path.join(ROOT, "live_3m_market_maker_console.html");
const THREE_MIN_SCRIPT_PATH = path.join(ROOT, "live_3m_market_maker_console.js");

const PORT = Number(process.env.PORT || 8787);
const QUOTE_CADENCE_MS = Math.max(2000, Number(process.env.QUOTE_CADENCE_MS || 2000));
const PLATFORM_CONFIG_URL = "https://apis.turboflow.xyz/public/pm/config?version=2";
const PLATFORM_WS_URL = process.env.PLATFORM_WS_URL || "wss://apis.turboflow.xyz/realtime";
const DEPTH_SOURCES = [
  {
    label: "Binance Futures BTCUSDT",
    url: "https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=10",
    normalize(payload) {
      if (!payload?.bids || !payload?.asks) return null;
      return { bids: payload.bids, asks: payload.asks };
    },
  },
  {
    label: "Binance Spot BTCUSDT",
    url: "https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=10",
    normalize(payload) {
      if (!payload?.bids || !payload?.asks) return null;
      return { bids: payload.bids, asks: payload.asks };
    },
  },
  {
    label: "Bybit Linear BTCUSDT",
    url: "https://api.bybit.com/v5/market/orderbook?category=linear&symbol=BTCUSDT&limit=10",
    normalize(payload) {
      const bids = payload?.result?.b;
      const asks = payload?.result?.a;
      if (!Array.isArray(bids) || !Array.isArray(asks)) return null;
      return { bids, asks };
    },
  },
  {
    label: "OKX BTC-USDT-SWAP",
    url: "https://www.okx.com/api/v5/market/books?instId=BTC-USDT-SWAP&sz=10",
    normalize(payload) {
      const row = Array.isArray(payload?.data) ? payload.data[0] : null;
      const bids = row?.bids;
      const asks = row?.asks;
      if (!Array.isArray(bids) || !Array.isArray(asks)) return null;
      return { bids, asks };
    },
  },
];

const fallbackCalibration = {
  label: "Embedded last 7d winner",
  kind: "notional",
  depth: 5,
  threshold: 0.5,
  persist: 3.0,
  triggeredProbability: 0.5924,
  maxProbabilityPct: 60.0,
  lowVolCutoff: 6.0,
  highVolCutoff: 12.0,
  alphaMin: 0.05,
  alphaMax: 0.18,
  maxStepPerSecond: 0.006,
  neutralSnapBand: 0.0015,
};

const defaultSettings = {
  edgePct: 4.0,
  pfofPct: 2.5,
  requireBinance: true,
  favoredPayoutFloor: 65.0,
};

const fittedMidModel = JSON.parse(
  fs.readFileSync(path.join(ROOT, "live_mid_model_30s_best_trade_model.json"), "utf8"),
);
const fittedCoef = fittedMidModel.coefficients || {};

const state = {
  startedAt: new Date().toISOString(),
  runtime: {
    quoteCadenceMs: QUOTE_CADENCE_MS,
    quoteCadenceSeconds: QUOTE_CADENCE_MS / 1000,
    port: PORT,
  },
  calibration: { ...fallbackCalibration },
  feed: {
    source: "Binance Futures BTCUSDT",
    lastUpdateTs: null,
    mid: null,
    spreadBps: null,
  },
  featureVector: {
    imb_top5_notional: 0,
    imb_top5_size: 0,
    imb_top10_notional: 0,
    imb_top10_size: 0,
    signed_persist_05: 0,
    signed_persist_06: 0,
    microprice_dev_bps: 0,
    spread_bps: 0,
    vol_10s_bps: 0,
    thin_depth: 0,
    ret_abs_3s: 0,
    ret_abs_10s: 0,
  },
  quote: {
    edgePct: defaultSettings.edgePct,
    pfofPct: defaultSettings.pfofPct,
    requireBinance: defaultSettings.requireBinance,
    favoredPayoutFloor: defaultSettings.favoredPayoutFloor,
    active: false,
    disabledReason: "Waiting for Binance depth",
    rawProbability: 0.5,
    displayProbability: 0.5,
    upPayout: 92.0,
    downPayout: 92.0,
    favoredSide: "Neutral",
    windowStartTs: null,
    windowEndTs: null,
    regime: "Neutral",
  },
  platformQuote: {
    source: "none",
    upPayout: null,
    downPayout: null,
    impliedEdgePct: null,
    lastUpdateTs: null,
  },
  publicTradeMonitor: {
    status: "offline",
    seenTrades: 0,
    competedTrades: 0,
    settledTrades: 0,
    competedVolume: 0,
    ourPnl: 0,
    wins: 0,
    losses: 0,
    lastTradeTs: null,
    openRoutedTrades: 0,
  },
  diagnostics: {
    lastError: null,
    lastDepthError: null,
    lastDepthSourceTried: null,
  },
};

let quoteWindowStartTs = null;
let lastFeedSign = 0;
let lastFeedSignTime = null;
let platformSocket = null;
let depthTimer = null;
let depthBoundaryTimer = null;
let platformConfigTimer = null;
const liveHistory = [];
const quoteHistory = [];
const seenTradeIds = new Set();
const routedById = new Map();
const sseClients = new Set();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function payoutForProbability(probability, edgePercent) {
  const grossMultiplier = 1 - edgePercent / 100;
  return 100 * grossMultiplier / probability - 100;
}

function probabilityForPayout(payout, edgePercent) {
  const grossMultiplier = 1 - edgePercent / 100;
  return (100 * grossMultiplier) / (100 + payout);
}

function clampProbabilityByFloor(probability, edgePercent, favoredPayoutFloor) {
  if (!Number.isFinite(favoredPayoutFloor)) return probability;
  const floor = Math.max(0, favoredPayoutFloor);
  const floorProbCap = probabilityForPayout(floor, edgePercent);
  if (!Number.isFinite(floorProbCap)) return probability;
  const upper = Math.max(0.5, floorProbCap);
  const lower = Math.min(0.5, 1 - floorProbCap);
  return clamp(probability, lower, upper);
}

function impliedProbabilityFromPayout(payout) {
  return 100 / (100 + payout);
}

function impliedEdgeFromTwoWayQuote(upPayout, downPayout) {
  const upProb = impliedProbabilityFromPayout(upPayout);
  const downProb = impliedProbabilityFromPayout(downPayout);
  const overround = upProb + downProb;
  if (!Number.isFinite(overround) || overround <= 0) {
    return null;
  }
  return (1 - 1 / overround) * 100;
}

function quoteWindowMs() {
  return QUOTE_CADENCE_MS;
}

function interpolateHistory(secondsAgo) {
  const target = Date.now() - secondsAgo * 1000;
  for (let i = liveHistory.length - 1; i >= 0; i -= 1) {
    if (liveHistory[i].ts <= target) return liveHistory[i];
  }
  return liveHistory[0] || null;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

function persistenceForThreshold(threshold) {
  if (!liveHistory.length) return 0;
  const last = liveHistory[liveHistory.length - 1];
  const current = last.top5Imbalance;
  const currentSign = current >= threshold ? 1 : current <= -threshold ? -1 : 0;
  if (currentSign === 0) return 0;
  let earliestTs = last.ts;
  for (let i = liveHistory.length - 1; i >= 0; i -= 1) {
    const val = liveHistory[i].top5Imbalance;
    const sign = val >= threshold ? 1 : val <= -threshold ? -1 : 0;
    if (sign !== currentSign) break;
    earliestTs = liveHistory[i].ts;
  }
  return currentSign * Math.max(0, (last.ts - earliestTs) / 1000);
}

function fittedProbabilityFromFeatures(features) {
  let score = Number(fittedCoef.intercept || 0);
  for (let i = 0; i < fittedMidModel.features.length; i += 1) {
    const key = fittedMidModel.features[i];
    const raw = Number(features[key] ?? 0);
    const mean = Number(fittedCoef.means?.[i] ?? 0);
    const scale = Math.max(Number(fittedCoef.scales?.[i] ?? 1), 1e-9);
    const coef = Number(fittedCoef.coef?.[i] ?? 0);
    const z = (raw - mean) / scale;
    score += coef * z;
  }
  return sigmoid(score);
}

function summarizeRegime(probability) {
  if (probability >= 0.58) return "Strong Up Pressure";
  if (probability <= 0.42) return "Strong Down Pressure";
  if (probability >= 0.53) return "Mild Up Pressure";
  if (probability <= 0.47) return "Mild Down Pressure";
  return "Neutral";
}

function broadcastState() {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function applyRuntimeSettings(input = {}) {
  const nextEdge = clamp(Number(input.edgePct ?? state.quote.edgePct), 0, 25);
  const nextPfof = clamp(Number(input.pfofPct ?? state.quote.pfofPct), 0, 25);
  const nextRequireBinance = input.requireBinance ?? state.quote.requireBinance;
  const nextFavoredPayoutFloor = clamp(Number(input.favoredPayoutFloor ?? state.quote.favoredPayoutFloor), 0, 100);
  state.quote.edgePct = Number.isFinite(nextEdge) ? nextEdge : state.quote.edgePct;
  state.quote.pfofPct = Number.isFinite(nextPfof) ? nextPfof : state.quote.pfofPct;
  state.quote.requireBinance = Boolean(nextRequireBinance);
  state.quote.favoredPayoutFloor = Number.isFinite(nextFavoredPayoutFloor) ? nextFavoredPayoutFloor : state.quote.favoredPayoutFloor;
  if (state.quote.active && Number.isFinite(state.quote.displayProbability)) {
    const p = clampProbabilityByFloor(state.quote.displayProbability, state.quote.edgePct, state.quote.favoredPayoutFloor);
    state.quote.displayProbability = p;
    state.quote.upPayout = payoutForProbability(p, state.quote.edgePct);
    state.quote.downPayout = payoutForProbability(1 - p, state.quote.edgePct);
  }
  recordQuoteSnapshot();
  broadcastState();
}

function recordQuoteSnapshot() {
  const ts = state.quote.windowStartTs ?? Date.now();
  const last = quoteHistory[quoteHistory.length - 1];
  const snapshot = {
    ts_ms: ts,
    active: Boolean(state.quote.active),
    up_payout: state.quote.upPayout,
    down_payout: state.quote.downPayout,
    display_probability: state.quote.displayProbability,
    regime: state.quote.regime,
  };
  if (last && last.ts_ms === snapshot.ts_ms) {
    Object.assign(last, snapshot);
    return;
  }
  quoteHistory.push(snapshot);
  if (quoteHistory.length > 50000) {
    quoteHistory.splice(0, quoteHistory.length - 50000);
  }
}

function quoteForTradeTimestamp(tsMs) {
  if (!quoteHistory.length) return null;
  let lo = 0;
  let hi = quoteHistory.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const item = quoteHistory[mid];
    if (item.ts_ms <= tsMs) {
      best = item;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function tradeSideLabel(side) {
  if (Number(side) === 1) return "UP";
  if (Number(side) === 2) return "DOWN";
  return "UNKNOWN";
}

function computeUserWonFromTrade(trade) {
  const side = Number(trade.side);
  const entry = Number(trade.entry_price);
  const settled = Number(trade.settled_price);
  if (!Number.isFinite(entry) || !Number.isFinite(settled)) return null;
  if (side === 1) return settled > entry;
  if (side === 2) return settled < entry;
  return null;
}

function processTradeMessage(msg) {
  if (!msg || msg.group !== "dex_predict_market") return false;
  const trade = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
  if (!trade || String(trade.pair_id ?? "") !== "6" || Number(trade.duration) !== 30) return false;

  const tradeId = String(trade.id ?? "");
  if (!tradeId) return false;

  state.publicTradeMonitor.status = "connected";
  state.publicTradeMonitor.lastTradeTs = Date.now();

  if (!seenTradeIds.has(tradeId)) {
    seenTradeIds.add(tradeId);
    state.publicTradeMonitor.seenTrades += 1;
  }

  const createdAtMs = Date.parse(trade.created_at || "");
  const quote = Number.isFinite(createdAtMs) ? quoteForTradeTimestamp(createdAtMs) : null;
  const actualPayout = Number(trade.return_rate) * 100;
  const side = tradeSideLabel(trade.side);
  const ourPayout = side === "UP" ? quote?.up_payout : side === "DOWN" ? quote?.down_payout : null;
  const amount = Number(trade.usdt_value ?? trade.amount ?? 0);
  const statusText = String(trade.order_status || "");

  if (!routedById.has(tradeId) && quote?.active && Number.isFinite(actualPayout) && Number.isFinite(ourPayout) && ourPayout > actualPayout) {
    routedById.set(tradeId, {
      id: tradeId,
      side,
      amount,
      ourPayout,
      settled: false,
    });
    state.publicTradeMonitor.competedTrades += 1;
    state.publicTradeMonitor.competedVolume += amount;
  }

  const routed = routedById.get(tradeId);
  if (routed && !routed.settled && statusText === "Finished") {
    const userWon = computeUserWonFromTrade(trade);
    if (userWon === true) {
      state.publicTradeMonitor.ourPnl += -(routed.amount * routed.ourPayout / 100);
      state.publicTradeMonitor.losses += 1;
    } else if (userWon === false) {
      state.publicTradeMonitor.ourPnl += routed.amount;
      state.publicTradeMonitor.wins += 1;
    }
    routed.settled = true;
    state.publicTradeMonitor.settledTrades += 1;
  }

  state.publicTradeMonitor.openRoutedTrades = [...routedById.values()].filter((x) => !x.settled).length;
  return true;
}

async function pullPlatformConfigQuote() {
  const response = await fetch(PLATFORM_CONFIG_URL, { cache: "no-store" });
  const payload = await response.json();
  const pairList = Array.isArray(payload?.data?.data)
    ? payload.data.data
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.pairs)
        ? payload.pairs
        : [];
  const btc = pairList.find((item) => String(item?.pair_name || item?.pairName || "").toUpperCase() === "BTC/USDT");
  const config30 = btc?.order_configs?.find((item) => Number(item?.duration) === 30);
  if (!config30) return;
  state.platformQuote = {
    source: "config",
    upPayout: Number(config30.bid_return_rate) * 100,
    downPayout: Number(config30.ask_return_rate) * 100,
    impliedEdgePct: impliedEdgeFromTwoWayQuote(Number(config30.bid_return_rate) * 100, Number(config30.ask_return_rate) * 100),
    lastUpdateTs: new Date().toISOString(),
  };
  broadcastState();
}

async function fetchJsonWithTimeout(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "user-agent": "btc-30s-market-maker-runtime/1.0",
        accept: "application/json",
      },
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
    return { ok: response.ok, status: response.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

async function pullDepthPayload() {
  const failures = [];
  const allowedSources = state.quote.requireBinance
    ? DEPTH_SOURCES.filter((source) => source.label.startsWith("Binance"))
    : DEPTH_SOURCES;
  for (const source of allowedSources) {
    state.diagnostics.lastDepthSourceTried = source.label;
    try {
      const result = await fetchJsonWithTimeout(source.url, 4000);
      if (!result.ok) {
        failures.push(`${source.label}: HTTP ${result.status}`);
        continue;
      }
      const payload = result.payload;
      const normalized = source.normalize?.(payload);
      if (!normalized?.bids || !normalized?.asks || !Array.isArray(normalized.bids) || !Array.isArray(normalized.asks)) {
        failures.push(`${source.label}: unexpected payload ${JSON.stringify(payload).slice(0, 220)}`);
        continue;
      }
      return { sourceLabel: source.label, payload: normalized };
    } catch (error) {
      failures.push(`${source.label}: ${String(error)}`);
    }
  }
  throw new Error(failures.join(" | "));
}

function connectPlatformStream() {
  if (platformSocket) {
    try { platformSocket.close(); } catch {}
    platformSocket = null;
  }

  state.publicTradeMonitor.status = "connecting";
  platformSocket = new WebSocket(PLATFORM_WS_URL);

  platformSocket.onopen = () => {
    state.publicTradeMonitor.status = "connected";
    platformSocket.send(JSON.stringify({ action: "subscribe", args: ["dex_predict_config"] }));
    platformSocket.send(JSON.stringify({ action: "subscribe", args: ["dex_predict_ticker"] }));
    platformSocket.send(JSON.stringify({ action: "subscribe", args: ["dex_predict_market"] }));
    broadcastState();
  };

  platformSocket.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (processTradeMessage(payload)) {
        broadcastState();
        return;
      }
    } catch (error) {
      state.diagnostics.lastError = String(error);
    }
  };

  platformSocket.onerror = (error) => {
    state.publicTradeMonitor.status = "error";
    state.diagnostics.lastError = String(error?.message || error);
    broadcastState();
  };

  platformSocket.onclose = () => {
    state.publicTradeMonitor.status = "offline";
    broadcastState();
    setTimeout(connectPlatformStream, 2000);
  };
}

async function refreshQuoteWindow() {
  try {
    const { sourceLabel, payload: data } = await pullDepthPayload();
    if (!data?.bids || !data?.asks) return;

    const bids = data.bids.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) }));
    const asks = data.asks.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) }));
    const bestBid = bids[0];
    const bestAsk = asks[0];
    if (!bestBid || !bestAsk) return;

    const sumLevels = (levels, depth, mapper) => levels.slice(0, depth).reduce((sum, level) => sum + mapper(level), 0);
    const bidNotional5 = sumLevels(bids, 5, (level) => level.price * level.qty);
    const askNotional5 = sumLevels(asks, 5, (level) => level.price * level.qty);
    const bidSize5 = sumLevels(bids, 5, (level) => level.qty);
    const askSize5 = sumLevels(asks, 5, (level) => level.qty);
    const bidNotional10 = sumLevels(bids, 10, (level) => level.price * level.qty);
    const askNotional10 = sumLevels(asks, 10, (level) => level.price * level.qty);
    const bidSize10 = sumLevels(bids, 10, (level) => level.qty);
    const askSize10 = sumLevels(asks, 10, (level) => level.qty);

    const mid = (bestBid.price + bestAsk.price) / 2;
    const microprice = ((bestAsk.price * bestBid.qty) + (bestBid.price * bestAsk.qty)) / Math.max(bestBid.qty + bestAsk.qty, 1e-9);
    const micropriceDeviationBps = ((microprice - mid) / mid) * 10000;
    const spreadBps = ((bestAsk.price - bestBid.price) / mid) * 10000;
    const top5Imbalance = (bidNotional5 - askNotional5) / Math.max(bidNotional5 + askNotional5, 0.0001);
    const top5SizeImbalance = (bidSize5 - askSize5) / Math.max(bidSize5 + askSize5, 0.0001);
    const top10Imbalance = (bidNotional10 - askNotional10) / Math.max(bidNotional10 + askNotional10, 0.0001);
    const top10SizeImbalance = (bidSize10 - askSize10) / Math.max(bidSize10 + askSize10, 0.0001);

    const now = Date.now();
    liveHistory.push({
      ts: now,
      mid,
      top5Imbalance,
      top10Imbalance,
      top5SizeImbalance,
      top10SizeImbalance,
      totalDepth: bidNotional10 + askNotional10,
    });
    while (liveHistory.length > 60) liveHistory.shift();

    const sign = top5Imbalance > 0 ? 1 : top5Imbalance < 0 ? -1 : 0;
    if (sign !== lastFeedSign) {
      lastFeedSign = sign;
      lastFeedSignTime = now;
    }

    const hist3 = interpolateHistory(3);
    const hist10 = interpolateHistory(10);
    const ret3 = hist3 ? ((mid - hist3.mid) / hist3.mid) * 10000 : 0;
    const ret10 = hist10 ? ((mid - hist10.mid) / hist10.mid) * 10000 : 0;
    const recentReturns = [];
    for (let i = 1; i < liveHistory.length; i += 1) {
      const prev = liveHistory[i - 1];
      const curr = liveHistory[i];
      recentReturns.push(((curr.mid - prev.mid) / prev.mid) * 10000);
    }
    const shortVol = stddev(recentReturns.slice(-10));
    const totalDepths = liveHistory.map((item) => item.totalDepth).sort((a, b) => a - b);
    const medianDepth = totalDepths.length ? totalDepths[Math.floor(totalDepths.length / 2)] : bidNotional10 + askNotional10;
    const currentDepth = bidNotional10 + askNotional10;
    const thinDepth = clamp(1 - currentDepth / Math.max(medianDepth, 0.0001), 0, 1);

    state.featureVector = {
      imb_top5_notional: top5Imbalance,
      imb_top5_size: top5SizeImbalance,
      imb_top10_notional: top10Imbalance,
      imb_top10_size: top10SizeImbalance,
      signed_persist_05: persistenceForThreshold(0.5),
      signed_persist_06: persistenceForThreshold(0.6),
      microprice_dev_bps: micropriceDeviationBps,
      spread_bps: spreadBps,
      vol_10s_bps: shortVol,
      thin_depth: thinDepth,
      ret_abs_3s: Math.abs(ret3),
      ret_abs_10s: Math.abs(ret10),
    };

    const rawProbability = fittedProbabilityFromFeatures(state.featureVector);
    const maxProb = fallbackCalibration.maxProbabilityPct / 100;
    const targetProbability = clamp(rawProbability, 0.5 - (maxProb - 0.5), 0.5 + (maxProb - 0.5));
    const windowMs = quoteWindowMs();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    if (quoteWindowStartTs !== windowStart) {
      const prev = state.quote.displayProbability ?? 0.5;
      const dtSeconds = quoteWindowStartTs == null ? windowMs / 1000 : clamp((windowStart - quoteWindowStartTs) / 1000, 0.25, 10);
      const alpha = clamp(dtSeconds / 6, fallbackCalibration.alphaMin, fallbackCalibration.alphaMax);
      const candidateProbability = prev + alpha * (targetProbability - prev);
      const maxStep = fallbackCalibration.maxStepPerSecond * dtSeconds;
      let nextProbability = clamp(
        prev + clamp(candidateProbability - prev, -maxStep, maxStep),
        0.5 - (maxProb - 0.5),
        0.5 + (maxProb - 0.5),
      );
      nextProbability = clampProbabilityByFloor(nextProbability, state.quote.edgePct, state.quote.favoredPayoutFloor);
      quoteWindowStartTs = windowStart;
      state.quote = {
        edgePct: state.quote.edgePct,
        pfofPct: state.quote.pfofPct,
        requireBinance: state.quote.requireBinance,
        favoredPayoutFloor: state.quote.favoredPayoutFloor,
        active: true,
        disabledReason: null,
        rawProbability,
        displayProbability: Math.abs(nextProbability - 0.5) < fallbackCalibration.neutralSnapBand ? 0.5 : nextProbability,
        upPayout: payoutForProbability(Math.abs(nextProbability - 0.5) < fallbackCalibration.neutralSnapBand ? 0.5 : nextProbability, state.quote.edgePct),
        downPayout: payoutForProbability(1 - (Math.abs(nextProbability - 0.5) < fallbackCalibration.neutralSnapBand ? 0.5 : nextProbability), state.quote.edgePct),
        favoredSide: nextProbability > 0.5005 ? "UP" : nextProbability < 0.4995 ? "DOWN" : "Neutral",
        windowStartTs: windowStart,
        windowEndTs: windowStart + windowMs,
        regime: summarizeRegime(rawProbability),
      };
      recordQuoteSnapshot();
      } else {
      state.quote.rawProbability = rawProbability;
      state.quote.regime = summarizeRegime(rawProbability);
      state.quote.active = true;
      state.quote.disabledReason = null;
    }

    state.feed = {
      source: sourceLabel,
      lastUpdateTs: new Date().toISOString(),
      mid,
      spreadBps,
    };
    state.diagnostics.lastError = null;
    state.diagnostics.lastDepthError = null;
    broadcastState();
  } catch (error) {
    state.diagnostics.lastError = String(error);
    state.diagnostics.lastDepthError = String(error);
    state.quote.active = false;
    state.quote.disabledReason = state.quote.requireBinance
      ? "Binance depth unavailable, quote disabled"
      : "Depth unavailable, quote disabled";
    broadcastState();
  }
}

function startDepthLoop() {
  if (depthTimer) clearInterval(depthTimer);
  if (depthBoundaryTimer) clearTimeout(depthBoundaryTimer);
  const cadenceMs = quoteWindowMs();
  const now = Date.now();
  const nextBoundary = Math.ceil(now / cadenceMs) * cadenceMs;
  refreshQuoteWindow();
  depthBoundaryTimer = setTimeout(() => {
    refreshQuoteWindow();
    depthTimer = setInterval(refreshQuoteWindow, cadenceMs);
  }, Math.max(0, nextBoundary - now));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath, contentType, missingMessage) {
  try {
    const body = fs.readFileSync(filePath, "utf8");
    res.writeHead(200, { "Content-Type": contentType });
    res.end(body);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(missingMessage);
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    sendFile(res, HOSTED_DASHBOARD_PATH, "text/html; charset=utf-8", "Hosted dashboard HTML missing.");
    return;
  }
  if (req.url === "/3m" || req.url === "/3m/" || req.url === "/3m/index.html") {
    sendFile(res, THREE_MIN_DASHBOARD_PATH, "text/html; charset=utf-8", "3m dashboard HTML missing.");
    return;
  }
  if (req.url === "/3m/live_3m_market_maker_console.js") {
    sendFile(res, THREE_MIN_SCRIPT_PATH, "application/javascript; charset=utf-8", "3m dashboard JS missing.");
    return;
  }
  if (req.url === "/api/state") {
    sendJson(res, 200, state);
    return;
  }
  if (req.url === "/api/settings" && req.method === "POST") {
    readRequestBody(req)
      .then((body) => {
        const payload = body ? JSON.parse(body) : {};
        applyRuntimeSettings(payload);
        sendJson(res, 200, {
          ok: true,
          edgePct: state.quote.edgePct,
          pfofPct: state.quote.pfofPct,
          requireBinance: state.quote.requireBinance,
          favoredPayoutFloor: state.quote.favoredPayoutFloor,
        });
      })
      .catch((error) => {
        sendJson(res, 400, { ok: false, error: String(error) });
      });
    return;
  }
  if (req.url === "/api/settings/reset" && req.method === "POST") {
    applyRuntimeSettings(defaultSettings);
    sendJson(res, 200, {
      ok: true,
      edgePct: state.quote.edgePct,
      pfofPct: state.quote.pfofPct,
      requireBinance: state.quote.requireBinance,
      favoredPayoutFloor: state.quote.favoredPayoutFloor,
    });
    return;
  }
  if (req.url === "/health") {
    sendJson(res, 200, { ok: true, startedAt: state.startedAt });
    return;
  }
  if (req.url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`Hosted runtime listening on http://127.0.0.1:${PORT}`);
});

await pullPlatformConfigQuote().catch((error) => {
  state.diagnostics.lastError = String(error);
});
platformConfigTimer = setInterval(() => {
  pullPlatformConfigQuote().catch((error) => {
    state.diagnostics.lastError = String(error);
  });
}, 2000);
connectPlatformStream();
startDepthLoop();
