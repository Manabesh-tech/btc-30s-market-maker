from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from itertools import product
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd
import psycopg2
import requests
from zoneinfo import ZoneInfo


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

EXCLUDED_ACCOUNTS = [
    453694342288766976, 453694515379304448, 453694698938824704, 453694862751214592,
    453695050429541376, 453695193342061568, 453695365094616064, 453695502558735360,
    453695682540514304, 453696029954714624, 453696169084319744, 453696336118282240,
    453696686250391552, 453697277915691008, 453699519179782144, 453699716827622400,
    453699871186398208, 453700111754898432, 453700307679226880, 453700435928807424,
    453700610797382656, 453700888569706496, 453701146590358528, 453701519728225280,
    453702299164473344, 453702432149075968, 453702550260676608, 453702674143639552,
    453702798844144640, 453702945032416256, 453703077790873600, 453703248918476800,
    453703393185410048, 453703530045896704, 453703669380675584, 453703873949117440,
    453704003112709120, 453704125108582400, 453704438963809280, 453704565275621376,
    453704592534055936, 453704388053347328, 453704128950564864, 453703864487114752,
    453703624296101888, 453703375317675008, 453703091472693248, 453702829597128704,
    453702382681454592, 453702011816553472,
]

VOL_BUCKETS = [
    (0, 5, "0-5"),
    (5, 10, "5-10"),
    (10, 15, "10-15"),
    (15, 20, "15-20"),
    (20, 25, "20-25"),
    (25, 30, "25-30"),
    (30, float("inf"), "30+"),
]


@dataclass(frozen=True)
class Candidate:
    name: str
    min_vol_pctile: float
    min_impact_pctile: float
    vol_low: float
    vol_high: float
    trend_horizon_s: int | None = None
    trend_threshold_bps: float = 0.0


def label_vol_bucket(x: float | None) -> str | None:
    if x is None or pd.isna(x):
        return None
    for low, high, label in VOL_BUCKETS:
        if low <= x < high:
            return label
    return None


def fetch_now() -> tuple[datetime, datetime]:
    with psycopg2.connect(**DB_CONFIG) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'Asia/Singapore'")
            now_utc_naive, now_sg_naive = cur.fetchone()
    return now_utc_naive.replace(tzinfo=UTC), now_sg_naive.replace(tzinfo=SG)


def fetch_orders_with_vol(start_utc: datetime, now_utc: datetime) -> pd.DataFrame:
    sql = """
    WITH oracle_ticks AS (
      SELECT
        l.created_at AS ts_utc,
        l.final_price::numeric AS price,
        floor(extract(epoch FROM l.created_at) / 30) * 30 AS bucket_epoch
      FROM public.oracle_price_log_partition_v1 l
      WHERE l.pair_name = 'BTC/USDT'
        AND l.source_type = 0
        AND l.created_at >= %(start_utc)s - interval '15 minutes'
        AND l.created_at < %(now_utc)s
        AND l.final_price::numeric > 0
    ),
    bucket_stats AS (
      SELECT
        bucket_epoch::bigint AS bucket_epoch,
        (array_agg(price ORDER BY ts_utc ASC))[1] AS open_price,
        (array_agg(price ORDER BY ts_utc DESC))[1] AS close_price
      FROM oracle_ticks
      GROUP BY 1
    ),
    vol_base AS (
      SELECT
        bucket_epoch,
        STDDEV_SAMP(ln(close_price / NULLIF(open_price, 0))) OVER (
          ORDER BY bucket_epoch
          ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING
        ) * 1025.3 * 100 AS raw_vol_pct
      FROM bucket_stats
    ),
    risk AS (
      SELECT
        bucket_epoch,
        AVG(raw_vol_pct) OVER (
          ORDER BY bucket_epoch
          ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING
        ) AS smoothed_vol_pct
      FROM vol_base
    ),
    platform_orders AS (
      SELECT
        o.id,
        o.created_at,
        o.side,
        floor(extract(epoch FROM o.created_at) / 30) * 30 AS entry_bucket_30s_epoch,
        floor(extract(epoch FROM o.created_at) / 900) * 900 AS entry_window_15m_epoch,
        o.usdt_value,
        CASE
          WHEN o.coin_code IN (
            11001,11002,11003,11004,11005,11006,11007,11008,11009,11010,
            11011,11012,11013,11014,11015,11016,11017,11018,11019,11020
          ) AND o.realized_pnl < 0 THEN 0
          ELSE -(o.realized_pnl)
        END AS raw_platform_pnl
      FROM public.chain_predict_order o
      WHERE o.order_status IN ('Finished', 'Pending')
        AND o.pair_id = 6
        AND o.duration = 30
        AND o.created_at >= %(start_utc)s
        AND o.created_at < %(now_utc)s
        AND (o.account_id IS NULL OR o.account_id <> ALL(%(excluded_accounts)s))
    )
    SELECT
      po.id,
      po.created_at,
      po.entry_bucket_30s_epoch::bigint,
      po.entry_window_15m_epoch::bigint,
      po.usdt_value,
      po.side,
      po.raw_platform_pnl,
      rk.smoothed_vol_pct
    FROM platform_orders po
    LEFT JOIN risk rk
      ON rk.bucket_epoch = po.entry_bucket_30s_epoch
    ORDER BY po.created_at
    """
    with psycopg2.connect(**DB_CONFIG) as conn:
        df = pd.read_sql_query(
            sql,
            conn,
            params={
                "start_utc": start_utc,
                "now_utc": now_utc,
                "excluded_accounts": EXCLUDED_ACCOUNTS,
            },
        )
    df["created_at"] = pd.to_datetime(df["created_at"], utc=True)
    df["window_sg"] = df["created_at"].dt.tz_convert(SG).dt.floor("15min")
    df["sg_date"] = df["window_sg"].dt.strftime("%Y-%m-%d")
    df["vol_bucket"] = df["smoothed_vol_pct"].apply(label_vol_bucket)
    # Empirically, side=1 wins when price rises and side=2 wins when price falls.
    df["direction"] = df["side"].map({1: 1, 2: -1})
    return df


