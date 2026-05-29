#!/usr/bin/env node

const DEFAULT_API_BASE = "https://apis.turboflow.xyz";
const DEFAULT_WS_URL = "wss://apis.turboflow.xyz/realtime";

const args = parseArgs(process.argv.slice(2));
const apiBase = args.apiBase || process.env.TF_PM_API_BASE || DEFAULT_API_BASE;
const wsUrl = args.wsUrl || process.env.TF_PM_WS_URL || DEFAULT_WS_URL;
const pairFilter = args.pairId ? String(args.pairId) : null;
const durationMs = args.durationMs ? Number(args.durationMs) : 0;
const once = Boolean(args.once);

const pairConfigs = new Map();
const tickerByPair = new Map();
let renderTimer = null;

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

async function main() {
  const config = await fetchEventContracts();
  mergeConfig(config);
  render("initial REST config");

  if (once) {
    return;
  }

  const ws = new WebSocket(wsUrl);

  if (durationMs > 0) {
    setTimeout(() => {
      console.log(`\nStopping after ${durationMs}ms.`);
      ws.close();
      process.exit(0);
    }, durationMs).unref();
  }

  ws.addEventListener("open", () => {
    console.log(`\nConnected: ${wsUrl}`);
    subscribe(ws, "dex_predict_config");
    subscribe(ws, "dex_predict_ticker");
  });

  ws.addEventListener("message", (event) => {
    const msg = parseMaybeJson(event.data);

    if (msg?.action === "subscribe") {
      console.log(`Subscribed: ${msg.data} (${msg.status ? "ok" : "failed"})`);
      return;
    }

    if (msg?.group === "dex_predict_config") {
      const configUpdate = normalizeConfigPayload(msg.data);
      mergeConfig(configUpdate);
      scheduleRender("live config update");
      return;
    }

    if (msg?.group === "dex_predict_ticker") {
      const tickers = normalizeTickerPayload(msg.data);
      for (const ticker of tickers) {
        const pairId = String(ticker.pair_id ?? ticker.pairId ?? "");
        if (!pairId) continue;
        tickerByPair.set(pairId, ticker);
      }
      scheduleRender("live ticker update");
    }
  });

  ws.addEventListener("close", () => {
    console.log("\nWebSocket closed.");
  });

  ws.addEventListener("error", (error) => {
    console.error("WebSocket error:", error?.message || error);
  });
}

async function fetchEventContracts() {
  const url = `${apiBase.replace(/\/$/, "")}/public/pm/config?version=2`;
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  }

  return normalizeConfigPayload(await response.json());
}

function subscribe(ws, topic) {
  ws.send(JSON.stringify({ action: "subscribe", args: [topic] }));
}

function mergeConfig(config) {
  for (const pair of config.pairs) {
    const pairId = String(pair.pair_id ?? pair.pairId ?? "");
    if (!pairId) continue;
    if (pairFilter && pairId !== pairFilter) continue;
    pairConfigs.set(pairId, pair);
  }
}

function scheduleRender(reason) {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render(reason);
  }, 250);
}

function render(reason) {
  const rows = [];

  for (const [pairId, pair] of pairConfigs.entries()) {
    if (pairFilter && pairId !== pairFilter) continue;

    const ticker = tickerByPair.get(pairId) || {};
    const higherAmount = Number(ticker.bid_amount ?? ticker.bidAmount ?? 0);
    const lowerAmount = Number(ticker.ask_amount ?? ticker.askAmount ?? 0);
    const totalAmount = higherAmount + lowerAmount;
    const higherOpenInterestPct = totalAmount > 0 ? (higherAmount / totalAmount) * 100 : 0;
    const lowerOpenInterestPct = totalAmount > 0 ? (lowerAmount / totalAmount) * 100 : 0;

    const orderConfigs = pair.order_configs ?? pair.orderConfigs ?? [];
    for (const orderConfig of orderConfigs) {
      rows.push({
        pair_id: pairId,
        pair: pair.pair_name ?? pair.pairName ?? "",
        duration_s: Number(orderConfig.duration ?? orderConfig.order_duration ?? 0),
        higher_return: formatReturnRate(orderConfig.bid_return_rate),
        lower_return: formatReturnRate(orderConfig.ask_return_rate),
        min_amount: orderConfig.min_amount ?? "",
        max_amount: orderConfig.max_amount ?? "",
        higher_oi: formatAmount(higherAmount),
        lower_oi: formatAmount(lowerAmount),
        higher_oi_pct: formatPercent(higherOpenInterestPct),
        lower_oi_pct: formatPercent(lowerOpenInterestPct),
      });
    }
  }

  console.log(`\n[${new Date().toISOString()}] ${reason}`);
  if (rows.length === 0) {
    console.log("No event contracts found.");
    return;
  }

  console.table(rows.sort(sortRows));
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

function normalizeTickerPayload(payload) {
  const raw = parseMaybeJson(payload);
  const top = parseMaybeJson(raw?.data ?? raw);
  return Array.isArray(top?.tickers) ? top.tickers : [];
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatReturnRate(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return "";
  return `+${(number * 100).toFixed(2)}%`;
}

function formatPercent(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return "";
  return `${number.toFixed(2)}%`;
}

function formatAmount(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return "";
  return number.toFixed(4).replace(/\.?0+$/, "");
}

function sortRows(a, b) {
  return Number(a.pair_id) - Number(b.pair_id) || a.duration_s - b.duration_s;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());

    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = next;
    index += 1;
  }
  return parsed;
}
