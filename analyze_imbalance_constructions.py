from __future__ import annotations

import csv
import gzip
import json
import os
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable

import psycopg2
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parent
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

DEPTHS = [5, 10, 25]
TYPES = ["notional", "size"]
THRESHOLDS = [0.5, 0.6, 0.7, 0.8]
PERSIST_SECONDS = 3.0
MOMENTUM_PAYOUT = 70.0
CONTRA_PAYOUT = 90.0
BASE_PAYOUT = 80.0
DATASET_DIR = ROOT / "tardis_datasets_book25"
TODAY_MULTI_PATH = ROOT / "annotated_orders_tardis_today_multi.json"
OUT_PATH = ROOT / "imbalance_construction_backtest_2026-05-27.json"

END_UTC = datetime(2026, 5, 27, 8, 8, tzinfo=UTC)
START_7D_UTC = datetime(2026, 5, 21, 0, 0, tzinfo=SG).astimezone(UTC)
TODAY_START_UTC = datetime(2026, 5, 27, 0, 0, tzinfo=SG).astimezone(UTC)
TODAY_REPLAY_START_UTC = datetime(2026, 5, 27, 0, 0, tzinfo=UTC)


@dataclass
class OrderRow:
    id: str
    created_at: datetime
    duration: int
    direction: int
    usdt_value: float
    raw_platform_pnl: float
    user_pnl: float
    metrics: Dict[str, Dict[str, float]] = field(default_factory=dict)


def to_epoch_us(dt: datetime) -> int:
    return int(dt.timestamp() * 1_000_000)


def dataset_path(day_utc: datetime) -> Path:
    return DATASET_DIR / f"binance-futures_book_snapshot_25_{day_utc.date()}_BTCUSDT.csv.gz"


def fetch_orders() -> list[OrderRow]:
    sql = """
    SELECT
      o.id,
      o.created_at,
      o.duration,
      o.side,
      o.usdt_value::float8 AS usdt_value,
      CASE
        WHEN o.coin_code IN (
          11001,11002,11003,11004,11005,11006,11007,11008,11009,11010,
          11011,11012,11013,11014,11015,11016,11017,11018,11019,11020
        ) AND o.realized_pnl < 0 THEN 0
        ELSE -(o.realized_pnl)
      END::float8 AS raw_platform_pnl,
      o.realized_pnl::float8 AS user_pnl
    FROM public.chain_predict_order o
    WHERE o.order_status IN ('Finished', 'Pending')
      AND o.pair_id = 6
      AND o.duration IN (30, 60)
      AND o.created_at >= %(start_utc)s
      AND o.created_at < %(end_utc)s
      AND (o.account_id IS NULL OR o.account_id <> ALL(%(excluded_accounts)s))
    ORDER BY o.created_at
    """
    with psycopg2.connect(**DB_CONFIG) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, {
                "start_utc": START_7D_UTC,
                "end_utc": END_UTC,
                "excluded_accounts": EXCLUDED_ACCOUNTS,
            })
            rows = cur.fetchall()
    out = []
    for rid, created_at, duration, side, usdt_value, raw_platform_pnl, user_pnl in rows:
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=UTC)
        out.append(OrderRow(
            id=str(rid),
            created_at=created_at.astimezone(UTC),
            duration=int(duration),
            direction=1 if int(side) == 1 else -1,
            usdt_value=float(usdt_value),
            raw_platform_pnl=float(raw_platform_pnl),
            user_pnl=float(user_pnl),
        ))
    return out


def imbalance_from_row(row: list[str], depth: int, kind: str) -> float:
    bid = 0.0
    ask = 0.0
    for i in range(depth):
        ask_price = float(row[4 + i * 4])
        ask_amt = float(row[5 + i * 4])
        bid_price = float(row[6 + i * 4])
        bid_amt = float(row[7 + i * 4])
        if kind == "notional":
            ask += ask_price * ask_amt
            bid += bid_price * bid_amt
        else:
            ask += ask_amt
            bid += bid_amt
    if bid + ask == 0:
        return 0.0
    return (bid - ask) / (bid + ask)


def sign_for(value: float, threshold: float) -> int:
    if value >= threshold:
        return 1
    if value <= -threshold:
        return -1
    return 0


def annotate_day_from_dataset(day_orders: list[OrderRow], gz_path: Path) -> None:
    if not day_orders:
        return
    day_orders.sort(key=lambda x: x.created_at)
    order_idx = 0
    states = {f"{kind}_{depth}_{thr}": {"sign": 0, "changed_us": None} for kind in TYPES for depth in DEPTHS for thr in THRESHOLDS}

    with gzip.open(gz_path, "rt", newline="") as f:
        reader = csv.reader(f)
        next(reader)

        def annotate_until(snapshot_ts_us: int) -> None:
            nonlocal order_idx
            while order_idx < len(day_orders) and to_epoch_us(day_orders[order_idx].created_at) < snapshot_ts_us:
                order = day_orders[order_idx]
                for key, state in states.items():
                    persist = 0.0
                    if state["sign"] != 0 and state["changed_us"] is not None:
                        persist = max(0.0, (to_epoch_us(order.created_at) - state["changed_us"]) / 1_000_000.0)
                    order.metrics[key] = {"sign": state["sign"], "persist": persist}
                order_idx += 1

        for row in reader:
            ts_us = int(row[2])
            annotate_until(ts_us)
            for kind in TYPES:
                for depth in DEPTHS:
                    value = imbalance_from_row(row, depth, kind)
                    for thr in THRESHOLDS:
                        key = f"{kind}_{depth}_{thr}"
                        sign = sign_for(value, thr)
                        if sign != states[key]["sign"]:
                            states[key]["sign"] = sign
                            states[key]["changed_us"] = ts_us
        annotate_until(10**20)


