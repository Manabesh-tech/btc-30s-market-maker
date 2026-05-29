import json
import threading
from bisect import bisect_right
from collections import deque
from decimal import Decimal
from html import escape
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg2
from psycopg2.extras import RealDictCursor


HOST = "127.0.0.1"
PORT = 8766
SG_TZ = ZoneInfo("Asia/Singapore")
STATE_DIR = Path(__file__).resolve().parent / "live_monitor_state"
DB_CONFIG = {
    "host": "aws-jp-tk-surf-pg-public.cluster-csteuf9lw8dv.ap-northeast-1.rds.amazonaws.com",
    "port": 5432,
    "dbname": "replication_report",
    "user": "manabesh_kaj",
    "password": "dPL084;KF1spv,g",
}


def utc_now():
    return datetime.now(timezone.utc)


def sg_now():
    return datetime.now(SG_TZ)


def current_sg_day_key():
    return sg_now().strftime("%Y-%m-%d")


def sg_midnight_utc(day_key=None):
    if day_key is None:
        day_key = current_sg_day_key()
    year, month, day = (int(part) for part in day_key.split("-"))
    return datetime(year, month, day, tzinfo=SG_TZ).astimezone(timezone.utc)


class MonitorState:
    def __init__(self):
        self.lock = threading.Lock()
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self.day_key = current_sg_day_key()
        self.started_at_utc = sg_midnight_utc(self.day_key)
        self.quote_history = deque(maxlen=20000)
        self.processed_ids = set()
        self.our_pnl = 0.0
        self.competed_volume = 0.0
        self.competed_trades = 0
        self.won_trades = 0
        self.lost_trades = 0
        self.last_status = {}
        self._load_or_reset_for_day(self.day_key)

    def _normalize_quote_history(self):
        ordered = sorted(self.quote_history, key=lambda item: int(item["ts_ms"]))
        if len(ordered) > 20000:
            ordered = ordered[-20000:]
        self.quote_history = deque(ordered, maxlen=20000)

    def _state_path(self, day_key=None):
        return STATE_DIR / f"btc_30s_monitor_state_{day_key or self.day_key}.json"

    def _reset_fields(self, day_key):
        self.day_key = day_key
        self.started_at_utc = sg_midnight_utc(day_key)
        self.quote_history = deque(maxlen=20000)
        self.processed_ids = set()
        self.our_pnl = 0.0
        self.competed_volume = 0.0
        self.competed_trades = 0
        self.won_trades = 0
        self.lost_trades = 0
        self.last_status = {}

    def _load_or_reset_for_day(self, day_key):
        path = self._state_path(day_key)
        if not path.exists():
            self._reset_fields(day_key)
            return

        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            self.day_key = str(payload.get("day_key") or day_key)
            self.started_at_utc = datetime.fromisoformat(payload["started_at_utc"])
            self.quote_history = deque(
                [
                    {
                        "ts_ms": int(item["ts_ms"]),
                        "up_payout": Decimal(str(item["up_payout"])),
                        "down_payout": Decimal(str(item["down_payout"])),
                        "display_probability": float(item.get("display_probability", 0.5)),
                        "regime": str(item.get("regime", "Unknown")),
                    }
                    for item in payload.get("quote_history", [])
                ],
                maxlen=20000,
            )
            self._normalize_quote_history()
            self.processed_ids = {int(x) for x in payload.get("processed_ids", [])}
            self.our_pnl = float(payload.get("our_pnl", 0.0))
            self.competed_volume = float(payload.get("competed_volume", 0.0))
            self.competed_trades = int(payload.get("competed_trades", 0))
            self.won_trades = int(payload.get("won_trades", 0))
            self.lost_trades = int(payload.get("lost_trades", 0))
            self.last_status = dict(payload.get("last_status", {}))
        except Exception:
            self._reset_fields(day_key)

    def ensure_current_day(self):
        with self.lock:
            live_day = current_sg_day_key()
            if live_day != self.day_key:
                self._load_or_reset_for_day(live_day)

    def save_state(self):
        with self.lock:
            payload = {
                "day_key": self.day_key,
                "started_at_utc": self.started_at_utc.isoformat(),
                "quote_history": [
                    {
                        "ts_ms": int(item["ts_ms"]),
                        "up_payout": str(item["up_payout"]),
                        "down_payout": str(item["down_payout"]),
                        "display_probability": float(item["display_probability"]),
                        "regime": str(item["regime"]),
                    }
                    for item in self.quote_history
                ],
                "processed_ids": sorted(self.processed_ids),
                "our_pnl": self.our_pnl,
                "competed_volume": self.competed_volume,
                "competed_trades": self.competed_trades,
                "won_trades": self.won_trades,
                "lost_trades": self.lost_trades,
                "last_status": self.last_status,
            }
            path = self._state_path()
            tmp_path = path.with_suffix(".tmp")
            tmp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            tmp_path.replace(path)

    def reset_from_now(self):
        with self.lock:
            self.day_key = current_sg_day_key()
            self.started_at_utc = utc_now()
            self.quote_history = deque(maxlen=20000)
            self.processed_ids = set()
            self.our_pnl = 0.0
            self.competed_volume = 0.0
            self.competed_trades = 0
            self.won_trades = 0
            self.lost_trades = 0
            self.last_status = {}
        self.save_state()

    def add_quote(self, payload):
        self.ensure_current_day()
        ts_ms = int(payload.get("ts_ms") or int(utc_now().timestamp() * 1000))
        up_payout = Decimal(str(payload.get("up_payout", 0)))
        down_payout = Decimal(str(payload.get("down_payout", 0)))
        display_prob = float(payload.get("display_probability", 0.5))
        regime = str(payload.get("regime", "Unknown"))
        with self.lock:
            self.quote_history.append(
                {
                    "ts_ms": ts_ms,
                    "up_payout": up_payout,
                    "down_payout": down_payout,
                    "display_probability": display_prob,
                    "regime": regime,
                }
            )
            self._normalize_quote_history()
        self.save_state()

    def quote_for_trade(self, created_at):
        if created_at is None:
            return None
        trade_ms = int(created_at.timestamp() * 1000)
        with self.lock:
            if not self.quote_history:
                return None
            timestamps = [q["ts_ms"] for q in self.quote_history]
            idx = bisect_right(timestamps, trade_ms) - 1
            if idx < 0:
                return None
            return list(self.quote_history)[idx]


