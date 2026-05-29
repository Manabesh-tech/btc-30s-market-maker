from __future__ import annotations

import csv
import gzip
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd
import psycopg2
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parent
DATASET_DIR = ROOT / "tardis_datasets_book25"
OUT_JSON = ROOT / "live_mid_model_30s_v1.json"
OUT_CSV = ROOT / "live_mid_model_30s_v1_trade_eval.csv"

SG = ZoneInfo("Asia/Singapore")
UTC = timezone.utc

DB_CONFIG = {
    "host": "aws-jp-tk-surf-pg-public.cluster-csteuf9lw8dv.ap-northeast-1.rds.amazonaws.com",
    "port": 5432,
    "dbname": "replication_report",
    "user": "manabesh_kaj",
    "password": "dPL084;KF1spv,g",
    "sslmode": "require",
}

BOOK_DAYS = [
    "2026-05-20",
    "2026-05-21",
    "2026-05-22",
    "2026-05-25",
    "2026-05-26",
]

FEATURES = [
    "imb_top5_notional",
    "imb_top5_size",
    "imb_top10_notional",
    "imb_top10_size",
    "signed_persist_05",
    "signed_persist_06",
    "microprice_dev_bps",
    "ret_3s_bps",
    "ret_10s_bps",
    "spread_bps",
    "vol_10s_bps",
    "thin_depth",
]


@dataclass(frozen=True)
class SplitConfig:
    train_days: tuple[str, ...]
    test_day: str
    label: str


SPLITS = [
    SplitConfig(("2026-05-20",), "2026-05-21", "20->21"),
    SplitConfig(("2026-05-20", "2026-05-21"), "2026-05-22", "20-21->22"),
    SplitConfig(("2026-05-20", "2026-05-21", "2026-05-22"), "2026-05-25", "20-22->25"),
    SplitConfig(("2026-05-20", "2026-05-21", "2026-05-22", "2026-05-25"), "2026-05-26", "20-25->26"),
]


def date_range_bounds(day_key: str) -> tuple[datetime, datetime]:
    day_start = datetime.fromisoformat(f"{day_key}T00:00:00").replace(tzinfo=SG).astimezone(UTC)
    day_end = (day_start.astimezone(SG).replace(tzinfo=SG) + pd.Timedelta(days=1)).astimezone(UTC)
    return day_start, day_end


def dataset_path(day_key: str) -> Path:
    return DATASET_DIR / f"binance-futures_book_snapshot_25_{day_key}_BTCUSDT.csv.gz"


def sign_for(value: float, threshold: float) -> int:
    if value >= threshold:
        return 1
    if value <= -threshold:
        return -1
    return 0


def _depth_pair(row: list[str], level: int) -> tuple[float, float, float, float]:
    ask_price = float(row[4 + level * 4])
    ask_amt = float(row[5 + level * 4])
    bid_price = float(row[6 + level * 4])
    bid_amt = float(row[7 + level * 4])
    return ask_price, ask_amt, bid_price, bid_amt


