"""paper.py — 💹 모의투자 가상계좌 (11-26, 로드맵 E1)

증권사로 주문을 보내지 않는다. 실제 시세(KIS 실시간 호가·체결, 조회만)를 보고 이 서버가 체결을 계산한다.
- 시작 금액은 사용자가 정하고, 리셋하면 지금 회차를 끝내 결과를 남기고 새 회차를 연다(회차 기록은 지우지 않음).
- 시간: 정규장·장 시작/마감 동시호가·장전/장후 시간외 종가·시간외 단일가(KRX)·넥스트레이드 프리/애프터.
- 수수료·세금: FEE_RATE(매수·매도), TAX_RATE(매도) — 실제 증권사·세율과 다를 수 있어 값만 바꾸면 되게 한 곳에 둠.

체결 규칙 (결정 009):
- 연속 매매(정규장·넥스트레이드): 시장가는 그 순간 반대쪽 호가 잔량을 차례로 먹음(잔량이 모자라면 마지막 호가로).
  지정가는 반대쪽 최우선 호가가 그 가격에 닿으면 체결, 실제 체결가가 정확히 그 가격이면 그 체결 수량만큼만(줄 서기 근사).
- 동시호가(08:40~09:00, 15:20~15:30): 주문을 모아 두었다가 시가(9시 첫 체결)·종가로 한 번에. 지정가는 그 가격이 조건에 맞을 때만.
- 장전 시간외(08:30~08:40)는 전일 종가, 장후 시간외(15:40~16:00)는 오늘 종가로 바로 체결.
- 시간외 단일가(16:00~18:00, 10분마다): 실제 시간외 체결이 나올 때 그 가격으로, 지정가 조건 맞으면 체결.
- 세션이 끝나면 남은 수량은 자동 취소(당일 주문).
"""
import os
import sqlite3
import threading
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))
# 시험용: STOCKVIEW_PAPER_DB(다른 DB 파일)·STOCKVIEW_PAPER_NOW("10:05" — 장 밖에서 장중처럼 시험). 실사용 서버엔 넣지 않는다.
DB_PATH = os.environ.get("STOCKVIEW_PAPER_DB") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "paper.sqlite")
_FAKE_NOW = os.environ.get("STOCKVIEW_PAPER_NOW", "").strip()
_FAKE_T0 = time.time()

FEE_RATE = 0.00015      # 증권사 수수료 0.015% (온라인 기준, 매수·매도 각각)
TAX_RATE = 0.0020       # 매도 거래세 0.20% (2026년 기준 코스피 거래세+농특세·코스닥 같음 — 바뀌면 여기만)
DEFAULT_CASH = 10_000_000

# 세션: id → (이름, 시작 'HH:MM', 끝, 종류, 거래소)
#   kind: cont 연속 · auc_open 시가 동시호가 · auc_close 종가 동시호가 · close_prev 전일 종가 · close_today 오늘 종가 · single 단일가
SESSIONS = {
    "nxt_pre":     ("넥스트레이드 프리마켓", "08:00", "08:50", "cont", "NX"),
    "pre_close":   ("장전 시간외 (전일 종가)", "08:30", "08:40", "close_prev", "J"),
    "auc_open":    ("장 시작 동시호가", "08:40", "09:00", "auc_open", "J"),
    "regular":     ("정규장", "09:00", "15:20", "cont", "UN"),
    "auc_close":   ("장 마감 동시호가", "15:20", "15:30", "auc_close", "J"),
    "nxt_after":   ("넥스트레이드 애프터마켓", "15:30", "20:00", "cont", "NX"),
    "post_close":  ("장후 시간외 (오늘 종가)", "15:40", "16:00", "close_today", "J"),
    "single":      ("시간외 단일가", "16:00", "18:00", "single", "J"),
}


