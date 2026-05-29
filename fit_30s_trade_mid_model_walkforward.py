from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler


ROOT = Path(__file__).resolve().parent
SOURCE_CSV = ROOT / "live_mid_model_30s_v1_trade_eval.csv"
OUT_JSON = ROOT / "live_mid_model_30s_walkforward_report.json"
OUT_MD = ROOT / "live_mid_model_30s_walkforward_report.md"
OUT_BEST_JSON = ROOT / "live_mid_model_30s_best_trade_model.json"


@dataclass(frozen=True)
class SplitConfig:
    train_days: tuple[str, ...]
    test_day: str
    label: str


SPLITS = [
    SplitConfig(("2026-05-21",), "2026-05-22", "21->22"),
    SplitConfig(("2026-05-21", "2026-05-22"), "2026-05-25", "21-22->25"),
    SplitConfig(("2026-05-21", "2026-05-22", "2026-05-25"), "2026-05-26", "21-25->26"),
]


def load_trade_seconds() -> pd.DataFrame:
    df = pd.read_csv(SOURCE_CSV, parse_dates=["ts_utc"])
    df["day_sg"] = df["ts_utc"].dt.tz_convert("Asia/Singapore").dt.strftime("%Y-%m-%d")
    df["mr_gap_bps"] = df["ret_3s_bps"] - df["ret_10s_bps"]
    df["mr_snap_bps"] = df["microprice_dev_bps"] - df["ret_3s_bps"]
    df["ret_abs_3s"] = df["ret_3s_bps"].abs()
    df["ret_abs_10s"] = df["ret_10s_bps"].abs()
    df["book_momo_agree"] = np.sign(df["imb_top10_notional"]) * np.sign(df["ret_3s_bps"]).astype(float)
    df["book_micro_agree"] = np.sign(df["imb_top10_notional"]) * np.sign(df["microprice_dev_bps"]).astype(float)
    df["persist_agree_05"] = np.sign(df["signed_persist_05"]) * np.sign(df["ret_3s_bps"]).astype(float)
    return df


FEATURE_GROUPS = {
    "skew": [
        "imb_top5_notional",
        "imb_top5_size",
        "imb_top10_notional",
        "imb_top10_size",
        "signed_persist_05",
        "signed_persist_06",
        "microprice_dev_bps",
    ],
    "momentum": [
        "ret_3s_bps",
        "ret_10s_bps",
    ],
    "vol": [
        "spread_bps",
        "vol_10s_bps",
        "thin_depth",
        "ret_abs_3s",
        "ret_abs_10s",
    ],
    "mean_reversion": [
        "mr_gap_bps",
        "mr_snap_bps",
    ],
    "confirmation": [
        "book_momo_agree",
        "book_micro_agree",
        "persist_agree_05",
    ],
}


FEATURE_SETS = {
    "skew_only": FEATURE_GROUPS["skew"],
    "skew_plus_momentum": FEATURE_GROUPS["skew"] + FEATURE_GROUPS["momentum"],
    "skew_plus_vol": FEATURE_GROUPS["skew"] + FEATURE_GROUPS["vol"],
    "skew_plus_mean_reversion": FEATURE_GROUPS["skew"] + FEATURE_GROUPS["mean_reversion"],
    "core_no_confirmation": FEATURE_GROUPS["skew"] + FEATURE_GROUPS["momentum"] + FEATURE_GROUPS["vol"] + FEATURE_GROUPS["mean_reversion"],
    "core_with_confirmation": FEATURE_GROUPS["skew"] + FEATURE_GROUPS["momentum"] + FEATURE_GROUPS["vol"] + FEATURE_GROUPS["mean_reversion"] + FEATURE_GROUPS["confirmation"],
}


def make_model() -> Pipeline:
    return Pipeline(
        steps=[
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
            ("model", LogisticRegression(max_iter=2000, C=0.5)),
        ]
    )


def evaluate(y_true: np.ndarray, probs: np.ndarray, trade_count: np.ndarray) -> dict:
    probs = np.clip(probs, 1e-6, 1 - 1e-6)
    preds = (probs > 0.5).astype(int)
    return {
        "n_rows": int(len(y_true)),
        "trade_count": int(trade_count.sum()),
        "accuracy_pct": round(float(accuracy_score(y_true, preds) * 100), 2),
        "accuracy_trade_weighted_pct": round(float(accuracy_score(y_true, preds, sample_weight=trade_count) * 100), 2),
        "brier": round(float(brier_score_loss(y_true, probs)), 5),
        "logloss": round(float(log_loss(y_true, probs)), 5),
        "avg_pred": round(float(probs.mean()), 5),
        "actual_up_rate": round(float(y_true.mean()), 5),
    }


def walk_forward(df: pd.DataFrame, features: list[str]) -> dict:
    split_results = []
    for split in SPLITS:
        train_df = df[df["day_sg"].isin(split.train_days)].copy()
        test_df = df[df["day_sg"] == split.test_day].copy()
        model = make_model()
        model.fit(train_df[features], train_df["actual_up_30s"].astype(int))
        probs = model.predict_proba(test_df[features])[:, 1]
        metric = evaluate(test_df["actual_up_30s"].to_numpy(dtype=int), probs, test_df["trade_count"].to_numpy())
        metric["split"] = split.label
        split_results.append(metric)

    mean_weighted_accuracy = float(np.mean([r["accuracy_trade_weighted_pct"] for r in split_results]))
    mean_logloss = float(np.mean([r["logloss"] for r in split_results]))
    mean_brier = float(np.mean([r["brier"] for r in split_results]))
    return {
        "features": features,
        "splits": split_results,
        "mean_accuracy_trade_weighted_pct": round(mean_weighted_accuracy, 2),
        "mean_logloss": round(mean_logloss, 5),
        "mean_brier": round(mean_brier, 5),
    }


