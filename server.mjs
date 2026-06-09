import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8787);
const execFileAsync = promisify(execFile);
const LEGACY_TURBO_SHORT_MODEL_PATH = path.join(ROOT, "live_mid_model_30s_best_trade_model.json");
const PYTHON_CANDIDATES = [
  process.env.PYTHON_BIN,
  process.env.PYTHON,
  process.env.CONDA_PYTHON_EXE,
  "python3",
  "python",
  "py",
].filter(Boolean);
const API_KEY = process.env.CHAINLINK_API_KEY || "1cc69e78-85fb-4c1f-b36c-6b55e69c1865";
const USER_SECRET = process.env.CHAINLINK_USER_SECRET || "Wz5NRTA1GbSQw04oE7s8Ug1go18pse01yddl7VNSOLxyr9ltkMw3K3HFDLLI9g5lH3x823tyqvzTHUI3BG07hy7MFVbsR9uq6MK9327X9e2rVEN5iCZ3OsQ77ARtHB51";
const BASE_URL = "https://api.dataengine.chain.link";
const FEEDS = {
  "BTC/USDT": "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8",
  "ETH/USDT": "0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9",
};
const SYMBOLS = {
  "BTC/USDT": "BTCUSDT",
  "ETH/USDT": "ETHUSDT",
};

