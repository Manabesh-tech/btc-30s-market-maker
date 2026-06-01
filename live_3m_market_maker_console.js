"use strict";

const PRODUCT_DURATION = 180;
const PLATFORM_CONFIG_URL = "https://apis.turboflow.xyz/public/pm/config?version=2";
const PLATFORM_WS_URL = "wss://apis.turboflow.xyz/realtime";
const BINANCE_WS_URL = "wss://fstream.binance.com/stream?streams=btcusdt@bookTicker/ethusdt@bookTicker";
const BINANCE_KLINES_URL = "https://fapi.binance.com/fapi/v1/klines";
const PAYOUT_FLOOR = 65;
const PAYOUT_CAP = 105;
const DEFAULT_EDGE = 4.0;
const DEFAULT_MODE = "phase1";
const DEFAULT_PAIR_FILTER = "all";
const STORAGE_KEY = "tf-3m-console-state-v1";
const HOSTED_STATE_URL = "/api/3m/state";
const HOSTED_SETTINGS_URL = "/api/3m/settings";
const HOSTED_SETTINGS_RESET_URL = "/api/3m/settings/reset";
const HOSTED_MONITOR_RESET_URL = "/api/3m/monitor/reset";
const HOSTED_EVENTS_URL = "/events/3m";

const PAIRS = [
  {
    pairName: "BTC/USDT",
    symbol: "BTCUSDT",
    lookbackMin: 3,
    bucketEdges: [5, 10, 15, 20],
    phase1DangerProb: [0.525, 0.54, 0.555, 0.57, 0.58],
    empiricalDangerProb: [0.5484, 0.5674, 0.5804, 0.6, 0.5851],
    meanReversionSharePct: [61.37, 75.74, 81.71, 81.1, 80.92],
    meanReversionWinPct: [54.84, 56.74, 58.04, 60.0, 58.51],
    note: "BTC 3m was the cleanest high-volume longer-duration read in the replay.",
  },
  {
    pairName: "ETH/USDT",
    symbol: "ETHUSDT",
    lookbackMin: 3,
    bucketEdges: [5, 10, 15, 20],
    phase1DangerProb: [0.52, 0.53, 0.54, 0.55, 0.56],
    empiricalDangerProb: [0.5419, 0.5505, 0.4942, 0.5429, 0.577],
    meanReversionSharePct: [62.98, 79.77, 84.21, 86.63, 86.36],
    meanReversionWinPct: [54.19, 55.05, 49.42, 54.29, 57.7],
    note: "ETH 3m is still mean-reversion-heavy, but the middle bucket is noisier than BTC.",
  },
];

const state = {
  controls: {
    edge: DEFAULT_EDGE,
    mode: DEFAULT_MODE,
    pairFilter: DEFAULT_PAIR_FILTER,
  },
  market: Object.fromEntries(PAIRS.map((pair) => [pair.pairName, { history: [], mid: null, spreadBps: null, lastUpdateTs: null }])),
  platform: {
    status: "Connecting",
    note: "Waiting for public config",
    lastUpdateTs: null,
    socketStatus: "connecting",
    pairs: {},
  },
  binance: {
    status: "Connecting",
    note: "Seeding recent 1m closes",
    lastUpdateTs: null,
  },
  monitor: {
    status: "Connecting",
    note: "Waiting for public trade feed",
    startedAtTs: Date.now(),
    lastTradeTs: null,
    seenTrades: 0,
    competedTrades: 0,
    settledTrades: 0,
    openRoutedTrades: 0,
    competedVolume: 0,
    ourPnl: 0,
    wins: 0,
    losses: 0,
    pairs: Object.fromEntries(PAIRS.map((pair) => [pair.pairName, {
      competedTrades: 0,
      settledTrades: 0,
      competedVolume: 0,
      ourPnl: 0,
      wins: 0,
      losses: 0,
    }])),
  },
  quotes: {},
  hosted: {
    enabled: false,
  },
};

let platformSocket = null;
let binanceSocket = null;
let platformPollHandle = null;
const ourQuoteHistory = Object.fromEntries(PAIRS.map((pair) => [pair.pairName, []]));
const seenTradeIds = new Set();
const routedById = new Map();
let hostedEventSource = null;

function $(id) {
  return document.getElementById(id);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatNum(value, decimals = 2) {
  if (value == null || !Number.isFinite(Number(value))) return "-";
  return Number(value).toFixed(decimals);
}

function formatPct(value, decimals = 2) {
  if (value == null || !Number.isFinite(Number(value))) return "-";
  return `${Number(value).toFixed(decimals)}%`;
}

function formatSigned(value, decimals = 2, suffix = "") {
  if (value == null || !Number.isFinite(Number(value))) return "-";
  const num = Number(value);
  return `${num >= 0 ? "+" : ""}${num.toFixed(decimals)}${suffix}`;
}

function formatMoney(value) {
  if (value == null || !Number.isFinite(Number(value))) return "-";
  const num = Number(value);
  return `${num >= 0 ? "+" : "-"}${Math.abs(num).toFixed(2)}`;
}

function formatDateTime(value) {
  const ts = typeof value === "number" ? value : Date.parse(value || "");
  if (!Number.isFinite(ts)) return "-";
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function emptyPairMonitor() {
  return {
    competedTrades: 0,
    settledTrades: 0,
    competedVolume: 0,
    ourPnl: 0,
    wins: 0,
    losses: 0,
  };
}

function payoutForProbability(probability, edgePercent) {
  const grossMultiplier = 1 - edgePercent / 100;
  return 100 * grossMultiplier / probability - 100;
}

function impliedProbabilityFromPayout(payout) {
  return 100 / (100 + payout);
}

function impliedEdgeFromTwoWayQuote(higherPayout, lowerPayout) {
  const pHigher = impliedProbabilityFromPayout(higherPayout);
  const pLower = impliedProbabilityFromPayout(lowerPayout);
  const overround = pHigher + pLower;
  if (!Number.isFinite(overround) || overround <= 0) return null;
  return (1 - 1 / overround) * 100;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isHostedThreeMinRoute() {
  return window.location.pathname === "/3m" || window.location.pathname === "/3m/" || window.location.pathname === "/3m/index.html";
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload ? JSON.stringify(payload) : "",
  });
  return response.json();
}

function saveControls() {
  const payload = state.hosted.enabled
    ? { pairFilter: state.controls.pairFilter }
    : state.controls;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function loadControls() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.controls.pairFilter = saved.pairFilter || DEFAULT_PAIR_FILTER;
    if (!state.hosted.enabled) {
      state.controls.edge = Number.isFinite(Number(saved.edge)) ? clamp(Number(saved.edge), 0, 20) : DEFAULT_EDGE;
      state.controls.mode = saved.mode === "empirical" ? "empirical" : DEFAULT_MODE;
    }
  } catch {
    state.controls.pairFilter = DEFAULT_PAIR_FILTER;
    if (!state.hosted.enabled) {
      state.controls.edge = DEFAULT_EDGE;
      state.controls.mode = DEFAULT_MODE;
    }
  }
}

