from __future__ import annotations

import csv
import gzip
import json
import os
import subprocess
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

import psycopg2
import requests
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

TARDIS_API_KEY = os.environ.get("TARDIS_API_KEY", "").strip()
THRESHOLD = 0.7
PERSIST_SECONDS = 3.0
MOMENTUM_PAYOUT = 70.0
CONTRA_PAYOUT = 90.0
BASE_PAYOUT = 80.0

TODAY_REPLAY_END_UTC = datetime(2026, 5, 27, 8, 8, tzinfo=UTC)
TODAY_REPLAY_START_UTC = datetime(2026, 5, 27, 0, 0, tzinfo=UTC)
EARLIEST_START_SG = datetime(2026, 5, 21, 0, 0, tzinfo=SG)

DATASET_DIR = ROOT / "tardis_datasets_book25"
TODAY_ANNOTATIONS = ROOT / "annotated_orders_tardis_today.json"
OUT_PATH = ROOT / "btc_skew_summary_30s_1m_2026-05-27.json"


@dataclass
class OrderRow:
    id: str
    created_at: datetime
    duration: int
    side: int
    direction: int
    usdt_value: float
    raw_platform_pnl: float
    user_pnl: float
    book_sign: int = 0
    book_persist_seconds: float = 0.0

    @property
    def created_at_sg(self) -> datetime:
        return self.created_at.astimezone(SG)

    @property
    def skew_delta(self) -> float:
        if self.book_sign == 0 or self.book_persist_seconds < PERSIST_SECONDS:
            return 0.0
        if self.user_pnl <= 0:
            return 0.0
        if self.direction == self.book_sign:
            return ((BASE_PAYOUT - MOMENTUM_PAYOUT) / 100.0) * self.usdt_value
        if self.direction == -self.book_sign:
            return -((CONTRA_PAYOUT - BASE_PAYOUT) / 100.0) * self.usdt_value
        return 0.0


def to_epoch_us(dt: datetime) -> int:
    return int(dt.timestamp() * 1_000_000)


def sign_for(imbalance: float, threshold: float = THRESHOLD) -> int:
    if imbalance >= threshold:
        return 1
    if imbalance <= -threshold:
        return -1
    return 0


def dataset_path(day_utc: datetime) -> Path:
    return DATASET_DIR / f"binance-futures_book_snapshot_25_{day_utc.date()}_BTCUSDT.csv.gz"


def ensure_dataset(day_utc: datetime) -> Path:
    if not TARDIS_API_KEY:
        raise RuntimeError("TARDIS_API_KEY env var is required")
    DATASET_DIR.mkdir(exist_ok=True)
    out = dataset_path(day_utc)
    if out.exists():
        return out
    url = f"https://datasets.tardis.dev/v1/binance-futures/book_snapshot_25/{day_utc:%Y/%m/%d}/BTCUSDT.csv.gz"
    r = requests.get(url, headers={"Authorization": f"Bearer {TARDIS_API_KEY}"}, timeout=120)
    r.raise_for_status()
    out.write_bytes(r.content)
    return out


def fetch_orders(start_utc: datetime, end_utc: datetime) -> list[OrderRow]:
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
                "start_utc": start_utc,
                "end_utc": end_utc,
                "excluded_accounts": EXCLUDED_ACCOUNTS,
            })
            rows = cur.fetchall()
    out: list[OrderRow] = []
    for rid, created_at, duration, side, usdt_value, raw_platform_pnl, user_pnl in rows:
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=UTC)
        out.append(
            OrderRow(
                id=str(rid),
                created_at=created_at.astimezone(UTC),
                duration=int(duration),
                side=int(side),
                direction=1 if int(side) == 1 else -1,
                usdt_value=float(usdt_value),
                raw_platform_pnl=float(raw_platform_pnl),
                user_pnl=float(user_pnl),
            )
        )
    return out