STATE = MonitorState()


def db_conn():
    return psycopg2.connect(**DB_CONFIG)


def side_label(side, order_way):
    if side == 1 and order_way == 1:
        return "UP"
    if side == 2 and order_way == 3:
        return "DOWN"
    return "UNKNOWN"


def actual_platform_today():
    sql = """
    WITH params AS (
      SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Singapore') AT TIME ZONE 'Asia/Singapore') AS start_utc,
             now() AS now_utc,
             now() AT TIME ZONE 'Asia/Singapore' AS now_sg
    )
    SELECT params.now_sg,
           COUNT(*) AS trades,
           COALESCE(SUM(o.usdt_value),0) AS volume,
           COALESCE(SUM(-(o.realized_pnl)),0) AS platform_pnl_raw,
           COALESCE(SUM(o.realized_pnl),0) AS user_pnl
    FROM public.chain_predict_order o
    JOIN public.trade_pool_pairs p ON p.pair_id = o.pair_id
    CROSS JOIN params
    WHERE o.order_status IN ('Finished','Pending')
      AND o.duration = 30
      AND p.pair_name = 'BTC/USDT'
      AND o.created_at >= params.start_utc
      AND o.created_at < params.now_utc
    GROUP BY params.now_sg;
    """
    with db_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql)
            row = cur.fetchone()
            return dict(row) if row else {}


def finished_trades_since_start():
    with STATE.lock:
        started_at_utc = STATE.started_at_utc
    sql = """
    SELECT o.id,
           o.side,
           o.order_way,
           o.usdt_value,
           o.return_rate,
           o.realized_pnl,
           o.created_at,
           o.settled_at
    FROM public.chain_predict_order o
    JOIN public.trade_pool_pairs p ON p.pair_id = o.pair_id
    WHERE o.order_status = 'Finished'
      AND o.duration = 30
      AND p.pair_name = 'BTC/USDT'
      AND o.created_at >= %s
    ORDER BY o.created_at ASC;
    """
    with db_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, (started_at_utc,))
            return [dict(r) for r in cur.fetchall()]


