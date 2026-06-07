from __future__ import annotations

import json
import math
from pathlib import Path

import pandas as pd


OUTPUT_DIR = Path(__file__).resolve().parent / "outputs"
SCHEDULE_PATH = OUTPUT_DIR / "longer_product_recommended_schedule.csv"
SUMMARY_PATH = OUTPUT_DIR / "longer_product_strategy_summary.csv"
DIAGNOSTICS_PATH = OUTPUT_DIR / "longer_product_bucket_diagnostics.csv"
OUT_PATH = OUTPUT_DIR / "turbo_product_suite_final_models.json"
FLOOR = 65.0


PAIR_SYMBOLS = {
    "BTC/USDT": "BTCUSDT",
    "ETH/USDT": "ETHUSDT",
}

ALL_PRODUCTS = [
    ("BTC/USDT", "30s", 30),
    ("ETH/USDT", "30s", 30),
    ("BTC/USDT", "1m", 60),
    ("ETH/USDT", "1m", 60),
    ("BTC/USDT", "3m", 180),
    ("ETH/USDT", "3m", 180),
    ("BTC/USDT", "5m", 300),
    ("ETH/USDT", "5m", 300),
    ("BTC/USDT", "15m", 900),
    ("ETH/USDT", "15m", 900),
    ("BTC/USDT", "1h", 3600),
    ("ETH/USDT", "1h", 3600),
]

PRODUCTION_BUCKET_OVERRIDES = {
    "BTC/USDT::3m": {
        "0-5": {"mode": "mean_reversion", "p_up_if_move_positive": 0.455, "p_up_if_move_negative": 0.545},
        "5-10": {"mode": "mean_reversion", "p_up_if_move_positive": 0.435, "p_up_if_move_negative": 0.565},
        "10-15": {"mode": "mean_reversion", "p_up_if_move_positive": 0.420, "p_up_if_move_negative": 0.580},
        "15-20": {"mode": "mean_reversion", "p_up_if_move_positive": 0.410, "p_up_if_move_negative": 0.590},
        "20+": {"mode": "mean_reversion", "p_up_if_move_positive": 0.415, "p_up_if_move_negative": 0.585},
    },
    "ETH/USDT::3m": {
        "0-5": {"mode": "mean_reversion", "p_up_if_move_positive": 0.460, "p_up_if_move_negative": 0.540},
        "5-10": {"mode": "mean_reversion", "p_up_if_move_positive": 0.450, "p_up_if_move_negative": 0.550},
        "10-15": {"mode": "mean_reversion", "p_up_if_move_positive": 0.450, "p_up_if_move_negative": 0.550},
        "15-20": {"mode": "mean_reversion", "p_up_if_move_positive": 0.440, "p_up_if_move_negative": 0.560},
        "20+": {"mode": "mean_reversion", "p_up_if_move_positive": 0.430, "p_up_if_move_negative": 0.570},
    },
    "BTC/USDT::5m": {
        "0-5": {"mode": "mean_reversion", "p_up_if_move_positive": 0.475, "p_up_if_move_negative": 0.525},
        "5-10": {"mode": "mean_reversion", "p_up_if_move_positive": 0.470, "p_up_if_move_negative": 0.530},
        "10-15": {"mode": "mean_reversion", "p_up_if_move_positive": 0.400, "p_up_if_move_negative": 0.600},
        "15-20": {"mode": "momentum", "p_up_if_move_positive": 0.510, "p_up_if_move_negative": 0.490},
        "20+": {"mode": "momentum", "p_up_if_move_positive": 0.515, "p_up_if_move_negative": 0.485},
    },
    "ETH/USDT::5m": {
        "0-5": {"mode": "mean_reversion", "p_up_if_move_positive": 0.460, "p_up_if_move_negative": 0.540},
        "5-10": {"mode": "mean_reversion", "p_up_if_move_positive": 0.465, "p_up_if_move_negative": 0.535},
        "10-15": {"mode": "mean_reversion", "p_up_if_move_positive": 0.455, "p_up_if_move_negative": 0.545},
        "15-20": {"mode": "mean_reversion", "p_up_if_move_positive": 0.445, "p_up_if_move_negative": 0.555},
        "20+": {"mode": "mean_reversion", "p_up_if_move_positive": 0.480, "p_up_if_move_negative": 0.520},
    },
    "BTC/USDT::15m": {
        "0-10": {"mode": "mean_reversion", "p_up_if_move_positive": 0.490, "p_up_if_move_negative": 0.510},
        "10-20": {"mode": "mean_reversion", "p_up_if_move_positive": 0.420, "p_up_if_move_negative": 0.580},
        "20-30": {"mode": "flat", "p_up_if_move_positive": 0.500, "p_up_if_move_negative": 0.500},
        "30-40": {"mode": "momentum", "p_up_if_move_positive": 0.600, "p_up_if_move_negative": 0.400},
        "40+": {"mode": "mean_reversion", "p_up_if_move_positive": 0.420, "p_up_if_move_negative": 0.580},
    },
    "ETH/USDT::15m": {
        "0-10": {"mode": "momentum", "p_up_if_move_positive": 0.580, "p_up_if_move_negative": 0.420},
        "10-20": {"mode": "momentum", "p_up_if_move_positive": 0.590, "p_up_if_move_negative": 0.410},
        "20-30": {"mode": "momentum", "p_up_if_move_positive": 0.620, "p_up_if_move_negative": 0.380},
        "30-40": {"mode": "mean_reversion", "p_up_if_move_positive": 0.380, "p_up_if_move_negative": 0.620},
        "40+": {"mode": "mean_reversion", "p_up_if_move_positive": 0.390, "p_up_if_move_negative": 0.610},
    },
    "BTC/USDT::1h": {
        "0-15": {"mode": "mean_reversion", "p_up_if_move_positive": 0.430, "p_up_if_move_negative": 0.570},
        "15-30": {"mode": "mean_reversion", "p_up_if_move_positive": 0.445, "p_up_if_move_negative": 0.555},
        "30-45": {"mode": "mean_reversion", "p_up_if_move_positive": 0.400, "p_up_if_move_negative": 0.600},
        "45-60": {"mode": "mean_reversion", "p_up_if_move_positive": 0.370, "p_up_if_move_negative": 0.630},
        "60-90": {"mode": "mean_reversion", "p_up_if_move_positive": 0.390, "p_up_if_move_negative": 0.610},
        "90+": {"mode": "mean_reversion", "p_up_if_move_positive": 0.420, "p_up_if_move_negative": 0.580},
    },
    "ETH/USDT::1h": {
        "0-15": {"mode": "mean_reversion", "p_up_if_move_positive": 0.410, "p_up_if_move_negative": 0.590},
        "15-30": {"mode": "mean_reversion", "p_up_if_move_positive": 0.380, "p_up_if_move_negative": 0.620},
        "30-45": {"mode": "mean_reversion", "p_up_if_move_positive": 0.370, "p_up_if_move_negative": 0.630},
        "45-60": {"mode": "mean_reversion", "p_up_if_move_positive": 0.360, "p_up_if_move_negative": 0.640},
        "60-90": {"mode": "mean_reversion", "p_up_if_move_positive": 0.360, "p_up_if_move_negative": 0.640},
        "90+": {"mode": "mean_reversion", "p_up_if_move_positive": 0.360, "p_up_if_move_negative": 0.640},
    },
}