def now_kst() -> datetime:
    n = datetime.now(KST)
    if _FAKE_NOW:     # 시험용 가짜 시각 (평일로 맞추고, 켠 뒤 흐른 시간만큼 진행)
        h, m = (int(x) for x in _FAKE_NOW.split(":"))
        d = n - timedelta(days=max(0, n.weekday() - 4))
        return d.replace(hour=h, minute=m, second=0, microsecond=0) + timedelta(seconds=time.time() - _FAKE_T0)
    return n


def _hm(s: str) -> int:
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def open_sessions(now: datetime, open_day: bool = True) -> list[str]:
    """지금 주문을 받는 세션 id들 (시간 순). 휴장일·주말이면 []."""
    if not open_day or now.weekday() >= 5:
        return []
    m = now.hour * 60 + now.minute
    return [k for k, v in SESSIONS.items() if _hm(v[1]) <= m < _hm(v[2])]


def tick_size(price: float) -> int:
    """국내 주식 호가 단위 (2023-01 개편 뒤 코스피·코스닥 같음)."""
    for lim, t in ((2000, 1), (5000, 5), (20000, 10), (50000, 50), (200000, 100), (500000, 500)):
        if price < lim:
            return t
    return 1000


def fee_of(amount: float) -> int:
    return int(amount * FEE_RATE)


def tax_of(amount: float) -> int:
    return int(amount * TAX_RATE)


class PaperError(ValueError):
    pass