def load_book_day(day_key: str) -> pd.DataFrame:
    path = dataset_path(day_key)
    if not path.exists():
        raise FileNotFoundError(path)

    per_sec: dict[int, dict[str, float]] = {}

    with gzip.open(path, "rt", newline="") as f:
        reader = csv.reader(f)
        next(reader)
        for row in reader:
            ts_us = int(row[2])
            ts_sec = ts_us // 1_000_000

            ask0, ask0_amt, bid0, bid0_amt = _depth_pair(row, 0)
            mid = (ask0 + bid0) / 2
            spread_bps = ((ask0 - bid0) / mid) * 10_000 if mid else 0.0
            micro = ((ask0 * bid0_amt) + (bid0 * ask0_amt)) / max(bid0_amt + ask0_amt, 1e-9)
            micro_dev_bps = ((micro - mid) / mid) * 10_000 if mid else 0.0

            bid_notional_5 = ask_notional_5 = bid_size_5 = ask_size_5 = 0.0
            bid_notional_10 = ask_notional_10 = bid_size_10 = ask_size_10 = 0.0
            bid_notional_25 = ask_notional_25 = 0.0
            for i in range(25):
                ask_price, ask_amt, bid_price, bid_amt = _depth_pair(row, i)
                bid_notional_25 += bid_price * bid_amt
                ask_notional_25 += ask_price * ask_amt
                if i < 10:
                    bid_notional_10 += bid_price * bid_amt
                    ask_notional_10 += ask_price * ask_amt
                    bid_size_10 += bid_amt
                    ask_size_10 += ask_amt
                if i < 5:
                    bid_notional_5 += bid_price * bid_amt
                    ask_notional_5 += ask_price * ask_amt
                    bid_size_5 += bid_amt
                    ask_size_5 += ask_amt

            imb_top5_notional = (bid_notional_5 - ask_notional_5) / max(bid_notional_5 + ask_notional_5, 1e-9)
            imb_top5_size = (bid_size_5 - ask_size_5) / max(bid_size_5 + ask_size_5, 1e-9)
            imb_top10_notional = (bid_notional_10 - ask_notional_10) / max(bid_notional_10 + ask_notional_10, 1e-9)
            imb_top10_size = (bid_size_10 - ask_size_10) / max(bid_size_10 + ask_size_10, 1e-9)
            total_depth = bid_notional_25 + ask_notional_25

            # Keep the last snapshot in each second.
            per_sec[ts_sec] = {
                "ts_sec": ts_sec,
                "mid": mid,
                "spread_bps": spread_bps,
                "microprice_dev_bps": micro_dev_bps,
                "imb_top5_notional": imb_top5_notional,
                "imb_top5_size": imb_top5_size,
                "imb_top10_notional": imb_top10_notional,
                "imb_top10_size": imb_top10_size,
                "total_depth_notional": total_depth,
            }

    df = pd.DataFrame(sorted(per_sec.values(), key=lambda x: x["ts_sec"]))
    df["ts_utc"] = pd.to_datetime(df["ts_sec"], unit="s", utc=True)
    df["day_sg"] = pd.to_datetime(df["ts_utc"]).dt.tz_convert(SG).dt.strftime("%Y-%m-%d")
    df["ret_1s_bps"] = (df["mid"] / df["mid"].shift(1) - 1.0) * 10_000
    df["ret_3s_bps"] = (df["mid"] / df["mid"].shift(3) - 1.0) * 10_000
    df["ret_10s_bps"] = (df["mid"] / df["mid"].shift(10) - 1.0) * 10_000
    df["vol_10s_bps"] = df["ret_1s_bps"].rolling(10, min_periods=4).std()

    roll_med_depth = df["total_depth_notional"].rolling(60, min_periods=10).median()
    df["thin_depth"] = (1.0 - df["total_depth_notional"] / roll_med_depth).clip(lower=0.0, upper=1.0)

    for threshold, out_col in [(0.5, "signed_persist_05"), (0.6, "signed_persist_06")]:
        signs = df["imb_top5_notional"].apply(lambda x: sign_for(float(x), threshold)).to_numpy()
        persist = np.zeros(len(signs), dtype=float)
        run_sign = 0
        run_len = 0
        for i, s in enumerate(signs):
            if s == 0:
                run_sign = 0
                run_len = 0
                persist[i] = 0.0
            elif s == run_sign:
                run_len += 1
                persist[i] = float(s * run_len)
            else:
                run_sign = s
                run_len = 1
                persist[i] = float(s)
        df[out_col] = persist

    return df


def fetch_oracle_prices(start_utc: datetime, end_utc: datetime) -> pd.DataFrame:
    sql = """
    WITH per_sec AS (
      SELECT
        date_trunc('second', created_at) AS ts_sec,
        (array_agg(final_price::numeric ORDER BY created_at DESC))[1] AS price
      FROM public.oracle_price_log_partition_v1
      WHERE pair_name = 'BTC/USDT'
        AND source_type = 0
        AND created_at >= %(start_utc)s
        AND created_at < %(end_utc)s
      GROUP BY 1
    )
    SELECT ts_sec, price::float8
    FROM per_sec
    ORDER BY ts_sec;
    """
    with psycopg2.connect(**DB_CONFIG) as conn:
        oracle = pd.read_sql_query(sql, conn, params={"start_utc": start_utc, "end_utc": end_utc})
    oracle["ts_utc"] = pd.to_datetime(oracle["ts_sec"], utc=True)
    oracle["ts_sec"] = oracle["ts_utc"].astype("int64") // 10**9
    oracle = oracle.rename(columns={"price": "oracle_price"})
    oracle["oracle_price_fwd_30s"] = oracle["oracle_price"].shift(-30)
    oracle["actual_up_30s"] = (oracle["oracle_price_fwd_30s"] > oracle["oracle_price"]).astype("float")
    oracle.loc[oracle["oracle_price_fwd_30s"].isna(), "actual_up_30s"] = np.nan
    return oracle[["ts_sec", "ts_utc", "oracle_price", "oracle_price_fwd_30s", "actual_up_30s"]]


