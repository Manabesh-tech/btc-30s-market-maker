# Predict Market Live Odds Guide

This guide shows how to fetch Turboflow event contracts and live Higher/Lower odds for the prediction market event page.

## Endpoints

Production API base:

```text
https://apis.turboflow.xyz
```

Production websocket:

```text
wss://apis.turboflow.xyz/realtime
```

Public data does not require authentication.

## Data Sources

Use the REST config endpoint to load the event contract list:

```sh
curl 'https://apis.turboflow.xyz/public/pm/config?version=2'
```

The response has this shape:

```json
{
  "errno": "200",
  "msg": "success",
  "data": {
    "data": [
      {
        "pair_id": "6",
        "pair_name": "BTC/USDT",
        "enable": true,
        "order_configs": [
          {
            "duration": 300,
            "ask_return_rate": "0.9023",
            "bid_return_rate": "0.7977",
            "min_amount": "2",
            "max_amount": "200"
          }
        ]
      }
    ],
    "oracle_cfg": {
      "min_rr": "0.65",
      "max_rr": "1.05",
      "refresh_interval": 2
    }
  }
}
```

Field mapping:

| Field | Meaning |
| --- | --- |
| `pair_id` | Event contract market id |
| `pair_name` | Market symbol, for example `BTC/USDT` |
| `duration` | Contract duration in seconds |
| `bid_return_rate` | Higher return rate |
| `ask_return_rate` | Lower return rate |
| `min_amount` | Minimum order amount |
| `max_amount` | Maximum order amount |

Return rates are decimals. For example, `0.7977` displays as `+79.77%`.

## Realtime Topics

Subscribe with this websocket message format:

```json
{"action":"subscribe","args":["<topic>"]}
```

Useful public topics:

| Topic | Purpose |
| --- | --- |
| `dex_predict_config` | Live event contract config and return-rate updates |
| `dex_predict_ticker` | Live Higher/Lower open-interest amounts |
| `dex_predict_market` | Public event market trades |

`dex_predict_ticker` payload example:

```json
{
  "group": "dex_predict_ticker",
  "data": "{\"tickers\":[{\"pair_id\":\"6\",\"ask_amount\":\"157\",\"bid_amount\":\"44.5\"}]}"
}
```

Ticker field mapping:

| Field | Meaning |
| --- | --- |
| `bid_amount` | Pending Higher open interest |
| `ask_amount` | Pending Lower open interest |

The frontend calculates the open-interest split as:

```text
higher_pct = bid_amount / (bid_amount + ask_amount) * 100
lower_pct = ask_amount / (bid_amount + ask_amount) * 100
```

This open-interest split is not the payout odds. Payout odds come from `bid_return_rate` and `ask_return_rate`.

## Run The Sample Script

The sample script lives at:

```text
scripts/predict-market-live-odds.mjs
```

Run once and exit after fetching the contract list:

```sh
node scripts/predict-market-live-odds.mjs --once
```

Run live for 15 seconds:

```sh
node scripts/predict-market-live-odds.mjs --duration-ms 15000
```

Filter to one pair id:

```sh
node scripts/predict-market-live-odds.mjs --pair-id 6 --duration-ms 15000
```

Override endpoints:

```sh
node scripts/predict-market-live-odds.mjs \
  --api-base https://apis.turboflow.xyz \
  --ws-url wss://apis.turboflow.xyz/realtime
```

Environment variables are also supported:

```sh
TF_PM_API_BASE=https://apis.turboflow.xyz \
TF_PM_WS_URL=wss://apis.turboflow.xyz/realtime \
node scripts/predict-market-live-odds.mjs --duration-ms 15000
```

## Minimal WebSocket Example

```js
const ws = new WebSocket("wss://apis.turboflow.xyz/realtime");

ws.onopen = () => {
  ws.send(JSON.stringify({ action: "subscribe", args: ["dex_predict_config"] }));
  ws.send(JSON.stringify({ action: "subscribe", args: ["dex_predict_ticker"] }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.group === "dex_predict_ticker") {
    const data = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
    console.log(data.tickers);
  }
};
```