def annotate_orders_from_dataset(day_orders: list[OrderRow], gz_path: Path) -> None:
    if not day_orders:
        return
    day_orders.sort(key=lambda x: x.created_at)
    order_idx = 0
    current_sign = 0
    sign_changed_us: int | None = None

    with gzip.open(gz_path, "rt", newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        idx = {name: i for i, name in enumerate(header)}
        bid_idx = [(idx[f"bids[{i}].price"], idx[f"bids[{i}].amount"]) for i in range(10)]
        ask_idx = [(idx[f"asks[{i}].price"], idx[f"asks[{i}].amount"]) for i in range(10)]
        ts_idx = idx["timestamp"]

        def annotate_until(snapshot_ts_us: int) -> None:
            nonlocal order_idx
            while order_idx < len(day_orders) and to_epoch_us(day_orders[order_idx].created_at) < snapshot_ts_us:
                order_ts_us = to_epoch_us(day_orders[order_idx].created_at)
                persist = 0.0
                if current_sign != 0 and sign_changed_us is not None:
                    persist = max(0.0, (order_ts_us - sign_changed_us) / 1_000_000.0)
                day_orders[order_idx].book_sign = current_sign
                day_orders[order_idx].book_persist_seconds = persist
                order_idx += 1

        for row in reader:
            snapshot_ts_us = int(row[ts_idx])
            annotate_until(snapshot_ts_us)
            bid = 0.0
            ask = 0.0
            for p_idx, a_idx in bid_idx:
                bid += float(row[p_idx]) * float(row[a_idx])
            for p_idx, a_idx in ask_idx:
                ask += float(row[p_idx]) * float(row[a_idx])
            imb = 0.0 if bid + ask == 0 else (bid - ask) / (bid + ask)
            sign = sign_for(imb)
            if sign != current_sign:
                current_sign = sign
                sign_changed_us = snapshot_ts_us

        annotate_until(10**20)


def annotate_today_from_replay(today_orders: list[OrderRow]) -> None:
    if not today_orders:
        return
    if not TARDIS_API_KEY:
        raise RuntimeError("TARDIS_API_KEY env var is required")
    env = os.environ.copy()
    env["TARDIS_API_KEY"] = TARDIS_API_KEY
    env["ANALYSIS_START_UTC"] = TODAY_REPLAY_START_UTC.isoformat()
    env["ANALYSIS_END_UTC"] = TODAY_REPLAY_END_UTC.isoformat()
    env["REPLAY_START_UTC"] = TODAY_REPLAY_START_UTC.isoformat()
    env["DURATIONS"] = "30,60"
    env["OUT_PATH"] = str(TODAY_ANNOTATIONS)
    env["IMBALANCE_THRESHOLD"] = str(THRESHOLD)
    env["PERSIST_SECONDS"] = str(PERSIST_SECONDS)
    subprocess.run(
        ["node", str(ROOT / "annotate_orders_tardis_replay.mjs")],
        cwd=str(ROOT),
        check=True,
        env=env,
    )
    payload = json.loads(TODAY_ANNOTATIONS.read_text())
    by_id = {str(row["id"]): row for row in payload["orders"]}
    for order in today_orders:
        ann = by_id.get(order.id)
        if not ann:
            continue
        order.book_sign = int(ann.get("book_sign", 0) or 0)
        order.book_persist_seconds = float(ann.get("book_persist_seconds", 0.0) or 0.0)


def summarize_window(rows: Iterable[OrderRow], duration: int) -> dict:
    subset = [r for r in rows if r.duration == duration]
    without_skew = sum(r.raw_platform_pnl for r in subset)
    with_skew = sum(r.raw_platform_pnl + r.skew_delta for r in subset)
    return {
        "duration": duration,
        "orders": len(subset),
        "volume": sum(r.usdt_value for r in subset),
        "without_skew": without_skew,
        "with_skew": with_skew,
        "improvement": with_skew - without_skew,
        "triggered_orders": sum(1 for r in subset if r.book_sign != 0 and r.book_persist_seconds >= PERSIST_SECONDS),
    }


def main() -> None:
    end_utc = TODAY_REPLAY_END_UTC
    start_utc = EARLIEST_START_SG.astimezone(UTC)
    all_orders = fetch_orders(start_utc, end_utc)

    by_utc_day: dict[datetime.date, list[OrderRow]] = defaultdict(list)
    for row in all_orders:
        by_utc_day[row.created_at.date()].append(row)

    completed_days = []
    d = datetime(2026, 5, 20, 0, 0, tzinfo=UTC)
    while d < TODAY_REPLAY_START_UTC:
        completed_days.append(d)
        d += timedelta(days=1)

    for day in completed_days:
        day_rows = by_utc_day.get(day.date(), [])
        if day_rows:
            annotate_orders_from_dataset(day_rows, ensure_dataset(day))

    today_rows = [r for r in all_orders if r.created_at >= TODAY_REPLAY_START_UTC]
    annotate_today_from_replay(today_rows)

    windows = {
        "today": datetime(2026, 5, 27, 0, 0, tzinfo=SG).astimezone(UTC),
        "last_3_days": datetime(2026, 5, 25, 0, 0, tzinfo=SG).astimezone(UTC),
        "last_7_days": datetime(2026, 5, 21, 0, 0, tzinfo=SG).astimezone(UTC),
    }

    out = {
        "rule": {
            "threshold": THRESHOLD,
            "persist_seconds": PERSIST_SECONDS,
            "payouts": "70/90",
            "base_payouts": "80/80",
            "end_sg": end_utc.astimezone(SG).isoformat(),
        },
        "summary": {},
    }

    for name, window_start_utc in windows.items():
        rows = [r for r in all_orders if r.created_at >= window_start_utc and r.created_at < end_utc]
        out["summary"][name] = {
            "30s": summarize_window(rows, 30),
            "1m": summarize_window(rows, 60),
        }

    OUT_PATH.write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