def fetch_trade_seconds(start_utc: datetime, end_utc: datetime) -> pd.DataFrame:
    sql = """
    SELECT
      date_trunc('second', o.created_at) AS ts_sec,
      COUNT(*)::int AS trade_count,
      SUM(o.usdt_value)::float8 AS trade_volume
    FROM public.chain_predict_order o
    JOIN public.trade_pool_pairs p ON p.pair_id = o.pair_id
    WHERE o.order_status = 'Finished'
      AND o.duration = 30
      AND p.pair_name = 'BTC/USDT'
      AND o.created_at >= %(start_utc)s
      AND o.created_at < %(end_utc)s
    GROUP BY 1
    ORDER BY 1;
    """
    with psycopg2.connect(**DB_CONFIG) as conn:
        trades = pd.read_sql_query(sql, conn, params={"start_utc": start_utc, "end_utc": end_utc})
    trades["ts_utc"] = pd.to_datetime(trades["ts_sec"], utc=True)
    trades["ts_sec"] = trades["ts_utc"].astype("int64") // 10**9
    return trades


def selected_model_kinds() -> list[str]:
    raw = os.environ.get("MODEL_KINDS", "logistic")
    return [part.strip() for part in raw.split(",") if part.strip()]


def make_model(kind: str):
    if kind == "logistic":
        return Pipeline(
            steps=[
                ("impute", SimpleImputer(strategy="median")),
                ("scale", StandardScaler()),
                ("model", LogisticRegression(max_iter=2000, C=0.5)),
            ]
        )
    if kind == "hgb":
        return Pipeline(
            steps=[
                ("impute", SimpleImputer(strategy="median")),
                ("model", HistGradientBoostingClassifier(
                    max_depth=4,
                    max_iter=250,
                    learning_rate=0.06,
                    min_samples_leaf=300,
                    random_state=7,
                )),
            ]
        )
    raise ValueError(kind)


def bucket_table(y_true: np.ndarray, probs: np.ndarray) -> list[dict]:
    bins = np.array([0.0, 0.45, 0.49, 0.51, 0.55, 0.60, 1.0])
    out = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        mask = (probs >= lo) & (probs < hi if hi < 1.0 else probs <= hi)
        if not mask.any():
            continue
        out.append(
            {
                "bucket": f"{lo:.2f}-{hi:.2f}",
                "n": int(mask.sum()),
                "avg_pred": round(float(probs[mask].mean()), 4),
                "actual_up_rate": round(float(y_true[mask].mean()), 4),
            }
        )
    return out


def evaluate(name: str, y_true: np.ndarray, probs: np.ndarray) -> dict:
    probs = np.clip(probs, 1e-6, 1 - 1e-6)
    pred_up = (probs > 0.5).astype(int)
    return {
        "sample": name,
        "n": int(len(y_true)),
        "accuracy_pct": round(float(accuracy_score(y_true, pred_up) * 100), 2),
        "brier": round(float(brier_score_loss(y_true, probs)), 5),
        "logloss": round(float(log_loss(y_true, probs)), 5),
        "avg_pred": round(float(probs.mean()), 5),
        "actual_up_rate": round(float(y_true.mean()), 5),
        "calibration": bucket_table(y_true, probs),
    }