const TURBO_DB_CONFIG = {
  host: process.env.TURBO_DB_HOST || "aws-jp-tk-surf-pg-public.cluster-csteuf9lw8dv.ap-northeast-1.rds.amazonaws.com",
  port: Number(process.env.TURBO_DB_PORT || 5432),
  dbname: process.env.TURBO_DB_NAME || "replication_report",
  user: process.env.TURBO_DB_USER || "manabesh_kaj",
  password: process.env.TURBO_DB_PASSWORD || "dPL084;KF1spv,g",
  sslmode: process.env.TURBO_DB_SSLMODE || "require",
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const LEGACY_TURBO_SHORT_MODEL = JSON.parse(fs.readFileSync(LEGACY_TURBO_SHORT_MODEL_PATH, "utf8"));
const LEGACY_TURBO_SHORT_COEF = LEGACY_TURBO_SHORT_MODEL.coefficients || {};
const LEGACY_TURBO_SHORT_HISTORY = [];
const LEGACY_TURBO_SHORT_PRODUCT_STATE = {
  "30s": { displayProbability: 0.5, quoteWindowStartTs: null },
  "1m": { displayProbability: 0.5, quoteWindowStartTs: null },
};
const LEGACY_TURBO_SHORT_BASE = {
  source: "Binance Futures BTCUSDT top-10 depth",
  threshold: 0.5,
  persist: 3.0,
  triggeredProbability: 0.5924,
  maxProbabilityPct: 60.0,
  alphaMin: 0.05,
  alphaMax: 0.18,
  maxStepPerSecond: 0.006,
  neutralSnapBand: 0.0015,
  upliftLast7: {
    "30s": 31617.229,
    "1m": 1862.911,
  },
  stepScale: {
    "30s": 1.0,
    "1m": 0.8,
  },
};

function resolvePythonCommand() {
  for (const candidate of PYTHON_CANDIDATES) {
    if (candidate === "python3" || candidate === "python" || candidate === "py") {
      return candidate;
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "python3";
}

const PYTHON_CMD = resolvePythonCommand();

function send(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  send(res, statusCode, JSON.stringify(payload), "application/json; charset=utf-8");
}

function decodeChainlinkMid(fullReport) {
  const hex = fullReport.startsWith("0x") ? fullReport.slice(2) : fullReport;
  const bid = Number.parseInt(hex.slice(960, 1024), 16) / 1e18;
  const ask = Number.parseInt(hex.slice(1024, 1088), 16) / 1e18;
  return (bid + ask) / 2;
}

async function fetchChainlinkLatest(pair) {
  const feedId = FEEDS[pair];
  if (!feedId) {
    throw new Error(`Unknown pair: ${pair}`);
  }
  const pathQuery = `/api/v1/reports/latest?feedID=${feedId}`;
  const tsMs = `${Date.now()}`;
  const bodyHash = crypto.createHash("sha256").update("").digest("hex");
  const message = `GET ${pathQuery} ${bodyHash} ${API_KEY} ${tsMs}`;
  const signature = crypto.createHmac("sha256", USER_SECRET).update(message).digest("hex");
  const response = await fetch(`${BASE_URL}${pathQuery}`, {
    headers: {
      Authorization: API_KEY,
      "X-Authorization-Timestamp": tsMs,
      "X-Authorization-Signature-SHA256": signature,
    },
  });
  if (!response.ok) {
    throw new Error(`Chainlink ${response.status}`);
  }
  const payload = await response.json();
  return {
    pair,
    price: decodeChainlinkMid(payload.report.fullReport),
    observationTs: Number(payload.report.observationsTimestamp) * 1000,
  };
}

async function fetchBinanceLatest(pair) {
  const symbol = SYMBOLS[pair];
  if (!symbol) {
    throw new Error(`Unknown pair: ${pair}`);
  }
  const spotResp = await fetch(`https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=${symbol}`);
  if (!spotResp.ok) {
    throw new Error(`Spot ${spotResp.status}`);
  }
  const spot = await spotResp.json();
  const spotBid = Number(spot.bidPrice);
  const spotAsk = Number(spot.askPrice);
  const spotMid = Number.isFinite(spotBid) && Number.isFinite(spotAsk) ? (spotBid + spotAsk) / 2 : Number(spot.price);
  let perpMark = spotMid;
  let perpFallback = true;
  try {
    const perpResp = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
    if (perpResp.ok) {
      const perp = await perpResp.json();
      const parsed = Number(perp.markPrice);
      if (Number.isFinite(parsed) && parsed > 0) {
        perpMark = parsed;
        perpFallback = false;
      }
    }
  } catch (_error) {
    perpFallback = true;
  }
  return {
    pair,
    spot: spotMid,
    perp: perpMark,
    perpFallback,
    ts: Date.now(),
  };
}

async function fetchTurboLatest(pair) {
  if (!SYMBOLS[pair]) {
    throw new Error(`Unknown pair: ${pair}`);
  }
  const script = `
import json, psycopg2
db = ${JSON.stringify(TURBO_DB_CONFIG)}
pair = ${JSON.stringify(pair)}
sql = """
SELECT created_at AT TIME ZONE 'UTC' AS ts_utc, final_price::double precision AS price
FROM public.oracle_price_log_partition_v1
WHERE pair_name = %s
  AND source_type = 0
  AND final_price::double precision > 0
ORDER BY created_at DESC
LIMIT 1
"""
with psycopg2.connect(**db) as conn:
    with conn.cursor() as cur:
        cur.execute(sql, (pair,))
        row = cur.fetchone()
        if not row:
            raise RuntimeError("No turbo price row")
        ts_utc, price = row
        print(json.dumps({"pair": pair, "price": price, "ts": int(ts_utc.timestamp() * 1000)}))
`;
  const pythonArgs = PYTHON_CMD.toLowerCase().endsWith("\\py") || PYTHON_CMD.toLowerCase() === "py"
    ? ["-3", "-c", script]
    : ["-c", script];
  const { stdout } = await execFileAsync(PYTHON_CMD, pythonArgs, { cwd: ROOT, timeout: 8000 });
  return JSON.parse(stdout.trim());
}

function sumLevels(levels, depth, mapper) {
  return levels.slice(0, depth).reduce((sum, level) => sum + mapper(level), 0);
}

function stddev(values) {
  if (!values.length) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(variance, 0));
}

function clampValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function interpolateLegacyTurboHistory(secondsAgo, nowTs) {
  const targetTs = nowTs - secondsAgo * 1000;
  for (let i = LEGACY_TURBO_SHORT_HISTORY.length - 1; i >= 0; i -= 1) {
    if (LEGACY_TURBO_SHORT_HISTORY[i].ts <= targetTs) {
      return LEGACY_TURBO_SHORT_HISTORY[i];
    }
  }
  return LEGACY_TURBO_SHORT_HISTORY[0] || null;
}

function legacyTurboPersistenceForThreshold(threshold) {
  if (!LEGACY_TURBO_SHORT_HISTORY.length) return 0;
  const last = LEGACY_TURBO_SHORT_HISTORY[LEGACY_TURBO_SHORT_HISTORY.length - 1];
  const current = last.top5Imbalance;
  const currentSign = current >= threshold ? 1 : current <= -threshold ? -1 : 0;
  if (currentSign === 0) return 0;
  let earliestTs = last.ts;
  for (let i = LEGACY_TURBO_SHORT_HISTORY.length - 1; i >= 0; i -= 1) {
    const item = LEGACY_TURBO_SHORT_HISTORY[i];
    const value = item.top5Imbalance;
    const sign = value >= threshold ? 1 : value <= -threshold ? -1 : 0;
    if (sign !== currentSign) break;
    earliestTs = item.ts;
  }
  return currentSign * Math.max(0, (last.ts - earliestTs) / 1000);
}

function fittedLegacyTurboShortProbability(features) {
  let score = Number(LEGACY_TURBO_SHORT_COEF.intercept || 0);
  for (let i = 0; i < LEGACY_TURBO_SHORT_MODEL.features.length; i += 1) {
    const key = LEGACY_TURBO_SHORT_MODEL.features[i];
    const raw = Number(features[key] ?? 0);
    const mean = Number(LEGACY_TURBO_SHORT_COEF.means?.[i] ?? 0);
    const scale = Math.max(Number(LEGACY_TURBO_SHORT_COEF.scales?.[i] ?? 1), 1e-9);
    const coef = Number(LEGACY_TURBO_SHORT_COEF.coef?.[i] ?? 0);
    const z = (raw - mean) / scale;
    score += coef * z;
  }
  return sigmoid(score);
}

function summarizeLegacyTurboShort(probability) {
  if (probability >= 0.58) return "Strong Up Pressure";
  if (probability <= 0.42) return "Strong Down Pressure";
  if (probability >= 0.53) return "Mild Up Pressure";
  if (probability <= 0.47) return "Mild Down Pressure";
  return "Neutral";
}

async function fetchLegacyTurboShortState(product) {
  if (product !== "30s" && product !== "1m") {
    throw new Error(`Unsupported legacy turbo short product: ${product}`);
  }

  const depthResp = await fetch("https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=10");
  if (!depthResp.ok) {
    throw new Error(`Turbo legacy depth ${depthResp.status}`);
  }
  const payload = await depthResp.json();
  if (!Array.isArray(payload?.bids) || !Array.isArray(payload?.asks) || !payload.bids.length || !payload.asks.length) {
    throw new Error("Turbo legacy depth payload missing bids/asks");
  }

  const bids = payload.bids.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })).filter((row) => Number.isFinite(row.price) && Number.isFinite(row.qty));
  const asks = payload.asks.map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })).filter((row) => Number.isFinite(row.price) && Number.isFinite(row.qty));
  const bestBid = bids[0];
  const bestAsk = asks[0];
  if (!bestBid || !bestAsk || bestBid.price <= 0 || bestAsk.price <= 0) {
    throw new Error("Turbo legacy best bid/ask missing");
  }

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
  LEGACY_TURBO_SHORT_HISTORY.push({
    ts: now,
    mid,
    top5Imbalance,
    top10Imbalance,
    top5SizeImbalance,
    top10SizeImbalance,
    totalDepth: bidNotional10 + askNotional10,
  });
  while (LEGACY_TURBO_SHORT_HISTORY.length > 120) {
    LEGACY_TURBO_SHORT_HISTORY.shift();
  }

  const hist3 = interpolateLegacyTurboHistory(3, now);
  const hist10 = interpolateLegacyTurboHistory(10, now);
  const ret3 = hist3 ? ((mid - hist3.mid) / hist3.mid) * 10000 : 0;
  const ret10 = hist10 ? ((mid - hist10.mid) / hist10.mid) * 10000 : 0;
  const recentReturns = [];
  for (let i = 1; i < LEGACY_TURBO_SHORT_HISTORY.length; i += 1) {
    const prev = LEGACY_TURBO_SHORT_HISTORY[i - 1];
    const curr = LEGACY_TURBO_SHORT_HISTORY[i];
    recentReturns.push(((curr.mid - prev.mid) / prev.mid) * 10000);
  }
  const shortVol = stddev(recentReturns.slice(-10));
  const totalDepths = LEGACY_TURBO_SHORT_HISTORY.map((row) => row.totalDepth).sort((a, b) => a - b);
  const medianDepth = totalDepths.length ? totalDepths[Math.floor(totalDepths.length / 2)] : bidNotional10 + askNotional10;
  const currentDepth = bidNotional10 + askNotional10;
  const thinDepth = clampValue(1 - currentDepth / Math.max(medianDepth, 0.0001), 0, 1);

  const featureVector = {
    imb_top5_notional: top5Imbalance,
    imb_top5_size: top5SizeImbalance,
    imb_top10_notional: top10Imbalance,
    imb_top10_size: top10SizeImbalance,
    signed_persist_05: legacyTurboPersistenceForThreshold(0.5),
    signed_persist_06: legacyTurboPersistenceForThreshold(0.6),
    microprice_dev_bps: micropriceDeviationBps,
    spread_bps: spreadBps,
    vol_10s_bps: shortVol,
    thin_depth: thinDepth,
    ret_abs_3s: Math.abs(ret3),
    ret_abs_10s: Math.abs(ret10),
  };

  const rawProbability = fittedLegacyTurboShortProbability(featureVector);
  const maxProb = LEGACY_TURBO_SHORT_BASE.maxProbabilityPct / 100;
  const targetProbability = clampValue(rawProbability, 0.5 - (maxProb - 0.5), 0.5 + (maxProb - 0.5));
  const stateForProduct = LEGACY_TURBO_SHORT_PRODUCT_STATE[product];
  const windowMs = 2000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const stepScale = LEGACY_TURBO_SHORT_BASE.stepScale[product] || 1.0;
  if (stateForProduct.quoteWindowStartTs !== windowStart) {
    const prev = Number.isFinite(stateForProduct.displayProbability) ? stateForProduct.displayProbability : 0.5;
    const dtSeconds = stateForProduct.quoteWindowStartTs == null ? windowMs / 1000 : clampValue((windowStart - stateForProduct.quoteWindowStartTs) / 1000, 0.25, 10);
    const alpha = clampValue(dtSeconds / 6, LEGACY_TURBO_SHORT_BASE.alphaMin, LEGACY_TURBO_SHORT_BASE.alphaMax);
    const candidateProbability = prev + alpha * (targetProbability - prev);
    const maxStep = LEGACY_TURBO_SHORT_BASE.maxStepPerSecond * stepScale * dtSeconds;
    let nextProbability = clampValue(prev + clampValue(candidateProbability - prev, -maxStep, maxStep), 0.5 - (maxProb - 0.5), 0.5 + (maxProb - 0.5));
    if (Math.abs(nextProbability - 0.5) < LEGACY_TURBO_SHORT_BASE.neutralSnapBand) {
      nextProbability = 0.5;
    }
    stateForProduct.displayProbability = nextProbability;
    stateForProduct.quoteWindowStartTs = windowStart;
  }

  return {
    pair: "BTC/USDT",
    product,
    source: LEGACY_TURBO_SHORT_BASE.source,
    metricLabel: product,
    rawProbability,
    displayProbability: stateForProduct.displayProbability,
    regime: summarizeLegacyTurboShort(rawProbability),
    featureVector,
    feedMid: mid,
    spreadBps,
    lookbackS: 10,
    upliftLast7: LEGACY_TURBO_SHORT_BASE.upliftLast7[product],
    updatedAt: now,
  };
}

