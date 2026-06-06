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
const RUNTIME_STATE_PATH = process.env.RUNTIME_STATE_PATH || path.join(ROOT, "runtime_settings.json");

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

const PRODUCTS = new Set(["30s", "1m", "3m", "5m", "15m", "1h"]);
const FAMILIES = new Set(["chainlink", "turbo"]);

const DEFAULT_RUNTIME_SETTINGS = {
  modelFamily: "chainlink",
  selectedPair: "BTC/USDT",
  selectedProduct: "30s",
  edgePct: 7.0,
  alphaOverride: null,
  payoutFloorOverride: null,
  updatedAt: Date.now(),
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

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

function safeNumber(value) {
  if (value == null || value === "") {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeRuntimeSettings(candidate = {}, base = DEFAULT_RUNTIME_SETTINGS) {
  const next = { ...base };

  if (FAMILIES.has(candidate.modelFamily)) {
    next.modelFamily = candidate.modelFamily;
  }
  if (Object.prototype.hasOwnProperty.call(candidate, "selectedPair") && SYMBOLS[candidate.selectedPair]) {
    next.selectedPair = candidate.selectedPair;
  }
  if (Object.prototype.hasOwnProperty.call(candidate, "selectedProduct") && PRODUCTS.has(candidate.selectedProduct)) {
    next.selectedProduct = candidate.selectedProduct;
  }

  const edgePct = safeNumber(candidate.edgePct);
  if (edgePct != null) {
    next.edgePct = clamp(edgePct, 0, 20);
  }

  if (Object.prototype.hasOwnProperty.call(candidate, "alphaOverride")) {
    const alphaOverride = safeNumber(candidate.alphaOverride);
    next.alphaOverride = alphaOverride == null ? null : clamp(alphaOverride, 0, 2);
  }

  if (Object.prototype.hasOwnProperty.call(candidate, "payoutFloorOverride")) {
    const payoutFloorOverride = safeNumber(candidate.payoutFloorOverride);
    next.payoutFloorOverride = payoutFloorOverride == null ? null : clamp(payoutFloorOverride, 30, 120);
  }

  next.updatedAt = Date.now();
  return next;
}

function loadRuntimeSettings() {
  try {
    if (!fs.existsSync(RUNTIME_STATE_PATH)) {
      fs.writeFileSync(RUNTIME_STATE_PATH, JSON.stringify(DEFAULT_RUNTIME_SETTINGS, null, 2));
      return { ...DEFAULT_RUNTIME_SETTINGS };
    }
    const parsed = JSON.parse(fs.readFileSync(RUNTIME_STATE_PATH, "utf8"));
    return normalizeRuntimeSettings(parsed);
  } catch (_error) {
    return { ...DEFAULT_RUNTIME_SETTINGS, updatedAt: Date.now() };
  }
}

function persistRuntimeSettings(next) {
  fs.mkdirSync(path.dirname(RUNTIME_STATE_PATH), { recursive: true });
  fs.writeFileSync(RUNTIME_STATE_PATH, JSON.stringify(next, null, 2));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) return {};
  return JSON.parse(body);
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
  const { stdout } = await execFileAsync("python", ["-c", script], { cwd: ROOT, timeout: 8000 });
  return JSON.parse(stdout.trim());
}

function safePathFromUrl(urlPath) {
  const pathname = decodeURIComponent(new URL(urlPath, "http://localhost").pathname);
  const relative = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(ROOT, `.${relative}`);
  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
}

let runtimeSettings = loadRuntimeSettings();

const server = http.createServer((req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", "http://localhost");

    if (req.method === "GET" && requestUrl.pathname === "/api/runtime") {
      sendJson(res, 200, runtimeSettings);
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/runtime") {
      readJsonBody(req)
        .then((body) => {
          runtimeSettings = normalizeRuntimeSettings(body, runtimeSettings);
          persistRuntimeSettings(runtimeSettings);
          sendJson(res, 200, runtimeSettings);
        })
        .catch((error) => sendJson(res, 400, { error: error.message }));
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/runtime/reset") {
      runtimeSettings = { ...DEFAULT_RUNTIME_SETTINGS, updatedAt: Date.now() };
      persistRuntimeSettings(runtimeSettings);
      sendJson(res, 200, runtimeSettings);
      return;
    }

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
  console.log(`Hosted product suite listening on http://0.0.0.0:${PORT}`);
});