def fetch_oracle_bucket_returns(start_utc: datetime, now_utc: datetime) -> pd.DataFrame:
    sql = """
    WITH oracle_ticks AS (
      SELECT
        l.created_at AS ts_utc,
        l.final_price::numeric AS price,
        floor(extract(epoch FROM l.created_at) / 30) * 30 AS bucket_epoch
      FROM public.oracle_price_log_partition_v1 l
      WHERE l.pair_name = 'BTC/USDT'
        AND l.source_type = 0
        AND l.created_at >= %(start_utc)s - interval '10 minutes'
        AND l.created_at < %(now_utc)s
        AND l.final_price::numeric > 0
    )
    SELECT
      bucket_epoch::bigint AS entry_bucket_30s_epoch,
      (array_agg(price ORDER BY ts_utc DESC))[1] AS close_price
    FROM oracle_ticks
    GROUP BY 1
    ORDER BY 1
    """
    with psycopg2.connect(**DB_CONFIG) as conn:
        df = pd.read_sql_query(sql, conn, params={"start_utc": start_utc, "now_utc": now_utc})
    df = df.sort_values("entry_bucket_30s_epoch").reset_index(drop=True)
    df["close_price"] = df["close_price"].astype(float)
    for seconds, periods in [(30, 1), (60, 2), (120, 4), (300, 10)]:
        prev_close = df["close_price"].shift(periods)
        df[f"ret_{seconds}s_bps"] = ((df["close_price"] / prev_close) - 1.0) * 10000
    return df


def exante_percentile_same_slot(values: Iterable[float]) -> list[float]:
    seen: list[float] = []
    out: list[float] = []
    for v in values:
        if not seen:
            out.append(np.nan)
        else:
            rank = sum(x <= v for x in seen) / len(seen) * 100
            out.append(rank)
        seen.append(v)
    return out