class Paper:
    """가상계좌. 모든 공개 메서드는 스레드 안전(_lock)."""

    def __init__(self, path: str = DB_PATH):
        self.path = path
        self._lock = threading.RLock()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with closing(self._db()) as con:
            con.executescript("""
            CREATE TABLE IF NOT EXISTS rounds (id INTEGER PRIMARY KEY, started REAL, ended REAL, start_cash INTEGER,
                cash INTEGER, end_value INTEGER, note TEXT);
            CREATE TABLE IF NOT EXISTS positions (round_id INTEGER, code TEXT, name TEXT, qty INTEGER, avg REAL,
                PRIMARY KEY (round_id, code));
            CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, round_id INTEGER, ts REAL, code TEXT, name TEXT,
                side TEXT, otype TEXT, price INTEGER, qty INTEGER, filled INTEGER DEFAULT 0, avg_fill REAL,
                session TEXT, status TEXT, reason TEXT, day TEXT);
            CREATE TABLE IF NOT EXISTS fills (id INTEGER PRIMARY KEY, round_id INTEGER, order_id INTEGER, ts REAL, code TEXT,
                name TEXT, side TEXT, price INTEGER, qty INTEGER, fee INTEGER, tax INTEGER, pnl INTEGER);
            CREATE TABLE IF NOT EXISTS equity (round_id INTEGER, ts REAL, value INTEGER);
            CREATE INDEX IF NOT EXISTS ix_orders_open ON orders (status, code);
            CREATE INDEX IF NOT EXISTS ix_fills_round ON fills (round_id, ts);
            CREATE INDEX IF NOT EXISTS ix_equity_round ON equity (round_id, ts);
            """)
            con.commit()
        self.last_price: dict[str, int] = {}     # 종목 → 마지막 체결가 (평가용)

    def _db(self):
        con = sqlite3.connect(self.path, timeout=10)
        con.row_factory = sqlite3.Row
        return con

    # ── 회차 ─────────────────────────────────────────────────────────────
    def _round(self, con) -> sqlite3.Row | None:
        return con.execute("SELECT * FROM rounds WHERE ended IS NULL ORDER BY id DESC LIMIT 1").fetchone()

    def new_round(self, amount: int, value_now: int | None = None) -> int:
        """지금 회차를 끝내고(결과 남김) 새 회차 시작. amount = 시작 금액(원)."""
        amount = int(amount)
        if not (100_000 <= amount <= 100_000_000_000):
            raise PaperError("시작 금액은 10만 원 ~ 1,000억 원")
        with self._lock, closing(self._db()) as con:
            r = self._round(con)
            if r:
                end = value_now if value_now is not None else self._equity(con, r)
                con.execute("UPDATE orders SET status='cancelled', reason='리셋' WHERE round_id=? AND status='open'", (r["id"],))
                con.execute("INSERT INTO equity VALUES (?,?,?)", (r["id"], time.time(), end))
                con.execute("UPDATE rounds SET ended=?, end_value=? WHERE id=?", (time.time(), end, r["id"]))
            cur = con.execute("INSERT INTO rounds (started, start_cash, cash) VALUES (?,?,?)", (time.time(), amount, amount))
            con.execute("INSERT INTO equity VALUES (?,?,?)", (cur.lastrowid, time.time(), amount))
            con.commit()
            return cur.lastrowid

    def ensure_round(self) -> None:
        with self._lock, closing(self._db()) as con:
            if self._round(con):
                return
        self.new_round(DEFAULT_CASH)

    # ── 평가 ─────────────────────────────────────────────────────────────
    def _equity(self, con, r) -> int:
        v = r["cash"]
        for p in con.execute("SELECT code, qty, avg FROM positions WHERE round_id=? AND qty>0", (r["id"],)):
            v += p["qty"] * self.last_price.get(p["code"], p["avg"])
        return int(v)

    def _reserved(self, con, rid: int) -> tuple[int, dict]:
        """미체결 매수에 묶인 돈, 미체결 매도에 묶인 종목별 수량."""
        cash, qty = 0, {}
        for o in con.execute("SELECT * FROM orders WHERE round_id=? AND status='open'", (rid,)):
            left = o["qty"] - o["filled"]
            if o["side"] == "buy":
                px = o["price"] or self.last_price.get(o["code"], 0) * 1.05
                cash += int(left * px * (1 + FEE_RATE)) + 1
            else:
                qty[o["code"]] = qty.get(o["code"], 0) + left
        return cash, qty

    def snapshot_equity(self) -> None:
        with self._lock, closing(self._db()) as con:
            r = self._round(con)
            if r:
                con.execute("INSERT INTO equity VALUES (?,?,?)", (r["id"], time.time(), self._equity(con, r)))
                con.commit()

    # ── 주문 ─────────────────────────────────────────────────────────────
    def place(self, code: str, name: str, side: str, otype: str, price: int | None, qty: int, session: str,
              quote: dict, now: datetime | None = None, open_day: bool = True) -> dict:
        """주문 접수 → 바로 체결 가능한 만큼 체결. quote = {price, prev_close, close, upper, lower, asks, bids}.
        반환: 주문 행(dict)."""
        now = now or now_kst()
        side, otype = side.lower(), otype.lower()
        if side not in ("buy", "sell") or otype not in ("limit", "market"):
            raise PaperError("주문 종류가 잘못됨")
        if session not in open_sessions(now, open_day):
            raise PaperError(f"지금은 {SESSIONS.get(session, ('이 세션',))[0]} 시간이 아님")
        kind = SESSIONS[session][3]
        qty = int(qty)
        if qty <= 0:
            raise PaperError("수량은 1주 이상")
        if kind in ("close_prev", "close_today"):
            ref = quote.get("prev_close") if kind == "close_prev" else quote.get("close")
            if not ref:
                raise PaperError("기준 종가를 아직 모름")
            otype, price = "limit", int(ref)
        elif kind == "single" and otype == "market":
            raise PaperError("시간외 단일가는 지정가만")
        if otype == "limit":
            price = int(price or 0)
            if price <= 0:
                raise PaperError("가격을 넣어 주세요")
            t = tick_size(price)
            if price % t:
                raise PaperError(f"호가 단위는 {t:,}원")
            lo, hi = quote.get("lower"), quote.get("upper")
            if kind == "single" and quote.get("close"):
                c = quote["close"]
                lo, hi = int(c * 0.9), int(c * 1.1)
            if lo and hi and not (lo <= price <= hi):
                raise PaperError(f"가격 범위 {int(lo):,} ~ {int(hi):,}원")
        else:
            price = None
        with self._lock, closing(self._db()) as con:
            r = self._round(con)
            if not r:
                raise PaperError("회차가 없음 — 시작 금액을 정해 주세요")
            res_cash, res_qty = self._reserved(con, r["id"])
            if side == "buy":
                est = price or self._est_market_buy(quote, qty)
                need = int(qty * est * (1 + FEE_RATE)) + 1
                if need > r["cash"] - res_cash:
                    raise PaperError(f"주문 가능 금액 부족 (가능 {max(0, r['cash'] - res_cash):,}원)")
            else:
                pos = con.execute("SELECT qty FROM positions WHERE round_id=? AND code=?", (r["id"], code)).fetchone()
                have = (pos["qty"] if pos else 0) - res_qty.get(code, 0)
                if qty > have:
                    raise PaperError(f"매도 가능 수량 부족 (가능 {max(0, have):,}주)")
            cur = con.execute("INSERT INTO orders (round_id, ts, code, name, side, otype, price, qty, session, status, day)"
                              " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                              (r["id"], time.time(), code, name, side, otype, price, qty, session, "open", now.strftime("%Y-%m-%d")))
            con.commit()
            oid = cur.lastrowid
        if quote.get("price"):
            self.last_price[code] = int(quote["price"])
        # 바로 체결
        if kind == "cont":
            self.on_book(code, SESSIONS[session][4], quote.get("asks") or [], quote.get("bids") or [], quote.get("price"))
        elif kind in ("close_prev", "close_today"):
            self._fill_order(oid, int(price), qty)
        return self.order(oid)

    @staticmethod
    def _est_market_buy(quote: dict, qty: int) -> float:
        left, cost, last = qty, 0.0, None
        for p, q in quote.get("asks") or []:
            if p <= 0 or q <= 0:
                continue
            n = min(left, q)
            cost += n * p
            left -= n
            last = p
            if left <= 0:
                break
        if left > 0:
            last = last or quote.get("price") or 0
            cost += left * last * 1.02
        return cost / qty if qty else 0

    def cancel(self, oid: int) -> dict:
        with self._lock, closing(self._db()) as con:
            o = con.execute("SELECT * FROM orders WHERE id=?", (oid,)).fetchone()
            if not o or o["status"] != "open":
                raise PaperError("취소할 수 있는 주문이 아님")
            con.execute("UPDATE orders SET status=?, reason='사용자 취소' WHERE id=?",
                        ("cancelled" if o["filled"] == 0 else "partial", oid))
            con.commit()
        return self.order(oid)

    def order(self, oid: int) -> dict:
        with closing(self._db()) as con:
            o = con.execute("SELECT * FROM orders WHERE id=?", (oid,)).fetchone()
            return dict(o) if o else {}

    def open_orders(self, code: str | None = None) -> list[dict]:
        with closing(self._db()) as con:
            q = "SELECT * FROM orders WHERE status='open'" + (" AND code=?" if code else "")
            return [dict(o) for o in con.execute(q, (code,) if code else ())]

    def open_codes(self) -> set[str]:
        with closing(self._db()) as con:
            return {r[0] for r in con.execute("SELECT DISTINCT code FROM orders WHERE status='open'")}

    # ── 체결 ─────────────────────────────────────────────────────────────
    def _fill_order(self, oid: int, price: int, qty: int) -> dict | None:
        """주문 oid를 price에 qty만큼 체결 (현금·잔고·손익 반영). 체결 행 반환."""
        with self._lock, closing(self._db()) as con:
            o = con.execute("SELECT * FROM orders WHERE id=?", (oid,)).fetchone()
            if not o or o["status"] != "open":
                return None
            qty = min(qty, o["qty"] - o["filled"])
            if qty <= 0:
                return None
            r = con.execute("SELECT * FROM rounds WHERE id=?", (o["round_id"],)).fetchone()
            amt = price * qty
            fee = fee_of(amt)
            pos = con.execute("SELECT * FROM positions WHERE round_id=? AND code=?", (r["id"], o["code"])).fetchone()
            pq, pavg = (pos["qty"], pos["avg"]) if pos else (0, 0.0)
            tax, pnl = 0, None
            if o["side"] == "buy":
                if amt + fee > r["cash"]:          # 시장가가 예상보다 비싸게 체결돼 돈이 모자라면 살 수 있는 만큼만
                    qty = int(r["cash"] / (price * (1 + FEE_RATE)))
                    if qty <= 0:
                        con.execute("UPDATE orders SET status='rejected', reason='금액 부족' WHERE id=?", (oid,))
                        con.commit()
                        return None
                    amt, fee = price * qty, fee_of(price * qty)
                cash = r["cash"] - amt - fee
                nq = pq + qty
                navg = (pq * pavg + amt) / nq
            else:
                qty = min(qty, pq)
                if qty <= 0:
                    con.execute("UPDATE orders SET status='rejected', reason='보유 수량 없음' WHERE id=?", (oid,))
                    con.commit()
                    return None
                amt, fee = price * qty, fee_of(price * qty)
                tax = tax_of(amt)
                cash = r["cash"] + amt - fee - tax
                nq, navg = pq - qty, pavg
                pnl = int((price - pavg) * qty - fee - tax)
            con.execute("INSERT OR REPLACE INTO positions VALUES (?,?,?,?,?)", (r["id"], o["code"], o["name"], nq, navg))
            con.execute("UPDATE rounds SET cash=? WHERE id=?", (int(cash), r["id"]))
            filled = o["filled"] + qty
            avg_fill = ((o["avg_fill"] or 0) * o["filled"] + price * qty) / filled
            con.execute("UPDATE orders SET filled=?, avg_fill=?, status=? WHERE id=?",
                        (filled, avg_fill, "filled" if filled >= o["qty"] else "open", oid))
            ts = time.time()
            cur = con.execute("INSERT INTO fills (round_id, order_id, ts, code, name, side, price, qty, fee, tax, pnl)"
                              " VALUES (?,?,?,?,?,?,?,?,?,?,?)", (r["id"], oid, ts, o["code"], o["name"], o["side"], price, qty, fee, tax, pnl))
            self.last_price.setdefault(o["code"], price)   # 평가는 실제 마지막 체결가로 (내 체결가로 덮지 않음)
            r2 = con.execute("SELECT * FROM rounds WHERE id=?", (r["id"],)).fetchone()
            con.execute("INSERT INTO equity VALUES (?,?,?)", (r["id"], ts, self._equity(con, r2)))
            con.commit()
            fill = {"id": cur.lastrowid, "order_id": oid, "ts": ts, "code": o["code"], "name": o["name"], "side": o["side"],
                    "price": price, "qty": qty, "fee": fee, "tax": tax, "pnl": pnl, "done": filled >= o["qty"]}
        if self.on_fill:
            try:
                self.on_fill(fill)
            except Exception:
                pass
        return fill

    on_fill = None   # 체결 알림 콜백 (app이 socketio로 보냄)

    def _cont_orders(self, code: str, venue: str) -> list:
        """이 종목의 연속 매매 미체결 주문 — 정규장 주문(UN)은 통합 시세로, 넥스트레이드 주문(NX)은 NX 시세로만 체결."""
        out = []
        for o in self.open_orders(code):
            s = SESSIONS.get(o["session"])
            if not s or s[3] != "cont":
                continue
            if s[4] == venue:
                out.append(o)
        return out

    def on_book(self, code: str, venue: str, asks: list, bids: list, last: float | None = None) -> list:
        """호가가 들어왔을 때 연속 매매 주문 체결. asks/bids = [(가격, 잔량)] 최우선부터."""
        fills = []
        if last:
            self.last_price[code] = int(last)
        for o in self._cont_orders(code, venue):
            book = asks if o["side"] == "buy" else bids
            left = o["qty"] - o["filled"]
            levels = [(int(p), int(q)) for p, q in book if p and q]
            if o["otype"] == "market":
                if not levels and last:
                    levels = [(int(last), left)]
                for i, (p, q) in enumerate(levels):
                    n = left if i == len(levels) - 1 else min(left, q)
                    f = self._fill_order(o["id"], p, n)
                    if f:
                        fills.append(f)
                        left -= f["qty"]
                    if left <= 0:
                        break
            else:
                lim = o["price"]
                for p, q in levels:
                    if (o["side"] == "buy" and p > lim) or (o["side"] == "sell" and p < lim):
                        break
                    f = self._fill_order(o["id"], p, min(left, q))
                    if f:
                        fills.append(f)
                        left -= f["qty"]
                    if left <= 0:
                        break
        return fills

    def on_trade(self, code: str, venue: str, price: float, vol: int, kind: str = "cont") -> list:
        """실제 체결이 들어왔을 때. kind: cont(연속)·open(9시 첫 체결)·close(종가 확정)·single(시간외 단일가 체결)."""
        price = int(price)
        self.last_price[code] = price
        fills = []
        for o in self.open_orders(code):
            s = SESSIONS.get(o["session"])
            if not s:
                continue
            k = s[3]
            left = o["qty"] - o["filled"]
            lim = o["price"]
            ok = lim is None or (o["side"] == "buy" and price <= lim) or (o["side"] == "sell" and price >= lim)
            if kind == "cont" and k == "cont" and s[4] == venue and lim is not None:
                # 지정가보다 유리한 가격에 체결이 났으면 내 주문도 그 가격(=지정가)에 다 체결, 같은 가격이면 그 수량만큼
                if (o["side"] == "buy" and price < lim) or (o["side"] == "sell" and price > lim):
                    f = self._fill_order(o["id"], lim, left)
                elif price == lim:
                    f = self._fill_order(o["id"], lim, min(left, max(1, int(vol))))
                else:
                    f = None
            elif kind == "open" and k == "auc_open" and ok:
                f = self._fill_order(o["id"], price, left)
            elif kind == "close" and k == "auc_close" and ok:
                f = self._fill_order(o["id"], price, left)
            elif kind == "single" and k == "single" and ok:
                f = self._fill_order(o["id"], price, left)
            else:
                f = None
            if f:
                fills.append(f)
        return fills

    def expire(self, now: datetime | None = None, open_day: bool = True) -> int:
        """세션이 끝난 미체결 주문 취소 (동시호가는 체결 처리를 기다리도록 5분 여유). 취소 건수."""
        now = now or now_kst()
        m = now.hour * 60 + now.minute
        today = now.strftime("%Y-%m-%d")
        n = 0
        with self._lock, closing(self._db()) as con:
            for o in con.execute("SELECT * FROM orders WHERE status='open'").fetchall():
                s = SESSIONS.get(o["session"])
                grace = 5 if s and s[3] in ("auc_open", "auc_close", "single") else 0
                if o["day"] != today or not s or m >= _hm(s[2]) + grace:
                    con.execute("UPDATE orders SET status=?, reason='세션 종료' WHERE id=?",
                                ("cancelled" if o["filled"] == 0 else "partial", o["id"]))
                    n += 1
            con.commit()
        return n

    # ── 조회 ─────────────────────────────────────────────────────────────
    def state(self) -> dict:
        with self._lock, closing(self._db()) as con:
            r = self._round(con)
            if not r:
                return {"round": None}
            rid = r["id"]
            res_cash, res_qty = self._reserved(con, rid)
            pos = []
            for p in con.execute("SELECT * FROM positions WHERE round_id=? AND qty>0 ORDER BY code", (rid,)):
                last = self.last_price.get(p["code"])
                val = p["qty"] * (last or p["avg"])
                pos.append({"code": p["code"], "name": p["name"], "qty": p["qty"], "avg": round(p["avg"], 1), "last": last,
                            "value": int(val), "pnl": int(val - p["qty"] * p["avg"]) if last else None,
                            "pct": round((last / p["avg"] - 1) * 100, 2) if last and p["avg"] else None,
                            "sellable": p["qty"] - res_qty.get(p["code"], 0)})
            day0 = now_kst().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
            orders = [dict(o) for o in con.execute("SELECT * FROM orders WHERE round_id=? AND (status='open' OR ts>=?) ORDER BY id DESC LIMIT 100", (rid, day0))]
            fills = [dict(f) for f in con.execute("SELECT * FROM fills WHERE round_id=? ORDER BY id DESC LIMIT 100", (rid,))]
            eq = self._equity(con, r)
            return {"round": {"id": rid, "no": self._round_no(con, rid), "started": r["started"], "start_cash": r["start_cash"]},
                    "cash": r["cash"], "orderable": max(0, r["cash"] - res_cash), "equity": eq,
                    "stock_value": eq - r["cash"], "pnl": eq - r["start_cash"],
                    "pct": round((eq / r["start_cash"] - 1) * 100, 2) if r["start_cash"] else 0,
                    "positions": pos, "orders": orders, "fills": fills,
                    "fee_rate": FEE_RATE, "tax_rate": TAX_RATE}

    @staticmethod
    def _round_no(con, rid: int) -> int:
        return con.execute("SELECT COUNT(*) FROM rounds WHERE id<=?", (rid,)).fetchone()[0]

    def rounds(self) -> list[dict]:
        """회차별 결과 (최신 먼저): 기간·시작/최종 금액·수익률·매매 횟수·이긴 매도 비율·최대 낙폭·수수료+세금."""
        out = []
        with self._lock, closing(self._db()) as con:
            for r in con.execute("SELECT * FROM rounds ORDER BY id DESC").fetchall():
                rid = r["id"]
                end = r["end_value"] if r["ended"] else self._equity(con, r)
                f = con.execute("SELECT COUNT(*) n, SUM(side='buy') b, SUM(side='sell') s, SUM(fee+tax) cost,"
                                " SUM(CASE WHEN side='sell' THEN pnl END) realized FROM fills WHERE round_id=?", (rid,)).fetchone()
                # 이긴 매매 = 주문 단위로 손익 합이 0보다 큰 매도 주문
                sells = [x[0] for x in con.execute("SELECT SUM(pnl) FROM fills WHERE round_id=? AND side='sell' GROUP BY order_id", (rid,))]
                wins = sum(1 for x in sells if (x or 0) > 0)
                peak, mdd = None, 0.0
                for (v,) in con.execute("SELECT value FROM equity WHERE round_id=? ORDER BY ts", (rid,)):
                    peak = v if peak is None or v > peak else peak
                    if peak:
                        mdd = min(mdd, v / peak - 1)
                out.append({"id": rid, "no": self._round_no(con, rid), "started": r["started"], "ended": r["ended"],
                            "start_cash": r["start_cash"], "end_value": int(end),
                            "pct": round((end / r["start_cash"] - 1) * 100, 2) if r["start_cash"] else 0,
                            "pnl": int(end - r["start_cash"]), "trades": f["n"] or 0, "buys": f["b"] or 0, "sells": len(sells),
                            "wins": wins, "win_rate": round(wins / len(sells) * 100, 1) if sells else None,
                            "mdd": round(mdd * 100, 2), "cost": int(f["cost"] or 0), "realized": int(f["realized"] or 0),
                            "active": r["ended"] is None})
        return out