def annotate_today_from_replay(today_orders: list[OrderRow]) -> None:
    if not today_orders:
        return
    env = os.environ.copy()
    env["TARDIS_API_KEY"] = os.environ["TARDIS_API_KEY"]
    env["ANALYSIS_START_UTC"] = TODAY_REPLAY_START_UTC.isoformat()
    env["ANALYSIS_END_UTC"] = END_UTC.isoformat()
    env["REPLAY_START_UTC"] = TODAY_REPLAY_START_UTC.isoformat()
    env["DURATIONS"] = "30,60"
    env["OUT_PATH"] = str(TODAY_MULTI_PATH)
    subprocess.run(["node", str(ROOT / "annotate_orders_tardis_replay_multi.mjs")], cwd=str(ROOT), env=env, check=True)
    payload = json.loads(TODAY_MULTI_PATH.read_text())
    by_id = {str(r["id"]): r for r in payload["orders"]}
    for order in today_orders:
        ann = by_id.get(order.id)
        if ann:
            order.metrics = ann["metrics"]


def improvement(rows: Iterable[OrderRow], duration: int, key: str) -> dict:
    subset = [r for r in rows if r.duration == duration]
    orig = sum(r.raw_platform_pnl for r in subset)
    delta = 0.0
    triggered = 0
    for r in subset:
        metric = r.metrics.get(key, {"sign": 0, "persist": 0.0})
        sign = int(metric["sign"])
        persist = float(metric["persist"])
        if sign == 0 or persist < PERSIST_SECONDS:
            continue
        triggered += 1
        if r.user_pnl <= 0:
            continue
        if r.direction == sign:
            delta += ((BASE_PAYOUT - MOMENTUM_PAYOUT) / 100.0) * r.usdt_value
        elif r.direction == -sign:
            delta -= ((CONTRA_PAYOUT - BASE_PAYOUT) / 100.0) * r.usdt_value
    return {
        "orders": len(subset),
        "without_skew": orig,
        "with_skew": orig + delta,
        "improvement": delta,
        "triggered_orders": triggered,
    }


def main() -> None:
    if "TARDIS_API_KEY" not in os.environ:
        raise RuntimeError("TARDIS_API_KEY env var is required")

    all_orders = fetch_orders()
    by_day = {}
    d = datetime(2026, 5, 20, 0, 0, tzinfo=UTC)
    while d < TODAY_REPLAY_START_UTC:
        by_day[d.date()] = [r for r in all_orders if r.created_at.date() == d.date()]
        if by_day[d.date()]:
            annotate_day_from_dataset(by_day[d.date()], dataset_path(d))
        d += timedelta(days=1)

    today_orders = [r for r in all_orders if r.created_at >= TODAY_REPLAY_START_UTC]
    annotate_today_from_replay(today_orders)

    last7 = [r for r in all_orders if START_7D_UTC <= r.created_at < END_UTC]
    today = [r for r in all_orders if TODAY_START_UTC <= r.created_at < END_UTC]

    rows = []
    for kind in TYPES:
        for depth in DEPTHS:
            for thr in THRESHOLDS:
                key = f"{kind}_{depth}_{thr}"
                stats7_30 = improvement(last7, 30, key)
                stats7_60 = improvement(last7, 60, key)
                stats_today_30 = improvement(today, 30, key)
                stats_today_60 = improvement(today, 60, key)
                rows.append({
                    "kind": kind,
                    "depth": depth,
                    "threshold": thr,
                    "last7_30_improvement": stats7_30["improvement"],
                    "last7_1m_improvement": stats7_60["improvement"],
                    "today_30_improvement": stats_today_30["improvement"],
                    "today_1m_improvement": stats_today_60["improvement"],
                    "last7_30_triggered_orders": stats7_30["triggered_orders"],
                    "last7_1m_triggered_orders": stats7_60["triggered_orders"],
                })

    rows.sort(key=lambda r: (r["last7_30_improvement"], r["last7_1m_improvement"]), reverse=True)
    out = {
        "rule": {
            "momentum_payout": 70,
            "contra_payout": 90,
            "persist_seconds": PERSIST_SECONDS,
            "cutoff_sg": END_UTC.astimezone(SG).isoformat(),
        },
        "top_by_last7_30s": rows[:12],
    }
    OUT_PATH.write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
