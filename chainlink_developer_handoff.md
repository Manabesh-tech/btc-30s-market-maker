# Chainlink Market-Making Monitor: Developer Handoff

## Purpose
This document describes the final production-ready starting point for a Chainlink-settled quote monitor across:
- `30s`
- `1m`
- `3m`
- `5m`
- `15m`
- `1h`

for both:
- `BTC/USDT`
- `ETH/USDT`

The goal is:
1. estimate fair user win probability first
2. apply a conservative deployment layer
3. convert that deployed probability into a two-way payout quote at the chosen edge

This is the production starting point, not the full research history.

## Files To Use

Primary files:
- `outputs/chainlink_product_suite_final_models.json`
- `outputs/chainlink_production_monitor_spec.md`
- `live_chainlink_product_suite_console.js`
- `live_chainlink_product_suite_console.html`
- `server.mjs`

Reference / builder files:
- `build_chainlink_theoretical_mid_suite.py`
- `build_chainlink_production_config.py`
- `build_chainlink_final_config.py`

## Final Production Policy

Use:
- `1s` entry delay assumption for **all** products
- calibrated fair-mid model as the base
- conservative product shrink
- flat quoting where model quality is weak
- one explicit overlay for `BTC 30s`

### Product-level policy

- `BTC 30s`: flat by default, plus delayed basis-delta overlay
- `ETH 30s`: mild skew only
- `BTC 1m`: mild skew only
- `ETH 1m`: mild to moderate skew
- `BTC 3m`: flat
- `ETH 3m`: flat
- `BTC 5m`: flat
- `ETH 5m`: moderate skew
- `BTC 15m`: moderate skew
- `ETH 15m`: moderate skew
- `BTC 1h`: light skew
- `ETH 1h`: flat

Interpretation:
- if the current feature set does not produce trustworthy fair-mid edge, quote `50/50`
- do **not** force skew just because a product exists

## Runtime Inputs

Each live quote uses:
- Chainlink mid
- Binance spot price
- Binance perp / futures mark proxy

Derived features include:
- `gap_spot_bp`
- `gap_perp_bp`
- `spot_perp_spread_bp`
- `delta_gap_spot_1u`
- `delta_gap_perp_1u`
- `delta_gap_spot_2u`
- `delta_gap_perp_2u`
- `spot_ret_1u_bp`
- `perp_ret_1u_bp`
- `chain_ret_1u_bp`
- `spot_ret_2u_bp`
- `perp_ret_2u_bp`
- `chain_ret_2u_bp`
- `gap_spot_z_12`
- `gap_perp_z_12`
- `spot_vol_6u`
- `perp_vol_6u`
- `chain_vol_6u`
- `gap_sign_agree`
- `delta_sign_agree`
- `basis_pressure`

The exact active feature subset is product-specific and already encoded in:
- `outputs/chainlink_product_suite_final_models.json`

## Probability Pipeline

For each `(pair, product)`:

1. Build the live feature vector.
2. Score the raw fitted model:
   - `raw_prob_up_base = sigmoid(intercept + sum(coef_i * z_i))`
3. Apply calibration:
   - `identity`, `platt`, or `isotonic`
4. Apply optional explicit overlay rules
5. Apply production shrink:
   - `deployed_p = 0.5 + alpha * (model_p - 0.5)`
6. Apply neutral band and the hard cap implied by the payout floor
7. Convert deployed probability into two-way payouts

## Payout Conversion

Let:
- `edge = 0.04` for `4%`
- `p = deployed probability of Higher`

Then:
- `higher_payout = 100 * (1 - edge) / p - 100`
- `lower_payout = 100 * (1 - edge) / (1 - p) - 100`

Example:
- if fair `P(Higher)=50%`, quote is `92 / 92`
- if fair `P(Higher)=55%`, quote is `74.55 / 113.33`

The low-side payout floor in this production config is `65`.

## Entry Delay Assumption

The production model assumes:
- signal computed at `t`
- trade enters at `t + 1s`
- settlement occurs after product duration from entry

This assumption matters most for:
- `BTC 30s`
- `BTC 1m`

It should be preserved unless the live execution path proves faster and stable.

## BTC 30s Special Overlay

`BTC 30s` is flat by default because the base Chainlink basis model alone was not good enough.

One explicit overlay is enabled:
- metric: `delta_gap_spot_1u`
- interpretation: current Chainlink-vs-spot gap minus gap `30s` ago
- delay assumption: signal at `t`, trade enters at `t+1s`

Rules:
- if `delta_gap_spot_1u >= 3bp`, set fair `P(Higher)=55%`
- if `delta_gap_spot_1u <= -3bp`, set fair `P(Higher)=45%`
- else if `delta_gap_spot_1u >= 2bp`, set fair `P(Higher)=53%`
- else if `delta_gap_spot_1u <= -2bp`, set fair `P(Higher)=47%`
- else use flat `50%`

This overlay is encoded directly in:
- `outputs/chainlink_product_suite_final_models.json`

## Product Warm-Up

The browser monitor builds local history before model-driven quotes appear.

Warm-up expectation:
- `30s`: about `1 minute`
- `1m`: about `2 minutes`
- `3m`: about `6 minutes`
- `5m`: about `10 minutes`
- `15m`: about `30 minutes`
- `1h`: about `2 hours`

During warm-up, the monitor shows a flat fallback quote.

## Live Data Architecture

Browser should not call Chainlink directly because of CORS.

Current solution:
- browser calls local endpoint:
  - `/api/chainlink/latest?pair=BTC/USDT`
  - `/api/chainlink/latest?pair=ETH/USDT`
- `server.mjs` signs and proxies the Chainlink request server-side

## Network Caveat

On the original local machine used during development:
- direct browser access to Chainlink did not work because of CORS
- direct browser/WebSocket access to Binance was unreliable from the local network
- final monitor now uses server-side proxy / polling to work around this

So if live Binance data does not appear in a given environment, that is likely a network/access problem, not a model-spec problem.

Developers may need to:
- run from a different network / region
- use VPN
- or swap in a different stable Binance market-data transport

## What Is Already Stable

Stable enough for implementation:
- model/config structure
- probability pipeline
- product policy
- `1s` delay assumption
- payout math
- Chainlink proxy pattern
- `BTC 30s` overlay rule

Not guaranteed by this local browser run:
- direct Binance connectivity from this network

## Implementation Notes

- Treat `chainlink_product_suite_final_models.json` as the main source of truth for runtime behavior.
- Do not infer product policy elsewhere if it conflicts with the config.
- Flat products are intentional. Do not “improve” them by adding skew without new validation.
- The monitor is a starting production policy, not the end of research.

## Recommended Engineering Follow-Up

After implementation:
1. verify stable live Binance data connectivity in production infra
2. log live features, deployed probabilities, and served quotes
3. add routed-trade outcome monitoring
4. revisit `BTC 30s` and `BTC 1m` with richer microstructure challengers if needed