def refresh_counterfactual():
    STATE.ensure_current_day()
    trades = finished_trades_since_start()
    recomputed_processed_ids = set()
    recomputed_our_pnl = 0.0
    recomputed_competed_volume = 0.0
    recomputed_competed_trades = 0
    recomputed_won_trades = 0
    recomputed_lost_trades = 0

    for trade in trades:
        trade_id = int(trade["id"])
        recomputed_processed_ids.add(trade_id)
        created_at = trade["created_at"]
        quote = STATE.quote_for_trade(created_at)
        if quote is None:
            continue

        side = side_label(trade["side"], trade["order_way"])
        actual_payout = Decimal(str(trade["return_rate"])) * Decimal("100")
        our_payout = quote["up_payout"] if side == "UP" else quote["down_payout"] if side == "DOWN" else None
        if our_payout is None:
            continue

        usdt_value = Decimal(str(trade["usdt_value"]))
        realized_pnl = Decimal(str(trade["realized_pnl"]))

        if our_payout > actual_payout:
            if realized_pnl > Decimal("0"):
                our_trade_pnl = -(usdt_value * our_payout / Decimal("100"))
                recomputed_lost_trades += 1
            else:
                our_trade_pnl = usdt_value
                recomputed_won_trades += 1

            recomputed_our_pnl += float(our_trade_pnl)
            recomputed_competed_volume += float(usdt_value)
            recomputed_competed_trades += 1

    actual = actual_platform_today()
    with STATE.lock:
        STATE.processed_ids = recomputed_processed_ids
        STATE.our_pnl = recomputed_our_pnl
        STATE.competed_volume = recomputed_competed_volume
        STATE.competed_trades = recomputed_competed_trades
        STATE.won_trades = recomputed_won_trades
        STATE.lost_trades = recomputed_lost_trades
        STATE.last_status = {
            "day_key_sg": STATE.day_key,
            "started_at_utc": STATE.started_at_utc.isoformat(),
            "quotes_buffered": len(STATE.quote_history),
            "processed_finished_trades": len(STATE.processed_ids),
            "our_pnl_since_start": round(STATE.our_pnl, 2),
            "competed_volume_since_start": round(STATE.competed_volume, 2),
            "competed_trades_since_start": STATE.competed_trades,
            "wins_for_us": STATE.won_trades,
            "losses_for_us": STATE.lost_trades,
            "actual_platform_today": {
                "now_sg": actual.get("now_sg").isoformat() if actual.get("now_sg") else None,
                "trades": int(actual.get("trades", 0) or 0),
                "volume": round(float(actual.get("volume", 0) or 0), 2),
                "platform_pnl_raw": round(float(actual.get("platform_pnl_raw", 0) or 0), 2),
                "user_pnl": round(float(actual.get("user_pnl", 0) or 0), 2),
            },
        }
    STATE.save_state()