def fetch_binance_bars(start_utc: datetime, now_utc: datetime) -> pd.DataFrame:
    history_start_utc = start_utc - timedelta(days=21)
    all_rows: list[list] = []
    chunk_start = history_start_utc - timedelta(minutes=15)
    seen = set()
    while chunk_start < now_utc:
        chunk_end = min(chunk_start + timedelta(days=10), now_utc)
        resp = requests.get(
            "https://fapi.binance.com/fapi/v1/klines",
            params={
                "symbol": "BTCUSDT",
                "interval": "15m",
                "startTime": int(chunk_start.timestamp() * 1000),
                "endTime": int(chunk_end.timestamp() * 1000),
                "limit": 1500,
            },
            timeout=30,
        )
        resp.raise_for_status()
        rows = resp.json()
        if not rows:
            break
        all_rows.extend(rows)
        last_open_ms = int(rows[-1][0])
        chunk_start = datetime.fromtimestamp(last_open_ms / 1000, tz=UTC) + timedelta(minutes=15)

    bars = []
    for row in all_rows:
        epoch = int(int(row[0]) / 1000)
        if epoch in seen:
            continue
        seen.add(epoch)
        ts_utc = datetime.fromtimestamp(epoch, tz=UTC)
        if ts_utc < history_start_utc or ts_utc >= now_utc:
            continue
        high = float(row[2])
        low = float(row[3])
        quote_volume = float(row[7])
        mid = (high + low) / 2 if (high + low) else 0
        range_bps = ((high - low) / mid) * 10000 if mid else 0
        impact = range_bps / (quote_volume / 1_000_000) if quote_volume else 0
        ts_sg = ts_utc.astimezone(SG)
        bars.append(
            {
                "entry_window_15m_epoch": epoch,
                "window_sg": ts_sg,
                "sg_date": ts_sg.strftime("%Y-%m-%d"),
                "slot": ts_sg.strftime("%H:%M"),
                "quote_volume_usd": quote_volume,
                "impact": impact,
            }
        )

    df = pd.DataFrame(bars).sort_values("entry_window_15m_epoch").reset_index(drop=True)
    df["volume_pctile_slot_exante"] = (
        df.groupby("slot", group_keys=False)["quote_volume_usd"]
        .apply(exante_percentile_same_slot)
        .explode()
        .astype(float)
        .values
    )
    df["impact_pctile_slot_exante"] = (
        df.groupby("slot", group_keys=False)["impact"]
        .apply(exante_percentile_same_slot)
        .explode()
        .astype(float)
        .values
    )
    df["volume_pctile_all_exante"] = exante_percentile_same_slot(df["quote_volume_usd"].tolist())
    df["impact_pctile_all_exante"] = exante_percentile_same_slot(df["impact"].tolist())
    df["volume_pctile_exante"] = df["volume_pctile_slot_exante"].fillna(df["volume_pctile_all_exante"])
    df["impact_pctile_exante"] = df["impact_pctile_slot_exante"].fillna(df["impact_pctile_all_exante"])
    df = df[df["entry_window_15m_epoch"] >= int(start_utc.timestamp())].copy()
    prev_cols = [
        "entry_window_15m_epoch",
        "window_sg",
        "sg_date",
        "slot",
        "volume_pctile_exante",
        "impact_pctile_exante",
    ]
    prev_df = df[prev_cols].copy()
    prev_df["entry_window_15m_epoch"] = prev_df["entry_window_15m_epoch"] + 900
    prev_df = prev_df.rename(
        columns={
            "window_sg": "prev_window_sg",
            "sg_date": "prev_sg_date",
            "slot": "prev_slot",
            "volume_pctile_exante": "prev_volume_pctile",
            "impact_pctile_exante": "prev_impact_pctile",
        }
    )
    return prev_df


def build_candidates() -> list[Candidate]:
    ranges = [
        (0, 5),
        (5, 10),
        (10, 15),
        (15, 20),
        (20, 25),
        (25, 30),
        (30, float("inf")),
        (10, 20),
        (5, 20),
        (10, 25),
        (10, 30),
        (15, 25),
        (15, 30),
    ]
    candidates = []
    for vol_low, vol_high in ranges:
        label = f"{int(vol_low)}-{('inf' if vol_high == float('inf') else int(vol_high))}"
        for vol_pct, impact_pct in product([10, 15, 20, 25], [70, 75, 80, 85]):
            candidates.append(
                Candidate(
                    name=f"prevVol<{vol_pct} prevImpact>{impact_pct} smoothedVol {label}",
                    min_vol_pctile=vol_pct,
                    min_impact_pctile=impact_pct,
                    vol_low=vol_low,
                    vol_high=vol_high,
                )
            )
            for trend_horizon_s, trend_threshold_bps in product([30, 60, 120, 300], [0.0, 1.0, 2.0, 3.0, 5.0]):
                candidates.append(
                    Candidate(
                        name=(
                            f"prevVol<{vol_pct} prevImpact>{impact_pct} "
                            f"smoothedVol {label} chase {trend_horizon_s}s>{trend_threshold_bps}bps"
                        ),
                        min_vol_pctile=vol_pct,
                        min_impact_pctile=impact_pct,
                        vol_low=vol_low,
                        vol_high=vol_high,
                        trend_horizon_s=trend_horizon_s,
                        trend_threshold_bps=trend_threshold_bps,
                    )
                )
    return candidates