def p_up_from_bucket_win_rates(mode: str, mean_reversion_win_rate_pct: float, momentum_win_rate_pct: float) -> tuple[float, float, float]:
    mr = float(mean_reversion_win_rate_pct) / 100.0
    mom = float(momentum_win_rate_pct) / 100.0
    if mode == "mean_reversion":
        p_up_if_move_positive = 1.0 - mr
        p_up_if_move_negative = mr
        chosen_win_rate = mr
    elif mode == "momentum":
        p_up_if_move_positive = mom
        p_up_if_move_negative = 1.0 - mom
        chosen_win_rate = mom
    else:
        p_up_if_move_positive = 0.5
        p_up_if_move_negative = 0.5
        chosen_win_rate = 0.5
    return p_up_if_move_positive, p_up_if_move_negative, chosen_win_rate


def finite_or_none(value):
    number = float(value)
    return number if math.isfinite(number) else None


def build_disabled(pair: str, product: str, duration_s: int) -> dict:
    return {
        "pair": pair,
        "symbol": PAIR_SYMBOLS[pair],
        "product": product,
        "duration_s": duration_s,
        "entry_delay_s": 1,
        "edge_pct": 4.0,
        "favored_payout_floor": FLOOR,
        "alpha": 1.0,
        "margin": 0.0,
        "engine": "turbo_disabled",
        "active_mode": "suppress",
        "model": {"features": []},
        "notes": {
            "family": "turbo",
            "source": "turbo_7d_backtest",
            "production_rationale": "Weekend turbo model has this product turned off.",
            "selection_metric": "Suppressed by policy for the current turbo weekend deployment.",
            "implementation_mode": "turbo_family_monitor",
        },
        "neutral_band": 0.0,
        "flip_signal": False,
        "calibration": {"kind": "identity", "flip_signal": False},
        "overlays": [],
    }


