"use strict";

const params = new URLSearchParams(window.location.search);
const CONFIG_MODE = params.get("config") || "final";
const DEFAULT_FAMILY = params.get("family") || "chainlink";
const ALPHA_PROXY_URL = "./outputs/pool_alpha_proxy_last8h.json";
const PLATFORM_CONFIG_URL = "https://apis.turboflow.xyz/public/pm/config?version=2";
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
  configs: {},
  modelFamily: DEFAULT_FAMILY,
  selectedPair: "BTC/USDT",
  selectedProduct: "30s",
  edgePct: 4.0,
  alphaOverride: null,
  lastReloadedAt: null,
  platformQuotes: {},
  alphaProxyRows: [],
  alphaProxyMeta: null,
  market: {
    "BTC/USDT": { chainlink: null, turbo: null, spot: null, perp: null, lastUpdateTs: null, history: [] },
    "ETH/USDT": { chainlink: null, turbo: null, spot: null, perp: null, lastUpdateTs: null, history: [] },
  },
  turboBucketMemory: {},
};

let snapshotTimer = null;
let chainlinkTimer = null;
let marketTimer = null;
let renderTimer = null;
let turboTimer = null;

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
  return state.configs[`${state.selectedPair}::${state.selectedProduct}`] || null;
}

function currentMarket() {
  return state.market[state.selectedPair];
}

function currentStateKey() {
  return `${state.modelFamily}::${state.selectedPair}::${state.selectedProduct}`;
}

function currentAlphaProxyRows() {
  return state.alphaProxyRows.filter(
    (row) => row.pair === state.selectedPair && row.product === state.selectedProduct,
  );
}

function parseJsonLenient(text) {
  return JSON.parse(
    text.replace(/\bNaN\b/g, "null"),
  );
}

function sortBucketRules(bucketRules) {
  return [...bucketRules].sort((a, b) => Number(a.min_abs_bp || 0) - Number(b.min_abs_bp || 0));
}

function pickTurboBucket(absMove, bucketRules, memoryKey) {
  const sortedRules = sortBucketRules(bucketRules);
  const direct = sortedRules.find(
    (rule) => absMove >= Number(rule.min_abs_bp || 0)
      && (rule.max_abs_bp == null || absMove < Number(rule.max_abs_bp)),
  ) || null;
  const previousLabel = state.turboBucketMemory[memoryKey];
  if (!previousLabel) {
    if (direct) state.turboBucketMemory[memoryKey] = direct.label;
    return direct;
  }
  const previous = sortedRules.find((rule) => rule.label === previousLabel);
  if (!previous) {
    if (direct) state.turboBucketMemory[memoryKey] = direct.label;
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
    state.turboBucketMemory[memoryKey] = direct.label;
    return direct;
  }
  return previous;
}

function configUrlForCurrentFamily() {
  if (state.modelFamily === "turbo") {
    return "./outputs/turbo_product_suite_final_models.json";
  }
  return CONFIG_MODE === "raw"
    ? "./outputs/chainlink_product_suite_best_models.json"
    : CONFIG_MODE === "v2"
      ? "./outputs/chainlink_product_suite_v2_models.json"
      : CONFIG_MODE === "mid"
        ? "./outputs/chainlink_product_suite_mid_models.json"
        : CONFIG_MODE === "prod"
          ? "./outputs/chainlink_product_suite_prod_models.json"
          : "./outputs/chainlink_product_suite_final_models.json";
}