function syncControlInputs() {
  $("edge-input").value = state.controls.edge.toFixed(1);
  $("pair-filter").value = state.controls.pairFilter;
  document.querySelectorAll(".mode-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.controls.mode);
  });
}

function attachHostedState(payload) {
  state.hosted.enabled = true;
  state.controls.edge = Number.isFinite(Number(payload?.controls?.edge)) ? clamp(Number(payload.controls.edge), 0, 20) : state.controls.edge;
  state.controls.mode = payload?.controls?.mode === "empirical" ? "empirical" : DEFAULT_MODE;
  state.market = payload?.market || state.market;
  state.platform = payload?.platform || state.platform;
  state.binance = payload?.binance || state.binance;
  state.monitor = payload?.monitor || state.monitor;
  state.quotes = payload?.quotes || {};
  syncControlInputs();
  saveControls();
}

function resetMonitorState() {
  seenTradeIds.clear();
  routedById.clear();
  for (const pair of PAIRS) {
    ourQuoteHistory[pair.pairName].length = 0;
  }
  state.monitor.status = "Connecting";
  state.monitor.note = "Waiting for public trade feed";
  state.monitor.startedAtTs = Date.now();
  state.monitor.lastTradeTs = null;
  state.monitor.seenTrades = 0;
  state.monitor.competedTrades = 0;
  state.monitor.settledTrades = 0;
  state.monitor.openRoutedTrades = 0;
  state.monitor.competedVolume = 0;
  state.monitor.ourPnl = 0;
  state.monitor.wins = 0;
  state.monitor.losses = 0;
  state.monitor.pairs = Object.fromEntries(PAIRS.map((pair) => [pair.pairName, emptyPairMonitor()]));
}

function bucketLabels(edges) {
  const labels = [];
  let lower = 0;
  for (const edge of edges) {
    labels.push(`${lower}-${edge}`);
    lower = edge;
  }
  labels.push(`${edges[edges.length - 1]}+`);
  return labels;
}

function bucketIndex(absMoveBps, edges) {
  for (let i = 0; i < edges.length; i += 1) {
    if (absMoveBps < edges[i]) return i;
  }
  return edges.length;
}

function modeLabel(mode) {
  return mode === "empirical" ? "Raw Backtest" : "Phase 1";
}

function platformModeLabel(status) {
  if (status === "live") return "Live";
  if (status === "poll") return "Polling";
  if (status === "error") return "Error";
  return "Waiting";
}

function upsertHistoryPoint(pairName, ts, mid, spreadBps) {
  const target = state.market[pairName];
  target.mid = mid;
  target.spreadBps = spreadBps;
  target.lastUpdateTs = ts;
  const history = target.history;
  const last = history[history.length - 1];
  if (last && Math.abs(last.ts - ts) < 250) {
    last.mid = mid;
    last.spreadBps = spreadBps;
  } else {
    history.push({ ts, mid, spreadBps });
  }
  const cutoff = ts - 15 * 60 * 1000;
  while (history.length && history[0].ts < cutoff) {
    history.shift();
  }
}

function pointAtOrBefore(history, targetTs) {
  let best = null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].ts <= targetTs) {
      best = history[i];
      break;
    }
  }
  return best;
}

function upsertQuoteSnapshot(history, snapshot) {
  const last = history[history.length - 1];
  if (
    last &&
    last.active === snapshot.active &&
    last.higherPayout === snapshot.higherPayout &&
    last.lowerPayout === snapshot.lowerPayout &&
    last.mode === snapshot.mode &&
    last.edge === snapshot.edge &&
    last.bucket === snapshot.bucket &&
    last.dangerousSide === snapshot.dangerousSide
  ) {
    return;
  }
  history.push(snapshot);
  if (history.length > 20000) {
    history.splice(0, history.length - 20000);
  }
}

