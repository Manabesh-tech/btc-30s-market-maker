"use strict";

const params = new URLSearchParams(window.location.search);
const CONFIG_MODE = params.get("config") || "final";
const DEFAULT_FAMILY = params.get("family") || "chainlink";
const DEFAULT_MODEL = params.get("model") || "model1";
const DEFAULT_BLEND_MODEL = params.get("blend_model") || "none";
const DEFAULT_BLEND_PCT = Number(params.get("blend") || 0);
const DEFAULT_VIEW = params.get("view") || "live";
const ALPHA_PROXY_URL = "./pool_alpha_proxy_last8h.json";
const PLATFORM_CONFIG_URL = "https://apis.turboflow.xyz/public/pm/config?version=2";
const TURBO_CONFIG_URL = "./turbo_product_suite_final_models.json";
const TURBO_LEGACY_SHORT_EDGE_HINT = 4.0;
const CL_POLL_MS = 1000;
const MARKET_POLL_MS = 1000;
const SNAPSHOT_MS = 1000;
const RENDER_MS = 1000;
const HISTORY_LIMIT = 9000;

const FEEDS = {
  "BTC/USDT": "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8",
  "ETH/USDT": "0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9",
};

const PAIR_META = {
  "BTC/USDT": {
    symbol: "BTCUSDT",
    spotStream: "btcusdt@aggTrade",
    perpMarkStream: "btcusdt@markPrice@1s",
    platformPairId: "6",
  },
  "ETH/USDT": {
    symbol: "ETHUSDT",
    spotStream: "ethusdt@aggTrade",
    perpMarkStream: "ethusdt@markPrice@1s",
    platformPairId: "5",
  },
};

const state = {
  configSets: {
    model1: {},
    model2: {},
    model3: {},
    turbo: {},
  },
  familyMode: DEFAULT_FAMILY,
  viewMode: DEFAULT_VIEW,
  modelMode: DEFAULT_MODEL,
  blendModelMode: DEFAULT_BLEND_MODEL,
  model2BlendPct: Number.isFinite(DEFAULT_BLEND_PCT) ? clamp(DEFAULT_BLEND_PCT, 0, 100) : 0,
  selectedPair: "BTC/USDT",
  selectedProduct: "30s",
  edgePct: 4.0,
  alphaOverride: null,
  lastReloadedAt: null,
  platformQuotes: {},
  alphaProxyRows: [],
  alphaProxyMeta: null,
  turboLegacyShort: {},
  market: {
    "BTC/USDT": { chainlink: null, turbo: null, spot: null, perp: null, lastUpdateTs: null, history: [] },
    "ETH/USDT": { chainlink: null, turbo: null, spot: null, perp: null, lastUpdateTs: null, history: [] },
  },
  bucketMemory: {},
};

let snapshotTimer = null;
let chainlinkTimer = null;
let turboTimer = null;
let turboLegacyTimer = null;
let marketTimer = null;
let renderTimer = null;

function $(id) {
  return document.getElementById(id);
}

function formatNum(value, decimals = 2) {
  if (!Number.isFinite(Number(value))) return "-";
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatPct(value, decimals = 2) {
  if (!Number.isFinite(Number(value))) return "-";
  return `${Number(value).toFixed(decimals)}%`;
}

function formatSigned(value, decimals = 2, suffix = "") {
  if (!Number.isFinite(Number(value))) return "-";
  const num = Number(value);
  return `${num >= 0 ? "+" : ""}${num.toFixed(decimals)}${suffix}`;
}

function formatDateTime(ts) {
  if (!Number.isFinite(Number(ts))) return "-";
  return new Date(Number(ts)).toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function payoutForProbability(probability, edgePct) {
  const gross = 1 - edgePct / 100;
  return 100 * gross / probability - 100;
}

function probabilityForPayout(payout, edgePct) {
  const gross = 1 - edgePct / 100;
  return (100 * gross) / (100 + payout);
}

function maxDefendableProbability(edgePct, floorPayout) {
  return probabilityForPayout(floorPayout, edgePct);
}

function impliedQuoteStats(higherReturnRate, lowerReturnRate) {
  const up = Number(higherReturnRate);
  const down = Number(lowerReturnRate);
  if (!Number.isFinite(up) || !Number.isFinite(down)) return null;
  const gross = 1 / (1 / (1 + up) + 1 / (1 + down));
  const pUp = gross / (1 + up);
  const pDown = gross / (1 + down);
  return {
    edgePct: (1 - gross) * 100,
    pUp,
    pDown,
    skewPp: (pUp - 0.5) * 100,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function quoteMarkup(higherPayout, lowerPayout, favoredSide) {
  const higherClass = favoredSide === "Higher"
    ? "quote-side quote-side--win"
    : favoredSide === "Lower"
      ? "quote-side quote-side--lose"
      : "quote-side";
  const lowerClass = favoredSide === "Lower"
    ? "quote-side quote-side--win"
    : favoredSide === "Higher"
      ? "quote-side quote-side--lose"
      : "quote-side";
  return [
    '<span class="quote-split">',
    `<span class="${higherClass}"><small>Higher</small><strong>${escapeHtml(formatNum(higherPayout))}</strong></span>`,
    '<span class="quote-sep">/</span>',
    `<span class="${lowerClass}"><small>Lower</small><strong>${escapeHtml(formatNum(lowerPayout))}</strong></span>`,
    "</span>",
  ].join("");
}

function signalMarkup(favoredSide) {
  if (favoredSide === "Higher") {
    return '<span class="signal-pill signal-pill--higher">Higher</span>';
  }
  if (favoredSide === "Lower") {
    return '<span class="signal-pill signal-pill--lower">Lower</span>';
  }
  return `<span class="signal-pill">${escapeHtml(favoredSide || "-")}</span>`;
}

async function fetchChainlinkLatest(pairName) {
  const response = await fetch(`./api/chainlink/latest?pair=${encodeURIComponent(pairName)}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Chainlink proxy ${response.status}`);
  }
  return response.json();
}

async function fetchBinanceLatest(pairName) {
  const response = await fetch(`./api/binance/latest?pair=${encodeURIComponent(pairName)}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Binance proxy ${response.status}`);
  }
  return response.json();
}

async function fetchTurboLatest(pairName) {
  const response = await fetch(`./api/turbo/latest?pair=${encodeURIComponent(pairName)}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Turbo proxy ${response.status}`);
  }
  return response.json();
}

async function fetchTurboLegacyShort(product) {
  const response = await fetch(`./api/turbo/legacy-short?product=${encodeURIComponent(product)}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Turbo legacy short ${response.status}`);
  }
  return response.json();
}

async function fetchServerHistory(pairName) {
  const response = await fetch(`./api/market/history?pair=${encodeURIComponent(pairName)}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Market history ${response.status}`);
  }
  return response.json();
}

function pointAtOrBefore(history, targetTs) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].ts <= targetTs) return history[i];
  }
  return null;
}

function rollingStats(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return { mean: NaN, std: NaN };
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
  return { mean, std: Math.sqrt(variance) };
}

function currentConfig() {
  if (state.familyMode === "turbo") {
    return currentTurboConfig();
  }
  return currentConfigFor(state.modelMode);
}

function currentConfigFor(modelKey) {
  const configs = state.configSets[modelKey] || {};
  return configs[`${state.selectedPair}::${state.selectedProduct}`] || null;
}

function currentTurboConfig() {
  const configs = state.configSets.turbo || {};
  return configs[`${state.selectedPair}::${state.selectedProduct}`] || null;
}

function modelLabel(modelKey) {
  if (modelKey === "none") return "None";
  if (modelKey === "model2") return "Model 2";
  if (modelKey === "model3") return "Model 3";
  return "Model 1";
}

function deployedModelKeyForProduct(_config) {
  return "model1";
}

function currentConfigKeys() {
  return state.familyMode === "turbo"
    ? Object.keys(state.configSets.turbo || {})
    : Object.keys(state.configSets.model1 || {});
}

function familyLabel() {
  return state.familyMode === "turbo" ? "Turbo" : "Chainlink";
}

function currentMarket() {
  return state.market[state.selectedPair];
}

function currentStateKey() {
  return `${state.modelMode}::${state.selectedPair}::${state.selectedProduct}`;
}

function currentAlphaProxyRows() {
  return state.alphaProxyRows.filter(
    (row) => row.pair === state.selectedPair && row.product === state.selectedProduct,
  );
}

function sanitizeBlendModel(selectedModel, blendModel) {
  if (!blendModel || blendModel === "none") return "none";
  if (blendModel === selectedModel) return "none";
  if (!state.configSets[blendModel]) return "none";
  return blendModel;
}

function syncBlendControls() {
  const blendSelect = $("blend-model-select");
  const blendInput = $("blend-input");
  const blendNumber = $("blend-number");
  const blendValue = $("blend-value");
  const modelSelect = $("model-select");
  const modelControl = $("model-control");
  const blendModelControl = $("blend-model-control");
  const blendWeightControl = $("blend-weight-control");
  if (!blendSelect || !blendInput || !blendNumber || !blendValue) return;
  const chainlinkMode = state.familyMode === "chainlink";
  if (modelSelect) {
    modelSelect.disabled = !chainlinkMode;
  }
  if (modelControl) {
    modelControl.style.opacity = chainlinkMode ? "1" : "0.55";
  }
  if (blendModelControl) {
    blendModelControl.style.opacity = chainlinkMode ? "1" : "0.55";
  }
  if (blendWeightControl) {
    blendWeightControl.style.opacity = chainlinkMode ? "1" : "0.55";
  }
  if (!chainlinkMode) {
    blendSelect.disabled = true;
    blendInput.disabled = true;
    blendNumber.disabled = true;
    blendValue.textContent = "N/A";
    return;
  }
  state.blendModelMode = sanitizeBlendModel(state.modelMode, state.blendModelMode);
  blendSelect.value = state.blendModelMode;
  const active = state.blendModelMode !== "none";
  blendInput.disabled = !active;
  blendNumber.disabled = !active;
  blendInput.value = String(state.model2BlendPct);
  blendNumber.value = String(state.model2BlendPct);
  if (!active) {
    blendValue.textContent = "N/A";
  } else {
    blendValue.textContent = `${state.model2BlendPct.toFixed(0)}%`;
  }
}

