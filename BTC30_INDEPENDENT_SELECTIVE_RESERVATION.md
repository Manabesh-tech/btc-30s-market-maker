# BTC 30s Independent Selective Reservation v1

This candidate separates fair-value estimation from competition. It uses four
regularized factors: depth-20 pressure, 10-second continuation, 2-second
anti-chase, and 300-second mean reversion.

Higher and Lower are always evaluated independently. For each side, the
reservation ceiling is:

`payout = (1 - sideProbability - edge) / sideProbability`

The engine only quotes one point above a competitor when that target remains
inside the relevant side's reservation ceiling.

## State-aware competition

- `safe_random`: compete on both sides independently.
- `readable` / `confirmed`: compete only on the model-favored side.
- `dangerous_uncertainty` / `unknown`: do not chase either side.

## Recommended initial settings

- Base edge: 5%
- Competition step: +1 percentage point
- Moderate reserve: +1 percentage point
- Defensive and unknown reserve: +4 percentage points
- Two-way minimum: off
- Flow-aware and drawdown overlays: off during shadow validation

The seven-day recorded-quote replay produced +1,593.82 unit PnL at +7.27% per
captured unit; the latest two-hour replay produced +11.00 units at +4.04%.
These results approximate capture from recorded NAYT quotes and do not fully
model bettor arrival, latency, queue priority, or adverse selection. Deploy in
shadow mode before enabling live quoting.