class Handler(BaseHTTPRequestHandler):
    def _headers(self, status=200, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_OPTIONS(self):
        self._headers(204)

    def do_POST(self):
        if self.path == "/reset":
            STATE.reset_from_now()
            refresh_counterfactual()
            self._headers(200)
            self.wfile.write(json.dumps({"ok": True, "reset": True, "started_at_utc": STATE.started_at_utc.isoformat()}).encode())
            return
        if self.path != "/quote":
            self._headers(404)
            self.wfile.write(json.dumps({"error": "not found"}).encode())
            return
        length = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(length) or b"{}")
        STATE.add_quote(payload)
        refresh_counterfactual()
        self._headers(200)
        self.wfile.write(json.dumps({"ok": True}).encode())

    def render_index(self, status):
        actual = status.get("actual_platform_today", {})
        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BTC 30s Live PnL Monitor</title>
  <meta http-equiv="refresh" content="3" />
  <style>
    body {{
      margin: 0;
      font-family: Segoe UI, Arial, sans-serif;
      background: linear-gradient(160deg, #f8f3ea, #ece6de);
      color: #17212b;
    }}
    .page {{
      width: min(1100px, calc(100vw - 32px));
      margin: 24px auto;
    }}
    .hero, .panel {{
      background: rgba(255,255,255,0.88);
      border: 1px solid rgba(23,33,43,0.10);
      border-radius: 20px;
      padding: 20px 22px;
      box-shadow: 0 12px 28px rgba(23,33,43,0.08);
      margin-bottom: 18px;
    }}
    .grid {{
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }}
    .metric {{
      background: rgba(255,255,255,0.8);
      border: 1px solid rgba(23,33,43,0.08);
      border-radius: 14px;
      padding: 14px;
    }}
    .metric span {{
      display: block;
      color: #5a6672;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 8px;
      font-weight: 700;
    }}
    .metric strong {{
      display: block;
      font-size: 28px;
      letter-spacing: -0.03em;
      margin-bottom: 4px;
    }}
    .metric small {{
      color: #5a6672;
      line-height: 1.4;
    }}
    pre {{
      background: #182129;
      color: #f4f6f8;
      border-radius: 14px;
      padding: 16px;
      overflow: auto;
      font-size: 13px;
    }}
    a {{ color: #0e7c66; }}
  </style>
</head>
<body>
  <div class="page">
    <div class="hero">
      <h1 style="margin:0 0 8px;">BTC 30s Live PnL Monitor</h1>
      <div style="color:#5a6672; line-height:1.5;">
        Counterfactual live monitor for your quote vs platform quote.
        Refreshes every 3 seconds. JSON is still available at <a href="/status">/status</a>.
      </div>
    </div>
    <div class="panel">
      <div class="grid">
        <div class="metric">
          <span>Your PnL Since Start</span>
          <strong>{status.get("our_pnl_since_start", 0):,.2f}</strong>
          <small>Counterfactual PnL from trades where your quote beat the platform quote.</small>
        </div>
        <div class="metric">
          <span>Competed Trades</span>
          <strong>{status.get("competed_trades_since_start", 0)}</strong>
          <small>Won {status.get("wins_for_us", 0)} / Lost {status.get("losses_for_us", 0)} counterfactual fills.</small>
        </div>
        <div class="metric">
          <span>Competed Volume</span>
          <strong>{status.get("competed_volume_since_start", 0):,.2f}</strong>
          <small>Trade volume assigned to your quote by the best-price rule.</small>
        </div>
        <div class="metric">
          <span>Actual Platform PnL Today</span>
          <strong>{float(actual.get("platform_pnl_raw", 0)):,.2f}</strong>
          <small>Raw BTC 30s platform PnL since Singapore midnight.</small>
        </div>
        <div class="metric">
          <span>Actual Trades Today</span>
          <strong>{int(actual.get("trades", 0) or 0)}</strong>
          <small>{float(actual.get("volume", 0) or 0):,.2f} BTC 30s volume today.</small>
        </div>
        <div class="metric">
          <span>Quotes Buffered</span>
          <strong>{status.get("quotes_buffered", 0)}</strong>
          <small>Quote snapshots received from the live pricing console.</small>
        </div>
      </div>
    </div>
    <div class="panel">
      <div style="font-weight:700; margin-bottom:10px;">Live Status Payload</div>
      <pre>{escape(json.dumps(status, indent=2))}</pre>
    </div>
  </div>
</body>
</html>"""
        return html.encode("utf-8")

    def do_GET(self):
        if self.path == "/" or self.path == "":
            refresh_counterfactual()
            self._headers(200, "text/html; charset=utf-8")
            self.wfile.write(self.render_index(STATE.last_status))
            return
        if self.path != "/status":
            self._headers(404)
            self.wfile.write(json.dumps({"error": "not found"}).encode())
            return
        refresh_counterfactual()
        self._headers(200)
        self.wfile.write(json.dumps(STATE.last_status).encode())


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Serving live monitor on http://{HOST}:{PORT}")
    server.serve_forever()
