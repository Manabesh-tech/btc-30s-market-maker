from __future__ import annotations

import json

from fit_chainlink_product_suite import OUTPUT_DIR


PROD_CONFIG_PATH = OUTPUT_DIR / "chainlink_product_suite_prod_models.json"
FINAL_CONFIG_PATH = OUTPUT_DIR / "chainlink_product_suite_final_models.json"
SPEC_PATH = OUTPUT_DIR / "chainlink_production_monitor_spec.md"
FINAL_PAYOUT_FLOOR = 65.0


def main() -> None:
    configs = json.loads(PROD_CONFIG_PATH.read_text(encoding="utf-8"))

    btc_30s = configs["BTC/USDT::30s"]
    btc_1m = configs["BTC/USDT::1m"]
    eth_1m = configs["ETH/USDT::1m"]
    btc_3m = configs["BTC/USDT::3m"]
    eth_3m = configs["ETH/USDT::3m"]
    eth_5m = configs["ETH/USDT::5m"]
    btc_15m = configs["BTC/USDT::15m"]
    eth_15m = configs["ETH/USDT::15m"]
    btc_1h = configs["BTC/USDT::1h"]
    eth_1h = configs["ETH/USDT::1h"]
    for config in configs.values():
        config["favored_payout_floor"] = FINAL_PAYOUT_FLOOR
        config["alpha"] = 1.0
        config.pop("soft_max_probability", None)
        config.pop("disable_probability_caps", None)

    btc_30s["alpha"] = 1.0
    btc_30s["margin"] = 0.0
    btc_30s["neutral_band"] = 0.0
    btc_30s["overlays"] = [
        {
            "type": "symmetric_metric_override",
            "metric": "delta_gap_spot_1u",
            "default_prob_up": 0.5,
            "label": "btc30_delayed_basis_delta",
            "bands": [
                {
                    "min_abs_bp": 3.0,
                    "prob_up_if_positive": 0.55,
                    "prob_up_if_negative": 0.45,
                    "label": "btc30_strong_delayed_basis_delta",
                },
                {
                    "min_abs_bp": 2.0,
                    "prob_up_if_positive": 0.53,
                    "prob_up_if_negative": 0.47,
                    "label": "btc30_mild_delayed_basis_delta",
                },
            ],
        }
    ]
    btc_30s["notes"]["production_rationale"] = (
        "Flat by default, but apply a delayed Binance-spot basis-delta overlay. "
        "If 30s gap change vs spot exceeds 2bp, skew lightly; if it exceeds 3bp, skew moderately. "
        "Entry is assumed at t+1s."
    )

    eth_30s = configs["ETH/USDT::30s"]
    eth_30s["alpha"] = 1.0
    eth_30s["margin"] = 0.015
    eth_30s["neutral_band"] = 0.015
    eth_30s["overlays"] = [
        {
            "type": "gated_directional_override",
            "gate_metric": "delta_gap_spot_1u",
            "signal_metric": "perp_ret_1u_bp",
            "default_prob_up": 0.5,
            "label": "eth30s_momentum",
            "bands": [
                {
                    "min_abs_gate_bp": 2.0,
                    "prob_up_if_signal_positive": 0.54,
                    "prob_up_if_signal_negative": 0.46,
                    "label": "eth30s_momentum_gate2",
                }
            ],
        }
    ]
    eth_30s["notes"]["production_rationale"] = (
        "Base fair-mid model plus a light ETH 30s momentum overlay when gap-delta exceeds 2bp."
    )

    btc_1m["alpha"] = 1.0
    btc_1m["margin"] = 0.01
    btc_1m["neutral_band"] = 0.01
    btc_1m["overlays"] = [
        {
            "type": "gated_directional_override",
            "gate_metric": "delta_gap_spot_1u",
            "signal_metric": "chain_ret_1u_bp",
            "default_prob_up": 0.5,
            "label": "btc1m_momentum",
            "bands": [
                {
                    "min_abs_gate_bp": 2.0,
                    "prob_up_if_signal_positive": 0.56,
                    "prob_up_if_signal_negative": 0.44,
                    "label": "btc1m_momentum_gate2",
                }
            ],
        }
    ]
    btc_1m["notes"]["production_rationale"] = (
        "Base fair-mid model plus a BTC 1m momentum overlay when gap-delta exceeds 2bp."
    )

    eth_1m["alpha"] = 1.0
    eth_1m["margin"] = 0.01
    eth_1m["neutral_band"] = 0.01
    eth_1m["overlays"] = [
        {
            "type": "gated_directional_override",
            "gate_metric": "delta_gap_spot_1u",
            "signal_metric": "chain_ret_1u_bp",
            "default_prob_up": 0.5,
            "label": "eth1m_momentum",
            "bands": [
                {
                    "min_abs_gate_bp": 3.0,
                    "prob_up_if_signal_positive": 0.60,
                    "prob_up_if_signal_negative": 0.40,
                    "label": "eth1m_momentum_gate3",
                }
            ],
        }
    ]
    eth_1m["notes"]["production_rationale"] = (
        "Base fair-mid model plus a stronger ETH 1m momentum overlay when gap-delta exceeds 3bp."
    )

    btc_3m["alpha"] = 1.0
    btc_3m["margin"] = 0.0
    btc_3m["neutral_band"] = 0.0
    btc_3m["overlays"] = [
        {
            "type": "gated_directional_override",
            "gate_metric": "delta_gap_spot_1u",
            "signal_metric": "spot_ret_1u_bp",
            "default_prob_up": 0.5,
            "label": "btc3m_mean_reversion",
            "bands": [
                {
                    "min_abs_gate_bp": 3.0,
                    "prob_up_if_signal_positive": 0.44,
                    "prob_up_if_signal_negative": 0.56,
                    "label": "btc3m_strong_mean_reversion",
                },
                {
                    "min_abs_gate_bp": 2.0,
                    "prob_up_if_signal_positive": 0.46,
                    "prob_up_if_signal_negative": 0.54,
                    "label": "btc3m_mild_mean_reversion",
                },
            ],
        }
    ]
    btc_3m["notes"]["production_rationale"] = (
        "Explicit BTC 3m mean-reversion overlay. When recent 3m spot move is stretched and gap-delta is active, "
        "lean against the move."
    )

    eth_3m["alpha"] = 1.0
    eth_3m["margin"] = 0.0
    eth_3m["neutral_band"] = 0.0
    eth_3m["overlays"] = [
        {
            "type": "gated_directional_override",
            "gate_metric": "delta_gap_spot_1u",
            "signal_metric": "spot_ret_1u_bp",
            "default_prob_up": 0.5,
            "label": "eth3m_momentum",
            "bands": [
                {
                    "min_abs_gate_bp": 3.0,
                    "prob_up_if_signal_positive": 0.58,
                    "prob_up_if_signal_negative": 0.42,
                    "label": "eth3m_momentum_gate3",
                }
            ],
        }
    ]
    eth_3m["notes"]["production_rationale"] = (
        "Base fair-mid model plus an ETH 3m momentum overlay on large gap-delta states."
    )

    eth_5m["alpha"] = 1.0
    eth_5m["margin"] = 0.0
    eth_5m["neutral_band"] = 0.0
    eth_5m["overlays"] = [
        {
            "type": "gated_directional_override",
            "gate_metric": "delta_gap_spot_1u",
            "signal_metric": "delta_gap_perp_1u",
            "default_prob_up": 0.5,
            "label": "eth5m_momentum",
            "bands": [
                {
                    "min_abs_gate_bp": 3.0,
                    "prob_up_if_signal_positive": 0.60,
                    "prob_up_if_signal_negative": 0.40,
                    "label": "eth5m_momentum_gate3",
                },
            ],
        }
    ]
    eth_5m["notes"]["production_rationale"] = (
        "Base fair-mid model plus a strong ETH 5m momentum overlay when gap-delta exceeds 3bp."
    )

    btc_15m["alpha"] = 1.0
    btc_15m["margin"] = 0.0
    btc_15m["neutral_band"] = 0.0
    btc_15m["overlays"] = [
        {
            "type": "gated_directional_override",
            "gate_metric": "delta_gap_spot_1u",
            "signal_metric": "delta_gap_spot_1u",
            "default_prob_up": 0.5,
            "label": "btc15m_mean_reversion",
            "bands": [
                {
                    "min_abs_gate_bp": 2.0,
                    "prob_up_if_signal_positive": 0.40,
                    "prob_up_if_signal_negative": 0.60,
                    "label": "btc15m_strong_mean_reversion",
                }
            ],
        }
    ]
    btc_15m["notes"]["production_rationale"] = (
        "Strong BTC 15m mean-reversion overlay on widening gap-delta states."
    )

    eth_15m["alpha"] = 1.0
    eth_15m["margin"] = 0.0
    eth_15m["neutral_band"] = 0.0
    eth_15m["overlays"] = [
        {
            "type": "gated_directional_override",
            "gate_metric": "delta_gap_spot_1u",
            "signal_metric": "chain_ret_1u_bp",
            "default_prob_up": 0.5,
            "label": "eth15m_momentum",
            "bands": [
                {
                    "min_abs_gate_bp": 3.0,
                    "prob_up_if_signal_positive": 0.58,
                    "prob_up_if_signal_negative": 0.42,
                    "label": "eth15m_momentum_gate3",
                }
            ],
        }
    ]
    eth_15m["notes"]["production_rationale"] = (
        "Base fair-mid model plus an ETH 15m momentum overlay in strong gap-delta states."
    )

    btc_1h["alpha"] = 1.0
    btc_1h["margin"] = 0.0
    btc_1h["neutral_band"] = 0.0
    btc_1h["overlays"] = [
        {
            "type": "gated_directional_override",
            "gate_metric": "delta_gap_spot_1u",
            "signal_metric": "chain_ret_1u_bp",
            "default_prob_up": 0.5,
            "label": "btc1h_momentum",
            "bands": [
                {
                    "min_abs_gate_bp": 3.0,
                    "prob_up_if_signal_positive": 0.60,
                    "prob_up_if_signal_negative": 0.40,
                    "label": "btc1h_momentum_gate3",
                }
            ],
        }
    ]
    btc_1h["notes"]["production_rationale"] = (
        "Base fair-mid model plus a BTC 1h momentum overlay in large gap-delta states."
    )

    eth_1h["alpha"] = 1.0
    eth_1h["margin"] = 0.0
    eth_1h["neutral_band"] = 0.0
    eth_1h["overlays"] = [
        {
            "type": "gated_directional_override",
            "gate_metric": "delta_gap_spot_1u",
            "signal_metric": "perp_ret_1u_bp",
            "default_prob_up": 0.5,
            "label": "eth1h_momentum",
            "bands": [
                {
                    "min_abs_gate_bp": 3.0,
                    "prob_up_if_signal_positive": 0.62,
                    "prob_up_if_signal_negative": 0.38,
                    "label": "eth1h_momentum_gate3",
                },
            ],
        }
    ]
    eth_1h["notes"]["production_rationale"] = (
        "Base fair-mid model plus a strong ETH 1h momentum overlay in large gap-delta states."
    )

    for key, config in configs.items():
        config["notes"]["deployment_profile"] = "production_final"
        config["notes"]["starter_logic"] = (
            "Production final: calibrated Chainlink fair-mid model everywhere, plus delayed basis and longer-horizon "
            "mean-reversion overlays where replay supported them."
        )
        config["notes"]["implementation_mode"] = "single_final_monitor"
        config.setdefault("overlays", [])

    FINAL_CONFIG_PATH.write_text(json.dumps(configs, indent=2), encoding="utf-8")

    spec = """# Chainlink Production Monitor Final

## Objective
One production-ready live quote monitor for Chainlink-settled products that:
- assumes a 1 second entry delay for every product
- estimates fair `P(Higher)` first
- applies conservative product-level deployment rules
- then converts probability to a two-way quote at the chosen edge

## Source files for dev handoff
- `outputs/chainlink_product_suite_final_models.json`
- `live_chainlink_product_suite_console.html`
- `live_chainlink_product_suite_console.js`
- `build_chainlink_theoretical_mid_suite.py`
- `build_chainlink_production_config.py`
- `build_chainlink_final_config.py`

## Production logic
1. Build live features from:
   - Chainlink mid
   - Binance spot
   - Binance perp
   - recent gap changes and return/vol context
2. Score the fitted raw model.
3. Calibrate raw probability using the saved calibration block.
4. Apply any explicit overlay rules.
5. Apply deployment shrink:
   - `deployed_p = 0.5 + alpha * (model_p - 0.5)`
   - in the final deploy config, `alpha = 1.0` means use the backtested model as-is
   - lower or higher runtime alpha values are optional commercial/risk overrides around that base
6. Apply neutral-band logic and the hard probability cap implied by the payout floor.
7. Convert deployed probability to payouts at user-selected edge:
   - favored payout = `100 * (1 - edge) / p - 100`
   - other payout = `100 * (1 - edge) / (1 - p) - 100`

## Defensive-side floor
- minimum low-side payout is `65`
- no quote may go below `65` on the defensive / favored side
- the only cap is the payout-floor-implied hard cap

## Product policy
- BTC 30s: flat by default plus delayed basis overlay
- ETH 30s: light momentum overlay
- BTC 1m: momentum overlay
- ETH 1m: stronger momentum overlay
- BTC 3m: explicit mean-reversion skew
- ETH 3m: momentum overlay
- BTC 5m: flat
- ETH 5m: strong momentum overlay
- BTC 15m: strong mean-reversion skew
- ETH 15m: momentum overlay
- BTC 1h: momentum overlay
- ETH 1h: strong momentum overlay

## BTC 30s explicit overlay
- metric: `delta_gap_spot_1u`
- interpretation: current Chainlink-vs-spot gap minus gap 30 seconds ago
- entry assumption: signal at `t`, trade enters at `t+1s`
- rules:
  - if `delta_gap_spot_1u >= 3bp`, set fair `P(Higher)=55%`
  - if `delta_gap_spot_1u <= -3bp`, set fair `P(Higher)=45%`
  - else if `delta_gap_spot_1u >= 2bp`, set fair `P(Higher)=53%`
  - else if `delta_gap_spot_1u <= -2bp`, set fair `P(Higher)=47%`
  - else use flat `50%`

## Operating note
Weak products are intentionally held close to `50/50` unless a replay-supported overlay is active. The final production profile uses smoothed replay-derived regime overlays rather than raw unsmoothed bucket outputs.
"""
    SPEC_PATH.write_text(spec, encoding="utf-8")
    print(str(FINAL_CONFIG_PATH))


if __name__ == "__main__":
    main()