def main() -> None:
    sched = pd.read_csv(SCHEDULE_PATH)
    summary = pd.read_csv(SUMMARY_PATH)
    diagnostics = pd.read_csv(DIAGNOSTICS_PATH)

    configs: dict[str, dict] = {}
    for pair, product, duration_s in ALL_PRODUCTS:
        configs[f"{pair}::{product}"] = build_disabled(pair, product, duration_s)

    summary_idx = {
        (row["pair_name"], row["product"]): row
        for _, row in summary.iterrows()
    }
    diagnostics_idx = {
        (row["pair_name"], row["product"], int(row["lookback_min"]), row["bucket_label"]): row
        for _, row in diagnostics.iterrows()
    }

    for (pair, product), group in sched.groupby(["pair_name", "product"], sort=False):
        if product in {"30s", "1m"}:
            continue
        duration_s = int(group["duration"].iloc[0])
        lookback_min = int(group["lookback_min"].iloc[0])
        summary_row = summary_idx[(pair, product)]
        base_payout_pct = float(summary_row["base_payout_pct"])
        improvement_vs_flat = float(summary_row["improvement_vs_flat_base"])

        product_key = f"{pair}::{product}"
        production_overrides = PRODUCTION_BUCKET_OVERRIDES.get(product_key, {})
        buckets = []
        for _, row in group.sort_values("bucket_label").iterrows():
            danger = float(row["danger_payout_pct"])
            safe = float(row["safe_payout_pct"])
            mode = str(row["recommended_mode"])
            label = str(row["bucket_label"])
            diag_row = diagnostics_idx[(pair, product, lookback_min, label)]
            p_up_if_move_positive, p_up_if_move_negative, chosen_win_rate = p_up_from_bucket_win_rates(
                mode,
                float(diag_row["mean_reversion_win_rate_pct"]),
                float(diag_row["momentum_win_rate_pct"]),
            )
            override = production_overrides.get(label)
            if override:
                mode = str(override["mode"])
                p_up_if_move_positive = float(override["p_up_if_move_positive"])
                p_up_if_move_negative = float(override["p_up_if_move_negative"])
                chosen_win_rate = max(p_up_if_move_positive, p_up_if_move_negative)
            lower_str, upper_str = label.split("-") if "-" in label else (label.replace("+", ""), "")
            min_abs_bp = float(lower_str)
            max_abs_bp = None if label.endswith("+") else float(upper_str)
            buckets.append({
                "label": label,
                "mode": mode,
                "min_abs_bp": min_abs_bp,
                "max_abs_bp": max_abs_bp,
                "danger_payout_pct": danger,
                "safe_payout_pct": safe,
                "p_up_if_move_positive": p_up_if_move_positive,
                "p_up_if_move_negative": p_up_if_move_negative,
                "chosen_win_rate_pct": finite_or_none(diag_row["momentum_win_rate_pct"] if mode == "momentum" else diag_row["mean_reversion_win_rate_pct"]),
                "mean_reversion_win_rate_pct": finite_or_none(diag_row["mean_reversion_win_rate_pct"]),
                "momentum_win_rate_pct": finite_or_none(diag_row["momentum_win_rate_pct"]),
                "chosen_skew_pp": (chosen_win_rate - 0.5) * 100.0,
                "trades": int(diag_row["trades"]),
                "optimized_bucket_pnl": float(row["optimized_bucket_pnl"]),
            })

        configs[product_key] = {
            "pair": pair,
            "symbol": PAIR_SYMBOLS[pair],
            "product": product,
            "duration_s": duration_s,
            "entry_delay_s": 1,
            "edge_pct": 4.0,
            "favored_payout_floor": FLOOR,
            "alpha": 1.0,
            "margin": 0.0,
            "engine": "turbo_bucket",
            "active_mode": "neutral",
            "lookback_s": lookback_min * 60,
            "base_payout_pct": base_payout_pct,
            "model": {
                "features": ["turbo_move_bp", "turbo_abs_move_bp", "platform_skew_pp"],
            },
            "notes": {
                "family": "turbo",
                "source": "turbo_7d_backtest",
                "production_rationale": f"7-day turbo own-feed backtest. Best lookback {lookback_min}m. Smoothed bucket-by-bucket probability ladder derived from empirical move-bucket win rates. Lift vs flat base {improvement_vs_flat:.2f}.",
                "selection_metric": "7-day turbo-feed replay, then smoothed into a production bucket skew function by move size.",
                "implementation_mode": "turbo_family_monitor",
            },
            "neutral_band": 0.0,
            "flip_signal": False,
            "calibration": {"kind": "identity", "flip_signal": False},
            "bucket_rules": buckets,
            "overlays": [],
        }

    OUT_PATH.write_text(json.dumps(configs, indent=2), encoding="utf-8")
    print(str(OUT_PATH))


if __name__ == "__main__":
    main()