def fit_full(df: pd.DataFrame, features: list[str]) -> dict:
    model = make_model()
    model.fit(df[features], df["actual_up_30s"].astype(int))
    probs = model.predict_proba(df[features])[:, 1]
    metric = evaluate(df["actual_up_30s"].to_numpy(dtype=int), probs, df["trade_count"].to_numpy())
    scaler = model.named_steps["scale"]
    log_model = model.named_steps["model"]
    return {
        "features": features,
        "coefficients": {
            "intercept": float(log_model.intercept_[0]),
            "coef": [float(x) for x in log_model.coef_[0]],
            "means": [float(x) for x in scaler.mean_],
            "scales": [float(x) for x in scaler.scale_],
        },
        "full_sample_eval": metric,
    }


def recommended_training_policy(best_name: str, best_result: dict) -> dict:
    weighted_acc = best_result["mean_accuracy_trade_weighted_pct"]
    if weighted_acc >= 55.5:
        cadence = "daily Singapore morning retrain"
    else:
        cadence = "daily retrain plus 4-hour challenger refresh in shadow mode"
    return {
        "recommended_retrain_cadence": cadence,
        "live_policy": [
            "Freeze coefficients between retrains; do not self-train every second.",
            "Use rolling walk-forward promotion only if challenger beats champion on weighted accuracy, logloss, and Brier.",
            "Keep confirmation features switchable so flow-like confirmation can be enabled later without changing the training scaffold.",
        ],
        "why": f"Best walk-forward family `{best_name}` averaged {best_result['mean_accuracy_trade_weighted_pct']}% trade-weighted accuracy with logloss {best_result['mean_logloss']}.",
    }


def build_markdown(summary: dict) -> str:
    lines = []
    lines.append("# BTC 30s Live Mid Model Walk-Forward Report")
    lines.append("")
    lines.append(f"Best family: **{summary['best_feature_set']}**")
    lines.append("")
    lines.append("## Feature Families")
    for name, cols in FEATURE_GROUPS.items():
        lines.append(f"- `{name}`: {', '.join(cols)}")
    lines.append("")
    lines.append("## Walk-Forward Results")
    for name, result in summary["feature_set_results"].items():
        lines.append(f"### {name}")
        lines.append(f"- Mean trade-weighted accuracy: `{result['mean_accuracy_trade_weighted_pct']}%`")
        lines.append(f"- Mean logloss: `{result['mean_logloss']}`")
        lines.append(f"- Mean Brier: `{result['mean_brier']}`")
        for split in result["splits"]:
            lines.append(
                f"- {split['split']}: weighted acc `{split['accuracy_trade_weighted_pct']}%`, "
                f"logloss `{split['logloss']}`, rows `{split['n_rows']}`, trades `{split['trade_count']}`"
            )
        lines.append("")
    lines.append("## Best Model Deployment Parameters")
    best = summary["best_model"]
    lines.append(f"- Feature set: `{summary['best_feature_set']}`")
    lines.append(f"- Full-sample weighted accuracy: `{best['full_sample_eval']['accuracy_trade_weighted_pct']}%`")
    lines.append(f"- Full-sample logloss: `{best['full_sample_eval']['logloss']}`")
    lines.append(f"- Full-sample Brier: `{best['full_sample_eval']['brier']}`")
    lines.append("")
    lines.append("## Recommended Training Policy")
    lines.append(f"- Cadence: `{summary['training_policy']['recommended_retrain_cadence']}`")
    for item in summary["training_policy"]["live_policy"]:
        lines.append(f"- {item}")
    lines.append("")
    lines.append("## Notes")
    lines.append("- This report is built on trade-time seconds from the cached Tardis/orderbook feature export.")
    lines.append("- Flow confirmation is left as a switchable feature family, not forced on by default.")
    return "\n".join(lines) + "\n"


def main() -> None:
    df = load_trade_seconds()
    results = {name: walk_forward(df, features) for name, features in FEATURE_SETS.items()}
    best_name, best_result = sorted(
        results.items(),
        key=lambda kv: (-kv[1]["mean_accuracy_trade_weighted_pct"], kv[1]["mean_logloss"]),
    )[0]
    best_model = fit_full(df, FEATURE_SETS[best_name])
    summary = {
        "source_csv": SOURCE_CSV.name,
        "rows": int(len(df)),
        "days": sorted(df["day_sg"].unique().tolist()),
        "feature_groups": FEATURE_GROUPS,
        "feature_set_results": results,
        "best_feature_set": best_name,
        "best_model": best_model,
        "training_policy": recommended_training_policy(best_name, best_result),
    }
    OUT_JSON.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    OUT_BEST_JSON.write_text(json.dumps(best_model, indent=2), encoding="utf-8")
    OUT_MD.write_text(build_markdown(summary), encoding="utf-8")
    print(json.dumps({
        "out_json": str(OUT_JSON),
        "out_md": str(OUT_MD),
        "out_best_json": str(OUT_BEST_JSON),
        "best_feature_set": best_name,
        "best_weighted_accuracy_pct": best_result["mean_accuracy_trade_weighted_pct"],
        "best_mean_logloss": best_result["mean_logloss"],
    }, indent=2))


if __name__ == "__main__":
    main()
