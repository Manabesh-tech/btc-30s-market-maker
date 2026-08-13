export const BTC30_ISR_MODEL_ID = "btc30_independent_selective_reservation_v1";

export const BTC30_ISR_DEFAULTS = Object.freeze({
  baseEdgePct: 5,
  competitionStepPp: 1,
  moderateReservePct: 1,
  defensiveReservePct: 4,
  unknownReservePct: 4,
  minPayoutPct: 50,
  maxPayoutPct: 100,
  maxOrderbookAgeMs: 1500,
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sign(value) {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

export function evaluateBtc30IndependentFair(features = {}, settings = {}) {
  const cfg = { ...BTC30_ISR_DEFAULTS, ...settings };
  const depth = finite(features.depth20Mean10 ?? features.depth20);
  const net2 = finite(features.net2Bps);
  const net10 = finite(features.net10Bps);
  const net300 = finite(features.net300Bps);
  const path30 = finite(features.path30Bps);
  const bookAgeMs = finite(features.orderbookAgeMs);
  const inputsAvailable = [depth, net2, net10, net300, path30].every((value) => value !== null);
  if (!inputsAvailable) {
    return {
      modelId: BTC30_ISR_MODEL_ID,
      probabilityHigher: 0.5,
      probabilityLower: 0.5,
      scorePp: 0,
      rawScorePp: 0,
      factorAgreement: 0,
      confidenceClass: "unknown",
      favoredSide: null,
      componentsPp: null,
      reason: "Required historical factors are unavailable.",
    };
  }

  const componentsPp = {
    depth20: 1.20 * clamp(depth, -1, 1),
    continuation10s: 0.16 * clamp(net10, -8, 8),
    antiChase2s: -0.16 * clamp(net2, -4, 4),
    meanReversion300s: -0.02 * clamp(net300, -25, 25),
  };
  const rawScorePp = Object.values(componentsPp).reduce((sum, value) => sum + value, 0);
  const directions = [sign(depth), sign(net10), sign(-net2), sign(-net300)].filter(Boolean);
  const positive = directions.filter((value) => value > 0).length;
  const negative = directions.filter((value) => value < 0).length;
  const factorAgreement = directions.length ? Math.max(positive, negative) / directions.length : 0;
  const staleBook = bookAgeMs !== null && bookAgeMs > cfg.maxOrderbookAgeMs;
  const safeRandom = Math.abs(rawScorePp) <= 0.35
    && Math.abs(net10) <= 0.30
    && Math.abs(depth) <= 0.15
    && path30 <= 2.5
    && !staleBook;
  const dangerousUncertainty = !safeRandom && (
    factorAgreement < 0.50
    || staleBook
    || (Math.abs(rawScorePp) < 0.60 && path30 >= 4)
  );
  const confidenceClass = safeRandom
    ? "safe_random"
    : dangerousUncertainty
      ? "dangerous_uncertainty"
      : Math.abs(rawScorePp) >= 1 && factorAgreement >= 0.50 ? "confirmed" : "readable";
  const scorePp = clamp(rawScorePp * (dangerousUncertainty ? 0.35 : 1), -3, 3);
  const probabilityHigher = clamp(0.5 + scorePp / 100, 0.47, 0.53);
  return {
    modelId: BTC30_ISR_MODEL_ID,
    probabilityHigher,
    probabilityLower: 1 - probabilityHigher,
    scorePp,
    rawScorePp,
    factorAgreement,
    confidenceClass,
    favoredSide: probabilityHigher >= 0.5 ? "Higher" : "Lower",
    componentsPp,
    reason: safeRandom
      ? "Quiet neutral factors: both sides may compete independently."
      : dangerousUncertainty
        ? "Conflicted, noisy, or stale factors: neither side may chase."
        : "Readable factor direction: only the model-favored side may chase.",
  };
}

export function payoutReservationPct(probability, edgePct, settings = {}) {
  const cfg = { ...BTC30_ISR_DEFAULTS, ...settings };
  const p = clamp(Number(probability), 0.01, 0.99);
  return clamp(100 * ((1 - p - edgePct / 100) / p), cfg.minPayoutPct, cfg.maxPayoutPct);
}

export function quoteBtc30AgainstCompetition(features = {}, competitors = {}, settings = {}) {
  const cfg = { ...BTC30_ISR_DEFAULTS, ...settings };
  const fair = evaluateBtc30IndependentFair(features, cfg);
  const reserveExtra = fair.confidenceClass === "readable"
    ? cfg.moderateReservePct
    : ["dangerous_uncertainty", "unknown"].includes(fair.confidenceClass)
      ? (fair.confidenceClass === "unknown" ? cfg.unknownReservePct : cfg.defensiveReservePct)
      : 0;
  const effectiveEdgePct = cfg.baseEdgePct + reserveExtra;
  const higherCeilingPct = payoutReservationPct(fair.probabilityHigher, effectiveEdgePct, cfg);
  const lowerCeilingPct = payoutReservationPct(fair.probabilityLower, effectiveEdgePct, cfg);
  const chaseBoth = fair.confidenceClass === "safe_random";
  const chaseNeither = ["dangerous_uncertainty", "unknown"].includes(fair.confidenceClass);
  const mayChaseHigher = !chaseNeither && (chaseBoth || fair.favoredSide === "Higher");
  const mayChaseLower = !chaseNeither && (chaseBoth || fair.favoredSide === "Lower");

  function quoteSide(ceilingPct, competitorPct, mayChase) {
    const competitor = finite(competitorPct);
    const target = competitor === null ? null : competitor + cfg.competitionStepPp;
    const competes = Boolean(mayChase && target !== null && target <= ceilingPct);
    return { ceilingPct, competitorPct: competitor, targetPct: target, competes, quotePct: competes ? target : ceilingPct };
  }

  return {
    ...fair,
    effectiveEdgePct,
    competitionMode: chaseNeither ? "off" : chaseBoth ? "both" : "favored",
    higher: quoteSide(higherCeilingPct, competitors.higherPayoutPct, mayChaseHigher),
    lower: quoteSide(lowerCeilingPct, competitors.lowerPayoutPct, mayChaseLower),
  };
}
