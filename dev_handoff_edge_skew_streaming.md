# Event Contracts Quote Engine Handoff

## Objective
Build a live quote engine that:

1. reads the current public best aggregate 2-way quote
2. converts that quote into:
   - implied edge
   - implied fair mid
   - implied skew
3. combines that with our own target edge and target skew
4. outputs our stream mid and our 2-way payouts

Quotes should refresh every second.

## Required quote math

Let:

- `r_up` = higher-side payout as decimal return rate, for example `0.80`
- `r_down` = lower-side payout as decimal return rate

Then:

- `gross = 1 / (1/(1+r_up) + 1/(1+r_down))`
- `implied_edge = 1 - gross`
- `p_up = gross / (1 + r_up)`
- `p_down = gross / (1 + r_down)`

`p_up` and `p_down` are the public implied fair probabilities.

Public skew can be represented as:

- `public_skew = p_up - 0.5`

## Our quote construction

We want our own quote to be driven by:

1. our chosen edge
2. our chosen fair mid / skew

Let:

- `our_p_up` = our fair probability for Higher
- `our_edge` = our chosen edge as a fraction, for example `0.04`
- `our_gross = 1 - our_edge`

Then:

- `our_r_up = our_gross / our_p_up - 1`
- `our_r_down = our_gross / (1 - our_p_up) - 1`

Apply the hard payout floor:

- minimum defensive-side payout = `0.65`

That is the only hard cap.

## What should be configurable

The runtime should allow per asset and per tenor control of:

- base edge
- alpha
- margin
- overlay thresholds
- skew ladder / target probabilities
- hard payout floor

The runtime should also support a live alpha override for manual testing.

## Default skew behavior

Default skew values should come from the historically backtested config already saved in:

- `outputs/chainlink_product_suite_final_models.json`

That file is the main source of truth for current default per-product behavior.

## Competition context

We currently have:

- public best aggregate platform quote
- historical trade fills by pool
- observed last-8h alpha proxy extraction for:
  - SIG
  - Nayt
  - Manabesh

We do not currently have a clean live separated SIG/Nayt two-way quote stream in this workspace.

So:

- use public aggregate quote for live implied edge/skew
- use historical pool studies for default competitive positioning

## Files in this handoff

Main control/config:

- `outputs/chainlink_product_suite_final_models.json`

Runtime:

- `server.mjs`
- `live_chainlink_product_suite_console.js`
- `live_chainlink_product_suite_console.html`

Docs:

- `outputs/chainlink_developer_handoff.md`
- `outputs/chainlink_production_monitor_spec.md`
- `outputs/dev_handoff_edge_skew_streaming.md`

Competitive calibration references:

- `outputs/pool_alpha_proxy_last8h.json`
- `outputs/pool_alpha_proxy_last8h.csv`
- `outputs/pool_reverse_engineering_product_summary_last8h.csv`
- `outputs/pool_reverse_engineering_last8h.csv`

## Implementation note

If strategy logic changes later, the main file to replace is:

- `outputs/chainlink_product_suite_final_models.json`

Only resend runtime files if code behavior changes.