function syncFamilyTabs() {
  const familyTabs = $("family-tabs");
  if (!familyTabs) return;
  for (const button of familyTabs.querySelectorAll("[data-family]")) {
    const active = button.dataset.family === state.familyMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function syncTopTabs() {
  const topTabs = $("top-tabs");
  if (!topTabs) return;
  for (const button of topTabs.querySelectorAll("[data-view]")) {
    const active = button.dataset.view === state.viewMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
  const liveView = $("live-view");
  const adminView = $("admin-view");
  if (liveView) {
    liveView.classList.toggle("hidden", state.viewMode !== "live");
  }
  if (adminView) {
    adminView.classList.toggle("active", state.viewMode !== "live");
  }
}

function parseJsonLenient(text) {
  return JSON.parse(
    text.replace(/\bNaN\b/g, "null"),
  );
}

function normalizeTurboConfigs(configs) {
  const next = { ...configs };
  const btc30 = next["BTC/USDT::30s"] || {};
  next["BTC/USDT::30s"] = {
    ...btc30,
    pair: "BTC/USDT",
    symbol: "BTCUSDT",
    product: "30s",
    duration_s: 30,
    entry_delay_s: 1,
    edge_pct: 4.0,
    favored_payout_floor: 65.0,
    alpha: 1.0,
    engine: "turbo_legacy_short",
    notes: {
      ...(btc30.notes || {}),
      family: "turbo",
      source: "legacy_btc_short_depth_model",
      production_rationale: "Restored legacy BTC turbo short-tenor model using Binance futures top-10 depth, 10s microstructure features, and the earlier 30s/1m setup.",
      selection_metric: "Legacy BTC short-tenor turbo setup with the original 30s/1m variants brought back into the unified console.",
      implementation_mode: "turbo_legacy_short",
    },
    legacy_short: {
      product: "30s",
      source: "Binance futures BTCUSDT top-10 depth",
      lookback_s: 10,
      style: "microstructure_momentum",
      metric_label: "30s",
      step_scale: 1.0,
      uplift_last7: 31617.229,
    },
  };
  const btc1m = next["BTC/USDT::1m"] || {};
  next["BTC/USDT::1m"] = {
    ...btc1m,
    pair: "BTC/USDT",
    symbol: "BTCUSDT",
    product: "1m",
    duration_s: 60,
    entry_delay_s: 1,
    edge_pct: 4.0,
    favored_payout_floor: 65.0,
    alpha: 1.0,
    engine: "turbo_legacy_short",
    notes: {
      ...(btc1m.notes || {}),
      family: "turbo",
      source: "legacy_btc_short_depth_model",
      production_rationale: "Restored legacy BTC turbo 1m variant from the earlier short-tenor setup, using the same fitted microstructure model with the softer 1m step scale.",
      selection_metric: "Legacy BTC 1m turbo variant from the prior 30s/1m console.",
      implementation_mode: "turbo_legacy_short",
    },
    legacy_short: {
      product: "1m",
      source: "Binance futures BTCUSDT top-10 depth",
      lookback_s: 10,
      style: "microstructure_momentum",
      metric_label: "1m",
      step_scale: 0.8,
      uplift_last7: 1862.911,
    },
  };
  const eth30 = next["ETH/USDT::30s"] || {};
  next["ETH/USDT::30s"] = {
    ...eth30,
    pair: "ETH/USDT",
    symbol: "ETHUSDT",
    product: "30s",
    duration_s: 30,
    entry_delay_s: 1,
    edge_pct: 4.0,
    favored_payout_floor: 65.0,
    alpha: 1.0,
    engine: "turbo_bucket",
    active_mode: "neutral",
    lookback_s: 30,
    base_payout_pct: 80.0,
    model: {
      features: ["turbo_move_bp", "turbo_abs_move_bp", "platform_skew_pp"],
    },
    notes: {
      ...(eth30.notes || {}),
      family: "turbo",
      source: "turbo_short_7d_replay",
      production_rationale: "7-day ETH turbo own-feed short-tenor replay. Uses a smoothed 30s own-feed move ladder with mild mean-reversion bias instead of leaving the product unavailable.",
      selection_metric: "Recovered from direct ETH turbo-feed replay after the earlier bundle left ETH 30s blank.",
      implementation_mode: "turbo_family_monitor",
    },
    neutral_band: 0.0,
    flip_signal: false,
    calibration: { kind: "identity", flip_signal: false },
    bucket_rules: [
      { label: "0-5", mode: "mean_reversion", min_abs_bp: 0.0, max_abs_bp: 5.0, danger_payout_pct: 65.0, safe_payout_pct: 96.0, p_up_if_move_positive: 0.495, p_up_if_move_negative: 0.495, chosen_win_rate_pct: 50.5 },
      { label: "5-10", mode: "mean_reversion", min_abs_bp: 5.0, max_abs_bp: 10.0, danger_payout_pct: 65.0, safe_payout_pct: 96.0, p_up_if_move_positive: 0.480, p_up_if_move_negative: 0.490, chosen_win_rate_pct: 52.0 },
      { label: "10-15", mode: "mean_reversion", min_abs_bp: 10.0, max_abs_bp: 15.0, danger_payout_pct: 65.0, safe_payout_pct: 96.0, p_up_if_move_positive: 0.472, p_up_if_move_negative: 0.485, chosen_win_rate_pct: 52.8 },
      { label: "15-20", mode: "mean_reversion", min_abs_bp: 15.0, max_abs_bp: 20.0, danger_payout_pct: 65.0, safe_payout_pct: 96.0, p_up_if_move_positive: 0.445, p_up_if_move_negative: 0.512, chosen_win_rate_pct: 55.2 },
      { label: "20+", mode: "mean_reversion", min_abs_bp: 20.0, max_abs_bp: null, danger_payout_pct: 65.0, safe_payout_pct: 96.0, p_up_if_move_positive: 0.465, p_up_if_move_negative: 0.545, chosen_win_rate_pct: 54.5 },
    ],
    overlays: [],
  };
  const eth1m = next["ETH/USDT::1m"] || {};
  next["ETH/USDT::1m"] = {
    ...eth1m,
    pair: "ETH/USDT",
    symbol: "ETHUSDT",
    product: "1m",
    duration_s: 60,
    entry_delay_s: 1,
    edge_pct: 4.0,
    favored_payout_floor: 65.0,
    alpha: 1.0,
    engine: "turbo_bucket",
    active_mode: "neutral",
    lookback_s: 10,
    base_payout_pct: 80.0,
    model: {
      features: ["turbo_move_bp", "turbo_abs_move_bp", "platform_skew_pp"],
    },
    notes: {
      ...(eth1m.notes || {}),
      family: "turbo",
      source: "turbo_short_7d_replay",
      production_rationale: "7-day ETH turbo own-feed short-tenor replay. Uses a smoothed 10s own-feed move ladder with the clearest observed ETH 1m mean-reversion effect.",
      selection_metric: "Recovered from direct ETH turbo-feed replay after the earlier bundle left ETH 1m blank.",
      implementation_mode: "turbo_family_monitor",
    },
    neutral_band: 0.0,
    flip_signal: false,
    calibration: { kind: "identity", flip_signal: false },
    bucket_rules: [
      { label: "0-5", mode: "mean_reversion", min_abs_bp: 0.0, max_abs_bp: 5.0, danger_payout_pct: 65.0, safe_payout_pct: 96.0, p_up_if_move_positive: 0.470, p_up_if_move_negative: 0.510, chosen_win_rate_pct: 53.0 },
      { label: "5-10", mode: "mean_reversion", min_abs_bp: 5.0, max_abs_bp: 10.0, danger_payout_pct: 65.0, safe_payout_pct: 96.0, p_up_if_move_positive: 0.475, p_up_if_move_negative: 0.535, chosen_win_rate_pct: 53.5 },
      { label: "10-15", mode: "mean_reversion", min_abs_bp: 10.0, max_abs_bp: 15.0, danger_payout_pct: 65.0, safe_payout_pct: 96.0, p_up_if_move_positive: 0.440, p_up_if_move_negative: 0.535, chosen_win_rate_pct: 56.0 },
      { label: "15-20", mode: "mean_reversion", min_abs_bp: 15.0, max_abs_bp: 20.0, danger_payout_pct: 65.0, safe_payout_pct: 96.0, p_up_if_move_positive: 0.445, p_up_if_move_negative: 0.500, chosen_win_rate_pct: 55.5 },
      { label: "20+", mode: "mean_reversion", min_abs_bp: 20.0, max_abs_bp: null, danger_payout_pct: 65.0, safe_payout_pct: 96.0, p_up_if_move_positive: 0.470, p_up_if_move_negative: 0.530, chosen_win_rate_pct: 53.0 },
    ],
    overlays: [],
  };
  return next;
}

function sortBucketRules(bucketRules) {
  return [...bucketRules].sort((a, b) => Number(a.min_abs_bp || 0) - Number(b.min_abs_bp || 0));
}

function pickStickyBucket(absMove, bucketRules, memoryKey) {
  const sortedRules = sortBucketRules(bucketRules);
  const direct = sortedRules.find(
    (rule) => absMove >= Number(rule.min_abs_bp || 0)
      && (rule.max_abs_bp == null || absMove < Number(rule.max_abs_bp)),
  ) || null;
  const previousLabel = state.bucketMemory[memoryKey];
  if (!previousLabel) {
    if (direct) state.bucketMemory[memoryKey] = direct.label;
    return direct;
  }
  const previous = sortedRules.find((rule) => rule.label === previousLabel);
  if (!previous) {
    if (direct) state.bucketMemory[memoryKey] = direct.label;
    return direct;
  }
  const hysteresisBp = 0.75;
  const prevMin = Number(previous.min_abs_bp || 0);
  const prevMax = previous.max_abs_bp == null ? Infinity : Number(previous.max_abs_bp);
  const withinStickyRange = absMove >= Math.max(0, prevMin - hysteresisBp) && absMove < (prevMax + hysteresisBp);
  if (withinStickyRange) {
    return previous;
  }
  if (direct) {
    state.bucketMemory[memoryKey] = direct.label;
    return direct;
  }
  return previous;
}

function configUrlForModel(modelKey) {
  if (modelKey === "model2") {
    return "./chainlink_model2_smoothed_mr_models.json";
  }
  if (modelKey === "model3") {
    return "./chainlink_model3_fixed_window_models.json";
  }
  return CONFIG_MODE === "raw"
    ? "./chainlink_product_suite_best_models.json"
    : CONFIG_MODE === "v2"
      ? "./chainlink_product_suite_v2_models.json"
      : CONFIG_MODE === "mid"
        ? "./chainlink_product_suite_mid_models.json"
        : CONFIG_MODE === "prod"
          ? "./chainlink_product_suite_prod_models.json"
          : "./chainlink_product_suite_final_models.json";
}

function warmupState(config, market) {
  const requiredSeconds = config.short_tenor_rule
    ? Number(config.short_tenor_rule.lookback_s || 0)
    : config.engine === "chainlink_bucket"
    ? Number(config.lookback_s || config.duration_s || 0)
    : Number(config.duration_s || 0) * 2;
  const requiredMs = requiredSeconds * 1000;
  const firstTs = market.history.length ? market.history[0].ts : null;
  const ageMs = Number.isFinite(firstTs) ? Math.max(0, Date.now() - firstTs) : 0;
  const progress = requiredMs > 0 ? clamp(ageMs / requiredMs, 0, 1) : 1;
  return {
    requiredMs,
    ageMs,
    progress,
    isReady: progress >= 1,
  };
}

function configModeLabel() {
  if (CONFIG_MODE === "raw") return "Raw Research";
  if (CONFIG_MODE === "v2") return "Replay Max V2";
  if (CONFIG_MODE === "mid") return "Theoretical Mid";
  if (CONFIG_MODE === "prod") return "Production Candidate";
  if (CONFIG_MODE === "final") return "Production Final";
  return "Starter V1";
}

function applyCalibration(rawProb, calibration) {
  if (!calibration || !calibration.kind) return rawProb;
  let p = calibration.flip_signal ? 1 - rawProb : rawProb;
  p = clamp(p, 0.000001, 0.999999);
  if (calibration.kind === "identity") {
    return p;
  }
  if (calibration.kind === "platt") {
    const score = Number(calibration.coef) * Math.log(p / (1 - p)) + Number(calibration.intercept);
    return clamp(sigmoid(score), 0.000001, 0.999999);
  }
  if (calibration.kind === "isotonic") {
    const xs = (calibration.x_thresholds || []).map(Number);
    const ys = (calibration.y_thresholds || []).map(Number);
    if (!xs.length || xs.length !== ys.length) return p;
    if (p <= xs[0]) return clamp(ys[0], 0.000001, 0.999999);
    if (p >= xs[xs.length - 1]) return clamp(ys[ys.length - 1], 0.000001, 0.999999);
    for (let i = 1; i < xs.length; i += 1) {
      if (p <= xs[i]) {
        const span = xs[i] - xs[i - 1] || 1;
        const t = (p - xs[i - 1]) / span;
        return clamp(ys[i - 1] + t * (ys[i] - ys[i - 1]), 0.000001, 0.999999);
      }
    }
  }
  return p;
}

function applyOverlays(probUp, config, features) {
  let prob = probUp;
  let overlayReason = "";
  const overlays = Array.isArray(config.overlays) ? config.overlays : [];
  for (const overlay of overlays) {
    if (overlay.type === "symmetric_metric_override") {
      const metricName = overlay.metric;
      const metricValue = Number(features[metricName]);
      if (!Number.isFinite(metricValue)) continue;
      const bands = Array.isArray(overlay.bands) ? [...overlay.bands].sort((a, b) => Number(b.min_abs_bp) - Number(a.min_abs_bp)) : [];
      let matched = null;
      for (const band of bands) {
        if (Math.abs(metricValue) >= Number(band.min_abs_bp || 0)) {
          matched = band;
          break;
        }
      }
      if (matched) {
        prob = metricValue >= 0 ? Number(matched.prob_up_if_positive) : Number(matched.prob_up_if_negative);
        overlayReason = matched.label || overlay.label || metricName;
      } else if (Number.isFinite(Number(overlay.default_prob_up))) {
        prob = Number(overlay.default_prob_up);
      }
    } else if (overlay.type === "gated_directional_override") {
      const gateMetric = overlay.gate_metric;
      const signalMetric = overlay.signal_metric;
      const gateValue = Number(features[gateMetric]);
      const signalValue = Number(features[signalMetric]);
      if (!Number.isFinite(gateValue) || !Number.isFinite(signalValue)) continue;
      const bands = Array.isArray(overlay.bands)
        ? [...overlay.bands].sort((a, b) => Number(b.min_abs_gate_bp || 0) - Number(a.min_abs_gate_bp || 0))
        : [];
      let matched = null;
      for (const band of bands) {
        if (Math.abs(gateValue) >= Number(band.min_abs_gate_bp || 0)) {
          matched = band;
          break;
        }
      }
      if (matched) {
        prob = signalValue >= 0
          ? Number(matched.prob_up_if_signal_positive)
          : Number(matched.prob_up_if_signal_negative);
        overlayReason = matched.label || overlay.label || signalMetric;
      } else if (Number.isFinite(Number(overlay.default_prob_up))) {
        prob = Number(overlay.default_prob_up);
      }
    }
  }
  return { prob, overlayReason };
}

function computeFeatures(config, market) {
  if (config.engine === "turbo_na") {
    return {
      eval_ts: Date.now(),
      active_bucket_feed: "N/A",
      active_lookback_s: null,
      note: config.notes?.production_rationale || "Turbo short-tenor variant unavailable for this pair.",
    };
  }
  if (config.engine === "turbo_legacy_short") {
    const legacy = state.turboLegacyShort[`${config.pair}::${config.product}`];
    if (!legacy || !Number.isFinite(Number(legacy.displayProbability))) return null;
    return {
      eval_ts: Number(legacy.updatedAt || Date.now()),
      signal_source: legacy.source || "Binance futures BTCUSDT top-10 depth",
      signal_move_bp: Number(legacy.featureVector?.ret_abs_10s ?? 0),
      signal_abs_move_bp: Number(legacy.featureVector?.ret_abs_10s ?? 0),
      active_bucket_label: legacy.metricLabel || config.product,
      active_bucket_mode: "microstructure_momentum",
      active_bucket_feed: legacy.source || "Binance futures BTCUSDT top-10 depth",
      active_lookback_s: Number(config.legacy_short?.lookback_s || 10),
      legacy_short: legacy,
    };
  }
  if (config.short_tenor_rule) {
    const latest = market.history.length ? market.history[market.history.length - 1] : null;
    const evalTs = latest ? latest.ts : Date.now();
    const lookbackMs = Number(config.short_tenor_rule.lookback_s || 10) * 1000;
    const current = pointAtOrBefore(market.history, evalTs);
    const prev10 = pointAtOrBefore(market.history, evalTs - lookbackMs);
    if (!current || !prev10) return null;
    const spotMove10 = Number.isFinite(current.spot) && Number.isFinite(prev10.spot)
      ? (current.spot / prev10.spot - 1) * 10000
      : NaN;
    const perpMove10 = Number.isFinite(current.perp) && Number.isFinite(prev10.perp)
      ? (current.perp / prev10.perp - 1) * 10000
      : NaN;
    const chainMove10 = Number.isFinite(current.chainlink) && Number.isFinite(prev10.chainlink)
      ? (current.chainlink / prev10.chainlink - 1) * 10000
      : NaN;
    const signalSource = config.short_tenor_rule.source || "chainlink";
    const signalMove = signalSource === "spot"
      ? spotMove10
      : signalSource === "perp"
        ? perpMove10
        : chainMove10;
    const bucketRules = Array.isArray(config.short_tenor_rule.bucket_rules) ? config.short_tenor_rule.bucket_rules : [];
    const bucket = pickStickyBucket(Math.abs(signalMove), bucketRules, currentStateKey());
    return {
      eval_ts: evalTs,
      signal_source: signalSource,
      signal_move_bp: signalMove,
      signal_abs_move_bp: Math.abs(signalMove),
      spot_ret_10s_bp: spotMove10,
      perp_ret_10s_bp: perpMove10,
      chain_ret_10s_bp: chainMove10,
      active_bucket_label: bucket ? bucket.label : "none",
      active_bucket_mode: config.short_tenor_rule.style || "custom",
      active_bucket_feed: signalSource === "spot" ? "Binance Spot" : signalSource === "perp" ? "Binance Perp" : "Chainlink",
      active_lookback_s: Number(config.short_tenor_rule.lookback_s || 10),
    };
  }
  if (config.engine === "turbo_bucket") {
    const lookbackMs = Number(config.lookback_s || config.duration_s || 0) * 1000;
    const evalTs = Date.now();
    const current = pointAtOrBefore(market.history, evalTs);
    const prev = pointAtOrBefore(market.history, evalTs - lookbackMs);
    if (!current || !prev || !Number.isFinite(current.turbo) || !Number.isFinite(prev.turbo)) return null;
    const turboMoveBp = ((current.turbo / prev.turbo) - 1) * 10000;
    const absMove = Math.abs(turboMoveBp);
    const bucketRules = Array.isArray(config.bucket_rules) ? config.bucket_rules : [];
    const memoryKey = `${state.familyMode}::${config.pair}::${config.product}`;
    const bucket = pickStickyBucket(absMove, bucketRules, memoryKey);
    return {
      eval_ts: evalTs,
      turbo_move_bp: turboMoveBp,
      turbo_abs_move_bp: absMove,
      active_bucket_label: bucket?.label || "Warm-up",
      active_bucket_mode: bucket?.mode || "flat",
      active_bucket_feed: "Turbo feed",
      active_lookback_s: Number(config.lookback_s || config.duration_s),
    };
  }
  if (config.engine === "chainlink_bucket") {
    const latest = market.history.length ? market.history[market.history.length - 1] : null;
    const evalTs = latest ? latest.ts : Date.now();
    const lookbackMs = Number(config.lookback_s || config.duration_s) * 1000;
    const current = pointAtOrBefore(market.history, evalTs);
    const prev = pointAtOrBefore(market.history, evalTs - lookbackMs);
    if (!current || !prev || !Number.isFinite(current.chainlink) || !Number.isFinite(prev.chainlink)) return null;
    const chainMoveBp = (current.chainlink / prev.chainlink - 1) * 10000;
    const absMove = Math.abs(chainMoveBp);
    const bucketRules = Array.isArray(config.bucket_rules) ? config.bucket_rules : [];
    const bucket = pickStickyBucket(absMove, bucketRules, currentStateKey());
    return {
      eval_ts: evalTs,
      chainlink_now: current.chainlink,
      chainlink_prev: prev.chainlink,
      chain_move_bp: chainMoveBp,
      chain_abs_move_bp: absMove,
      gap_spot_bp: ((current.spot - current.chainlink) / current.chainlink) * 10000,
      gap_perp_bp: ((current.perp - current.chainlink) / current.chainlink) * 10000,
      spot_perp_spread_bp: ((current.spot - current.perp) / current.chainlink) * 10000,
      active_bucket_label: bucket ? bucket.label : "none",
      active_bucket_mode: bucket ? bucket.mode : "flat",
      active_bucket_feed: "Chainlink",
      active_lookback_s: Number(config.lookback_s || config.duration_s),
    };
  }
  const unitMs = config.duration_s * 1000;
  const evalTs = Date.now();
  const current = pointAtOrBefore(market.history, evalTs);
  const prev1 = pointAtOrBefore(market.history, evalTs - unitMs);
  const prev2 = pointAtOrBefore(market.history, evalTs - unitMs * 2);
  if (!current || !prev1 || !prev2) return null;

  const hist12 = market.history.filter((row) => row.ts >= evalTs - unitMs * 12 && row.ts <= evalTs);
  const hist6 = market.history.filter((row) => row.ts >= evalTs - unitMs * 6 && row.ts <= evalTs);

  const gapSpotSeries = hist12.map((row) => ((row.spot - row.chainlink) / row.chainlink) * 10000);
  const gapPerpSeries = hist12.map((row) => ((row.perp - row.chainlink) / row.chainlink) * 10000);
  const spotRetSeries = [];
  const perpRetSeries = [];
  const chainRetSeries = [];
  for (let i = 1; i < hist6.length; i += 1) {
    spotRetSeries.push((hist6[i].spot / hist6[i - 1].spot - 1) * 10000);
    perpRetSeries.push((hist6[i].perp / hist6[i - 1].perp - 1) * 10000);
    chainRetSeries.push((hist6[i].chainlink / hist6[i - 1].chainlink - 1) * 10000);
  }

  const gapSpot = ((current.spot - current.chainlink) / current.chainlink) * 10000;
  const gapPerp = ((current.perp - current.chainlink) / current.chainlink) * 10000;
  const prevGapSpot = ((prev1.spot - prev1.chainlink) / prev1.chainlink) * 10000;
  const prevGapPerp = ((prev1.perp - prev1.chainlink) / prev1.chainlink) * 10000;
  const prev2GapSpot = ((prev2.spot - prev2.chainlink) / prev2.chainlink) * 10000;
  const prev2GapPerp = ((prev2.perp - prev2.chainlink) / prev2.chainlink) * 10000;

  const spotStats = rollingStats(gapSpotSeries);
  const perpStats = rollingStats(gapPerpSeries);
  const spotVolStats = rollingStats(spotRetSeries);
  const perpVolStats = rollingStats(perpRetSeries);
  const chainVolStats = rollingStats(chainRetSeries);

  const features = {
    eval_ts: evalTs,
    gap_spot_bp: gapSpot,
    gap_perp_bp: gapPerp,
    spot_perp_spread_bp: ((current.spot - current.perp) / current.chainlink) * 10000,
    delta_gap_spot_1u: gapSpot - prevGapSpot,
    delta_gap_perp_1u: gapPerp - prevGapPerp,
    delta_gap_spot_2u: gapSpot - prev2GapSpot,
    delta_gap_perp_2u: gapPerp - prev2GapPerp,
    spot_ret_1u_bp: (current.spot / prev1.spot - 1) * 10000,
    perp_ret_1u_bp: (current.perp / prev1.perp - 1) * 10000,
    chain_ret_1u_bp: (current.chainlink / prev1.chainlink - 1) * 10000,
    spot_ret_2u_bp: (current.spot / prev2.spot - 1) * 10000,
    perp_ret_2u_bp: (current.perp / prev2.perp - 1) * 10000,
    chain_ret_2u_bp: (current.chainlink / prev2.chainlink - 1) * 10000,
    gap_spot_z_12: spotStats.std ? (gapSpot - spotStats.mean) / spotStats.std : 0,
    gap_perp_z_12: perpStats.std ? (gapPerp - perpStats.mean) / perpStats.std : 0,
    spot_vol_6u: spotVolStats.std,
    perp_vol_6u: perpVolStats.std,
    chain_vol_6u: chainVolStats.std,
    gap_sign_agree: Math.sign(gapSpot) * Math.sign(gapPerp),
    delta_sign_agree: Math.sign(gapSpot - prevGapSpot) * Math.sign(gapPerp - prevGapPerp),
    basis_pressure: gapPerp - gapSpot,
  };
  return features;
}

function evaluateModel(config, features) {
  if (config.engine === "turbo_na") {
    return {
      adjProbUp: NaN,
      confidence: 0,
      favoredSide: "N/A",
      active: false,
      inactiveMode: "suppress",
      overlayReason: config.notes?.production_rationale || "Unavailable",
      higherPayout: NaN,
      lowerPayout: NaN,
      signalFeed: "N/A",
      signalLookbackS: null,
    };
  }
  if (config.engine === "turbo_legacy_short") {
    const legacy = features.legacy_short;
    const modelProbUp = Number(legacy.displayProbability);
    const confidence = Math.abs(modelProbUp - 0.5);
    const favoredSide = modelProbUp >= 0.5 ? "Higher" : "Lower";
    const favoredProb = Math.max(modelProbUp, 1 - modelProbUp);
    const favoredPayout = payoutForProbability(favoredProb, state.edgePct);
    const otherPayout = payoutForProbability(1 - favoredProb, state.edgePct);
    return {
      rawProbUpBase: Number(legacy.rawProbability),
      rawProbUp: Number(legacy.rawProbability),
      calibratedProbUp: Number(legacy.displayProbability),
      modelProbUp,
      adjProbUp: modelProbUp,
      effectiveAlpha: 1.0,
      confidence,
      active: true,
      inactiveMode: "neutral",
      overlayReason: `${legacy.metricLabel || config.product} legacy short depth model`,
      favoredSide,
      favoredProb,
      favoredPayout,
      otherPayout,
      higherPayout: favoredSide === "Higher" ? favoredPayout : otherPayout,
      lowerPayout: favoredSide === "Lower" ? favoredPayout : otherPayout,
      signalFeed: legacy.source || "Binance futures BTCUSDT top-10 depth",
      signalLookbackS: Number(config.legacy_short?.lookback_s || 10),
    };
  }
  if (config.short_tenor_rule) {
    const bucketRules = Array.isArray(config.short_tenor_rule.bucket_rules) ? config.short_tenor_rule.bucket_rules : [];
    const bucket = bucketRules.find((rule) => rule.label === features.active_bucket_label);
    let modelProbUp = 0.5;
    let overlayReason = config.short_tenor_rule.label || "short_tenor_rule";
    if (bucket && Number.isFinite(features.signal_move_bp)) {
      modelProbUp = features.signal_move_bp >= 0
        ? Number(bucket.p_up_if_move_positive)
        : Number(bucket.p_up_if_move_negative);
      overlayReason = `${config.short_tenor_rule.style}:${bucket.label}:${config.short_tenor_rule.source}_${config.short_tenor_rule.lookback_s}s`;
    }
    const effectiveAlpha = Number.isFinite(state.alphaOverride) ? state.alphaOverride : config.alpha;
    const adjusted = 0.5 + effectiveAlpha * (modelProbUp - 0.5);
    const maxProb = maxDefendableProbability(state.edgePct, config.favored_payout_floor);
    const adjProbUp = clamp(adjusted, 1 - maxProb, maxProb);
    const confidence = Math.abs(adjProbUp - 0.5);
    const favoredSide = adjProbUp >= 0.5 ? "Higher" : "Lower";
    const favoredProb = Math.max(adjProbUp, 1 - adjProbUp);
    const favoredPayout = payoutForProbability(favoredProb, state.edgePct);
    const otherPayout = payoutForProbability(1 - favoredProb, state.edgePct);
    return {
      rawProbUpBase: modelProbUp,
      rawProbUp: modelProbUp,
      calibratedProbUp: modelProbUp,
      modelProbUp,
      adjProbUp,
      effectiveAlpha,
      confidence,
      active: true,
      inactiveMode: "neutral",
      overlayReason,
      favoredSide,
      favoredProb,
      favoredPayout,
      otherPayout,
      higherPayout: favoredSide === "Higher" ? favoredPayout : otherPayout,
      lowerPayout: favoredSide === "Lower" ? favoredPayout : otherPayout,
      signalFeed: features.active_bucket_feed,
      signalLookbackS: Number(config.short_tenor_rule.lookback_s || 10),
    };
  }
  if (config.engine === "turbo_bucket") {
    const bucketRules = Array.isArray(config.bucket_rules) ? config.bucket_rules : [];
    const bucket = bucketRules.find((rule) => rule.label === features.active_bucket_label);
    let modelProbUp = 0.5;
    let overlayReason = "flat";
    if (bucket) {
      modelProbUp = features.turbo_move_bp >= 0 ? Number(bucket.p_up_if_move_positive) : Number(bucket.p_up_if_move_negative);
      overlayReason = `${bucket.mode}:${bucket.label}`;
    }
    const effectiveAlpha = Number.isFinite(state.alphaOverride) ? state.alphaOverride : config.alpha;
    const adjusted = 0.5 + effectiveAlpha * (modelProbUp - 0.5);
    const maxProb = maxDefendableProbability(state.edgePct, config.favored_payout_floor);
    const adjProbUp = clamp(adjusted, 1 - maxProb, maxProb);
    const confidence = Math.abs(adjProbUp - 0.5);
    const active = Boolean(bucket);
    const favoredSide = !active ? "Neutral" : adjProbUp >= 0.5 ? "Higher" : "Lower";
    const favoredProb = Math.max(adjProbUp, 1 - adjProbUp);
    const favoredPayout = payoutForProbability(favoredProb, state.edgePct);
    const otherPayout = payoutForProbability(1 - favoredProb, state.edgePct);
    const neutralPayout = payoutForProbability(0.5, state.edgePct);
    return {
      rawProbUpBase: modelProbUp,
      rawProbUp: modelProbUp,
      calibratedProbUp: modelProbUp,
      modelProbUp,
      adjProbUp,
      effectiveAlpha,
      confidence,
      active,
      inactiveMode: "neutral",
      overlayReason,
      favoredSide,
      favoredProb,
      favoredPayout,
      otherPayout,
      higherPayout: !active ? neutralPayout : favoredSide === "Higher" ? favoredPayout : otherPayout,
      lowerPayout: !active ? neutralPayout : favoredSide === "Lower" ? favoredPayout : otherPayout,
      signalFeed: "Turbo feed",
      signalLookbackS: Number(config.lookback_s || config.duration_s),
    };
  }
  if (config.engine === "chainlink_bucket") {
    const bucketRules = Array.isArray(config.bucket_rules) ? config.bucket_rules : [];
    const bucket = bucketRules.find((rule) => rule.label === features.active_bucket_label);
    let modelProbUp = 0.5;
    let overlayReason = "flat";
    if (bucket) {
      modelProbUp = features.chain_move_bp >= 0 ? Number(bucket.p_up_if_move_positive) : Number(bucket.p_up_if_move_negative);
      overlayReason = `${bucket.mode}:${bucket.label}`;
    }
    const effectiveAlpha = Number.isFinite(state.alphaOverride) ? state.alphaOverride : config.alpha;
    const adjusted = 0.5 + effectiveAlpha * (modelProbUp - 0.5);
    const maxProb = maxDefendableProbability(state.edgePct, config.favored_payout_floor);
    const adjProbUp = clamp(adjusted, 1 - maxProb, maxProb);
    const confidence = Math.abs(adjProbUp - 0.5);
    const active = Boolean(bucket);
    const favoredSide = !active ? "Neutral" : adjProbUp >= 0.5 ? "Higher" : "Lower";
    const favoredProb = Math.max(adjProbUp, 1 - adjProbUp);
    const favoredPayout = payoutForProbability(favoredProb, state.edgePct);
    const otherPayout = payoutForProbability(1 - favoredProb, state.edgePct);
    const neutralPayout = payoutForProbability(0.5, state.edgePct);
    return {
      rawProbUpBase: modelProbUp,
      rawProbUp: modelProbUp,
      calibratedProbUp: modelProbUp,
      modelProbUp,
      adjProbUp,
      effectiveAlpha,
      confidence,
      active,
      inactiveMode: "neutral",
      overlayReason,
      favoredSide,
      favoredProb,
      favoredPayout,
      otherPayout,
      higherPayout: !active ? neutralPayout : favoredSide === "Higher" ? favoredPayout : otherPayout,
      lowerPayout: !active ? neutralPayout : favoredSide === "Lower" ? favoredPayout : otherPayout,
      signalFeed: "Chainlink",
      signalLookbackS: Number(config.lookback_s || config.duration_s),
    };
  }
  const model = config.model;
  let score = model.intercept;
  for (let i = 0; i < model.features.length; i += 1) {
    const name = model.features[i];
    const raw = Number(features[name]);
    const scale = Number(model.scales[i]) || 1;
    const z = (raw - Number(model.means[i])) / scale;
    score += Number(model.coef[i]) * z;
  }
  const rawProbUpBase = sigmoid(score);
  const calibratedProbUp = applyCalibration(rawProbUpBase, config.calibration);
  const signalProbUp = config.flip_signal && !config.calibration ? 1 - rawProbUpBase : calibratedProbUp;
  const overlayResult = applyOverlays(signalProbUp, config, features);
  const modelProbUp = overlayResult.prob;
  const effectiveAlpha = Number.isFinite(state.alphaOverride) ? state.alphaOverride : config.alpha;
  const adjusted = 0.5 + effectiveAlpha * (modelProbUp - 0.5);
  const maxProb = maxDefendableProbability(state.edgePct, config.favored_payout_floor);
  const adjProbUp = clamp(adjusted, 1 - maxProb, maxProb);
  const confidence = Math.abs(adjProbUp - 0.5);
  const neutralBand = Number.isFinite(Number(config.neutral_band)) ? Number(config.neutral_band) : 0;
  const active = confidence >= Math.max(Number(config.margin || 0), neutralBand);
  const inactiveMode = config.active_mode || "neutral";
  const favoredSide = !active ? (inactiveMode === "suppress" ? "Standby" : "Neutral") : adjProbUp >= 0.5 ? "Higher" : "Lower";
  const favoredProb = Math.max(adjProbUp, 1 - adjProbUp);
  const favoredPayout = payoutForProbability(favoredProb, state.edgePct);
  const otherPayout = payoutForProbability(1 - favoredProb, state.edgePct);
  const neutralPayout = payoutForProbability(0.5, state.edgePct);
  const higherPayout =
    !active && inactiveMode === "suppress"
      ? NaN
      : favoredSide === "Higher"
        ? favoredPayout
        : favoredSide === "Lower"
          ? otherPayout
          : neutralPayout;
  const lowerPayout =
    !active && inactiveMode === "suppress"
      ? NaN
      : favoredSide === "Lower"
        ? favoredPayout
        : favoredSide === "Higher"
          ? otherPayout
          : neutralPayout;
  return {
    rawProbUpBase,
    rawProbUp: signalProbUp,
    calibratedProbUp,
    modelProbUp,
    adjProbUp,
    effectiveAlpha,
    confidence,
    active,
    inactiveMode,
    overlayReason: overlayResult.overlayReason,
    favoredSide,
    favoredProb,
    favoredPayout,
    otherPayout,
    higherPayout,
    lowerPayout,
  };
}

function populateSelectors() {
  const pairSelect = $("pair-select");
  const productSelect = $("product-select");
  const pairChips = $("pair-chips");
  const productChips = $("product-chips");
  const keys = currentConfigKeys();
  const pairs = [...new Set(keys.map((key) => key.split("::")[0]))];
  pairSelect.innerHTML = pairs.map((pair) => `<option value="${pair}">${pair}</option>`).join("");
  if (!pairs.includes(state.selectedPair)) {
    state.selectedPair = pairs[0] || "";
  }
  const products = keys
    .filter((key) => key.startsWith(`${state.selectedPair}::`))
    .map((key) => key.split("::")[1]);
  if (!products.includes(state.selectedProduct)) {
    state.selectedProduct = products[0] || "";
  }
  productSelect.innerHTML = products.map((product) => `<option value="${product}">${product}</option>`).join("");
  pairSelect.value = state.selectedPair;
  productSelect.value = state.selectedProduct;
  pairChips.innerHTML = pairs.map((pair) => `
    <button type="button" class="quick-chip${pair === state.selectedPair ? " active" : ""}" data-pair="${pair}">
      ${pair}
    </button>
  `).join("");
  productChips.innerHTML = products.map((product) => `
    <button type="button" class="quick-chip${product === state.selectedProduct ? " active" : ""}" data-product="${product}">
      ${product}
    </button>
  `).join("");
  syncFamilyTabs();
  syncBlendControls();
}

async function loadConfigs() {
  const [response1, response2, response3, turboResponse] = await Promise.all([
    fetch(configUrlForModel("model1"), { cache: "no-store" }),
    fetch(configUrlForModel("model2"), { cache: "no-store" }),
    fetch(configUrlForModel("model3"), { cache: "no-store" }),
    fetch(TURBO_CONFIG_URL, { cache: "no-store" }),
  ]);
  state.configSets.model1 = parseJsonLenient(await response1.text());
  state.configSets.model2 = parseJsonLenient(await response2.text());
  state.configSets.model3 = parseJsonLenient(await response3.text());
  state.configSets.turbo = normalizeTurboConfigs(parseJsonLenient(await turboResponse.text()));
  state.lastReloadedAt = Date.now();
  const firstKey = currentConfigKeys()[0];
  if (firstKey) {
    const [pair, product] = firstKey.split("::");
    if (!state.configSets.model1[`${state.selectedPair}::${state.selectedProduct}`]) {
      state.selectedPair = pair;
      state.selectedProduct = product;
    }
  }
  populateSelectors();
  syncBlendControls();
  render();
}

async function loadAlphaProxies() {
  try {
    const response = await fetch(ALPHA_PROXY_URL, { cache: "no-store" });
    const payload = parseJsonLenient(await response.text());
    state.alphaProxyRows = Array.isArray(payload.rows) ? payload.rows : [];
    state.alphaProxyMeta = payload;
  } catch (error) {
    console.error("Alpha proxy load failed", error);
    state.alphaProxyRows = [];
    state.alphaProxyMeta = null;
  }
}

async function fetchPlatformQuotes() {
  try {
    const response = await fetch(PLATFORM_CONFIG_URL, { cache: "no-store" });
    const payload = await response.json();
    const rows = Array.isArray(payload?.data?.data)
      ? payload.data.data
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload)
          ? payload
          : [];
    const next = {};
    for (const row of rows) {
      const orderConfigs = Array.isArray(row.order_configs) ? row.order_configs : [];
      if (orderConfigs.length) {
        for (const cfg of orderConfigs) {
          next[`${row.pair_name}::${cfg.duration}`] = {
            pair_name: row.pair_name,
            duration: Number(cfg.duration),
            bid_return_rate: cfg.bid_return_rate,
            ask_return_rate: cfg.ask_return_rate,
            min_amount: cfg.min_amount,
            max_amount: cfg.max_amount,
            bid_owner: cfg.bid_owner || cfg.bid_source || cfg.bid_source_name || row.bid_owner || row.bid_source || row.bid_source_name || null,
            ask_owner: cfg.ask_owner || cfg.ask_source || cfg.ask_source_name || row.ask_owner || row.ask_source || row.ask_source_name || null,
          };
        }
      } else if (Array.isArray(row.durations)) {
        for (const duration of row.durations) {
          next[`${row.pair_name}::${duration}`] = {
            pair_name: row.pair_name,
            duration: Number(duration),
            bid_return_rate: row.bid_return_rate,
            ask_return_rate: row.ask_return_rate,
            bid_owner: row.bid_owner || row.bid_source || row.bid_source_name || null,
            ask_owner: row.ask_owner || row.ask_source || row.ask_source_name || null,
          };
        }
      }
    }
    state.platformQuotes = next;
  } catch (error) {
    console.error("Platform quote fetch failed", error);
  }
}

async function pollChainlink() {
  const pairs = Object.keys(FEEDS);
  await Promise.all(
    pairs.map(async (pair) => {
      try {
        const next = await fetchChainlinkLatest(pair);
        state.market[pair].chainlink = next.price;
        state.market[pair].lastUpdateTs = next.observationTs;
      } catch (error) {
        console.error(pair, error);
      }
    }),
  );
  render();
}

async function pollTurbo() {
  const pairs = Object.keys(PAIR_META);
  await Promise.all(
    pairs.map(async (pair) => {
      try {
        const next = await fetchTurboLatest(pair);
        state.market[pair].turbo = Number(next.price);
      } catch (error) {
        console.error(pair, error);
      }
    }),
  );
  render();
}

async function pollTurboLegacyShort() {
  await Promise.all(
    ["30s", "1m"].map(async (product) => {
      try {
        const next = await fetchTurboLegacyShort(product);
        state.turboLegacyShort[`BTC/USDT::${product}`] = next;
      } catch (error) {
        console.error(product, error);
      }
    }),
  );
  render();
}

async function preloadServerHistories() {
  await Promise.all(
    Object.keys(state.market).map(async (pair) => {
      try {
        const payload = await fetchServerHistory(pair);
        const market = state.market[pair];
        if (!market || !payload) return;
        market.chainlink = Number.isFinite(Number(payload.chainlink)) ? Number(payload.chainlink) : market.chainlink;
        market.turbo = Number.isFinite(Number(payload.turbo)) ? Number(payload.turbo) : market.turbo;
        market.spot = Number.isFinite(Number(payload.spot)) ? Number(payload.spot) : market.spot;
        market.perp = Number.isFinite(Number(payload.perp)) ? Number(payload.perp) : market.perp;
        market.lastUpdateTs = Number.isFinite(Number(payload.lastUpdateTs)) ? Number(payload.lastUpdateTs) : market.lastUpdateTs;
        if (Array.isArray(payload.history) && payload.history.length) {
          market.history = payload.history
            .map((row) => ({
              ts: Number(row.ts),
              chainlink: Number.isFinite(Number(row.chainlink)) ? Number(row.chainlink) : null,
              turbo: Number.isFinite(Number(row.turbo)) ? Number(row.turbo) : null,
              spot: Number.isFinite(Number(row.spot)) ? Number(row.spot) : null,
              perp: Number.isFinite(Number(row.perp)) ? Number(row.perp) : null,
            }))
            .filter((row) => Number.isFinite(row.ts))
            .slice(-HISTORY_LIMIT);
        }
      } catch (error) {
        console.error(`History preload failed for ${pair}`, error);
      }
    }),
  );
  render();
}

async function pollBinance() {
  const pairs = Object.keys(PAIR_META);
  await Promise.all(
    pairs.map(async (pair) => {
      try {
        const next = await fetchBinanceLatest(pair);
        state.market[pair].spot = Number(next.spot);
        state.market[pair].perp = Number(next.perp);
        state.market[pair].lastUpdateTs = Number(next.ts || Date.now());
      } catch (error) {
        console.error(pair, error);
      }
    }),
  );
  render();
}

function recordSnapshots() {
  const now = Date.now();
  for (const [pairName, market] of Object.entries(state.market)) {
    if (!Number.isFinite(market.spot) || !Number.isFinite(market.perp)) continue;
    if (!Number.isFinite(market.chainlink) && !Number.isFinite(market.turbo)) continue;
    market.history.push({ ts: now, chainlink: market.chainlink, turbo: market.turbo, spot: market.spot, perp: market.perp });
    if (market.history.length > HISTORY_LIMIT) {
      market.history.splice(0, market.history.length - HISTORY_LIMIT);
    }
  }
  render();
}

function renderFeatureTable(features, config) {
  const body = $("feature-body");
  if (!config || !features) {
    body.innerHTML = `<tr><td colspan="3">Waiting for enough history to compute the selected model.</td></tr>`;
    return;
  }
  if (config.engine === "turbo_na") {
    body.innerHTML = `<tr><td>status</td><td>N/A</td><td>${escapeHtml(features.note || "Turbo short-tenor variant unavailable for this pair.")}</td></tr>`;
    return;
  }
  if (config.engine === "turbo_legacy_short") {
    const legacy = features.legacy_short || {};
    body.innerHTML = `
      <tr><td>source</td><td>${legacy.source || "Binance futures BTCUSDT top-10 depth"}</td><td>Recovered legacy turbo short-tenor source.</td></tr>
      <tr><td>top5_notional_imbalance</td><td>${formatSigned(legacy.featureVector?.imb_top5_notional, 3)}</td><td>Main depth imbalance signal from the old turbo console.</td></tr>
      <tr><td>top10_notional_imbalance</td><td>${formatSigned(legacy.featureVector?.imb_top10_notional, 3)}</td><td>Broader depth confirmation signal.</td></tr>
      <tr><td>signed_persist_05</td><td>${formatSigned(legacy.featureVector?.signed_persist_05, 3, "s")}</td><td>How long top-5 imbalance stayed beyond the 0.5 threshold.</td></tr>
      <tr><td>microprice_dev_bps</td><td>${formatSigned(legacy.featureVector?.microprice_dev_bps, 3, "bp")}</td><td>Top-of-book lean versus simple mid.</td></tr>
      <tr><td>ret_abs_10s</td><td>${formatSigned(legacy.featureVector?.ret_abs_10s, 3, "bp")}</td><td>Legacy 10-second move context in the restored turbo short model.</td></tr>
    `;
    return;
  }
  if (config.short_tenor_rule) {
    body.innerHTML = `
      <tr><td>signal_source</td><td>${features.active_bucket_feed}</td><td>Selected short-tenor source for the shared BTC override.</td></tr>
      <tr><td>signal_move_bp</td><td>${formatSigned(features.signal_move_bp, 3, "bp")}</td><td>Recent move over the selected short-tenor lookback.</td></tr>
      <tr><td>signal_abs_move_bp</td><td>${formatSigned(features.signal_abs_move_bp, 3, "bp")}</td><td>Absolute move size used for bucket selection.</td></tr>
      <tr><td>active_bucket_label</td><td>${features.active_bucket_label}</td><td>Backtested 10s move bucket.</td></tr>
      <tr><td>active_bucket_mode</td><td>${features.active_bucket_mode}</td><td>Directional style for the selected short-tenor rule.</td></tr>
      <tr><td>lookback_s</td><td>${features.active_lookback_s}s</td><td>Selected short-tenor lookback.</td></tr>
    `;
    return;
  }
  if (config.engine === "turbo_bucket") {
    body.innerHTML = `
      <tr><td>turbo_move_bp</td><td>${formatSigned(features.turbo_move_bp, 3, "bp")}</td><td>Turbo feed move over the selected lookback.</td></tr>
      <tr><td>turbo_abs_move_bp</td><td>${formatSigned(features.turbo_abs_move_bp, 3, "bp")}</td><td>Absolute move size used for bucket selection.</td></tr>
      <tr><td>active_bucket_label</td><td>${features.active_bucket_label}</td><td>Backtested turbo move bucket.</td></tr>
      <tr><td>active_bucket_mode</td><td>${features.active_bucket_mode}</td><td>Smoothed turbo ladder mode for this move.</td></tr>
      <tr><td>lookback_s</td><td>${features.active_lookback_s}s</td><td>Turbo lookback selected by the earlier setup.</td></tr>
    `;
    return;
  }
  if (config.engine === "chainlink_bucket") {
    body.innerHTML = `
      <tr><td>chain_move_bp</td><td>${formatSigned(features.chain_move_bp, 3, "bp")}</td><td>Chainlink move over the selected lookback.</td></tr>
      <tr><td>chain_abs_move_bp</td><td>${formatSigned(features.chain_abs_move_bp, 3, "bp")}</td><td>Absolute move size used for bucket selection.</td></tr>
      <tr><td>active_bucket_label</td><td>${features.active_bucket_label}</td><td>Backtested move bucket.</td></tr>
      <tr><td>active_bucket_mode</td><td>${features.active_bucket_mode}</td><td>Smoothed Chainlink MR ladder mode.</td></tr>
      <tr><td>lookback_s</td><td>${features.active_lookback_s}s</td><td>Selected Chainlink lookback for the active bucket model.</td></tr>
    `;
    return;
  }
  body.innerHTML = config.model.features
    .map((name) => {
      const value = Number(features[name]);
      const comment = name.includes("gap") ? "Basis / dislocation feature" :
        name.includes("ret") ? "Return / move context" :
        name.includes("vol") ? "Volatility context" :
        "Derived signal";
      return `<tr><td>${name}</td><td>${formatSigned(value, 3)}</td><td>${comment}</td></tr>`;
    })
    .join("");
}

function blendedQuoteEval(probUp, config, modelModeLabel, model1Eval, model2Eval) {
  if (!Number.isFinite(probUp) || !config) return null;
  const maxProb = maxDefendableProbability(state.edgePct, config.favored_payout_floor);
  const clipped = clamp(probUp, 1 - maxProb, maxProb);
  const confidence = Math.abs(clipped - 0.5);
  const favoredSide = clipped >= 0.5 ? "Higher" : "Lower";
  const favoredProb = Math.max(clipped, 1 - clipped);
  const favoredPayout = payoutForProbability(favoredProb, state.edgePct);
  const otherPayout = payoutForProbability(1 - favoredProb, state.edgePct);
  return {
    adjProbUp: clipped,
    confidence,
    favoredSide,
    higherPayout: favoredSide === "Higher" ? favoredPayout : otherPayout,
    lowerPayout: favoredSide === "Lower" ? favoredPayout : otherPayout,
    modelModeLabel,
    model1ProbUp: model1Eval ? model1Eval.adjProbUp : NaN,
    model2ProbUp: model2Eval ? model2Eval.adjProbUp : NaN,
  };
}

function renderTurboFamily(config, market) {
  const heroCopy = $("hero-copy");
  const platform = state.platformQuotes[`${config.pair}::${config.duration_s}`];
  const legacyShort = state.turboLegacyShort[`${config.pair}::${config.product}`];
  const warmup = config.engine === "turbo_bucket" ? warmupState(config, market) : { isReady: Boolean(legacyShort), progress: legacyShort ? 1 : 0, requiredMs: 0, ageMs: 0 };
  const features = computeFeatures(config, market);
  const selectedEval = features ? evaluateModel(config, features) : null;
  const reloadText = state.lastReloadedAt ? ` Last reload ${formatDateTime(state.lastReloadedAt)}.` : "";

  if (heroCopy) {
    heroCopy.textContent = "Turbo tab restores the earlier turbo setup inside the unified console: BTC 30s and 1m come from the recovered legacy short-tenor depth model, while 3m and above use the earlier turbo move-bucket ladders.";
  }
  $("controls-note").textContent = `Loaded Turbo for ${config.pair} ${config.product}. ${config.notes.production_rationale}${reloadText}`;
  $("deployed-model").textContent = "Turbo family";
  $("viewing-model").textContent = config.engine === "turbo_legacy_short" ? "Turbo legacy short" : "Turbo bucket ladder";
  $("chainlink-mid").textContent = config.engine === "turbo_legacy_short" && legacyShort
    ? formatNum(legacyShort.feedMid)
    : formatNum(market.turbo);
  $("spot-mid").textContent = formatNum(market.spot);
  $("perp-mid").textContent = formatNum(market.perp);
  $("last-update").textContent = formatDateTime(config.engine === "turbo_legacy_short" && legacyShort ? legacyShort.updatedAt : market.lastUpdateTs);
  $("struct-spot").textContent = "-";
  $("struct-perp").textContent = "-";

  if (config.engine === "turbo_na") {
    $("signal-side").innerHTML = signalMarkup("N/A");
    $("signal-note").textContent = config.notes.production_rationale;
    $("our-quote").innerHTML = '<span class="signal-pill">N/A</span>';
    $("our-quote-note").textContent = "No recovered ETH turbo short-tenor runtime in the earlier bundle.";
    $("model-prob").textContent = "N/A";
    $("model-prob-note").textContent = "This pair/product had no recovered earlier turbo short-tenor model.";
    $("gap-spot").textContent = "-";
    $("gap-perp").textContent = "-";
    $("spot-perp-spread").textContent = "-";
    $("our-fair-mid").textContent = "-";
    $("model1-mid").textContent = "-";
    $("model2-mid").textContent = "-";
    $("model3-mid").textContent = "-";
    $("blend-mid").textContent = "-";
    $("active-driver").textContent = "Unavailable";
    $("active-lookback").textContent = "-";
    $("model-status").textContent = "N/A";
    $("model-summary").textContent = "Turbo short-tenor ETH was not present in the recovered earlier setup, so the unified dashboard leaves it as unavailable.";
    $("alpha-summary").textContent = `Alpha control is inactive here; earlier turbo short-tenor logic was only recovered for BTC. Edge hint from the old setup was ${TURBO_LEGACY_SHORT_EDGE_HINT.toFixed(1)}%.`;
    $("feed-summary").textContent = config.notes.selection_metric || config.notes.production_rationale;
    if (platform) {
      const implied = impliedQuoteStats(Number(platform.bid_return_rate), Number(platform.ask_return_rate));
      const up = Number(platform.bid_return_rate) * 100;
      const down = Number(platform.ask_return_rate) * 100;
      $("platform-quote").textContent = `${formatNum(up)} / ${formatNum(down)}`;
      $("platform-quote-note").textContent = `All-in public ${config.product} quote for ${config.pair}.`;
      $("platform-edge").textContent = implied ? formatPct(implied.edgePct, 2) : "-";
      $("platform-mid").textContent = implied ? `${formatPct(implied.pUp * 100, 2)} / ${formatPct(implied.pDown * 100, 2)}` : "-";
      $("platform-skew").textContent = implied ? formatSigned(implied.skewPp, 2, "pp") : "-";
      $("platform-owners").textContent = `Higher: ${platform.bid_owner || "public aggregate"} / Lower: ${platform.ask_owner || "public aggregate"}`;
    } else {
      $("platform-quote").textContent = "-";
      $("platform-quote-note").textContent = "No current public quote found for this pair/duration.";
      $("platform-edge").textContent = "-";
      $("platform-mid").textContent = "-";
      $("platform-skew").textContent = "-";
      $("platform-owners").textContent = "-";
    }
    $("mid-gap-vs-aggregate").textContent = "-";
    renderFeatureTable(features, config);
    return;
  }

  if (!features || !selectedEval || (!warmup.isReady && config.engine === "turbo_bucket")) {
    $("signal-side").innerHTML = signalMarkup("Warm-up");
    $("signal-note").textContent = config.engine === "turbo_legacy_short"
      ? "Waiting for restored turbo short-tenor depth state."
      : `Building turbo feed history for ${config.product}. Warm-up ${formatPct(warmup.progress * 100, 0)} complete.`;
    const flatPayout = payoutForProbability(0.5, state.edgePct);
    $("our-quote").innerHTML = quoteMarkup(flatPayout, flatPayout, "Warm-up");
    $("our-quote-note").textContent = "Warm-up fallback quote: flat 50/50.";
    $("model-prob").textContent = "-";
    $("model-prob-note").textContent = config.engine === "turbo_legacy_short"
      ? "Need a few seconds of restored depth history before the legacy turbo short model is ready."
      : `Need about ${Math.round(warmup.requiredMs / 1000)}s of turbo history; currently have ${Math.round(warmup.ageMs / 1000)}s.`;
    $("gap-spot").textContent = "-";
    $("gap-perp").textContent = "-";
    $("spot-perp-spread").textContent = "-";
    $("our-fair-mid").textContent = "-";
    $("model1-mid").textContent = "-";
    $("model2-mid").textContent = "-";
    $("model3-mid").textContent = "-";
    $("blend-mid").textContent = "-";
    $("active-driver").textContent = config.engine === "turbo_legacy_short" ? "Legacy short depth model" : "Turbo move bucket";
    $("active-lookback").textContent = config.engine === "turbo_legacy_short" ? `${config.legacy_short?.lookback_s || 10}s` : `${Number(config.lookback_s || config.duration_s)}s`;
    $("model-status").textContent = "Warm-up flat quote";
    $("model-summary").textContent = config.notes.production_rationale;
    $("alpha-summary").textContent = config.engine === "turbo_legacy_short"
      ? `Recovered BTC short-tenor turbo setup. Old setup edge hint was ${TURBO_LEGACY_SHORT_EDGE_HINT.toFixed(1)}%; current page edge still wraps the MID after that.`
      : `Turbo ladder alpha ${Number.isFinite(state.alphaOverride) ? state.alphaOverride.toFixed(2) : config.alpha.toFixed(2)}.`;
    $("feed-summary").textContent = config.notes.selection_metric || config.notes.production_rationale;
    $("platform-quote").textContent = "-";
    $("platform-quote-note").textContent = "No current public quote found for this pair/duration.";
    $("platform-edge").textContent = "-";
    $("platform-mid").textContent = "-";
    $("platform-skew").textContent = "-";
    $("platform-owners").textContent = "-";
    $("mid-gap-vs-aggregate").textContent = "-";
    renderFeatureTable(features, config);
    return;
  }

  const quoteEval = blendedQuoteEval(selectedEval.adjProbUp, config, "Turbo", null, null);
  $("gap-spot").textContent = Number.isFinite(market.turbo) && Number.isFinite(market.spot)
    ? formatSigned(((market.spot - market.turbo) / market.turbo) * 10000, 2, "bp")
    : "-";
  $("gap-perp").textContent = Number.isFinite(market.turbo) && Number.isFinite(market.perp)
    ? formatSigned(((market.perp - market.turbo) / market.turbo) * 10000, 2, "bp")
    : "-";
  $("spot-perp-spread").textContent = Number.isFinite(market.spot) && Number.isFinite(market.perp) && Number.isFinite(market.turbo)
    ? formatSigned(((market.spot - market.perp) / market.turbo) * 10000, 2, "bp")
    : "-";
  $("signal-side").innerHTML = signalMarkup(quoteEval.favoredSide);
  $("signal-note").textContent = `${config.engine === "turbo_legacy_short" ? "Legacy short model" : "Turbo bucket ladder"} active. Confidence ${formatPct(quoteEval.confidence * 100, 2)}. Rule: ${selectedEval.overlayReason}.`;
  $("our-quote").innerHTML = quoteMarkup(quoteEval.higherPayout, quoteEval.lowerPayout, quoteEval.favoredSide);
  $("our-quote-note").textContent = `Owner: Manabesh. Higher / Lower payouts at ${state.edgePct.toFixed(1)}% edge.`;
  $("model-prob").textContent = `${formatPct(quoteEval.adjProbUp * 100, 2)} up`;
  $("model-prob-note").textContent = config.engine === "turbo_legacy_short"
    ? `Recovered turbo short MID ${formatPct(quoteEval.adjProbUp * 100, 2)} from legacy depth model; evaluated ${formatDateTime(features.eval_ts)}.`
    : `Turbo bucket MID ${formatPct(quoteEval.adjProbUp * 100, 2)} from ${selectedEval.overlayReason}; evaluated ${formatDateTime(features.eval_ts)}.`;
  $("our-fair-mid").textContent = `${formatPct(quoteEval.adjProbUp * 100, 2)} / ${formatPct((1 - quoteEval.adjProbUp) * 100, 2)}`;
  $("model1-mid").textContent = "-";
  $("model2-mid").textContent = "-";
  $("model3-mid").textContent = "-";
  $("blend-mid").textContent = "-";
  $("model-status").textContent = "Live signal";
  $("model-summary").textContent = config.notes.production_rationale;
  $("alpha-summary").textContent = config.engine === "turbo_legacy_short"
    ? `Recovered BTC short-tenor turbo setup. ` +
      `30s metric uplift ${formatNum(config.legacy_short?.uplift_last7, 0)} over last 7d${config.product === "1m" ? "; 1m uses the softer earlier step scale." : "."}`
    : `Turbo alpha ${selectedEval.effectiveAlpha.toFixed(2)}. Short tenors follow the recovered earlier setup; longer tenors follow the earlier turbo bucket ladders.`;
  $("feed-summary").textContent = config.notes.selection_metric || config.notes.production_rationale;
  $("active-driver").textContent = config.engine === "turbo_legacy_short"
    ? `${selectedEval.signalFeed} ${config.legacy_short?.lookback_s || 10}s legacy short`
    : "Turbo move bucket";
  $("active-lookback").textContent = config.engine === "turbo_legacy_short"
    ? `${config.legacy_short?.lookback_s || 10}s`
    : `${Number(config.lookback_s || config.duration_s)}s`;

  if (platform) {
    const upRate = Number(platform.bid_return_rate);
    const downRate = Number(platform.ask_return_rate);
    const up = upRate * 100;
    const down = downRate * 100;
    const implied = impliedQuoteStats(upRate, downRate);
    const higherOwner = platform.bid_owner || "public aggregate (provider unavailable)";
    const lowerOwner = platform.ask_owner || "public aggregate (provider unavailable)";
    $("platform-quote").textContent = `${formatNum(up)} / ${formatNum(down)}`;
    $("platform-quote-note").textContent = `All-in public ${config.product} quote for ${config.pair}. Higher owner: ${higherOwner}. Lower owner: ${lowerOwner}.`;
    $("platform-edge").textContent = implied ? formatPct(implied.edgePct, 2) : "-";
    $("platform-mid").textContent = implied ? `${formatPct(implied.pUp * 100, 2)} / ${formatPct(implied.pDown * 100, 2)}` : "-";
    $("platform-skew").textContent = implied ? formatSigned(implied.skewPp, 2, "pp") : "-";
    $("platform-owners").textContent = `Higher: ${higherOwner} / Lower: ${lowerOwner}`;
    $("mid-gap-vs-aggregate").textContent = implied
      ? formatSigned((quoteEval.adjProbUp - implied.pUp) * 100, 2, "pp")
      : "-";
  } else {
    $("platform-quote").textContent = "-";
    $("platform-quote-note").textContent = "No current public quote found for this pair/duration.";
    $("platform-edge").textContent = "-";
    $("platform-mid").textContent = "-";
    $("platform-skew").textContent = "-";
    $("platform-owners").textContent = "-";
    $("mid-gap-vs-aggregate").textContent = "-";
  }

  renderFeatureTable(features, config);
}

function render() {
  syncTopTabs();
  $("page-time").textContent = formatDateTime(Date.now());
  if (state.viewMode !== "live") {
    renderAdminView();
    return;
  }
  if (state.familyMode === "turbo") {
    const config = currentTurboConfig();
    const market = currentMarket();
    if (!config) {
      $("controls-note").textContent = "No turbo config loaded for the selected pair/product.";
      return;
    }
    renderTurboFamily(config, market);
    return;
  }
  const config = currentConfig();
  const model1Config = currentConfigFor("model1");
  const model2Config = currentConfigFor("model2");
  const model3Config = currentConfigFor("model3");
  const market = currentMarket();
  if ($("hero-copy")) {
    $("hero-copy").textContent = "Compare Chainlink Model 1, Model 2, and Model 3, blend an alternate model into the selected quote engine, and recompute the MID every second. It shows our live MID and quote, the all-in aggregate market quote, the deployed baseline, and the gap between our model and the public market.";
  }
  if (!config) {
    $("controls-note").textContent = "No model config loaded for the selected pair/product.";
    return;
  }
  const warmup = warmupState(config, market);
  const reloadText = state.lastReloadedAt ? ` Last reload ${formatDateTime(state.lastReloadedAt)}.` : "";
  const alphaMode = Number.isFinite(state.alphaOverride) ? `override ${state.alphaOverride.toFixed(2)}` : `config ${config.alpha.toFixed(2)}`;
  const deployedModelKey = deployedModelKeyForProduct(config);
  const viewedModelLabel = modelLabel(state.modelMode);
  const blendModelKey = sanitizeBlendModel(state.modelMode, state.blendModelMode);
  const blendModelLabel = modelLabel(blendModelKey);
  const blendDescription = blendModelKey === "none"
    ? "no blend active"
    : `blend with ${blendModelLabel} at ${state.model2BlendPct.toFixed(0)}%`;
  $("controls-note").textContent = `Loaded ${viewedModelLabel} for ${config.pair} ${config.product}: alpha ${alphaMode}, ${blendDescription}, payout floor ${config.favored_payout_floor.toFixed(0)}. Deployed baseline: ${modelLabel(deployedModelKey)}.${reloadText}`;
  const model1Features = model1Config ? computeFeatures(model1Config, market) : null;
  const model2Features = model2Config ? computeFeatures(model2Config, market) : null;
  const model3Features = model3Config ? computeFeatures(model3Config, market) : null;
  const model1Eval = model1Features ? evaluateModel(model1Config, model1Features) : null;
  const model2Eval = model2Features ? evaluateModel(model2Config, model2Features) : null;
  const model3Eval = model3Features ? evaluateModel(model3Config, model3Features) : null;
  const features = state.modelMode === "model2"
    ? model2Features
    : state.modelMode === "model3"
      ? model3Features
      : model1Features;
  const selectedEval = state.modelMode === "model2"
    ? model2Eval
    : state.modelMode === "model3"
      ? model3Eval
      : model1Eval;
  const model1Prob = model1Eval?.adjProbUp;
  const model2Prob = model2Eval?.adjProbUp;
  const model3Prob = model3Eval?.adjProbUp;
  const selectedProb = state.modelMode === "model2"
    ? model2Prob
    : state.modelMode === "model3"
      ? model3Prob
      : model1Prob;
  const selectedBlendProb = blendModelKey === "model2"
    ? model2Prob
    : blendModelKey === "model3"
      ? model3Prob
      : blendModelKey === "model1"
        ? model1Prob
        : NaN;
  const blendWeight = state.model2BlendPct / 100;
  const useBlend = blendModelKey !== "none" && state.model2BlendPct > 0 && Number.isFinite(selectedProb) && Number.isFinite(selectedBlendProb);
  const blendedProb = useBlend
    ? (1 - blendWeight) * selectedProb + blendWeight * selectedBlendProb
    : selectedProb;
  const quoteModelLabel = useBlend
    ? `${viewedModelLabel} + ${state.model2BlendPct.toFixed(0)}% ${blendModelLabel}`
    : viewedModelLabel;
  const quoteEval = blendedQuoteEval(
    blendedProb,
    config,
    quoteModelLabel,
    model1Eval,
    model2Eval,
  );
  const platform = state.platformQuotes[`${config.pair}::${config.duration_s}`];
  const alphaRows = currentAlphaProxyRows();
  const sigRow = alphaRows.find((row) => row.pool_name === "SIG");
  const naytRow = alphaRows.find((row) => row.pool_name === "Nayt");
  const manabeshRow = alphaRows.find((row) => row.pool_name === "Manabesh");

  $("chainlink-mid").textContent = formatNum(market.chainlink);
  $("spot-mid").textContent = formatNum(market.spot);
  $("perp-mid").textContent = formatNum(market.perp);
  $("our-fair-mid").textContent = quoteEval ? `${formatPct(quoteEval.adjProbUp * 100, 2)} / ${formatPct((1 - quoteEval.adjProbUp) * 100, 2)}` : "-";
  $("model1-mid").textContent = model1Eval ? `${formatPct(model1Eval.adjProbUp * 100, 2)} / ${formatPct((1 - model1Eval.adjProbUp) * 100, 2)}` : "-";
  $("model2-mid").textContent = model2Eval ? `${formatPct(model2Eval.adjProbUp * 100, 2)} / ${formatPct((1 - model2Eval.adjProbUp) * 100, 2)}` : "-";
  $("model3-mid").textContent = model3Eval ? `${formatPct(model3Eval.adjProbUp * 100, 2)} / ${formatPct((1 - model3Eval.adjProbUp) * 100, 2)}` : "-";
  $("blend-mid").textContent = quoteEval ? `${formatPct(quoteEval.adjProbUp * 100, 2)} / ${formatPct((1 - quoteEval.adjProbUp) * 100, 2)}` : "-";
  $("deployed-model").textContent = modelLabel(deployedModelKey);
  $("viewing-model").textContent = useBlend ? `${quoteModelLabel}` : `${viewedModelLabel}`;
  $("last-update").textContent = formatDateTime(market.lastUpdateTs);
  const spotStructuralGap = config.structural_gaps?.spot_gap_bp;
  const perpStructuralGap = config.structural_gaps?.perp_gap_bp;
  $("struct-spot").textContent = Number.isFinite(Number(spotStructuralGap)) ? formatSigned(spotStructuralGap, 2, "bp") : "-";
  $("struct-perp").textContent = Number.isFinite(Number(perpStructuralGap)) ? formatSigned(perpStructuralGap, 2, "bp") : "-";

  if (features && selectedEval && quoteEval) {
    $("gap-spot").textContent = formatSigned(features.gap_spot_bp, 2, "bp");
    $("gap-perp").textContent = formatSigned(features.gap_perp_bp, 2, "bp");
    $("spot-perp-spread").textContent = formatSigned(features.spot_perp_spread_bp, 2, "bp");
    $("signal-side").innerHTML = signalMarkup(quoteEval.favoredSide);
    $("signal-note").textContent = `${quoteEval.modelModeLabel} active. Confidence ${formatPct(quoteEval.confidence * 100, 2)}. ${selectedEval.overlayReason ? `Rule: ${selectedEval.overlayReason}. ` : ""}${config.notes.starter_logic || config.notes.basis_story}`;
    $("our-quote").innerHTML = Number.isFinite(quoteEval.higherPayout) && Number.isFinite(quoteEval.lowerPayout)
      ? quoteMarkup(quoteEval.higherPayout, quoteEval.lowerPayout, quoteEval.favoredSide)
      : '<span class="signal-pill">No Quote</span>';
    $("our-quote-note").textContent = Number.isFinite(quoteEval.higherPayout) && Number.isFinite(quoteEval.lowerPayout)
      ? `Owner: Manabesh. Higher / Lower payouts at ${state.edgePct.toFixed(1)}% edge.`
      : "No current quote.";
    $("model-prob").textContent = `${formatPct(quoteEval.adjProbUp * 100, 2)} up`;
    const capLabel = `${config.favored_payout_floor.toFixed(0)}-floor cap ${formatPct(maxDefendableProbability(state.edgePct, config.favored_payout_floor) * 100, 2)}`;
    $("model-prob-note").textContent = `Model 1 ${Number.isFinite(model1Prob) ? formatPct(model1Prob * 100, 2) : "-"} / Model 2 ${Number.isFinite(model2Prob) ? formatPct(model2Prob * 100, 2) : "-"} / Model 3 ${Number.isFinite(model3Prob) ? formatPct(model3Prob * 100, 2) : "-"} / Final ${formatPct(quoteEval.adjProbUp * 100, 2)} (${capLabel}); evaluated ${formatDateTime(features.eval_ts)} for entry in 1s.`;
    $("model-status").textContent = "Live signal";
    $("model-summary").textContent = `${config.product} deployed baseline: ${modelLabel(deployedModelKey)}. Quote engine: ${viewedModelLabel}${useBlend ? ` blended with ${blendModelLabel} at ${state.model2BlendPct.toFixed(0)}%` : ""}.`;
    $("alpha-summary").textContent = `Our alpha ${selectedEval.effectiveAlpha.toFixed(2)}. Observed last-8h alpha proxy${state.alphaProxyMeta ? ` (assumed ${state.alphaProxyMeta.assumed_edge_pct.toFixed(0)}% edge)` : ""}: SIG ${sigRow ? formatNum(sigRow.alpha_proxy_mean, 2) : "-"}, Nayt ${naytRow ? formatNum(naytRow.alpha_proxy_mean, 2) : "-"}, Manabesh ${manabeshRow ? formatNum(manabeshRow.alpha_proxy_mean, 2) : "-"}.`;
    $("feed-summary").textContent = config.notes.production_rationale || config.notes.starter_logic || config.notes.basis_story || config.notes.selection_metric;
    $("active-driver").textContent = config.short_tenor_rule
      ? `${selectedEval.signalFeed} ${config.short_tenor_rule.lookback_s}s ${config.short_tenor_rule.style}`
      : config.engine === "chainlink_bucket"
      ? "Chainlink move bucket"
      : "Basis-aware calibrated production model";
    $("active-lookback").textContent = config.short_tenor_rule
      ? `${Number(config.short_tenor_rule.lookback_s)}s`
      : config.engine === "chainlink_bucket"
      ? `${Number(config.lookback_s || config.duration_s)}s`
      : "Mixed basis + return features";
  } else {
    $("gap-spot").textContent = "-";
    $("gap-perp").textContent = "-";
    $("spot-perp-spread").textContent = "-";
    $("model1-mid").textContent = "-";
    $("model2-mid").textContent = "-";
    $("model3-mid").textContent = "-";
    $("blend-mid").textContent = "-";
    $("signal-side").innerHTML = signalMarkup("Warm-up");
    $("signal-note").textContent = `Building live history for ${config.product}. Warm-up ${formatPct(warmup.progress * 100, 0)} complete; quoting flat until the model is ready.`;
    const flatPayout = payoutForProbability(0.5, state.edgePct);
    $("our-quote").innerHTML = quoteMarkup(flatPayout, flatPayout, "Warm-up");
    $("our-quote-note").textContent = "Owner: Manabesh. Warm-up fallback quote: flat 50/50.";
    $("model-prob").textContent = "-";
    $("model-prob-note").textContent = `Need about ${Math.round(warmup.requiredMs / 1000)}s of live history; currently have ${Math.round(warmup.ageMs / 1000)}s.`;
    $("model-status").textContent = "Warm-up flat quote";
    $("model-summary").textContent = `${config.product} selected model loaded. Quote engine: ${viewedModelLabel}${blendModelKey !== "none" && state.model2BlendPct > 0 ? ` blended with ${blendModelLabel} at ${state.model2BlendPct.toFixed(0)}%` : ""}. Live model will take over once enough spot/perp/Chainlink history is built.`;
    $("alpha-summary").textContent = `Observed last-8h alpha proxy${state.alphaProxyMeta ? ` (assumed ${state.alphaProxyMeta.assumed_edge_pct.toFixed(0)}% edge)` : ""}: SIG ${sigRow ? formatNum(sigRow.alpha_proxy_mean, 2) : "-"}, Nayt ${naytRow ? formatNum(naytRow.alpha_proxy_mean, 2) : "-"}, Manabesh ${manabeshRow ? formatNum(manabeshRow.alpha_proxy_mean, 2) : "-"}. Our active alpha is ${Number.isFinite(state.alphaOverride) ? state.alphaOverride.toFixed(2) : config.alpha.toFixed(2)}.`;
    $("feed-summary").textContent = config.notes.production_rationale || config.notes.starter_logic || config.notes.basis_story;
    $("active-driver").textContent = config.short_tenor_rule
      ? `${config.short_tenor_rule.source} ${config.short_tenor_rule.lookback_s}s ${config.short_tenor_rule.style}`
      : config.engine === "chainlink_bucket"
      ? "Chainlink move bucket"
      : "Basis-aware calibrated production model";
    $("active-lookback").textContent = config.short_tenor_rule
      ? `${Number(config.short_tenor_rule.lookback_s)}s`
      : config.engine === "chainlink_bucket"
      ? `${Number(config.lookback_s || config.duration_s)}s`
      : "Mixed basis + return features";
  }

  if (platform) {
    const upRate = Number(platform.bid_return_rate);
    const downRate = Number(platform.ask_return_rate);
    const up = upRate * 100;
    const down = downRate * 100;
    const implied = impliedQuoteStats(upRate, downRate);
    const higherOwner = platform.bid_owner || "public aggregate (provider unavailable)";
    const lowerOwner = platform.ask_owner || "public aggregate (provider unavailable)";
    $("platform-quote").textContent = `${formatNum(up)} / ${formatNum(down)}`;
    $("platform-quote-note").textContent = implied
      ? `All-in public ${config.product} quote for ${config.pair}. Higher owner: ${higherOwner}. Lower owner: ${lowerOwner}.`
      : `Public ${config.product} quote for ${config.pair}`;
    $("platform-edge").textContent = implied ? formatPct(implied.edgePct, 2) : "-";
    $("platform-mid").textContent = implied ? `${formatPct(implied.pUp * 100, 2)} / ${formatPct(implied.pDown * 100, 2)}` : "-";
    $("platform-skew").textContent = implied ? formatSigned(implied.skewPp, 2, "pp") : "-";
    $("platform-owners").textContent = `Higher: ${higherOwner} / Lower: ${lowerOwner}`;
    $("mid-gap-vs-aggregate").textContent = implied && quoteEval
      ? formatSigned((quoteEval.adjProbUp - implied.pUp) * 100, 2, "pp")
      : "-";
  } else {
    $("platform-quote").textContent = "-";
    $("platform-quote-note").textContent = "No current public quote found for this pair/duration.";
    $("platform-edge").textContent = "-";
    $("platform-mid").textContent = "-";
    $("platform-skew").textContent = "-";
    $("platform-owners").textContent = "-";
    $("mid-gap-vs-aggregate").textContent = "-";
  }

  renderFeatureTable(features, config);
}

function renderAdminView() {
  const isCalibrate = state.viewMode === "calibrate";
  $("admin-eyebrow").textContent = isCalibrate ? "Research" : "Review";
  $("admin-title").textContent = isCalibrate ? "Calibration Workspace" : "Candidate Models";
  $("admin-copy").textContent = isCalibrate
    ? "This tab is where we should run offline replay, regenerate ladders, and create a candidate model without touching the live quote engine. It is the right place for a future Calibrate button."
    : "This tab is where generated candidate models should be reviewed before promotion. The goal is to compare current live logic against saved candidate versions and then approve, reject, or export them.";
  $("admin-scope").textContent = isCalibrate ? `${familyLabel()} family research` : `${familyLabel()} candidate review`;
  $("admin-state").textContent = isCalibrate ? "Structure is live; calibration actions not yet wired" : "Structure is live; candidate storage/promotion not yet wired";
  $("admin-output").textContent = isCalibrate
    ? "Candidate JSON + report + ladder summary"
    : "Current vs candidate comparison + promote/discard controls";
  $("admin-promotion").textContent = "Human review before deploy";
  $("admin-note").textContent = isCalibrate
    ? "Today this is a structured placeholder. The live dashboard remains fully functional while calibration gets built separately."
    : "Today this is a structured placeholder. The next step would be persisting candidate versions and adding explicit promote/discard actions.";
}

function bindControls() {
  $("top-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    state.viewMode = button.dataset.view;
    render();
  });
  $("family-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-family]");
    if (!button) return;
    state.familyMode = button.dataset.family;
    populateSelectors();
    render();
  });
  $("pair-select").addEventListener("change", (event) => {
    state.selectedPair = event.target.value;
    populateSelectors();
    render();
  });
  $("pair-chips").addEventListener("click", (event) => {
    const button = event.target.closest("[data-pair]");
    if (!button) return;
    state.selectedPair = button.dataset.pair;
    populateSelectors();
    render();
  });
  $("model-select").addEventListener("change", (event) => {
    state.modelMode = event.target.value;
    state.blendModelMode = sanitizeBlendModel(state.modelMode, state.blendModelMode);
    syncBlendControls();
    render();
  });
  $("blend-model-select").addEventListener("change", (event) => {
    state.blendModelMode = sanitizeBlendModel(state.modelMode, event.target.value);
    syncBlendControls();
    render();
  });
  $("product-select").addEventListener("change", (event) => {
    state.selectedProduct = event.target.value;
    populateSelectors();
    render();
  });
  $("product-chips").addEventListener("click", (event) => {
    const button = event.target.closest("[data-product]");
    if (!button) return;
    state.selectedProduct = button.dataset.product;
    populateSelectors();
    render();
  });
  $("edge-input").addEventListener("change", (event) => {
    state.edgePct = Number(event.target.value) || 4.0;
    render();
  });
  $("alpha-override").addEventListener("change", (event) => {
    const value = event.target.value;
    state.alphaOverride = value === "auto" ? null : Number(value);
    render();
  });
  $("blend-input").addEventListener("input", (event) => {
    state.model2BlendPct = Number(event.target.value) || 0;
    syncBlendControls();
    render();
  });
  $("blend-number").addEventListener("input", (event) => {
    const raw = Number(event.target.value);
    state.model2BlendPct = Number.isFinite(raw) ? clamp(raw, 0, 100) : 0;
    syncBlendControls();
    render();
  });
  $("refresh-btn").addEventListener("click", async () => {
    const button = $("refresh-btn");
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Reloading...";
    try {
      await loadConfigs();
      await loadAlphaProxies();
      await fetchPlatformQuotes();
      await pollChainlink();
      await pollTurbo();
      await pollTurboLegacyShort();
      await pollBinance();
      render();
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  });
}

async function init() {
  bindControls();
  syncFamilyTabs();
  $("model-select").value = state.modelMode;
  $("blend-input").value = String(state.model2BlendPct);
  syncBlendControls();
  await loadConfigs();
  await loadAlphaProxies();
  await preloadServerHistories();
  await fetchPlatformQuotes();
  await pollChainlink();
  await pollTurbo();
  await pollTurboLegacyShort();
  await pollBinance();
  chainlinkTimer = window.setInterval(pollChainlink, CL_POLL_MS);
  turboTimer = window.setInterval(pollTurbo, MARKET_POLL_MS);
  turboLegacyTimer = window.setInterval(pollTurboLegacyShort, MARKET_POLL_MS);
  marketTimer = window.setInterval(pollBinance, MARKET_POLL_MS);
  snapshotTimer = window.setInterval(recordSnapshots, SNAPSHOT_MS);
  renderTimer = window.setInterval(render, RENDER_MS);
}

init().catch((error) => {
  console.error(error);
  $("controls-note").textContent = `Init failed: ${error.message}`;
});