function warmupState(config, market) {
  const requiredMs = config.duration_s * 2 * 1000;
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
  if (config.engine === "turbo_disabled") {
    return { eval_ts: Date.now(), disabled: true };
  }
  if (config.engine === "turbo_bucket") {
    const latest = market.history.length ? market.history[market.history.length - 1] : null;
    const evalTs = latest ? latest.ts : Date.now();
    const lookbackMs = Number(config.lookback_s || config.duration_s) * 1000;
    const current = pointAtOrBefore(market.history, evalTs);
    const prev = pointAtOrBefore(market.history, evalTs - lookbackMs);
    if (!current || !prev || !Number.isFinite(current.turbo) || !Number.isFinite(prev.turbo)) return null;
    const turboMoveBp = (current.turbo / prev.turbo - 1) * 10000;
    const absMove = Math.abs(turboMoveBp);
    const bucketRules = Array.isArray(config.bucket_rules) ? config.bucket_rules : [];
    const bucket = pickTurboBucket(absMove, bucketRules, currentStateKey());
    return {
      eval_ts: evalTs,
      turbo_now: current.turbo,
      turbo_prev: prev.turbo,
      turbo_move_bp: turboMoveBp,
      turbo_abs_move_bp: absMove,
      platform_skew_pp: 0,
      active_bucket_label: bucket ? bucket.label : "none",
      active_bucket_mode: bucket ? bucket.mode : "flat",
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
  if (config.engine === "turbo_disabled") {
    return {
      rawProbUpBase: 0.5,
      rawProbUp: 0.5,
      calibratedProbUp: 0.5,
      modelProbUp: 0.5,
      adjProbUp: 0.5,
      effectiveAlpha: Number.isFinite(state.alphaOverride) ? state.alphaOverride : config.alpha,
      confidence: 0,
      active: false,
      inactiveMode: "suppress",
      overlayReason: "product_off",
      favoredSide: "Standby",
      favoredProb: 0.5,
      favoredPayout: NaN,
      otherPayout: NaN,
      higherPayout: NaN,
      lowerPayout: NaN,
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
  const keys = Object.keys(state.configs);
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
}

async function loadConfigs() {
  const response = await fetch(configUrlForCurrentFamily(), { cache: "no-store" });
  state.configs = parseJsonLenient(await response.text());
  state.lastReloadedAt = Date.now();
  const firstKey = Object.keys(state.configs)[0];
  if (firstKey) {
    const [pair, product] = firstKey.split("::");
    if (!state.configs[`${state.selectedPair}::${state.selectedProduct}`]) {
      state.selectedPair = pair;
      state.selectedProduct = product;
    }
  }
  populateSelectors();
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
          };
        }
      } else if (Array.isArray(row.durations)) {
        for (const duration of row.durations) {
          next[`${row.pair_name}::${duration}`] = {
            pair_name: row.pair_name,
            duration: Number(duration),
            bid_return_rate: row.bid_return_rate,
            ask_return_rate: row.ask_return_rate,
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
  if (config.engine === "turbo_disabled") {
    body.innerHTML = `<tr><td>status</td><td>off</td><td>Turbo model has this product turned off.</td></tr>`;
    return;
  }
  if (config.engine === "turbo_bucket") {
    body.innerHTML = `
      <tr><td>turbo_move_bp</td><td>${formatSigned(features.turbo_move_bp, 3, "bp")}</td><td>Own-feed move over the selected lookback.</td></tr>
      <tr><td>turbo_abs_move_bp</td><td>${formatSigned(features.turbo_abs_move_bp, 3, "bp")}</td><td>Absolute move size used for bucket selection.</td></tr>
      <tr><td>active_bucket_label</td><td>${features.active_bucket_label}</td><td>Backtested move bucket.</td></tr>
      <tr><td>active_bucket_mode</td><td>${features.active_bucket_mode}</td><td>Bucket style from 7-day turbo replay.</td></tr>
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

function render() {
  const config = currentConfig();
  const market = currentMarket();
  $("page-time").textContent = formatDateTime(Date.now());
  if (!config) {
    $("controls-note").textContent = "No model config loaded for the selected pair/product.";
    return;
  }
  const warmup = warmupState(config, market);
  const reloadText = state.lastReloadedAt ? ` Last reload ${formatDateTime(state.lastReloadedAt)}.` : "";
  const alphaMode = Number.isFinite(state.alphaOverride) ? `override ${state.alphaOverride.toFixed(2)}` : `config ${config.alpha.toFixed(2)}`;
  $("controls-note").textContent = `Loaded ${state.modelFamily} ${configModeLabel()} ${config.pair} ${config.product} model: alpha ${alphaMode}, margin ${formatPct(config.margin * 100, 1)}, payout floor ${config.favored_payout_floor.toFixed(0)}.${reloadText}`;
  const features = computeFeatures(config, market);
  const modelEval = features ? evaluateModel(config, features) : null;
  const platform = state.platformQuotes[`${config.pair}::${config.duration_s}`];
  const alphaRows = currentAlphaProxyRows();
  const sigRow = alphaRows.find((row) => row.pool_name === "SIG");
  const naytRow = alphaRows.find((row) => row.pool_name === "Nayt");
  const manabeshRow = alphaRows.find((row) => row.pool_name === "Manabesh");

  $("chainlink-mid").textContent = formatNum(state.modelFamily === "turbo" ? market.turbo : market.chainlink);
  $("spot-mid").textContent = formatNum(market.spot);
  $("perp-mid").textContent = formatNum(market.perp);
  $("our-fair-mid").textContent = modelEval ? `${formatPct(modelEval.adjProbUp * 100, 2)} / ${formatPct((1 - modelEval.adjProbUp) * 100, 2)}` : "-";
  $("last-update").textContent = formatDateTime(market.lastUpdateTs);
  const spotStructuralGap = config.structural_gaps?.spot_gap_bp;
  const perpStructuralGap = config.structural_gaps?.perp_gap_bp;
  $("struct-spot").textContent = Number.isFinite(Number(spotStructuralGap)) ? formatSigned(spotStructuralGap, 2, "bp") : "-";
  $("struct-perp").textContent = Number.isFinite(Number(perpStructuralGap)) ? formatSigned(perpStructuralGap, 2, "bp") : "-";

  if (features && modelEval) {
    $("gap-spot").textContent = formatSigned(features.gap_spot_bp, 2, "bp");
    $("gap-perp").textContent = formatSigned(features.gap_perp_bp, 2, "bp");
    $("spot-perp-spread").textContent = formatSigned(features.spot_perp_spread_bp, 2, "bp");
    $("signal-side").innerHTML = signalMarkup(modelEval.favoredSide);
    if (modelEval.active) {
    $("signal-note").textContent = `Confidence ${formatPct(modelEval.confidence * 100, 2)}. ${modelEval.overlayReason ? `Overlay: ${modelEval.overlayReason}. ` : ""}${config.notes.starter_logic || config.notes.basis_story}`;
    } else if (modelEval.inactiveMode === "suppress") {
      $("signal-note").textContent = "Outside the replay-max active region, so this product stands down instead of quoting neutral.";
    } else {
      $("signal-note").textContent = "Inside the neutral band; this profile stays close to flat.";
    }
    $("our-quote").innerHTML = Number.isFinite(modelEval.higherPayout) && Number.isFinite(modelEval.lowerPayout)
      ? quoteMarkup(modelEval.higherPayout, modelEval.lowerPayout, modelEval.favoredSide)
      : '<span class="signal-pill">No Quote</span>';
    $("our-quote-note").textContent = Number.isFinite(modelEval.higherPayout) && Number.isFinite(modelEval.lowerPayout)
      ? `Higher / Lower payouts at ${state.edgePct.toFixed(1)}% edge`
      : "Suppressed until confidence clears the active threshold.";
    $("model-prob").textContent = `${formatPct(modelEval.adjProbUp * 100, 2)} up`;
    const capLabel = `${config.favored_payout_floor.toFixed(0)}-floor cap ${formatPct(maxDefendableProbability(state.edgePct, config.favored_payout_floor) * 100, 2)}`;
    $("model-prob-note").textContent = `${config.calibration ? `${config.calibration.kind} calibrated ` : ""}Raw ${formatPct(modelEval.rawProbUpBase * 100, 2)} -> fair ${formatPct(modelEval.rawProbUp * 100, 2)}${modelEval.overlayReason ? ` -> overlay ${formatPct(modelEval.modelProbUp * 100, 2)}` : ""} -> adjusted ${formatPct(modelEval.adjProbUp * 100, 2)} (${capLabel}); evaluated ${formatDateTime(features.eval_ts)} for entry in 1s.`;
    $("model-status").textContent = modelEval.active ? "Live signal" : modelEval.inactiveMode === "suppress" ? "Standby / No Quote" : "Neutral band";
    $("model-summary").textContent = `${config.product} ${configModeLabel().toLowerCase()} uses ${config.model.features.length} features, hard floor-only skew, and ${config.notes.selection_metric}`;
    $("alpha-summary").textContent = `Our alpha ${modelEval.effectiveAlpha.toFixed(2)}. Observed last-8h alpha proxy${state.alphaProxyMeta ? ` (assumed ${state.alphaProxyMeta.assumed_edge_pct.toFixed(0)}% edge)` : ""}: SIG ${sigRow ? formatNum(sigRow.alpha_proxy_mean, 2) : "-"}, Nayt ${naytRow ? formatNum(naytRow.alpha_proxy_mean, 2) : "-"}, Manabesh ${manabeshRow ? formatNum(manabeshRow.alpha_proxy_mean, 2) : "-"}.`;
    if (Number.isFinite(Number(spotStructuralGap)) || Number.isFinite(Number(perpStructuralGap))) {
      $("feed-summary").textContent = `${config.notes.starter_logic || config.notes.basis_story} Structural gaps: spot ${Number.isFinite(Number(spotStructuralGap)) ? formatSigned(spotStructuralGap, 2, "bp") : "-"}, perp ${Number.isFinite(Number(perpStructuralGap)) ? formatSigned(perpStructuralGap, 2, "bp") : "-"}.`;
    } else {
      $("feed-summary").textContent = config.notes.production_rationale || config.notes.basis_story || config.notes.selection_metric;
    }
  } else {
    $("gap-spot").textContent = "-";
    $("gap-perp").textContent = "-";
    $("spot-perp-spread").textContent = "-";
    $("signal-side").innerHTML = signalMarkup("Warm-up");
    $("signal-note").textContent = `Building live history for ${config.product}. Warm-up ${formatPct(warmup.progress * 100, 0)} complete; quoting flat until the model is ready.`;
    const flatPayout = payoutForProbability(0.5, state.edgePct);
    $("our-quote").innerHTML = quoteMarkup(flatPayout, flatPayout, "Warm-up");
    $("our-quote-note").textContent = "Warm-up fallback quote: flat 50/50.";
    $("model-prob").textContent = "-";
    $("model-prob-note").textContent = `Need about ${Math.round(warmup.requiredMs / 1000)}s of live history; currently have ${Math.round(warmup.ageMs / 1000)}s.`;
    $("model-status").textContent = "Warm-up flat quote";
    $("model-summary").textContent = `${config.product} ${configModeLabel().toLowerCase()} loaded; live model will take over once enough spot/perp/Chainlink history is built.`;
    $("alpha-summary").textContent = `Observed last-8h alpha proxy${state.alphaProxyMeta ? ` (assumed ${state.alphaProxyMeta.assumed_edge_pct.toFixed(0)}% edge)` : ""}: SIG ${sigRow ? formatNum(sigRow.alpha_proxy_mean, 2) : "-"}, Nayt ${naytRow ? formatNum(naytRow.alpha_proxy_mean, 2) : "-"}, Manabesh ${manabeshRow ? formatNum(manabeshRow.alpha_proxy_mean, 2) : "-"}. Our active alpha is ${Number.isFinite(state.alphaOverride) ? state.alphaOverride.toFixed(2) : config.alpha.toFixed(2)}.`;
    $("feed-summary").textContent = config.notes.production_rationale || config.notes.basis_story;
  }

  if (platform) {
    const upRate = Number(platform.bid_return_rate);
    const downRate = Number(platform.ask_return_rate);
    const up = upRate * 100;
    const down = downRate * 100;
    const implied = impliedQuoteStats(upRate, downRate);
    $("platform-quote").textContent = `${formatNum(up)} / ${formatNum(down)}`;
    $("platform-quote-note").textContent = implied
      ? `Public ${config.product} quote for ${config.pair}. Implied edge ${formatPct(implied.edgePct, 2)}, implied mid ${formatPct(implied.pUp * 100, 2)} / ${formatPct(implied.pDown * 100, 2)}.`
      : `Public ${config.product} quote for ${config.pair}`;
    $("platform-edge").textContent = implied ? formatPct(implied.edgePct, 2) : "-";
    $("platform-mid").textContent = implied ? `${formatPct(implied.pUp * 100, 2)} / ${formatPct(implied.pDown * 100, 2)}` : "-";
    $("platform-skew").textContent = implied ? formatSigned(implied.skewPp, 2, "pp") : "-";
  } else {
    $("platform-quote").textContent = "-";
    $("platform-quote-note").textContent = "No current public quote found for this pair/duration.";
    $("platform-edge").textContent = "-";
    $("platform-mid").textContent = "-";
    $("platform-skew").textContent = "-";
  }

  renderFeatureTable(features, config);
}

function bindControls() {
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
  $("family-select").addEventListener("change", async (event) => {
    state.modelFamily = event.target.value;
    await loadConfigs();
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
  $("family-select").value = state.modelFamily;
  await loadConfigs();
  await loadAlphaProxies();
  await fetchPlatformQuotes();
  await pollChainlink();
  await pollTurbo();
  await pollBinance();
  chainlinkTimer = window.setInterval(pollChainlink, CL_POLL_MS);
  turboTimer = window.setInterval(pollTurbo, CL_POLL_MS);
  marketTimer = window.setInterval(pollBinance, MARKET_POLL_MS);
  snapshotTimer = window.setInterval(recordSnapshots, SNAPSHOT_MS);
  renderTimer = window.setInterval(render, RENDER_MS);
}

init().catch((error) => {
  console.error(error);
  $("controls-note").textContent = `Init failed: ${error.message}`;
});