def summarize_candidate(df: pd.DataFrame, candidate: Candidate) -> dict:
    base_mask = (
        (df["prev_volume_pctile"] < candidate.min_vol_pctile)
        & (df["prev_impact_pctile"] > candidate.min_impact_pctile)
        & (df["smoothed_vol_pct"] >= candidate.vol_low)
        & (df["smoothed_vol_pct"] < candidate.vol_high)
    )
    if candidate.trend_horizon_s is not None:
        ret_col = f"ret_{candidate.trend_horizon_s}s_bps"
        chase_signal = df["direction"] * df[ret_col]
        trend_mask = chase_signal > candidate.trend_threshold_bps
        mask = base_mask & trend_mask
    else:
        mask = base_mask
    excluded = df.loc[mask].copy()
    total_pnl = float(df["raw_platform_pnl"].sum())
    excluded_pnl = float(excluded["raw_platform_pnl"].sum())
    after_pnl = total_pnl - excluded_pnl

    daily = (
        df.groupby("sg_date", as_index=False)["raw_platform_pnl"]
        .sum()
        .rename(columns={"raw_platform_pnl": "original_pnl"})
    )
    daily_ex = (
        excluded.groupby("sg_date", as_index=False)["raw_platform_pnl"]
        .sum()
        .rename(columns={"raw_platform_pnl": "excluded_pnl"})
    )
    daily = daily.merge(daily_ex, on="sg_date", how="left").fillna({"excluded_pnl": 0})
    daily["after_pnl"] = daily["original_pnl"] - daily["excluded_pnl"]
    daily["delta"] = daily["after_pnl"] - daily["original_pnl"]

    negative_days = daily[daily["original_pnl"] < 0].copy()
    positive_days = daily[daily["original_pnl"] > 0].copy()
    neg_improvement = float(negative_days["delta"].sum())
    pos_drag = float((-positive_days["delta"].clip(upper=0)).sum())

    return {
        "name": candidate.name,
        "min_vol_pctile": candidate.min_vol_pctile,
        "min_impact_pctile": candidate.min_impact_pctile,
        "vol_low": candidate.vol_low,
        "vol_high": candidate.vol_high,
        "trend_horizon_s": candidate.trend_horizon_s,
        "trend_threshold_bps": candidate.trend_threshold_bps,
        "orders_excluded": int(mask.sum()),
        "excluded_volume": float(excluded["usdt_value"].sum()),
        "excluded_pnl": excluded_pnl,
        "after_pnl": after_pnl,
        "improvement": after_pnl - total_pnl,
        "positive_excluded_pnl": float(excluded.loc[excluded["raw_platform_pnl"] > 0, "raw_platform_pnl"].sum()),
        "negative_excluded_pnl": float(excluded.loc[excluded["raw_platform_pnl"] < 0, "raw_platform_pnl"].sum()),
        "negative_day_improvement": neg_improvement,
        "positive_day_drag": pos_drag,
        "days_helped": int((daily["delta"] > 0).sum()),
        "days_hurt": int((daily["delta"] < 0).sum()),
        "daily": daily.to_dict(orient="records"),
    }


def main() -> None:
    now_utc, now_sg = fetch_now()
    start_sg = now_sg.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=6)
    start_utc = start_sg.astimezone(UTC)

    orders = fetch_orders_with_vol(start_utc, now_utc)
    oracle_returns = fetch_oracle_bucket_returns(start_utc, now_utc)
    binance_prev = fetch_binance_bars(start_utc, now_utc)
    df = orders.merge(binance_prev, on="entry_window_15m_epoch", how="inner")
    df = df.merge(oracle_returns, on="entry_bucket_30s_epoch", how="left")

    total_summary = (
        df.groupby("sg_date", as_index=False)["raw_platform_pnl"]
        .sum()
        .rename(columns={"raw_platform_pnl": "original_pnl"})
    )

    candidates = [summarize_candidate(df, c) for c in build_candidates()]
    candidates_df = pd.DataFrame(
        [
            {
                "name": c["name"],
                "orders_excluded": c["orders_excluded"],
                "excluded_volume": c["excluded_volume"],
                "excluded_pnl": c["excluded_pnl"],
                "after_pnl": c["after_pnl"],
                "improvement": c["improvement"],
                "negative_day_improvement": c["negative_day_improvement"],
                "positive_day_drag": c["positive_day_drag"],
                "days_helped": c["days_helped"],
                "days_hurt": c["days_hurt"],
                "score": c["negative_day_improvement"] - c["positive_day_drag"],
            }
            for c in candidates
        ]
    )
    # Prefer filters that improve bad days a lot without hurting too many good days.
    ranked = candidates_df.sort_values(
        ["score", "improvement", "days_hurt", "orders_excluded"],
        ascending=[False, False, True, True],
    )
    top_names = ranked.head(15)["name"].tolist()
    top_candidates = [c for c in candidates if c["name"] in top_names]

    out = {
        "window_sg_start": start_sg.isoformat(),
        "window_sg_end": now_sg.isoformat(),
        "orders": int(len(df)),
        "original_pnl": float(df["raw_platform_pnl"].sum()),
        "daily_original": total_summary.to_dict(orient="records"),
        "ranked_candidates": ranked.head(15).to_dict(orient="records"),
        "top_candidate_details": top_candidates,
    }

    out_path = Path("btc_30s_filter_search_7d.json")
    out_path.write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