function quoteSnapshotForTrade(pairName, createdAtMs) {
  const history = ourQuoteHistory[pairName];
  if (!history?.length || !Number.isFinite(createdAtMs)) return null;
  let lo = 0;
  let hi = history.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const item = history[mid];
    if (item.tsMs <= createdAtMs) {
      best = item;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function normalizeConfigPayload(payload) {
  const raw = parseMaybeJson(payload);
  const top = raw?.errno && raw?.data ? raw.data : raw;
  if (Array.isArray(top?.data)) {
    return { pairs: top.data, oracle: top.oracle_cfg ?? null };
  }
  if (Array.isArray(top?.pair_configs)) {
    return { pairs: top.pair_configs, oracle: top.global_configs ?? null };
  }
  if (Array.isArray(top?.pairs)) {
    return { pairs: top.pairs, oracle: top.oracle_cfg ?? null };
  }
  return { pairs: [], oracle: null };
}

function applyPlatformConfig(config, source) {
  const quotePairs = {};
  for (const pair of config.pairs || []) {
    const pairName = String(pair.pair_name || pair.pairName || "");
    const orderConfigs = pair.order_configs || pair.orderConfigs || [];
    const match = orderConfigs.find((item) => Number(item.duration || item.order_duration) === PRODUCT_DURATION);
    if (!pairName || !match) continue;
    quotePairs[pairName] = {
      pairId: String(pair.pair_id || pair.pairId || ""),
      higherPayout: Number(match.bid_return_rate) * 100,
      lowerPayout: Number(match.ask_return_rate) * 100,
      refreshIntervalSec: Number(config.oracle?.refresh_interval || 2),
      minPayout: PAYOUT_FLOOR,
      maxPayout: PAYOUT_CAP,
      raw: match,
    };
  }
  state.platform.pairs = quotePairs;
  state.platform.lastUpdateTs = Date.now();
  state.platform.status = source === "socket" ? "live" : "poll";
  state.platform.note = source === "socket"
    ? "Realtime config socket is updating the 3m quote."
    : "REST config fallback is active.";
}

async function fetchPlatformConfig() {
  try {
    const response = await fetch(PLATFORM_CONFIG_URL, { cache: "no-store" });
    const payload = normalizeConfigPayload(await response.json());
    applyPlatformConfig(payload, "poll");
  } catch (error) {
    state.platform.status = "error";
    state.platform.note = `Public config fetch failed: ${error.message}`;
  } finally {
    render();
  }
}

function connectPlatformSocket() {
  if (platformSocket) platformSocket.close();
  state.platform.socketStatus = "connecting";
  platformSocket = new WebSocket(PLATFORM_WS_URL);

  platformSocket.addEventListener("open", () => {
    state.platform.socketStatus = "open";
    platformSocket.send(JSON.stringify({ action: "subscribe", args: ["dex_predict_config"] }));
    platformSocket.send(JSON.stringify({ action: "subscribe", args: ["dex_predict_market"] }));
    state.monitor.status = "Connecting";
    state.monitor.note = "Subscribed to the public 3m trade stream.";
    render();
  });

  platformSocket.addEventListener("message", (event) => {
    const msg = parseMaybeJson(event.data);
    if (msg?.group === "dex_predict_config") {
      applyPlatformConfig(normalizeConfigPayload(msg.data), "socket");
      render();
      return;
    }
    if (processTradeMessage(msg)) {
      render();
    }
  });

  platformSocket.addEventListener("close", () => {
    state.platform.socketStatus = "closed";
    state.monitor.status = "Reconnecting";
    state.monitor.note = "Public trade socket closed. Reconnecting in 3 seconds.";
    render();
    window.setTimeout(connectPlatformSocket, 3000);
  });

  platformSocket.addEventListener("error", () => {
    state.platform.socketStatus = "error";
    state.monitor.status = "Error";
    state.monitor.note = "Public trade socket errored.";
    render();
  });
}

async function seedPairHistory(pair) {
  const url = new URL(BINANCE_KLINES_URL);
  url.searchParams.set("symbol", pair.symbol);
  url.searchParams.set("interval", "1m");
  url.searchParams.set("limit", "12");
  const response = await fetch(url, { cache: "no-store" });
  const rows = await response.json();
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    const closeTime = Number(row[6]);
    const close = Number(row[4]);
    if (!Number.isFinite(closeTime) || !Number.isFinite(close)) continue;
    upsertHistoryPoint(pair.pairName, closeTime, close, 0);
  }
}

async function seedAllHistory() {
  state.binance.status = "Seeding";
  state.binance.note = "Pulling recent 1m closes so the 3m signal can start immediately.";
  render();
  try {
    await Promise.all(PAIRS.map((pair) => seedPairHistory(pair)));
    state.binance.status = "Seeded";
    state.binance.note = "Recent closes loaded. Waiting for live bookTicker updates.";
    recordOurQuoteSnapshots();
  } catch (error) {
    state.binance.status = "Error";
    state.binance.note = `Seed failed: ${error.message}`;
  }
  render();
}

function connectBinanceSocket() {
  if (binanceSocket) binanceSocket.close();
  binanceSocket = new WebSocket(BINANCE_WS_URL);

  binanceSocket.addEventListener("open", () => {
    state.binance.status = "Live";
    state.binance.note = "Receiving Binance Futures bookTicker for BTC and ETH.";
    render();
  });

  binanceSocket.addEventListener("message", (event) => {
    const payload = parseMaybeJson(event.data);
    const data = payload?.data;
    const symbol = String(data?.s || "");
    const bid = Number(data?.b);
    const ask = Number(data?.a);
    const ts = Number(data?.E || Date.now());
    const pair = PAIRS.find((item) => item.symbol === symbol);
    if (!pair || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return;
    const mid = (bid + ask) / 2;
    const spreadBps = ((ask - bid) / mid) * 10000;
    upsertHistoryPoint(pair.pairName, ts, mid, spreadBps);
    state.binance.lastUpdateTs = ts;
    recordOurQuoteSnapshots();
    render();
  });

  binanceSocket.addEventListener("close", () => {
    state.binance.status = "Reconnecting";
    state.binance.note = "Binance socket closed. Reconnecting in 3 seconds.";
    render();
    window.setTimeout(connectBinanceSocket, 3000);
  });

  binanceSocket.addEventListener("error", () => {
    state.binance.status = "Error";
    state.binance.note = "Binance socket errored. Reconnecting.";
    render();
  });
}

function signalForPair(pair) {
  if (state.hosted.enabled && state.quotes[pair.pairName]?.signal) {
    return state.quotes[pair.pairName].signal;
  }
  const market = state.market[pair.pairName];
  if (!market.mid || !market.history.length) {
    return { ready: false, reason: "Waiting for live price history." };
  }

  const nowTs = market.lastUpdateTs || Date.now();
  const lookbackTs = nowTs - pair.lookbackMin * 60 * 1000;
  const anchor = pointAtOrBefore(market.history, lookbackTs);
  if (!anchor || !Number.isFinite(anchor.mid) || anchor.mid <= 0) {
    return { ready: false, reason: "Not enough history to compute the full 3m move." };
  }

  const moveBps = Math.log(market.mid / anchor.mid) * 10000;
  const absMoveBps = Math.abs(moveBps);
  const index = bucketIndex(absMoveBps, pair.bucketEdges);
  const labels = bucketLabels(pair.bucketEdges);
  const bucket = labels[index];
  const dangerousSide = moveBps > 0 ? "Lower" : moveBps < 0 ? "Higher" : "None";
  const favoredSide = dangerousSide === "Lower" ? "Higher" : dangerousSide === "Higher" ? "Lower" : "Neutral";
  const probs = state.controls.mode === "empirical" ? pair.empiricalDangerProb : pair.phase1DangerProb;
  const dangerousProb = probs[index];
  const dangerousWinPct = pair.meanReversionWinPct[index];
  const dangerSharePct = pair.meanReversionSharePct[index];

  return {
    ready: true,
    moveBps,
    absMoveBps,
    bucket,
    bucketIndex: index,
    dangerousSide,
    favoredSide,
    dangerousProb,
    dangerousWinPct,
    dangerSharePct,
    anchorMid: anchor.mid,
    currentMid: market.mid,
    spreadBps: market.spreadBps,
    anchorTs: anchor.ts,
    lookbackMin: pair.lookbackMin,
  };
}

function quoteForPair(pair) {
  if (state.hosted.enabled && state.quotes[pair.pairName]) {
    return state.quotes[pair.pairName];
  }
  const signal = signalForPair(pair);
  if (!signal.ready || signal.dangerousSide === "None") {
    const neutralPayout = clamp(payoutForProbability(0.5, state.controls.edge), PAYOUT_FLOOR, PAYOUT_CAP);
    return {
      signal,
      ready: false,
      higherPayout: neutralPayout,
      lowerPayout: neutralPayout,
      favoredSide: "Neutral",
      dangerousSide: "None",
      higherProb: 0.5,
      lowerProb: 0.5,
      dangerPayout: neutralPayout,
      safePayout: neutralPayout,
      note: signal.reason || "Neutral fallback.",
    };
  }

  const dangerousProb = clamp(signal.dangerousProb, 0.5001, 0.70);
  const safeProb = 1 - dangerousProb;
  const dangerPayout = clamp(payoutForProbability(dangerousProb, state.controls.edge), PAYOUT_FLOOR, PAYOUT_CAP);
  const safePayout = clamp(payoutForProbability(safeProb, state.controls.edge), PAYOUT_FLOOR, PAYOUT_CAP);

  let higherPayout = safePayout;
  let lowerPayout = safePayout;
  let higherProb = safeProb;
  let lowerProb = safeProb;

  if (signal.dangerousSide === "Higher") {
    higherPayout = dangerPayout;
    lowerPayout = safePayout;
    higherProb = dangerousProb;
    lowerProb = safeProb;
  } else if (signal.dangerousSide === "Lower") {
    higherPayout = safePayout;
    lowerPayout = dangerPayout;
    higherProb = safeProb;
    lowerProb = dangerousProb;
  }

  return {
    signal,
    ready: true,
    favoredSide: signal.favoredSide,
    dangerousSide: signal.dangerousSide,
    higherPayout,
    lowerPayout,
    higherProb,
    lowerProb,
    dangerPayout,
    safePayout,
    note: `${pair.pairName} ${signal.bucket} bucket, ${modeLabel(state.controls.mode)} schedule.`,
  };
}

function recordOurQuoteSnapshots() {
  for (const pair of PAIRS) {
    const quote = quoteForPair(pair);
    const tsMs = state.market[pair.pairName]?.lastUpdateTs || Date.now();
    upsertQuoteSnapshot(ourQuoteHistory[pair.pairName], {
      tsMs,
      active: Boolean(quote.ready),
      higherPayout: Number.isFinite(quote.higherPayout) ? Number(quote.higherPayout.toFixed(4)) : null,
      lowerPayout: Number.isFinite(quote.lowerPayout) ? Number(quote.lowerPayout.toFixed(4)) : null,
      bucket: quote.signal?.bucket || null,
      dangerousSide: quote.dangerousSide,
      mode: state.controls.mode,
      edge: Number(state.controls.edge.toFixed(4)),
    });
  }
}

function pairNameForTrade(trade) {
  const pairName = String(trade?.pair_name || trade?.pairName || "").toUpperCase();
  if (pairName === "BTC/USDT" || pairName === "ETH/USDT") return pairName;
  const pairId = String(trade?.pair_id ?? trade?.pairId ?? "");
  for (const pair of PAIRS) {
    if (String(state.platform.pairs[pair.pairName]?.pairId || "") === pairId) {
      return pair.pairName;
    }
  }
  return null;
}

function tradeSideLabel(side) {
  if (Number(side) === 1) return "Higher";
  if (Number(side) === 2) return "Lower";
  return "Unknown";
}

function computeUserWonFromTrade(trade) {
  const side = Number(trade?.side);
  const entry = Number(trade?.entry_price);
  const settled = Number(trade?.settled_price);
  if (!Number.isFinite(entry) || !Number.isFinite(settled)) return null;
  if (side === 1) return settled > entry;
  if (side === 2) return settled < entry;
  return null;
}

function processTradeMessage(message) {
  if (!message || message.group !== "dex_predict_market") return false;
  const trade = parseMaybeJson(message.data);
  if (!trade || Number(trade.duration) !== PRODUCT_DURATION) return false;

  const pairName = pairNameForTrade(trade);
  if (!pairName) return false;

  state.monitor.status = "Live";
  state.monitor.note = "Routing public 3m trades against our time-stamped quote snapshots.";
  state.monitor.lastTradeTs = Date.now();

  const tradeId = String(trade.id ?? "");
  if (!tradeId) return false;

  if (!seenTradeIds.has(tradeId)) {
    seenTradeIds.add(tradeId);
    state.monitor.seenTrades += 1;
  }

  const createdAtMs = Date.parse(trade.created_at || trade.createdAt || "");
  const quote = quoteSnapshotForTrade(pairName, createdAtMs);
  const side = tradeSideLabel(trade.side);
  const actualPayoutRaw = Number(trade.return_rate) * 100;
  const actualPayout = Number.isFinite(actualPayoutRaw)
    ? actualPayoutRaw
    : side === "Higher"
      ? state.platform.pairs[pairName]?.higherPayout
      : side === "Lower"
        ? state.platform.pairs[pairName]?.lowerPayout
        : null;
  const ourPayout = side === "Higher"
    ? quote?.higherPayout
    : side === "Lower"
      ? quote?.lowerPayout
      : null;
  const amount = Number(trade.usdt_value ?? trade.amount ?? 0);
  const statusText = String(trade.order_status || trade.orderStatus || "");

  if (
    !routedById.has(tradeId) &&
    quote?.active &&
    Number.isFinite(actualPayout) &&
    Number.isFinite(ourPayout) &&
    Number.isFinite(amount) &&
    amount > 0 &&
    ourPayout > actualPayout
  ) {
    routedById.set(tradeId, {
      id: tradeId,
      pairName,
      side,
      amount,
      actualPayout,
      ourPayout,
      payoutDelta: ourPayout - actualPayout,
      createdAtMs,
      createdAtText: trade.created_at || trade.createdAt || null,
      settled: false,
      outcome: "Open",
      pnl: null,
    });
    state.monitor.competedTrades += 1;
    state.monitor.competedVolume += Number.isFinite(amount) ? amount : 0;
    state.monitor.pairs[pairName].competedTrades += 1;
    state.monitor.pairs[pairName].competedVolume += Number.isFinite(amount) ? amount : 0;
  }

  const routed = routedById.get(tradeId);
  if (routed && !routed.settled && statusText === "Finished") {
    const userWon = computeUserWonFromTrade(trade);
    if (userWon === true) {
      const pnl = -(routed.amount * routed.ourPayout / 100);
      routed.pnl = pnl;
      routed.outcome = "User Won";
      state.monitor.ourPnl += pnl;
      state.monitor.losses += 1;
      state.monitor.pairs[pairName].ourPnl += pnl;
      state.monitor.pairs[pairName].losses += 1;
    } else if (userWon === false) {
      const pnl = routed.amount;
      routed.pnl = pnl;
      routed.outcome = "User Lost";
      state.monitor.ourPnl += pnl;
      state.monitor.wins += 1;
      state.monitor.pairs[pairName].ourPnl += pnl;
      state.monitor.pairs[pairName].wins += 1;
    } else {
      routed.outcome = "Finished";
    }
    routed.settled = true;
    routed.settledAtText = trade.updated_at || trade.updatedAt || null;
    state.monitor.settledTrades += 1;
    state.monitor.pairs[pairName].settledTrades += 1;
  }

  state.monitor.openRoutedTrades = [...routedById.values()].filter((entry) => !entry.settled).length;
  return true;
}

function pillClass(status) {
  if (status === "Live") return "pill live";
  if (status === "Error") return "pill bad";
  return "pill wait";
}

function badgeClassForQuote(quote, platform) {
  if (!quote.ready) return "badge warn";
  if (!platform) return "badge good";
  const ourEdge = impliedEdgeFromTwoWayQuote(quote.higherPayout, quote.lowerPayout);
  const platformEdge = impliedEdgeFromTwoWayQuote(platform.higherPayout, platform.lowerPayout);
  if (ourEdge != null && platformEdge != null && ourEdge > platformEdge + 0.2) return "badge good";
  if (ourEdge != null && platformEdge != null && ourEdge < platformEdge - 0.2) return "badge bad";
  return "badge warn";
}

function renderPairCard(pair) {
  const quote = quoteForPair(pair);
  const signal = quote.signal;
  const platform = state.platform.pairs[pair.pairName] || null;
  const platformEdge = platform ? impliedEdgeFromTwoWayQuote(platform.higherPayout, platform.lowerPayout) : null;
  const ourEdge = impliedEdgeFromTwoWayQuote(quote.higherPayout, quote.lowerPayout);
  const higherDelta = platform ? quote.higherPayout - platform.higherPayout : null;
  const lowerDelta = platform ? quote.lowerPayout - platform.lowerPayout : null;
  const favoredLabel = quote.favoredSide === "Neutral" ? "Neutral" : `${quote.favoredSide} favored`;

  return `
    <article class="pair-card">
      <div class="pair-head">
        <div>
          <h2>${pair.pairName} 3m</h2>
          <div class="subtle">${pair.note}</div>
        </div>
        <div class="${badgeClassForQuote(quote, platform)}">${favoredLabel}</div>
      </div>

      <div class="mini-grid">
        <div class="metric">
          <span>Live Move</span>
          <strong>${signal.ready ? formatSigned(signal.moveBps, 2, " bps") : "-"}</strong>
          <small>${signal.ready ? `Last ${pair.lookbackMin}m move from ${formatNum(signal.anchorMid, 2)} to ${formatNum(signal.currentMid, 2)}.` : signal.reason}</small>
        </div>
        <div class="metric">
          <span>Bucket</span>
          <strong>${signal.ready ? signal.bucket : "-"}</strong>
          <small>${signal.ready ? `${formatPct(signal.dangerSharePct, 2)} of historical trades in this bucket were mean-reversion.` : "Waiting for signal."}</small>
        </div>
        <div class="metric">
          <span>Dangerous Side</span>
          <strong>${quote.dangerousSide}</strong>
          <small>${signal.ready ? `${quote.dangerousSide} historically won ${formatPct(signal.dangerousWinPct, 2)} in this bucket.` : "No active side yet."}</small>
        </div>
        <div class="metric">
          <span>Binance Spread</span>
          <strong>${signal.ready ? `${formatNum(signal.spreadBps, 2)} bps` : "-"}</strong>
          <small>Live Futures bookTicker spread.</small>
        </div>
      </div>

      <div class="quote-grid">
        <div class="quote-box">
          <span>Our Higher Quote</span>
          <div class="quote-value">${formatNum(quote.higherPayout, 2)}</div>
          <div class="quote-note">Fair probability ${formatPct(quote.higherProb * 100, 2)} at edge ${formatPct(state.controls.edge, 2)}.</div>
        </div>
        <div class="quote-box">
          <span>Our Lower Quote</span>
          <div class="quote-value">${formatNum(quote.lowerPayout, 2)}</div>
          <div class="quote-note">${quote.note}</div>
        </div>
      </div>

      <div class="status-grid">
        <div class="status-box">
          <span>Our Implied Edge</span>
          <strong>${ourEdge == null ? "-" : formatPct(ourEdge, 2)}</strong>
          <small>Reverse-calculated from our two-way quote.</small>
        </div>
        <div class="status-box">
          <span>Platform Implied Edge</span>
          <strong>${platformEdge == null ? "-" : formatPct(platformEdge, 2)}</strong>
          <small>${platform ? "Latest public 3m quote." : "Waiting for platform config."}</small>
        </div>
        <div class="status-box">
          <span>Higher vs Platform</span>
          <strong>${higherDelta == null ? "-" : formatSigned(higherDelta, 2)}</strong>
          <small>Positive means our Higher payout is richer.</small>
        </div>
        <div class="status-box">
          <span>Lower vs Platform</span>
          <strong>${lowerDelta == null ? "-" : formatSigned(lowerDelta, 2)}</strong>
          <small>Positive means our Lower payout is richer.</small>
        </div>
      </div>

      <div class="quote-grid">
        <div class="quote-box">
          <span>Platform Higher</span>
          <div class="quote-value">${platform ? formatNum(platform.higherPayout, 2) : "-"}</div>
          <div class="quote-note">${platform ? "Current public bid_return_rate for the 180s product." : "Waiting for public config."}</div>
        </div>
        <div class="quote-box">
          <span>Platform Lower</span>
          <div class="quote-value">${platform ? formatNum(platform.lowerPayout, 2) : "-"}</div>
          <div class="quote-note">${platform ? `Pair ${platform.pairId}, refresh ${platform.refreshIntervalSec}s.` : "Socket / polling fallback."}</div>
        </div>
      </div>
    </article>
  `;
}

function renderPairStack() {
  const pairs = state.controls.pairFilter === "all"
    ? PAIRS
    : PAIRS.filter((pair) => pair.pairName === state.controls.pairFilter);
  $("pair-stack").innerHTML = pairs.map(renderPairCard).join("");
}

function renderBucketBoard() {
  const tables = PAIRS
    .filter((pair) => state.controls.pairFilter === "all" || pair.pairName === state.controls.pairFilter)
    .map((pair) => {
      const labels = bucketLabels(pair.bucketEdges);
      const probs = state.controls.mode === "empirical" ? pair.empiricalDangerProb : pair.phase1DangerProb;
      const rows = labels.map((label, index) => {
        const dangerProb = probs[index];
        const safeProb = 1 - dangerProb;
        const dangerPayout = clamp(payoutForProbability(dangerProb, state.controls.edge), PAYOUT_FLOOR, PAYOUT_CAP);
        const safePayout = clamp(payoutForProbability(safeProb, state.controls.edge), PAYOUT_FLOOR, PAYOUT_CAP);
        return `
          <tr>
            <td><strong>${label}</strong></td>
            <td>${formatPct(pair.meanReversionSharePct[index], 2)}</td>
            <td>${formatPct(pair.meanReversionWinPct[index], 2)}</td>
            <td>${formatPct(dangerProb * 100, 2)}</td>
            <td>${formatNum(dangerPayout, 2)}</td>
            <td>${formatNum(safePayout, 2)}</td>
          </tr>
        `;
      }).join("");

      return `
        <div style="margin-bottom:18px;">
          <div class="pill ${state.controls.mode === "empirical" ? "wait" : "live"}" style="margin-bottom:10px;">${pair.pairName} ${modeLabel(state.controls.mode)}</div>
          <table>
            <thead>
              <tr>
                <th>Bucket</th>
                <th>MR Share</th>
                <th>MR Win</th>
                <th>Danger Prob</th>
                <th>Danger Payout</th>
                <th>Safe Payout</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    });
  $("bucket-board").innerHTML = tables.join("");
}

function renderPlatformBoard() {
  const rows = PAIRS
    .filter((pair) => state.controls.pairFilter === "all" || pair.pairName === state.controls.pairFilter)
    .map((pair) => {
      const platform = state.platform.pairs[pair.pairName];
      const edge = platform ? impliedEdgeFromTwoWayQuote(platform.higherPayout, platform.lowerPayout) : null;
      return `
        <tr>
          <td><strong>${pair.pairName}</strong></td>
          <td>${platform ? formatNum(platform.higherPayout, 2) : "-"}</td>
          <td>${platform ? formatNum(platform.lowerPayout, 2) : "-"}</td>
          <td>${edge == null ? "-" : formatPct(edge, 2)}</td>
          <td>${platform ? `${platform.pairId}` : "-"}</td>
        </tr>
      `;
    }).join("");
  $("platform-board").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Pair</th>
          <th>Higher</th>
          <th>Lower</th>
          <th>Implied Edge</th>
          <th>Pair ID</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderMonitorSummary() {
  const pairRows = PAIRS
    .filter((pair) => state.controls.pairFilter === "all" || pair.pairName === state.controls.pairFilter)
    .map((pair) => {
      const stats = state.monitor.pairs[pair.pairName];
      return `
        <tr>
          <td><strong>${pair.pairName}</strong></td>
          <td>${stats.competedTrades}</td>
          <td>${stats.settledTrades}</td>
          <td>${formatNum(stats.competedVolume, 2)}</td>
          <td>${formatMoney(stats.ourPnl)}</td>
          <td>${stats.wins}</td>
          <td>${stats.losses}</td>
        </tr>
      `;
    }).join("");

  $("monitor-summary").innerHTML = `
    <div class="metric-grid">
      <div class="metric">
        <span>Monitor Status</span>
        <strong>${state.monitor.status}</strong>
        <small>Started ${formatDateTime(state.monitor.startedAtTs)}.</small>
      </div>
      <div class="metric">
        <span>Seen Trades</span>
        <strong>${state.monitor.seenTrades}</strong>
        <small>All public 3m trades observed since start.</small>
      </div>
      <div class="metric">
        <span>Competed Trades</span>
        <strong>${state.monitor.competedTrades}</strong>
        <small>Trades where our payout beat the traded platform payout.</small>
      </div>
      <div class="metric">
        <span>Settled Trades</span>
        <strong>${state.monitor.settledTrades}</strong>
        <small>Only these contribute to realized PnL.</small>
      </div>
      <div class="metric">
        <span>Competed Volume</span>
        <strong>${formatNum(state.monitor.competedVolume, 2)}</strong>
        <small>USDT notional routed to us counterfactually.</small>
      </div>
      <div class="metric">
        <span>Our PnL</span>
        <strong>${formatMoney(state.monitor.ourPnl)}</strong>
        <small>Wins add stake, user wins cost stake times payout over 100.</small>
      </div>
      <div class="metric">
        <span>Wins / Losses</span>
        <strong>${state.monitor.wins} / ${state.monitor.losses}</strong>
        <small>From our point of view after settlement.</small>
      </div>
      <div class="metric">
        <span>Open Routed</span>
        <strong>${state.monitor.openRoutedTrades}</strong>
        <small>Routed trades still waiting to finish.</small>
      </div>
    </div>

    <table style="margin-top:14px;">
      <thead>
        <tr>
          <th>Pair</th>
          <th>Competed</th>
          <th>Settled</th>
          <th>Volume</th>
          <th>Our PnL</th>
          <th>Wins</th>
          <th>Losses</th>
        </tr>
      </thead>
      <tbody>${pairRows}</tbody>
    </table>
  `;

  $("monitor-note").textContent = state.monitor.note;
}

function renderMonitorSplits() {
  const cards = PAIRS
    .filter((pair) => state.controls.pairFilter === "all" || pair.pairName === state.controls.pairFilter)
    .map((pair) => {
      const stats = state.monitor.pairs[pair.pairName];
      const settled = Math.max(stats.settledTrades, 1);
      const avgPnlPerSettled = stats.settledTrades > 0 ? stats.ourPnl / settled : null;
      const avgVolumePerCompeted = stats.competedTrades > 0 ? stats.competedVolume / stats.competedTrades : null;
      return `
        <div class="split-card">
          <span>${pair.pairName} Split</span>
          <strong>${formatMoney(stats.ourPnl)}</strong>
          <small>Competed ${stats.competedTrades} trades, settled ${stats.settledTrades}, volume ${formatNum(stats.competedVolume, 2)}.</small>
          <small>Wins ${stats.wins}, losses ${stats.losses}, avg settled PnL ${avgPnlPerSettled == null ? "-" : formatMoney(avgPnlPerSettled)}.</small>
          <small>Avg competed trade size ${avgVolumePerCompeted == null ? "-" : formatNum(avgVolumePerCompeted, 2)} USDT.</small>
        </div>
      `;
    }).join("");

  $("monitor-splits").innerHTML = cards
    ? `
      <div class="split-grid">
        ${cards}
      </div>
    `
    : "";
}

function renderMonitorTrades() {
  const rows = [...routedById.values()]
    .filter((trade) => state.controls.pairFilter === "all" || trade.pairName === state.controls.pairFilter)
    .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0))
    .slice(0, 18)
    .map((trade) => `
      <tr>
        <td><strong>${formatDateTime(trade.createdAtText || trade.createdAtMs)}</strong></td>
        <td>${trade.pairName}</td>
        <td>${trade.side}</td>
        <td>${formatNum(trade.amount, 2)}</td>
        <td>${formatNum(trade.actualPayout, 2)}</td>
        <td>${formatNum(trade.ourPayout, 2)}</td>
        <td>${formatSigned(trade.payoutDelta, 2)}</td>
        <td>${trade.outcome}</td>
        <td>${trade.pnl == null ? "-" : formatMoney(trade.pnl)}</td>
      </tr>
    `).join("");

  $("monitor-trades").innerHTML = rows
    ? `
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Pair</th>
            <th>Side</th>
            <th>Amount</th>
            <th>Platform</th>
            <th>Ours</th>
            <th>Delta</th>
            <th>Status</th>
            <th>PnL</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `
    : `<div class="subtle">No routed trades yet. Once our quote beats the traded platform payout on BTC or ETH 3m, they will appear here.</div>`;
}

function renderFormula() {
  const neutral = clamp(payoutForProbability(0.5, state.controls.edge), PAYOUT_FLOOR, PAYOUT_CAP);
  $("formula-text").textContent =
`dangerous_side = sign(last_3m_move_bps)
bucket = abs(last_3m_move_bps)
danger_prob = schedule[pair][${state.controls.mode}]

danger_payout = clamp((100 * (1 - edge / 100)) / danger_prob - 100, ${PAYOUT_FLOOR}, ${PAYOUT_CAP})
safe_payout   = clamp((100 * (1 - edge / 100)) / (1 - danger_prob) - 100, ${PAYOUT_FLOOR}, ${PAYOUT_CAP})

neutral(edge = ${formatNum(state.controls.edge, 2)}%) -> ${formatNum(neutral, 2)} / ${formatNum(neutral, 2)}`;
}

function renderHero() {
  $("hero-edge").textContent = formatPct(state.controls.edge, 2);
  const neutral = clamp(payoutForProbability(0.5, state.controls.edge), PAYOUT_FLOOR, PAYOUT_CAP);
  $("hero-neutral").textContent = `${formatNum(neutral, 2)} / ${formatNum(neutral, 2)}`;
  $("hero-mode").textContent = modeLabel(state.controls.mode);
  $("hero-platform").textContent = platformModeLabel(state.platform.status);
}

function renderStatus() {
  $("binance-status").textContent = state.binance.status;
  $("binance-note").textContent = state.binance.note;
  $("platform-status").textContent = platformModeLabel(state.platform.status);
  $("platform-note").textContent = state.platform.note;
}

function render() {
  renderHero();
  renderStatus();
  renderFormula();
  renderPairStack();
  renderBucketBoard();
  renderPlatformBoard();
  renderMonitorSummary();
  renderMonitorSplits();
  renderMonitorTrades();
}

function resetControls() {
  if (state.hosted.enabled) {
    state.controls.pairFilter = DEFAULT_PAIR_FILTER;
    saveControls();
    syncControlInputs();
    postJson(HOSTED_SETTINGS_RESET_URL)
      .then((result) => {
        if (result?.ok) {
          state.controls.edge = Number(result.edge ?? DEFAULT_EDGE);
          state.controls.mode = result.mode === "empirical" ? "empirical" : DEFAULT_MODE;
          syncControlInputs();
          render();
        }
      })
      .catch(() => {});
    render();
    return;
  }
  state.controls.edge = DEFAULT_EDGE;
  state.controls.mode = DEFAULT_MODE;
  state.controls.pairFilter = DEFAULT_PAIR_FILTER;
  saveControls();
  syncControlInputs();
  recordOurQuoteSnapshots();
  render();
}

function bindEvents() {
  $("edge-input").addEventListener(state.hosted.enabled ? "change" : "input", () => {
    const value = Number($("edge-input").value);
    if (!Number.isFinite(value)) return;
    state.controls.edge = clamp(value, 0, 20);
    saveControls();
    if (state.hosted.enabled) {
      postJson(HOSTED_SETTINGS_URL, { edge: state.controls.edge, mode: state.controls.mode }).catch(() => {});
      render();
      return;
    }
    recordOurQuoteSnapshots();
    render();
  });

  $("pair-filter").addEventListener("change", () => {
    state.controls.pairFilter = $("pair-filter").value;
    saveControls();
    render();
  });

  document.querySelectorAll(".mode-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.controls.mode = button.dataset.mode === "empirical" ? "empirical" : "phase1";
      saveControls();
      syncControlInputs();
      if (state.hosted.enabled) {
        postJson(HOSTED_SETTINGS_URL, { edge: state.controls.edge, mode: state.controls.mode }).catch(() => {});
        render();
        return;
      }
      recordOurQuoteSnapshots();
      render();
    });
  });

  $("refresh-btn").addEventListener("click", async () => {
    if (state.hosted.enabled) {
      try {
        const response = await fetch(HOSTED_STATE_URL, { cache: "no-store" });
        attachHostedState(await response.json());
      } catch (error) {
        state.platform.status = "error";
        state.platform.note = `Refresh failed: ${error.message}`;
      }
      render();
      return;
    }
    await Promise.all([fetchPlatformConfig(), seedAllHistory()]);
    render();
  });

  $("reset-btn").addEventListener("click", () => {
    resetControls();
  });

  $("monitor-reset-btn").addEventListener("click", () => {
    if (state.hosted.enabled) {
      postJson(HOSTED_MONITOR_RESET_URL)
        .then(() => {})
        .catch(() => {});
      return;
    }
    resetMonitorState();
    recordOurQuoteSnapshots();
    render();
  });
}

async function initHostedMode() {
  state.hosted.enabled = true;
  loadControls();
  bindEvents();
  render();

  const response = await fetch(HOSTED_STATE_URL, { cache: "no-store" });
  attachHostedState(await response.json());
  render();

  hostedEventSource = new EventSource(HOSTED_EVENTS_URL);
  hostedEventSource.onmessage = (event) => {
    attachHostedState(JSON.parse(event.data));
    render();
  };
  hostedEventSource.onerror = () => {
    state.monitor.status = "Reconnecting";
    state.monitor.note = "Lost connection to hosted 3m stream. Waiting to reconnect.";
    render();
  };
}

async function init() {
  if (isHostedThreeMinRoute()) {
    await initHostedMode();
    return;
  }
  loadControls();
  resetMonitorState();
  syncControlInputs();
  bindEvents();
  render();

  await Promise.all([seedAllHistory(), fetchPlatformConfig()]);
  connectPlatformSocket();
  connectBinanceSocket();
  platformPollHandle = window.setInterval(fetchPlatformConfig, 5000);
  render();
}

init().catch((error) => {
  console.error(error);
  state.platform.status = "error";
  state.platform.note = `Initialization failed: ${error.message}`;
  render();
});