function safePathFromUrl(urlPath) {
  const pathname = decodeURIComponent(new URL(urlPath, "http://localhost").pathname);
  const relative = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(ROOT, `.${relative}`);
  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
}

const server = http.createServer((req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    if (requestUrl.pathname === "/api/chainlink/latest") {
      const pair = requestUrl.searchParams.get("pair") || "";
      fetchChainlinkLatest(pair)
        .then((payload) => sendJson(res, 200, payload))
        .catch((error) => sendJson(res, 500, { error: error.message }));
      return;
    }
    if (requestUrl.pathname === "/api/binance/latest") {
      const pair = requestUrl.searchParams.get("pair") || "";
      fetchBinanceLatest(pair)
        .then((payload) => sendJson(res, 200, payload))
        .catch((error) => sendJson(res, 500, { error: error.message }));
      return;
    }
    if (requestUrl.pathname === "/api/turbo/latest") {
      const pair = requestUrl.searchParams.get("pair") || "";
      fetchTurboLatest(pair)
        .then((payload) => sendJson(res, 200, payload))
        .catch((error) => sendJson(res, 500, { error: error.message }));
      return;
    }
    if (requestUrl.pathname === "/api/turbo/legacy-short") {
      const product = requestUrl.searchParams.get("product") || "30s";
      fetchLegacyTurboShortState(product)
        .then((payload) => sendJson(res, 200, payload))
        .catch((error) => sendJson(res, 500, { error: error.message }));
      return;
    }

    const filePath = safePathFromUrl(req.url || "/");
    if (!filePath) {
      send(res, 403, "Forbidden");
      return;
    }

    fs.stat(filePath, (statErr, stats) => {
      if (statErr || !stats.isFile()) {
        send(res, 404, "Not found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      const stream = fs.createReadStream(filePath);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      });
      stream.pipe(res);
      stream.on("error", () => {
        if (!res.headersSent) {
          send(res, 500, "Failed to read file");
        } else {
          res.destroy();
        }
      });
    });
  } catch (error) {
    send(res, 500, `Server error: ${error.message}`);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Hosted product suite listening on http://0.0.0.0:${PORT} using ${PYTHON_CMD}`);
});