def fit_and_score(df: pd.DataFrame, trades: pd.DataFrame) -> dict:
    seconds_eval = []
    trade_eval = []

    for model_kind in selected_model_kinds():
        split_rows = []
        for split in SPLITS:
            train_mask = df["day_sg"].isin(split.train_days)
            test_mask = df["day_sg"] == split.test_day
            train_df = df.loc[train_mask].dropna(subset=FEATURES + ["actual_up_30s"])
            test_df = df.loc[test_mask].dropna(subset=FEATURES + ["actual_up_30s"])
            model = make_model(model_kind)
            model.fit(train_df[FEATURES], train_df["actual_up_30s"].astype(int))
            probs = model.predict_proba(test_df[FEATURES])[:, 1]
            metric = evaluate(f"{model_kind}:{split.label}:seconds", test_df["actual_up_30s"].to_numpy(dtype=int), probs)

            test_trades = trades.loc[trades["day_sg"] == split.test_day].merge(
                test_df[["ts_sec", "actual_up_30s"] + FEATURES], on="ts_sec", how="inner"
            )
            trade_probs = model.predict_proba(test_trades[FEATURES])[:, 1]
            trade_metric = evaluate(
                f"{model_kind}:{split.label}:trade_seconds",
                test_trades["actual_up_30s"].to_numpy(dtype=int),
                trade_probs,
            )
            weighted_acc = accuracy_score(
                test_trades["actual_up_30s"].to_numpy(dtype=int),
                (trade_probs > 0.5).astype(int),
                sample_weight=test_trades["trade_count"].to_numpy(),
            )
            trade_metric["accuracy_trade_weighted_pct"] = round(float(weighted_acc * 100), 2)
            trade_metric["trade_count"] = int(test_trades["trade_count"].sum())
            trade_metric["trade_volume"] = round(float(test_trades["trade_volume"].sum()), 2)

            split_rows.append({"split": split.label, "seconds": metric, "trade_seconds": trade_metric})

        seconds_mean_logloss = float(np.mean([row["seconds"]["logloss"] for row in split_rows]))
        trade_mean_logloss = float(np.mean([row["trade_seconds"]["logloss"] for row in split_rows]))
        seconds_eval.append((model_kind, seconds_mean_logloss, split_rows))
        trade_eval.append((model_kind, trade_mean_logloss, split_rows))

    best_model_kind = sorted(trade_eval, key=lambda x: x[1])[0][0]
    final_model = make_model(best_model_kind)
    full_df = df.dropna(subset=FEATURES + ["actual_up_30s"])
    final_model.fit(full_df[FEATURES], full_df["actual_up_30s"].astype(int))
    full_probs = final_model.predict_proba(full_df[FEATURES])[:, 1]
    full_eval = evaluate(f"{best_model_kind}:all_seconds", full_df["actual_up_30s"].to_numpy(dtype=int), full_probs)

    trade_full = trades.merge(full_df[["ts_sec", "actual_up_30s"] + FEATURES], on="ts_sec", how="inner")
    trade_full_probs = final_model.predict_proba(trade_full[FEATURES])[:, 1]
    trade_full_eval = evaluate(
        f"{best_model_kind}:all_trade_seconds",
        trade_full["actual_up_30s"].to_numpy(dtype=int),
        trade_full_probs,
    )
    trade_full_eval["accuracy_trade_weighted_pct"] = round(
        float(
            accuracy_score(
                trade_full["actual_up_30s"].to_numpy(dtype=int),
                (trade_full_probs > 0.5).astype(int),
                sample_weight=trade_full["trade_count"].to_numpy(),
            ) * 100
        ),
        2,
    )
    trade_full_eval["trade_count"] = int(trade_full["trade_count"].sum())
    trade_full_eval["trade_volume"] = round(float(trade_full["trade_volume"].sum()), 2)

    logistic_fit = make_model("logistic")
    logistic_fit.fit(full_df[FEATURES], full_df["actual_up_30s"].astype(int))
    log_model = logistic_fit.named_steps["model"]
    scaler = logistic_fit.named_steps["scale"]
    logistic_coefficients = {
        "intercept": float(log_model.intercept_[0]),
        "features": FEATURES,
        "coef": [float(x) for x in log_model.coef_[0]],
        "means": [float(x) for x in scaler.mean_],
        "scales": [float(x) for x in scaler.scale_],
    }

    trade_export = trade_full[["ts_utc", "trade_count", "trade_volume", "actual_up_30s"] + FEATURES].copy()
    trade_export["pred_p_up"] = trade_full_probs
    trade_export.to_csv(OUT_CSV, index=False)

    return {
        "available_days": BOOK_DAYS,
        "feature_columns": FEATURES,
        "seconds_rows": int(len(full_df)),
        "trade_second_rows": int(len(trade_full)),
        "model_comparison": [
            {
                "model": model_kind,
                "mean_seconds_logloss": round(seconds_ll, 5),
                "splits": split_rows,
            }
            for model_kind, seconds_ll, split_rows in seconds_eval
        ],
        "best_model_kind_by_trade_logloss": best_model_kind,
        "final_all_seconds_eval": full_eval,
        "final_all_trade_seconds_eval": trade_full_eval,
        "logistic_coefficients_for_live_ui": logistic_coefficients,
        "trade_eval_csv": OUT_CSV.name,
    }


def main() -> None:
    frames = [load_book_day(day_key) for day_key in BOOK_DAYS]
    book = pd.concat(frames, ignore_index=True)
    start_utc = min(pd.to_datetime(book["ts_utc"])).to_pydatetime()
    end_utc = (max(pd.to_datetime(book["ts_utc"])) + pd.Timedelta(seconds=31)).to_pydatetime()

    oracle = fetch_oracle_prices(start_utc, end_utc)
    trades = fetch_trade_seconds(start_utc, end_utc)
    trades["day_sg"] = pd.to_datetime(trades["ts_utc"]).dt.tz_convert(SG).dt.strftime("%Y-%m-%d")

    df = book.merge(oracle, on=["ts_sec", "ts_utc"], how="left")
    df = df.dropna(subset=["actual_up_30s"]).copy()

    summary = fit_and_score(df, trades)
    OUT_JSON.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps({
        "out_json": str(OUT_JSON),
        "out_csv": str(OUT_CSV),
        "best_model_kind_by_trade_logloss": summary["best_model_kind_by_trade_logloss"],
        "final_all_trade_seconds_eval": summary["final_all_trade_seconds_eval"],
    }, indent=2))


if __name__ == "__main__":
    main()
