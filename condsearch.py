"""🎯 조건검색기 (11-26) — 사용자 조건검색식(키움식 A~U를 and/or로 묶은 식) 프리셋을 장중에 국내 보통주에 돌린다.

흐름 (정규장 5분마다, 휴장일 제외):
  1차  네이버 시세(전 종목, 1분 갱신) + 아침에 받아 둔 일봉 → 지금 알 수 있는 조건만 판정.
       아직 모르는 값(오늘 시가·고가·저가, 5분봉, KIS 체결강도·호가·종목 상태)은 '모름'으로 두고 통과시킨다.
  2차  남은 후보만 네이버 1분봉(오늘) → 5분봉 · 오늘 시가/고가/저가 · 전일 같은 시각 거래량.
  3차  남은 후보만 KIS → 종목 상태(관리·경고 등, 하루 한 번)·체결강도·호가 잔량.
  조건 값은 참/거짓/모름 세 가지. and는 거짓이 하나라도 있으면 거짓, or는 참이 하나라도 있으면 참. 마지막엔 모름 = 거짓.

데이터 (아침 08:10 한 번, 서버 시작 때 오늘 것이 없으면 한 번):
  - 일봉 4년치(야후, KRX 공식) → 최근 WIN개 봉 + 그 앞까지의 지수이평 값(seed). 오늘 봉은 시세로 붙인다.
  - 전 거래일 1분봉(네이버) → 5분봉 OHLCV, 분마다 누적 거래량(전일 같은 시각 비교용).
  ⚠️ 네이버 1분봉의 accumulatedTradingVolume은 이름과 달리 '그 1분의 거래량'이다(11-26 확인: 하루 합 ≈ 일봉 거래량).
  저장: data/cond_daily.json.gz (그날 다시 시작해도 다시 안 받음). 잡힌 기록: data/cond_hits.sqlite.

키움과 다를 수 있는 점 (docs/architecture.md에도 적음):
  - 과거 거래대금은 종가×거래량 근사(오늘 값만 실제 거래대금).
  - 지수이평 시작값은 4년 전 첫 종가. 일목 선행스팬은 25봉 전 계산값(26일 선행).
"""
from __future__ import annotations

import array
import gzip
import json
import logging
import os
import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

import data_fetcher as df
import kis

log = logging.getLogger(__name__)
KST = ZoneInfo("Asia/Seoul")
_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DAILY_FILE = os.path.join(_DIR, "cond_daily.json.gz")
HITS_DB = os.path.join(_DIR, "cond_hits.sqlite")

WIN = 140                       # 계산에 쓰는 최근 일봉 수 (50봉 안 조건 + 일목 52+25봉)
EMA_P = (5, 15, 20, 60, 112, 150, 224, 448, 500, 600)
FILE_VER = 4   # 3: 1분봉 거래량을 분당 값으로 바로잡음(11-27) · 4: 전일 넥스트 애프터 5분봉(p5x) 추가(11-27)
KIS_CAP = 40                    # 프리셋 하나가 한 번에 KIS로 확인하는 최대 종목 수
_MIN_URL = ("https://api.stock.naver.com/chart/domestic/item/{code}/minute"
            "?startDateTime={d}0900&endDateTime={d}{end}")


# ── 참/거짓/모름 ────────────────────────────────────────────────────────────
def AND(*xs):
    r = True
    for x in xs:
        if x is False:
            return False
        if x is None:
            r = None
    return r


def OR(*xs):
    r = False
    for x in xs:
        if x is True:
            return True
        if x is None:
            r = None
    return r


def within(v, lo, hi):
    return None if v is None else lo <= v <= hi


def pct(a, b):
    """a가 b보다 몇 % 높은가."""
    return None if a is None or not b else (a / b - 1) * 100


def gt(a, b):
    return None if a is None or b is None else a > b


def count_true(xs):
    """[참/거짓/모름] → (참 수, 모름 수)."""
    return sum(1 for x in xs if x is True), sum(1 for x in xs if x is None)


def any_of(xs):
    t, u = count_true(xs)
    return True if t else (None if u else False)


def all_of(xs):
    if any(x is False for x in xs):
        return False
    return None if any(x is None for x in xs) else True


# ── 조건식 해석: "A and (B or C)" ───────────────────────────────────────────
def compile_expr(expr: str):
    toks = re.findall(r"\(|\)|\band\b|\bor\b|[A-Z]", expr)
    pos = [0]

    def peek():
        return toks[pos[0]] if pos[0] < len(toks) else None

    def take():
        pos[0] += 1
        return toks[pos[0] - 1]

    def p_or():
        xs = [p_and()]
        while peek() == "or":
            take()
            xs.append(p_and())
        return xs[0] if len(xs) == 1 else ("or", xs)

    def p_and():
        xs = [p_atom()]
        while peek() == "and":
            take()
            xs.append(p_atom())
        return xs[0] if len(xs) == 1 else ("and", xs)

    def p_atom():
        t = take()
        if t == "(":
            n = p_or()
            take()   # ")"
            return n
        return ("k", t)

    node = p_or()
    if pos[0] != len(toks):
        raise ValueError(f"조건식 해석 실패: {expr}")
    return node


def eval_node(node, vals: dict):
    if node[0] == "k":
        return vals.get(node[1])
    xs = [eval_node(n, vals) for n in node[1]]
    return AND(*xs) if node[0] == "and" else OR(*xs)


# ── 지표 ──────────────────────────────────────────────────────────────────
def _ema_series(closes, p, seed, start_index):
    """closes 전체에 대한 지수이평. start_index = 이 목록 첫 봉의 전체 봉 번호(0부터). 봉 수가 p 미만인 자리는 None."""
    a, e, out = 2 / (p + 1), seed, []
    for k, x in enumerate(closes):
        if x is None:
            out.append(None)
            continue
        e = x if e is None else e + a * (x - e)
        out.append(e if start_index + k + 1 >= p else None)
    return out


def _sma_series(xs, p):
    out, s = [], 0.0
    for i, x in enumerate(xs):
        s += x
        if i >= p:
            s -= xs[i - p]
        out.append(s / p if i + 1 >= p else None)
    return out


def _bb_upper(xs, p, k):
    out = []
    for i in range(len(xs)):
        if i + 1 < p:
            out.append(None)
            continue
        w = xs[i + 1 - p:i + 1]
        m = sum(w) / p
        sd = (sum((x - m) ** 2 for x in w) / p) ** 0.5
        out.append(m + k * sd)
    return out


def _cross_up(x, up, i):
    """i번째 봉에서 x가 up을 아래에서 위로 뚫었나 (i-1 ≤, i >)."""
    try:
        a0, a1, b0, b1 = x[i - 1], x[i], up[i - 1], up[i]
    except IndexError:
        return False
    if a0 is None or a1 is None:
        return None
    if b0 is None or b1 is None:
        return False
    return a0 <= b0 and a1 > b1


class Day:
    """일봉 = 어제까지 WIN개 + 오늘 1개(현재가). 오늘 시가·고가·저가는 분봉을 받기 전엔 None."""

    def __init__(self, rec: dict, q: dict, today_ohl: tuple | None):
        o, h, l = today_ohl if today_ohl else (None, None, None)
        self.c = rec["c"] + [q["price"]]
        self.o = rec["o"] + [o]
        self.h = rec["h"] + [h]
        self.l = rec["l"] + [l]
        # 오늘 거래량·대금 None = 아직 모름(넥스트레이드 프리마켓 1차 — 네이버 시세엔 넥스트 거래량이 0으로 옴)
        self.v = rec["v"] + [q.get("volume") if "volume" in q else 0]
        self.val = [c * v for c, v in zip(rec["c"], rec["v"])] + [q.get("value") if "value" in q else 0]
        self.start = rec["n"] - len(rec["c"])          # 목록 첫 봉의 전체 봉 번호
        self.seed = rec["seed"]
        self._ema, self._ichi = {}, None

    def ema(self, p):
        if p not in self._ema:
            self._ema[p] = _ema_series(self.c, p, self.seed.get(str(p)), self.start)
        return self._ema[p]

    def e(self, p, i=-1):
        return self.ema(p)[i]

    def bb_up(self, p, k):
        key = ("bb", p, k)
        if key not in self._ema:
            self._ema[key] = _bb_upper(self.c, p, k)
        return self._ema[key]

    def sar(self):
        """파라볼릭 SAR(0.007·0.007·0.15) → [(sar, 오름세?)]. 오늘 고가·저가를 모르면 오늘 자리는 None."""
        if "sar" not in self._ema:
            n = len(self.c) if self.h[-1] is not None else len(self.c) - 1
            self._ema["sar"] = _sar(self.h[:n], self.l[:n]) + [None] * (len(self.c) - n)
        return self._ema["sar"]

    def span(self, which, i=-1):
        """일목균형표(9·26·52) 선행스팬 1·2 — i번째 봉 위치의 값(25봉 전에 계산된 값)."""
        j = len(self.c) + i - 25 if i < 0 else i - 25
        if j < 52:
            return None
        h, l = self.h, self.l

        def mid(n):
            hh, ll = h[j + 1 - n:j + 1], l[j + 1 - n:j + 1]
            if any(x is None for x in hh + ll):
                return None
            return (max(hh) + min(ll)) / 2
        if which == 1:
            t, k = mid(9), mid(26)
            return None if t is None or k is None else (t + k) / 2
        return mid(52)


def _m5_up(closes, kind, p, k):
    return _bb_upper(closes, p, k) if kind == "bb" else [None if s is None else s * (1 + k / 100) for s in _sma_series(closes, p)]


def _sar(h, l, af0=0.007, step=0.007, amax=0.15):
    """파라볼릭 SAR (와일더). 첫 봉은 오름세로 시작. [(sar, 오름세?)]"""
    out = []
    if not h:
        return out
    up, af, ep, s = True, af0, h[0], l[0]
    out.append((s, up))
    for i in range(1, len(h)):
        s = s + af * (ep - s)
        if up:
            s = min(s, l[i - 1], l[i - 2] if i >= 2 else l[i - 1])
            if l[i] < s:
                up, s, ep, af = False, ep, l[i], af0
            elif h[i] > ep:
                ep, af = h[i], min(af + step, amax)
        else:
            s = max(s, h[i - 1], h[i - 2] if i >= 2 else h[i - 1])
            if h[i] > s:
                up, s, ep, af = True, ep, h[i], af0
            elif l[i] < ep:
                ep, af = l[i], min(af + step, amax)
        out.append((s, up))
    return out


class M5:
    """5분봉 [(봉 번호, 시가, 고가, 저가, 종가, 거래량)] — 전 거래일(들) + 오늘. today_from = 오늘 첫 봉 위치."""

    def __init__(self, prev_bars, today_bars):
        bars = list(prev_bars) + list(today_bars)
        self.k = [b[0] for b in bars]
        self.o, self.h, self.l, self.c, self.v = ([b[i] for b in bars] for i in range(1, 6))
        self.today_from = len(prev_bars)
        self.prev = list(prev_bars)
        self._cache = {}

    def up(self, kind, p, k):
        key = (kind, p, k)
        if key not in self._cache:
            self._cache[key] = _m5_up(self.c, kind, p, k)
        return self._cache[key]

    def sma(self, p):
        key = ("sma", p)
        if key not in self._cache:
            self._cache[key] = _sma_series(self.c, p)
        return self._cache[key]

    def kijun(self, i=-1):
        """일목 기준선(26) — 최근 26봉 고가·저가 가운데."""
        j = len(self.c) + i if i < 0 else i
        if j + 1 < 26:
            return None
        return (max(self.h[j - 25:j + 1]) + min(self.l[j - 25:j + 1])) / 2

    def sar(self):
        if "sar" not in self._cache:
            self._cache["sar"] = _sar(self.h, self.l)
        return self._cache["sar"]


class Ctx:
    def __init__(self, code, name, q, d: Day, now_hm):
        self.code, self.name, self.q, self.d, self.now_hm = code, name, q, d, now_hm
        self.m5 = None          # M5 (전일 + 오늘 5분봉) — 2차에서 채움
        self.m1 = None          # 오늘 1분봉 [(분 번호, 시가, 고가, 저가, 종가, 그 1분 거래량)]
        self.fin = None         # 재무 {sales(억), icr, debt, reserve, per} — 3차에서 채움
        self.same_ratio = None  # 오늘 누적 거래량 ÷ 전일 같은 시각 누적 거래량
        self.k = None           # {"status": {...}, "cttr": 체결강도, "ask_ratio": 매도잔량비율} — 3차에서 채움
        self.m_rank = None      # 전일 동시간 대비 거래량 증가율 상위 1000 집합

    def m5_cross(self, kind, p, k, back=0):
        if self.m5 is None:
            return None
        return _cross_up(self.m5.c, self.m5.up(kind, p, k), len(self.m5.c) - 1 - back)

    def status_ok(self, kinds):
        if self.k is None or self.k.get("status") is None:
            return None
        return not any(self.k["status"].get(x) for x in kinds)

    def kval(self, key):
        return None if self.k is None else self.k.get(key)


# ── 프리셋 (사용자 조건검색식 원문 그대로, 11-26) ─────────────────────────────
_EX_BASE = ("정리매매", "관리", "투자위험", "투자경고", "거래정지", "환기")
_EX_WARN = _EX_BASE + ("투자주의",)


def _avg(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def _no_spac(c):
    return "스팩" not in (c.name or "")


def _ddeok(env=2.5, pid="ddeok", alias="떡상이", name="시가급등"):
    ev = f"{env:g}"
    C = {
        "A": ("5분봉 종가가 볼린저(45·2) 윗줄 상향 돌파", lambda c: c.m5_cross("bb", 45, 2)),
        "B": ("5분봉 종가가 볼린저(55·2) 윗줄 상향 돌파", lambda c: c.m5_cross("bb", 55, 2)),
        "C": (f"5분봉 종가가 엔벨로프(13·{ev}%) 윗줄 상향 돌파", lambda c: c.m5_cross("env", 13, env)),
        "D": (f"5분봉 종가가 엔벨로프(22·{ev}%) 윗줄 상향 돌파", lambda c: c.m5_cross("env", 22, env)),
        "E": ("직전 5분봉 종가가 볼린저(45·2) 윗줄 상향 돌파", lambda c: c.m5_cross("bb", 45, 2, 1)),
        "F": ("직전 5분봉 종가가 볼린저(55·2) 윗줄 상향 돌파", lambda c: c.m5_cross("bb", 55, 2, 1)),
        "G": (f"직전 5분봉 종가가 엔벨로프(13·{ev}%) 윗줄 상향 돌파", lambda c: c.m5_cross("env", 13, env, 1)),
        "H": (f"직전 5분봉 종가가 엔벨로프(22·{ev}%) 윗줄 상향 돌파", lambda c: c.m5_cross("env", 22, env, 1)),
        "I": ("오늘 거래량 5만 주 이상", lambda c: c.d.v[-1] >= 50_000),
        "J": ("체결강도 100% ~ 1,000%", lambda c: within(c.kval("cttr"), 100, 1000)),
        "M": ("제외: 정리매매·관리·투자위험·투자경고·거래정지·환기", lambda c: c.status_ok(_EX_BASE)),
        "N": ("우선주 제외 (보통주만)", lambda c: True),
        "O": ("ETF·ETN·스팩 제외", _no_spac),
    }
    return {"id": pid, "name": name, "alias": alias, "kind": "단타", "tag": "급등 포착",
            "title": (f"5분봉이 볼린저 밴드·엔벨로프({ev}%) 윗줄을 한꺼번에 뚫으며 막 오르기 시작한 종목" if env != 2.5 else
                      "5분봉이 볼린저 밴드·엔벨로프 윗줄을 한꺼번에 뚫고, 거래량과 사는 힘이 붙어 지금 급등 중인 종목"),
            "expr": "((A and B and C and D) or (E and F and G and H)) and I and J and M and N and O",
            "conds": C, "kis": ("status", "cttr"), "cap": 500}


def _odol():
    def D(c):   # 어제 기준 최근 4일 내내 종가 ≤ 지수5이평
        e5 = c.d.ema(5)
        return all_of([None if e5[i] is None else c.d.c[i] <= e5[i] for i in range(-5, -1)])

    def L(c):   # 최근 5분봉 5개 안에 한 번이라도 종가가 엔벨로프(20·2.5%) 윗줄 상향 돌파
        if c.m5 is None:
            return None
        up, n = c.m5.up("env", 20, 2.5), len(c.m5.c)
        return any_of([_cross_up(c.m5.c, up, n - 1 - b) for b in range(5)])

    def o_cross(c, p):   # 시가가 지수이평을 상향 돌파 (어제 시가 ≤ 어제 이평, 오늘 시가 > 오늘 이평)
        e = c.d.ema(p)
        return _cross_up(c.d.o, e, len(c.d.c) - 1)

    C = {
        "A": ("제외: 정리매매·관리·투자위험·투자경고·투자주의·거래정지·환기", lambda c: c.status_ok(_EX_WARN)),
        "B": ("보통주", lambda c: True),
        "C": ("ETF·ETN·스팩 제외", _no_spac),
        "D": ("어제 기준 최근 4일 내내 종가 ≤ 5일선(지수)", D),
        "E": ("시가가 5일선(지수)을 상향 돌파", lambda c: o_cross(c, 5)),
        "F": ("종가가 5일선(지수)을 상향 돌파", lambda c: _cross_up(c.d.c, c.d.ema(5), len(c.d.c) - 1)),
        "G": ("종가가 15일선(지수)을 상향 돌파", lambda c: _cross_up(c.d.c, c.d.ema(15), len(c.d.c) - 1)),
        "H": ("오늘 시가 > 어제 고가", lambda c: gt(c.d.o[-1], c.d.h[-2])),
        "I": ("양봉 (시가 ≤ 종가)", lambda c: None if c.d.o[-1] is None else c.d.o[-1] <= c.d.c[-1]),
        "J": ("5·20·60일선(지수) 역배열", lambda c: None if c.d.e(60) is None else c.d.e(5) < c.d.e(20) < c.d.e(60)),
        "K": ("어제 기준 5일 평균 거래대금 3억 원 이상", lambda c: (_avg(c.d.val[-6:-1]) or 0) >= 3e8),
        "L": ("최근 5분봉 5개 안 엔벨로프(20·2.5%) 윗줄 상향 돌파", L),
        "M": ("전일 같은 시각 대비 거래량 증가율 상위 1,000", lambda c: None if c.m_rank is None else c.code in c.m_rank),
        "N": ("오늘 거래량 ≥ 어제의 50%", lambda c: c.d.v[-1] >= 0.5 * c.d.v[-2]),
        "O": ("9:00 ~ 10:30 사이", lambda c: 540 <= c.now_hm <= 630),
        "P": ("오늘 거래량 ≥ 어제의 80%", lambda c: c.d.v[-1] >= 0.8 * c.d.v[-2]),
    }
    return {"id": "odol", "name": "5일선 강한 반등", "alias": "오돌이", "kind": "단타", "tag": "저점 반등",
            "title": "며칠(최근 4일) 5일선 아래에서 내리던 종목이 오늘 5일선이나 15일선을 다시 뚫고 양봉으로 반등한 순간",
            "expr": "A and B and C and D and (E or F or G or H) and I and J and K and L and (M or (N and O) or P)",
            "conds": C, "kis": ("status",), "cap": 300, "mrank": True}


def _dayup():
    def conv(c):   # 지수 112·112·224 이평 간 수렴도 = (가장 큰 값 − 가장 작은 값) ÷ 가장 작은 값
        a, b = c.d.e(112), c.d.e(224)
        if a is None or b is None:
            return False
        return within((max(a, b) - min(a, b)) / min(a, b) * 100, 5, 20)

    C = {
        "A": ("어제 기준 5일 평균 거래량 5만 주 이상", lambda c: (_avg(c.d.v[-6:-1]) or 0) >= 50_000),
        "B": ("어제 기준 5일 평균 거래대금 5억 원 이상", lambda c: (_avg(c.d.val[-6:-1]) or 0) >= 5e8),
        "C": ("112·224·448일선(지수) 역배열", lambda c: None if c.d.e(448) is None else c.d.e(112) < c.d.e(224) < c.d.e(448)),
        "D": ("112일선과 224일선 간격 5% ~ 20%", conv),
        "E": ("20일선 < 60일선 (지수)", lambda c: None if c.d.e(60) is None else c.d.e(20) < c.d.e(60)),
        "F": ("종가 ≥ 5일선 (지수)", lambda c: None if c.d.e(5) is None else c.d.c[-1] >= c.d.e(5)),
        "G": ("시가가 어제 종가보다 2% ~ 10% 높음 (갭 상승)", lambda c: within(pct(c.d.o[-1], c.d.c[-2]), 2, 10)),
        "H": ("종가가 시가보다 4% ~ 12% 높음 (양봉)", lambda c: within(pct(c.d.c[-1], c.d.o[-1]), 4, 12)),
        "I": ("거래량이 어제 같은 시각의 200% 이상", lambda c: None if c.same_ratio is None else c.same_ratio >= 2.0),
        "J": ("오늘 거래량 ≥ 어제 하루 거래량의 40%", lambda c: c.d.v[-1] >= 0.4 * c.d.v[-2]),
        "K": ("체결강도 100% 이상", lambda c: None if c.kval("cttr") is None else c.kval("cttr") >= 100),
        "L": ("매도잔량비율 120% 이상 (매도 잔량 ÷ 매수 잔량)", lambda c: None if c.kval("ask_ratio") is None else c.kval("ask_ratio") >= 120),
        "M": ("제외: 정리매매·관리·투자위험·투자경고·투자주의·거래정지·환기·단기과열", lambda c: c.status_ok(_EX_WARN + ("단기과열",))),
        "N": ("보통주", lambda c: True),
        "O": ("ETF·ETN 제외", lambda c: True),
    }
    return {"id": "dayup", "name": "바닥 갭상승", "alias": "DayUp 오돌이", "kind": "단타", "tag": "저점 반등",
            "title": "긴 평균선이 아직 내림세(바닥 구간)인데, 오늘 갭 상승이나 큰 양봉으로 거래량을 싣고 튀어 오른 종목",
            "expr": "(A or B) and C and D and E and F and (G or H) and (I or J) and K and L and M and N and O",
            "conds": C, "kis": ("status", "cttr", "book"), "cap": 300}


def _ymgp():
    def big_high(c, base):   # 최근 50일 안에 한 번이라도 고가가 (전날 종가 | 그날 시가)보다 12% ~ 30% 높음
        d, n = c.d, len(c.d.c)
        xs = []
        for i in range(n - 50, n):
            ref = d.c[i - 1] if base == "prev" else d.o[i]
            xs.append(within(pct(d.h[i], ref), 12, 30))
        return any_of(xs)

    def rev50(c, a, b, cc):   # 최근 50일 내내 a < b < cc (지수이평 역배열)
        ea, eb, ec = c.d.ema(a), c.d.ema(b), c.d.ema(cc)
        n = len(c.d.c)
        if ec[n - 50] is None:
            return False
        return all_of([ea[i] < eb[i] < ec[i] for i in range(n - 50, n)])

    def bb_high(c):   # 최근 10일 안에 한 번이라도 고가가 볼린저(40·2) 윗줄 상향 돌파
        up, n = c.d.bb_up(40, 2), len(c.d.c)
        return any_of([_cross_up(c.d.h, up, i) for i in range(n - 10, n)])

    def near(c, p, lo, hi):
        e = c.d.e(p)
        return False if e is None else within(c.d.c[-1] / e * 100, lo, hi)

    def above(c, p):
        e = c.d.e(p)
        return False if e is None else c.d.c[-1] > e

    C = {
        "A": ("제외: 정리매매·관리·투자위험·투자경고·거래정지·환기", lambda c: c.status_ok(_EX_BASE)),
        "B": ("보통주", lambda c: True),
        "C": ("ETF·ETN·스팩 제외", _no_spac),
        "D": ("최근 50일 안 고가가 전날 종가보다 12% ~ 30% 높았던 날", lambda c: big_high(c, "prev")),
        "E": ("최근 50일 안 고가가 그날 시가보다 12% ~ 30% 높았던 날", lambda c: big_high(c, "open")),
        "F": ("최근 50일 내내 112·224·448일선(지수) 역배열", lambda c: rev50(c, 112, 224, 448)),
        "G": ("최근 50일 내내 224·448·600일선(지수) 역배열", lambda c: rev50(c, 224, 448, 600)),
        "H": ("5일선 > 20일선", lambda c: c.d.e(5) > c.d.e(20) if c.d.e(20) is not None else False),
        "I": ("5일선 > 60일선", lambda c: c.d.e(5) > c.d.e(60) if c.d.e(60) is not None else False),
        "J": ("20일선 > 60일선", lambda c: c.d.e(20) > c.d.e(60) if c.d.e(60) is not None else False),
        "K": ("종가 < 448일선", lambda c: False if c.d.e(448) is None else c.d.c[-1] < c.d.e(448)),
        "L": ("현재가가 20일선의 90% ~ 110%", lambda c: near(c, 20, 90, 110)),
        "M": ("현재가가 112일선의 85% ~ 115%", lambda c: near(c, 112, 85, 115)),
        "N": ("종가 > 60일선", lambda c: above(c, 60)),
        "O": ("현재가가 224일선의 85% ~ 115%", lambda c: near(c, 224, 85, 115)),
        "P": ("종가 > 112일선", lambda c: above(c, 112)),
        "Q": ("종가 > 일목 선행스팬1 (9·26·52)", lambda c: gt(c.d.c[-1], c.d.span(1))),
        "R": ("종가 > 일목 선행스팬2 (9·26·52)", lambda c: gt(c.d.c[-1], c.d.span(2))),
        "S": ("최근 10일 안 고가가 볼린저(40·2) 윗줄 상향 돌파", bb_high),
        "T": ("최근 10일 평균 거래대금 10억 원 이상 (오늘 포함)", lambda c: (_avg(c.d.val[-10:]) or 0) >= 1e9),
        "U": ("종가가 시가보다 0% ~ 30% 높음 (양봉)", lambda c: within(pct(c.d.c[-1], c.d.o[-1]), 0, 30)),
    }
    return {"id": "ymgp", "name": "역매공파", "alias": "역매공파1", "kind": "스윙", "tag": "장기 저평가 추세전환",
            "title": "50일 내내 긴 평균선이 내림세였던 바닥에서, 짧은 선들이 오름세로 돌아서고 구름대 위로 올라선 종목",
            "expr": "A and B and C and (D or E) and (F or G) and (H or I or J) and K and L and ((M and N) or (O and P)) "
                    "and (Q or R) and S and T and U",
            "conds": C, "kis": ("status",), "cap": 300}


def _cross_dn(a, b, i):
    """i번째 봉에서 a가 b를 위에서 아래로 뚫었나."""
    try:
        a0, a1, b0, b1 = a[i - 1], a[i], b[i - 1], b[i]
    except IndexError:
        return False
    if None in (a0, a1, b0, b1):
        return False
    return a0 >= b0 and a1 < b1


def _gap(a, b):
    """두 이평 사이 수렴도 % = (큰 값 − 작은 값) ÷ 작은 값."""
    return None if a is None or b is None else (max(a, b) - min(a, b)) / min(a, b) * 100


def _high_jump(c, lo, hi, n, skip_today=False):
    """최근 n봉 안에 한 번이라도 고가가 전날 종가보다 lo% ~ hi% 높았나 (skip_today면 어제부터 n봉)."""
    d, end = c.d, len(c.d.c) - (1 if skip_today else 0)
    return any_of([within(pct(d.h[i], d.c[i - 1]), lo, hi) for i in range(end - n, end)])


def _odol2():
    def dead5(c):   # 최근 5봉 안에 5일선이 20일선을 아래로 뚫음(데드크로스) → 이런 종목은 뺀다
        e5, e20, n = c.d.ema(5), c.d.ema(20), len(c.d.c)
        return not any(_cross_dn(e5, e20, i) for i in range(n - 5, n))

    def kijun_cross(c):
        if c.m5 is None:
            return None
        n = len(c.m5.c)
        k0, k1 = c.m5.kijun(-2), c.m5.kijun(-1)
        return None if k0 is None or k1 is None else c.m5.c[n - 2] <= k0 and c.m5.c[n - 1] > k1

    def kijun_above(c):
        if c.m5 is None:
            return None
        k = c.m5.kijun(-1)
        return None if k is None else c.m5.c[-1] >= k

    def min_value(c):   # 최근 1분봉 5개 안에 한 번이라도 1분 거래대금 1,000만 원 이상
        if c.m1 is None:
            return None
        rows = c.m1
        vals = [r[5] * r[4] for r in rows[-5:]]
        return any(v >= 1e7 for v in vals[-5:])

    def env3(c):
        if c.m5 is None:
            return None
        up, n = c.m5.up("env", 20, 2.5), len(c.m5.c)
        return any_of([_cross_up(c.m5.c, up, n - 1 - b) for b in range(3)])

    C = {
        "A": ("종가가 5일선(지수)을 상향 돌파", lambda c: _cross_up(c.d.c, c.d.ema(5), len(c.d.c) - 1)),
        "B": ("종가가 20일선(지수)을 상향 돌파", lambda c: _cross_up(c.d.c, c.d.ema(20), len(c.d.c) - 1)),
        "C": ("어제 기준 5일선 ≤ 60일선 (지수)", lambda c: False if c.d.e(60, -2) is None else c.d.e(60, -2) >= c.d.e(5, -2)),
        "D": ("전일 같은 시각 대비 거래량 증가율 상위 1,000", lambda c: None if c.m_rank is None else c.code in c.m_rank),
        "E": ("최근 5일 안 5일선이 20일선 아래로 뚫음(데드크로스) 제외", dead5),
        "F": ("종가 ≤ 112일선 (지수)", lambda c: False if c.d.e(112) is None else c.d.e(112) >= c.d.c[-1]),
        "G": ("20일선과 60일선 간격 5% 이상", lambda c: (_gap(c.d.e(20), c.d.e(60)) or 0) >= 5),
        "H": ("5분봉 종가가 일목 기준선(26)을 상향 돌파", kijun_cross),
        "I": ("5분봉 종가 ≥ 일목 기준선(26)", kijun_above),
        "J": ("5일 평균 거래대금 5,000만 원 이상 (오늘 포함)", lambda c: (_avg(c.d.val[-5:]) or 0) >= 5e7),
        "K": ("양봉 (시가 ≤ 종가)", lambda c: None if c.d.o[-1] is None else c.d.o[-1] <= c.d.c[-1]),
        "L": ("최근 1분봉 5개 안 1분 거래대금 1,000만 원 이상", min_value),
        "M": ("오늘 거래량 ≥ 어제의 50%", lambda c: c.d.v[-1] >= 0.5 * c.d.v[-2]),
        "N": ("최근 5분봉 3개 안 엔벨로프(20·2.5%) 윗줄 상향 돌파", env3),
        "O": ("제외: 정리매매·관리·거래정지·환기", lambda c: c.status_ok(("정리매매", "관리", "거래정지", "환기"))),
        "P": ("보통주", lambda c: True),
        "Q": ("ETF·ETN·스팩 제외", _no_spac),
    }
    return {"id": "odol2", "name": "5일선 반등(중대장)", "alias": "오돌이(중대장)", "kind": "단타", "tag": "저점 반등",
            "title": "5일선이 아직 60일선 아래인 저점 구간에서, 거래량을 싣고 종가가 5일선이나 20일선을 위로 뚫으며 5분봉에서도 힘이 붙는 종목",
            "expr": "(A or B) and C and D and E and F and G and (H or I) and J and K and L and M and N and O and P and Q",
            "conds": C, "kis": ("status",), "cap": 300, "mrank": True}


def _ymgp224():
    def rev(c, a, b, lo, hi):   # 봉 범위 [n-lo, n-hi) 내내 a선 < b선
        ea, eb, n = c.d.ema(a), c.d.ema(b), len(c.d.c)
        if n - lo < 0 or eb[n - lo] is None:
            return False
        return all(ea[i] < eb[i] for i in range(n - lo, n - hi))

    def near_bb(c):   # 종가가 볼린저(40·2) 윗줄보다 7% 아래 ~ 3% 위
        up = c.d.bb_up(40, 2)[-1]
        return False if up is None else within(pct(c.d.c[-1], up), -7, 3)

    C = {
        "A": ("112·224·448일선(지수) 역배열", lambda c: False if c.d.e(448) is None else c.d.e(112) < c.d.e(224) < c.d.e(448)),
        "B": ("최근 50일 내내 224일선 < 448일선", lambda c: rev(c, 224, 448, 50, 0)),
        "C": ("50일 전 기준 최근 50일 내내 224일선 < 448일선", lambda c: rev(c, 224, 448, 100, 50)),
        "D": ("어제 기준 최근 50일 안 고가가 전날 종가보다 15% ~ 30% 높았던 날", lambda c: _high_jump(c, 15, 30, 50, True)),
        "E": ("종가 > 224일선", lambda c: False if c.d.e(224) is None else c.d.c[-1] > c.d.e(224)),
        "F": ("현재가가 224일선의 100% ~ 105%", lambda c: False if c.d.e(224) is None else within(c.d.c[-1] / c.d.e(224) * 100, 100, 105)),
        "G": ("종가 < 448일선", lambda c: False if c.d.e(448) is None else c.d.c[-1] < c.d.e(448)),
        "H": ("5일선 > 60일선", lambda c: False if c.d.e(60) is None else c.d.e(5) > c.d.e(60)),
        "I": ("종가가 볼린저(40·2) 윗줄의 −7% ~ +3%", near_bb),
        "J": ("어제 기준 10일 평균 거래대금 5억 원 이상", lambda c: (_avg(c.d.val[-11:-1]) or 0) >= 5e8),
        "K": ("제외: 정리매매·관리·투자위험·투자경고·투자주의·거래정지·환기", lambda c: c.status_ok(_EX_WARN)),
        "L": ("보통주", lambda c: True),
        "M": ("ETF·ETN·스팩 제외", _no_spac),
    }
    return {"id": "ymgp224", "name": "역매공파 224", "alias": "역매공파224", "kind": "스윙", "tag": "1년선 추세전환",
            "title": "긴 평균선이 내림세로 늘어선 바닥 구간에서, 종가가 224일선을 막 넘어 그 바로 위에 있는 종목",
            "expr": "A and B and C and D and E and F and G and H and I and J and K and L and M", "conds": C,
            "kis": ("status",), "cap": 300}


def _sjfilter():
    def cross20(c):   # 최근 20일 안에 5일선이 112일선을 상향 돌파(골든크로스)
        e5, e112, n = c.d.ema(5), c.d.ema(112), len(c.d.c)
        return any(_cross_up(e5, e112, i) is True for i in range(n - 20, n))

    def per(c):
        f = c.fin
        if f is None:
            return None
        return False if not f.get("eps") or f["eps"] <= 0 else within(c.d.c[-1] / f["eps"], 0, 50)

    def fv(key, test):
        def g(c):
            if c.fin is None:
                return None
            v = c.fin.get(key)
            return False if v is None else test(v)
        return g

    C = {
        "A": ("5일선 ≥ 112일선 (지수)", lambda c: False if c.d.e(112) is None else c.d.e(5) >= c.d.e(112)),
        "B": ("최근 20일 안 5일선이 112일선 상향 돌파(골든크로스)", cross20),
        "C": ("112일선 < 500일선", lambda c: False if c.d.e(500) is None else c.d.e(112) < c.d.e(500)),
        "D": ("종가가 20일선보다 −5% ~ +15%", lambda c: within(pct(c.d.c[-1], c.d.e(20)), -5, 15)),
        "E": ("종가가 224일선보다 −15% ~ +15%", lambda c: False if c.d.e(224) is None else within(pct(c.d.c[-1], c.d.e(224)), -15, 15)),
        "F": ("최근 50일 안 고가가 전날 종가보다 15% ~ 30% 높았던 날", lambda c: _high_jump(c, 15, 30, 50)),
        "G": ("종가가 볼린저(40·2) 윗줄의 −7% ~ +7%", lambda c: False if c.d.bb_up(40, 2)[-1] is None else within(pct(c.d.c[-1], c.d.bb_up(40, 2)[-1]), -7, 7)),
        "J": ("시가총액 1,000억 원 이상", lambda c: (c.q.get("market_cap") or 0) >= 1e11),
        "K": ("매출액 300억 원 이상 (최근 연간, 연결)", fv("sales", lambda v: v >= 300)),
        "L": ("이자보상배율 1배 이상 (영업이익 ÷ 이자 지급, DART 근사)", fv("icr", lambda v: v >= 1)),
        "M": ("부채비율 200% 이하", fv("debt", lambda v: v <= 200)),
        "N": ("유보율 300% 이상", fv("reserve", lambda v: v >= 300)),
        "O": ("PER 0 ~ 50배 (현재가 ÷ 최근 연간 EPS)", per),
        "P": ("제외: 정리매매·관리·투자위험·투자경고·거래정지·환기", lambda c: c.status_ok(_EX_BASE)),
        "Q": ("보통주", lambda c: True),
        "R": ("ETF·ETN·스팩 제외", _no_spac),
    }
    return {"id": "sjfilter", "name": "매집봉 이평돌파(재무)", "alias": "스중필터링안정화", "kind": "스윙", "tag": "매집봉 이평돌파",
            "title": "최근 50일 안에 큰 상승봉이 나온 뒤, 5일선이 112일선 위로 올라서 볼린저 윗줄 근처로 오는 종목 — 재무가 좋은 종목만",
            "expr": "(A or B) and C and D and E and F and G and J and K and L and M and N and O and P and Q and R",
            "conds": C, "kis": ("status",), "cap": 300, "fin": True,
            "notes": ["재무: 네이버 연간(최근 확정 연도) · 이자보상배율은 DART 영업이익 ÷ 이자 지급(현금흐름표) 근사 · PER = 현재가 ÷ 최근 연간 EPS"]}


def _pkj():
    def sar3(c):   # 최근 3일 안에 SAR 오름세가 1번 이상 이어진 날
        s, n = c.d.sar(), len(c.d.c)
        xs = []
        for i in range(n - 3, n):
            if s[i] is None or s[i - 1] is None:
                xs.append(None)
            else:
                xs.append(s[i][1] and s[i - 1][1])
        return any_of(xs)

    def bb_high(c):
        up, n = c.d.bb_up(40, 2), len(c.d.c)
        return any_of([_cross_up(c.d.h, up, i) for i in range(n - 10, n)])

    def rising(c, p):
        a, b = c.d.e(p, -1), c.d.e(p, -2)
        return False if a is None or b is None else a > b

    C = {
        "A": ("제외: 정리매매·관리·투자위험·거래정지·환기", lambda c: c.status_ok(("정리매매", "관리", "투자위험", "거래정지", "환기"))),
        "B": ("보통주", lambda c: True),
        "C": ("ETF·ETN·스팩 제외", _no_spac),
        "D": ("최근 3일 안 파라볼릭 SAR(0.007·0.007·0.15) 오름세 유지", sar3),
        "E": ("최근 40일 안 고가가 전날 종가보다 10% ~ 30% 높았던 날", lambda c: _high_jump(c, 10, 30, 40)),
        "F": ("최근 10일 안 고가가 볼린저(40·2) 윗줄 상향 돌파", bb_high),
        "G": ("현재가가 112일선의 100% ~ 107%", lambda c: False if c.d.e(112) is None else within(c.d.c[-1] / c.d.e(112) * 100, 100, 107)),
        "H": ("현재가가 224일선의 95% ~ 105%", lambda c: False if c.d.e(224) is None else within(c.d.c[-1] / c.d.e(224) * 100, 95, 105)),
        "J": ("224일선 ≤ 448일선", lambda c: False if c.d.e(448) is None else c.d.e(224) <= c.d.e(448)),
        "K": ("종가 > 20일선", lambda c: c.d.c[-1] > c.d.e(20)),
        "L": ("20일선 오르는 중 (전날보다 높음)", lambda c: rising(c, 20)),
        "M": ("150일선 오르는 중 (전날보다 높음)", lambda c: rising(c, 150)),
        "N": ("어제 기준 5일 평균 거래대금 3억 원 이상", lambda c: (_avg(c.d.val[-6:-1]) or 0) >= 3e8),
    }
    return {"id": "pkj", "name": "SAR 매집봉 이평돌파", "alias": "파캔장", "kind": "스윙", "tag": "매집봉 이평돌파",
            "title": "파라볼릭 SAR이 오름세로 돌아서고 20일선·150일선이 오르는 중이며, 112일선이나 224일선 근처에 있는 종목",
            "expr": "A and B and C and D and E and F and (G or H) and J and K and L and M and N", "conds": C,
            "kis": ("status",), "cap": 300}


def _force5():
    def same_bar(c):   # 지금 5분봉 거래량 ≥ 전 거래일 같은 시각 5분봉의 150%
        m = c.m5
        if m is None or m.today_from >= len(m.c):
            return None
        k, v = m.k[-1], m.v[-1]
        prev_day = [b for b in m.prev if b[0] == k]
        return False if not prev_day or not prev_day[-1][5] else v >= 1.5 * prev_day[-1][5]

    def vol40(c):
        m = c.m5
        if m is None or len(m.v) < 40:
            return None if m is None else False
        avg = sum(m.v[-40:]) / 40
        return avg > 0 and m.v[-1] >= 1.5 * avg

    def s224(c, mode):
        m = c.m5
        if m is None:
            return None
        s, n = m.sma(224), len(m.c)
        if s[-1] is None:
            return False
        if mode == "above":
            return m.c[-1] >= s[-1]
        if mode == "cross":
            return _cross_up(m.c, s, n - 1)
        if mode == "cross5":
            return any(_cross_up(m.c, s, i) is True for i in range(n - 5, n))
        return m.c[-1] / s[-1] * 100 <= 104

    def bbh(c):
        if c.m5 is None:
            return None
        return _cross_up(c.m5.h, c.m5.up("bb", 40, 2.2), len(c.m5.c) - 1)

    def sar(c):
        if c.m5 is None:
            return None
        return c.m5.sar()[-1][0] < c.m5.c[-1]

    C = {
        "A": ("제외: 정리매매·관리·거래정지·환기", lambda c: c.status_ok(("정리매매", "관리", "거래정지", "환기"))),
        "B": ("보통주", lambda c: True),
        "C": ("ETF·ETN 제외", lambda c: True),
        "D": ("오늘 거래량 3만 주 이상", lambda c: c.d.v[-1] >= 30_000),
        "E": ("5일 평균 거래량 7만 주 이상 (오늘 포함)", lambda c: (_avg(c.d.v[-5:]) or 0) >= 70_000),
        "F": ("어제 기준 5일 평균 거래대금 5억 원 이상", lambda c: (_avg(c.d.val[-6:-1]) or 0) >= 5e8),
        "G": ("지금 5분봉 거래량 ≥ 전 거래일 같은 시각 5분봉의 150%", same_bar),
        "H": ("지금 5분봉 거래량 ≥ 최근 5분봉 40개 평균의 150%", vol40),
        "I": ("5분봉 종가 ≥ 5분봉 224선(단순)", lambda c: s224(c, "above")),
        "J": ("5분봉 종가가 5분봉 224선을 상향 돌파", lambda c: s224(c, "cross")),
        "K": ("최근 5분봉 5개 안 224선 상향 돌파", lambda c: s224(c, "cross5")),
        "L": ("5분봉 종가가 224선의 104% 이하", lambda c: s224(c, "gap")),
        "M": ("5분봉 고가가 볼린저(40·2.2) 윗줄 상향 돌파", bbh),
        "N": ("5분봉 파라볼릭 SAR < 종가 (오름세)", sar),
    }
    return {"id": "force5", "name": "5분봉 강지 세력주", "alias": "5분봉강지세력주", "kind": "단타", "tag": "세력주",
            "title": "5분봉에서 거래량이 1.5배 이상 터지며 5분봉 224선 위로 올라서고 볼린저 윗줄을 뚫은 순간",
            "expr": "A and B and C and D and E and F and G and H and (I or J or K) and L and M and N", "conds": C,
            "kis": ("status",), "cap": 300, "deep": True,
            "notes": ["5분봉 224선은 전 3거래일 + 오늘 5분봉으로 계산"]}


def _gapup():
    C = {
        "A": ("제외: 정리매매·관리·투자위험·투자경고·거래정지", lambda c: c.status_ok(("정리매매", "관리", "투자위험", "투자경고", "거래정지"))),
        "B": ("보통주", lambda c: True),
        "C": ("ETF·ETN·스팩 제외", _no_spac),
        "D": ("어제 종가가 그 전날 종가보다 5% 이상 높음", lambda c: (c.gap["yday"] or 0) >= 5),
        "E": ("오늘 첫 체결가(시초가)가 어제 종가보다 2% 이상 높음", lambda c: None if c.gap.get("open") is None else (pct(c.gap["open"], c.gap["base"]) or 0) >= 2),
    }
    return {"id": "gapup", "name": "시초가 갭 상승", "alias": "시초가 갭상승", "kind": "단타", "tag": "시초가 갭 상승(전날 급등 이어짐)",
            "title": "어제 5% 넘게 오른 종목이 오늘 아침 첫 가격(시초가)도 어제 종가보다 2% 넘게 높게 시작한 종목",
            "expr": "A and B and C and D and E", "conds": C, "kis": ("status",), "cap": 300,
            "window": "08:00~15:30 (10분마다)",
            "notes": ["시초가 = 오늘 첫 체결가 — 넥스트레이드 종목은 08:00 넥스트 첫 체결(KIS 넥스트 시가), 아닌 종목은 09:00 정규장 시가(네이버 1분봉)"]}


def _pre():
    C = {
        "A": ("제외: 정리매매·관리·투자위험·투자경고·거래정지", lambda c: c.status_ok(("정리매매", "관리", "투자위험", "투자경고", "거래정지"))),
        "B": ("보통주", lambda c: True),
        "C": ("ETF·ETN·스팩 제외", _no_spac),
        "D": ("장 시작 예상체결 거래량 5만 주 이상", lambda c: c.pre["vol"] >= 50_000),
        "E": ("장 시작 예상체결 금액 1,000만 원 이상", lambda c: c.pre["vol"] * c.pre["price"] >= 1e7),
        "F": ("예상체결가가 기준가(어제 종가)보다 높음", lambda c: c.pre["price"] > c.pre["base"] > 0),
        "G": ("예상체결가가 어제 종가보다 2% 이상 높음", lambda c: (pct(c.pre["price"], c.pre["base"]) or 0) >= 2),
    }
    return {"id": "pre", "name": "시가급등예상", "alias": "시가급등예상", "kind": "단타", "tag": "장전 수급 유입",
            "title": "장 시작 전 동시호가에서 예상 체결 가격이 어제 종가보다 높게 잡히고, 거래량·금액도 모인 종목",
            "expr": "A and B and C and D and E and (F or G)", "conds": C, "kis": ("status",), "cap": 60,
            "window": "08:30~09:00 (2분마다)"}


PRESETS = [_pre(), _gapup(), _ddeok(), _ddeok(2.0, "ddeok2", "떡상이 마이너스", "시가급등 2%"), _odol(), _odol2(), _dayup(),
           _force5(), _ymgp(), _ymgp224(), _sjfilter(), _pkj()]
_INTRADAY = [p for p in PRESETS if p["id"] not in ("pre", "gapup")]
for _p in PRESETS:
    _p["node"] = compile_expr(_p["expr"])


def presets_public() -> list[dict]:
    return [{"id": p["id"], "name": p["name"], "alias": p["alias"], "kind": p["kind"], "tag": p["tag"],
             "title": p["title"], "expr": p["expr"], "window": p.get("window", "08:03~08:48 넥스트 프리마켓 · 09:00~15:30 정규장 (5분마다)"), "conds": [{"key": k, "label": v[0]} for k, v in p["conds"].items()]}
            for p in PRESETS]


# ── 종목 구분 ──────────────────────────────────────────────────────────────
_PREF = re.compile(r"우[A-Z]?$|우\(전환\)$")


def is_common(code: str, name: str, kind: str) -> bool:
    """보통주인가 — ETF·ETN 아님, 우선주(코드 끝자리 0 아님 또는 이름이 '우'로 끝남) 아님. 스팩은 프리셋별로 뺀다."""
    return kind == "stock" and len(code) == 6 and code[-1] == "0" and not _PREF.search(name or "")


# ── 아침 데이터 받기 ────────────────────────────────────────────────────────
_lock = threading.Lock()
DAILY: dict = {}        # {"loaded": 날짜, "prev_day": 전 거래일, "stocks": {code: rec}}
LOAD = {"state": "없음", "done": 0, "total": 0, "started": None, "finished": None}


def now_kst() -> datetime:
    return datetime.now(KST)


def _minutes(code: str, day: str, last: int = 390) -> list[tuple]:
    """네이버 1분봉 (그날 09:00~15:30 KRX, last=660이면 넥스트 애프터 ~20:00까지) → [(분 번호 0=09:00, 시가, 고가, 저가, 종가, 그 1분 거래량)].
    08시대 넥스트 프리마켓 구간은 네이버에 없다(11-27 확인)."""
    d = day.replace("-", "")
    end = f"{(540 + last) // 60:02d}{(540 + last) % 60:02d}"
    r = requests.get(_MIN_URL.format(code=code, d=d, end=end), headers=df._NAVER_RT_HEADERS, timeout=10)
    r.raise_for_status()
    out = []
    for x in r.json() or []:
        t = str(x.get("localDateTime") or "")
        if t[:8] != d:
            continue
        hm = int(t[8:10]) * 60 + int(t[10:12]) - 540
        if not 0 <= hm <= last:
            continue
        c = x.get("currentPrice")
        if not c:
            continue
        out.append((hm, x.get("openPrice") or c, x.get("highPrice") or c, x.get("lowPrice") or c, c,
                    int(x.get("accumulatedTradingVolume") or 0)))
    return out


def _to_m5(rows) -> list[list]:
    """1분봉 → 5분봉 [[봉 번호(0 = 09:00~09:04), 시가, 고가, 저가, 종가, 거래량]] (거래량은 누적의 차이)."""
    bars = {}
    for hm, o, h, l, c, v in rows:
        k = hm // 5
        b = bars.get(k)
        if b is None:
            bars[k] = [k, o, h, l, c, v]
        else:
            b[2], b[3], b[4], b[5] = max(b[2], h), min(b[3], l), c, b[5] + v
    return [bars[k] for k in sorted(bars)]


def _cum_array(rows) -> array.array:
    """분 번호 0~390별 그때까지의 누적 거래량 (1분 거래량을 더해 감)."""
    a, v, it = array.array("l", [0] * 391), 0, {r[0]: r[5] for r in rows}
    for i in range(391):
        v += it.get(i, 0)
        a[i] = v
    return a


def _load_one(code: str, ticker: str, today: str):
    bars = [b for b in df.fetch_ohlcv(ticker, years=4) if b["time"] < today and b.get("close")]
    if len(bars) < 70:
        return None
    closes = [b["close"] for b in bars]
    n, w = len(bars), min(WIN, len(bars))
    seed = {}
    for p in EMA_P:
        if n - w <= 0:
            seed[str(p)] = None
            continue
        a, e = 2 / (p + 1), None
        for x in closes[:n - w]:
            e = x if e is None else e + a * (x - e)
        seed[str(p)] = e
    tail = bars[n - w:]
    rec = {"n": n, "t": [b["time"] for b in tail], "o": [b["open"] for b in tail], "h": [b["high"] for b in tail],
           "l": [b["low"] for b in tail], "c": [b["close"] for b in tail], "v": [int(b.get("volume") or 0) for b in tail],
           "seed": seed}
    try:
        allrows = _minutes(code, tail[-1]["time"], 660)
        rows = [r for r in allrows if r[0] <= 390]          # KRX 정규장
        after = [r for r in allrows if r[0] > 390]          # 넥스트 애프터 15:31~20:00 (넥스트 종목만)
        if rows:
            rec["p5"] = _to_m5(rows)
            rec["pcum"] = list(_cum_array(rows))
        if after:
            rec["p5x"] = _to_m5(after)
    except Exception as e:
        log.debug(f"cond 전일 분봉 {code}: {e}")
    return rec


def load_daily(universe: dict[str, tuple[str, str]], force: bool = False) -> None:
    """universe = {code: (ticker, name)}. 오늘 이미 받았으면(파일 포함) 건너뜀."""
    today = now_kst().strftime("%Y-%m-%d")
    if LOAD["state"] == "받는 중":
        return
    if not force and DAILY.get("loaded") == today:
        return
    if not force and _read_file(today):
        return
    LOAD.update(state="받는 중", done=0, total=len(universe), started=time.time(), finished=None)
    stocks: dict = {}

    def job(item):
        code, (ticker, _name) = item
        try:
            r = _load_one(code, ticker, today)
            if r:
                stocks[code] = r
        except Exception as e:
            log.debug(f"cond 일봉 {code}: {e}")
        LOAD["done"] += 1

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=4) as ex:
        list(ex.map(job, universe.items()))
    prev = max((r["t"][-1] for r in stocks.values()), default=None)
    data = {"ver": FILE_VER, "loaded": today, "prev_day": prev, "stocks": stocks, "tickers": {c: tk for c, (tk, _n) in universe.items()}}
    with _lock:
        DAILY.clear()
        DAILY.update(data)
    LOAD.update(state="준비됨", finished=time.time())
    log.info(f"조건검색 일봉 준비: {len(stocks)}/{len(universe)}종목, 전 거래일 {prev}, {time.time() - t0:.0f}초")
    try:
        tmp = DAILY_FILE + ".tmp"
        with gzip.open(tmp, "wt", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"))
        os.replace(tmp, DAILY_FILE)
    except Exception as e:
        log.warning(f"cond_daily 저장 실패: {e}")
    try:
        fill_returns()
    except Exception as e:
        log.warning(f"조건검색 기록 수익 채우기 실패: {e}")


def _read_file(today: str) -> bool:
    try:
        with gzip.open(DAILY_FILE, "rt", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return False
    except Exception as e:
        log.warning(f"cond_daily 읽기 실패: {e}")
        return False
    if data.get("loaded") != today or data.get("ver") != FILE_VER:
        return False
    with _lock:
        DAILY.clear()
        DAILY.update(data)
    LOAD.update(state="준비됨", done=len(data["stocks"]), total=len(data["stocks"]), finished=time.time())
    log.info(f"조건검색 일봉: 저장 파일 사용 ({len(data['stocks'])}종목)")
    return True


def _ticker(code: str) -> str | None:
    return (DAILY.get("tickers") or {}).get(code)


def loaded_today() -> bool:
    return DAILY.get("loaded") == now_kst().strftime("%Y-%m-%d")


# ── KIS (마지막 후보만) ─────────────────────────────────────────────────────
_status_cache: dict = {}    # {(날짜, code): {...}}


def _kis_status(code: str):
    key = (now_kst().strftime("%Y-%m-%d"), code)
    if key in _status_cache:
        return _status_cache[key]
    s = kis.stock_status(code)
    if s is not None:
        _status_cache[key] = s
    return s


def _kis_fill(ctx: Ctx, needs, mkt: str = "J") -> None:
    """mkt: J = KRX 정규장, NX = 넥스트레이드(프리마켓 검색)."""
    k = {}
    if "status" in needs:
        k["status"] = _kis_status(ctx.code)
    if "cttr" in needs:
        k["cttr"] = kis.strength(ctx.code, mkt)
    if "book" in needs:
        b = kis.book(ctx.code, mkt)
        k["ask_ratio"] = (b["total_ask"] / b["total_bid"] * 100) if b and b.get("total_bid") else None
    ctx.k = k


# ── 검색 ───────────────────────────────────────────────────────────────────
RESULTS: dict = {}          # {preset id: {...}}
SCAN = {"ts": None, "secs": None, "note": None, "running": False, "session": None,
        "day": None, "n": 0, "n_nx": 0, "n_gap": 0, "n_pre": 0, "errors": 0, "last_error": None}   # 그날 횟수·오류 (자동 점검용)


def _count(kind: str, err: Exception | None = None) -> None:
    today = now_kst().strftime("%Y-%m-%d")
    if SCAN["day"] != today:
        SCAN.update(day=today, n=0, n_nx=0, n_gap=0, n_pre=0, errors=0, last_error=None)
    SCAN[{"scan": "n", "nx": "n_nx", "gap": "n_gap", "pre": "n_pre"}[kind]] += 1
    if err is not None:
        SCAN["errors"] += 1
        SCAN["last_error"] = f"{now_kst():%H:%M} {kind}: {err}"
_minute_cache: dict = {}    # {code: (시각, 오늘 1분봉)}


def _today_minutes(code: str, today: str, max_age: float = 200):
    hit = _minute_cache.get(code)
    if hit and time.time() - hit[0] < max_age:
        return hit[1]
    try:
        rows = _minutes(code, today)
    except Exception as e:
        log.debug(f"cond 오늘 분봉 {code}: {e}")
        rows = None
    _minute_cache[code] = (time.time(), rows)
    return rows


_nx_cache: dict = {}        # {code: (오늘, {분 번호: 1분봉})} — 넥스트레이드 프리마켓 1분봉 (한 번 받은 분은 다시 안 받음)
NX_CAP = 100                # 프리마켓 검색에서 1분봉을 받는 최대 종목 수 (KIS 초당 한도 — 1종목 1~2회 호출)


def _nx_minutes(code: str, today: str, now: datetime):
    """넥스트레이드 프리마켓(08:00~08:50) 오늘 1분봉 — KIS 분봉(NX, 한 번에 30개) → [(분 번호 -60=08:00, 시가, 고가, 저가, 종가, 그 1분 거래량)].
    네이버 1분봉엔 08시대 넥스트레이드 구간이 없다(11-27 확인 — 어제 것도 09:00부터)."""
    d = today.replace("-", "")
    day, have = _nx_cache.get(code) or (None, {})
    if day != today:
        have = {}
    hour = now.strftime("%H%M00")
    for _ in range(3):
        try:
            rows = kis.minute_bars(code, "NX", hour)
        except Exception as e:
            log.debug(f"cond 넥스트 분봉 {code}: {e}")
            rows = None
        if not rows:
            break
        early = None
        for dt, hms, o, h, l, c, v in rows:
            if dt != d or not c:
                continue
            m = int(hms[:2]) * 60 + int(hms[2:4])
            if not 480 <= m < 540:
                continue
            have[m - 540] = (m - 540, o or c, h or c, l or c, c, v)
            early = m if early is None else min(early, m)
        # 처음 받는 종목이면 08:00까지 거슬러 받는다 (30개씩)
        if early is None or early <= 480 or (early - 1 - 540) in have:
            break
        hour = f"{(early - 1) // 60:02d}{(early - 1) % 60:02d}00"
    _nx_cache[code] = (today, have)
    return [have[k] for k in sorted(have)] or None


_deep_cache: dict = {}      # {(오늘, code): 전 3거래일 5분봉}


def _deep_prev(code: str, rec: dict, today: str):
    """5분봉 224선·볼린저 40용 — 전 3거래일 5분봉 (종목마다 하루 한 번)."""
    key = (today, code)
    if key in _deep_cache:
        return _deep_cache[key]
    bars = []
    try:
        for day in rec["t"][-3:]:
            bars += _to_m5(_minutes(code, day))
    except Exception as e:
        log.debug(f"cond 3일 분봉 {code}: {e}")
        bars = None
    _deep_cache[key] = bars
    return bars


_fin_cache: dict = {}       # {code: (받은 날, {...})}


def _fin(code: str) -> dict:
    """연간 결산(연결) 최근 확정 연도 — 네이버(매출액·부채비율·유보율·EPS) + DART(영업이익 ÷ 이자 지급 = 이자보상배율 근사).
    PER = 현재가 ÷ 최근 연도 EPS (화면 계산 시점에 곱함). 하루 한 번."""
    today = now_kst().strftime("%Y-%m-%d")
    hit = _fin_cache.get(code)
    if hit and hit[0] == today:
        return hit[1]
    out = {"sales": None, "debt": None, "reserve": None, "eps": None, "icr": None, "year": None}
    try:
        r = requests.get(f"https://m.stock.naver.com/api/stock/{code}/finance/annual",
                         headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        fi = r.json().get("financeInfo") or {}
        cols = [x["key"] for x in fi.get("trTitleList") or [] if x.get("isConsensus") == "N"]
        if cols:
            y = cols[-1]
            out["year"] = y[:4]
            for row in fi.get("rowList") or []:
                v = df._safe(str(((row.get("columns") or {}).get(y) or {}).get("value") or "").replace(",", ""))
                k = {"매출액": "sales", "부채비율": "debt", "유보율": "reserve", "EPS": "eps"}.get(row.get("title"))
                if k:
                    out[k] = v
    except Exception as e:
        log.debug(f"cond 재무 {code}: {e}")
    if out["year"]:
        out["icr"] = _dart_icr(code, out["year"])
    _fin_cache[code] = (today, out)
    return out


def _dart_icr(code: str, year: str):
    """DART 사업보고서(연결 우선) 영업이익 ÷ 현금흐름표 이자 지급. 이자 지급 줄이 없으면 영업이익>0일 때 무한대(빚 없음)."""
    try:
        corp = df.load_dart_corp_map().get(code)
        if not corp or not df.DART_KEY:
            return None
        for fs in ("CFS", "OFS"):
            j = requests.get("https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json", timeout=20,
                             params={"crtfc_key": df.DART_KEY, "corp_code": corp, "bsns_year": year, "reprt_code": "11011", "fs_div": fs}).json()
            rows = j.get("list") or []
            if j.get("status") != "000" or not rows:
                continue
            op = intr = None
            for r in rows:
                nm = (r.get("account_nm") or "").replace(" ", "")
                amt = df._dart_num(r.get("thstrm_amount") or "")
                if amt is None:
                    continue
                if op is None and r.get("sj_div") in ("IS", "CIS") and nm in ("영업이익", "영업이익(손실)"):
                    op = amt
                if r.get("sj_div") == "CF" and "이자" in nm and ("지급" in nm) and "수취" not in nm:
                    intr = (intr or 0) + abs(amt)
            if op is None:
                return None
            if not intr:
                return float("inf") if op > 0 else 0.0
            return op / intr
    except Exception as e:
        log.debug(f"cond DART {code}: {e}")
    return None


def _m_rank(quotes: dict, codes, now_idx: int) -> set | None:
    """전일 같은 시각 대비 거래량 증가율 상위 1,000 (보통주 안에서)."""
    st = DAILY.get("stocks") or {}
    ratios = []
    for code in codes:
        rec = st.get(code)
        pc = rec and rec.get("pcum")
        if not pc:
            continue
        y = pc[min(now_idx, 390)]
        if y > 0:
            ratios.append(((quotes[code].get("volume") or 0) / y, code))
    if len(ratios) < 500:
        return None
    ratios.sort(reverse=True)
    return {c for _r, c in ratios[:1000]}


def scan(quotes: dict, names: dict[str, str], nx: bool = False) -> None:
    """장중 5분마다. quotes = 네이버 전 종목 시세 캐시, names = {code: 이름}.
    nx=True: 넥스트레이드 프리마켓(08:00~08:50) — 넥스트 거래 종목만, 오늘 1분봉은 KIS 넥스트레이드 분봉."""
    if SCAN["running"] or not loaded_today():
        return
    SCAN["running"] = True
    t0 = time.time()
    kind = "nx" if nx else "scan"
    try:
        _scan(quotes, names, nx)
        _count(kind)
    except Exception as e:
        log.exception(f"조건검색 실패: {e}")
        SCAN["note"] = f"검색 실패: {e}"
        _count(kind, e)
    finally:
        SCAN.update(running=False, ts=time.time(), secs=round(time.time() - t0, 1), session="넥스트 프리마켓" if nx else "정규장")


_NX_NOTE = ("넥스트레이드 프리마켓(08:00~08:50) 검색 — 넥스트 거래 종목만. 5분봉은 어제 정규장 → 어제 넥스트 애프터(~20:00) → 오늘 넥스트 프리(KIS) 순서로 이어 계산하고, "
            "체결강도·호가도 넥스트 기준. 전일 같은 시각 비교(거래량 증가율 등)는 어제 그 시각 기록이 없어 '모름'")


def _scan(quotes, names, nx: bool = False):
    now = now_kst()
    today = now.strftime("%Y-%m-%d")
    now_hm = now.hour * 60 + now.minute
    now_idx = max(0, now_hm - 540)
    st = DAILY.get("stocks") or {}
    if nx:
        # 네이버 시세의 넥스트 거래량은 0 → 오늘 거래량·대금은 '모름'으로 두고 2차에서 분봉 합으로 채운다
        quotes = {c: {**q, "volume": None, "value": None} for c, q in quotes.items() if q.get("session") == "pre"}
    codes = [c for c, q in quotes.items()
             if c in st and q.get("price") and is_common(c, names.get(c, ""), q.get("kind", "stock"))]
    m_rank = None if nx else _m_rank(quotes, codes, now_idx)

    ctxs = {}
    for code in codes:
        ctxs[code] = Ctx(code, names.get(code, code), quotes[code], Day(st[code], quotes[code], None), now_hm)
        ctxs[code].m_rank = m_rank

    def vals(p, c):
        out = {}
        for k, (_lbl, fn) in p["conds"].items():
            try:
                out[k] = fn(c)
            except (TypeError, ZeroDivisionError, IndexError):
                out[k] = None
        return out

    # 1차 — 시세·일봉만
    stage1 = {}
    for p in _INTRADAY:
        keep = [c for c in codes if eval_node(p["node"], vals(p, ctxs[c])) is not False]
        if nx:   # 거래대금을 아직 모름 → 오른 순서
            keep.sort(key=lambda c: -(quotes[c].get("change_pct") or 0))
        else:
            keep.sort(key=lambda c: -(quotes[c].get("value") or 0))
        stage1[p["id"]] = (len(keep), keep[:p["cap"]])

    # 2차 — 후보 종목만 오늘 1분봉
    need = sorted({c for _n, keep in stage1.values() for c in keep})
    if nx and len(need) > NX_CAP:
        need = sorted(need, key=lambda c: -(quotes[c].get("change_pct") or 0))[:NX_CAP]
    need_set = set(need)
    deep = sorted({c for p in _INTRADAY if p.get("deep") for c in stage1[p["id"]][1] if c in need_set})
    with ThreadPoolExecutor(max_workers=1 if nx else 6) as ex:   # KIS는 어차피 한 줄로 (초당 한도)
        mins = dict(zip(need, ex.map((lambda c: _nx_minutes(c, today, now)) if nx else (lambda c: _today_minutes(c, today)), need)))
    with ThreadPoolExecutor(max_workers=6) as ex:
        deeps = dict(zip(deep, ex.map(lambda c: _deep_prev(c, st[c], today), deep)))
    for code in need:
        rows = mins.get(code)
        if not rows:
            continue
        rec, ctx = st[code], ctxs[code]
        o, h, l = rows[0][1], max(r[2] for r in rows), min(r[3] for r in rows)
        if nx:
            ctx.q = quotes[code] = {**quotes[code], "price": rows[-1][4], "volume": sum(r[5] for r in rows),
                                    "value": sum(r[5] * r[4] for r in rows)}
        ctx.d = Day(rec, quotes[code], (o, h, l))
        prev5 = deeps.get(code) or rec.get("p5") or []
        if nx:   # 통합 시세처럼: 어제 정규장 → 어제 넥스트 애프터 → 오늘 넥스트 프리 (11-27 엔켐 08:13 비교로 확인)
            prev5 = prev5 + (rec.get("p5x") or [])
        ctx.m5 = M5(prev5, _to_m5(rows))
        ctx.m1 = rows
        pc = rec.get("pcum")
        if pc and not nx:
            idx = min(rows[-1][0], 390)
            ctx.same_ratio = sum(r[5] for r in rows) / pc[idx] if pc[idx] else None

    for p in _INTRADAY:
        n1, keep = stage1[p["id"]]
        stage2 = [c for c in keep if mins.get(c) and eval_node(p["node"], vals(p, ctxs[c])) is not False]
        # 3차 — KIS
        final, checked = [], 0
        for code in stage2[:KIS_CAP]:
            ctx = ctxs[code]
            _kis_fill(ctx, p["kis"], "NX" if nx else "J")
            if p.get("fin") and ctx.fin is None:
                ctx.fin = _fin(code)
            checked += 1
            v = vals(p, ctx)
            if eval_node(p["node"], v) is True:
                final.append((code, v))
        hits = _record(p["id"], today, now, final, ctxs)
        notes = []
        if m_rank is None and p.get("mrank"):
            notes.append("전일 같은 시각 거래량 기록이 없어 M(증가율 상위 1,000)은 '모름'으로 판정")
        if len(stage2) > KIS_CAP:
            notes.append(f"마지막 후보 {len(stage2)}개 중 거래대금 상위 {KIS_CAP}개만 KIS로 확인")
        if not kis.enabled():
            notes.append("KIS 키가 없어 체결강도·종목 상태 조건을 판정할 수 없음")
        if nx:
            notes.append(_NX_NOTE)
            if len(stage1[p["id"]][1]) > len([c for c in stage1[p["id"]][1] if c in need_set]):
                notes.append(f"넥스트 분봉은 1차 후보 중 많이 오른 {NX_CAP}종목만 받음")
        notes += p.get("notes", [])
        RESULTS[p["id"]] = {"ts": time.time(), "hm": now.strftime("%H:%M"), "session": "nx" if nx else "krx",
                            "funnel": {"universe": len(codes), "stage1": n1, "stage2": len(stage2),
                                       "checked": checked, "final": len(final)},
                            "hits": hits, "notes": notes}
    SCAN["note"] = None
    log.info(("조건검색(넥스트 프리) " if nx else "조건검색 ") + " · ".join(f"{p['alias']} {RESULTS[p['id']]['funnel']['final']}" for p in _INTRADAY)
             + f" (보통주 {len(codes)})")


def scan_pre(quotes: dict, names: dict[str, str]) -> None:
    try:
        _scan_pre(quotes, names)
        _count("pre")
    except Exception as e:
        log.exception(f"조건검색 시가급등예상 실패: {e}")
        _count("pre", e)


def _scan_pre(quotes: dict, names: dict[str, str]) -> None:
    """시가급등예상 — 08:30~09:00 동시호가 예상체결 (KIS 예상체결 상승률 상위 30 × 코스피·코스닥)."""
    p = next(x for x in PRESETS if x["id"] == "pre")
    now = now_kst()
    today = now.strftime("%Y-%m-%d")
    rows = kis.expected_rank("0001", 50_000) + kis.expected_rank("1001", 50_000)
    seen, cands = set(), []
    for r in rows:
        code = r["code"]
        q = quotes.get(code) or {}
        name = names.get(code) or r["name"]
        if code in seen or not is_common(code, name, q.get("kind", "stock")):
            continue
        seen.add(code)
        c = Ctx(code, name, {"price": r["price"], "change_pct": r["rate"], "value": r["price"] * r["vol"]}, None,
                now.hour * 60 + now.minute)
        c.pre = r
        cands.append(c)

    def vals(c):
        out = {}
        for k, (_lbl, fn) in p["conds"].items():
            try:
                out[k] = fn(c)
            except (TypeError, ZeroDivisionError, KeyError):
                out[k] = None
        return out
    stage = [c for c in cands if eval_node(p["node"], vals(c)) is not False]
    final = []
    for c in stage[:KIS_CAP]:
        _kis_fill(c, p["kis"])
        v = vals(c)
        if eval_node(p["node"], v) is True:
            final.append((c.code, v))
    ctxs = {c.code: c for c in cands}
    hits = _record("pre", today, now, final, ctxs)
    for h in hits:
        h["vol"] = ctxs[h["code"]].pre["vol"]
    RESULTS["pre"] = {"ts": time.time(), "hm": now.strftime("%H:%M"),
                      "funnel": {"universe": len(rows), "stage1": len(cands), "stage2": len(stage),
                                 "checked": min(len(stage), KIS_CAP), "final": len(final)},
                      "hits": hits,
                      "notes": ["KIS 예상체결 상승률 순위(코스피·코스닥 각 30종목, 예상 거래량 5만 주 이상) 안에서 판정"]}
    log.info(f"조건검색 시가급등예상 {len(final)} (순위 {len(rows)})")


_first_cache: dict = {}     # {(오늘, code): (시초가, "HH:MM") | None}


_nx_open_cache: dict = {}   # {(오늘, code): 넥스트 시가 | 0(넥스트 종목 아님)}


def _first_trade(code: str, day: str):
    """오늘 첫 체결 — 넥스트레이드 종목은 KIS 넥스트 시가(08:00 프리마켓 첫 체결), 아니면 네이버 1분봉 첫 줄의 시가(09:00).
    네이버 1분봉엔 08시대 넥스트 구간이 없다(11-27 확인) → 예전엔 프리마켓 동안 0건, 9시 뒤엔 정규장 시가로 잘못 봄."""
    key = (day, code)
    if key in _first_cache and _first_cache[key]:
        return _first_cache[key]
    if kis.enabled():
        nxo = _nx_open_cache.get(key)
        if nxo is None:
            p = kis.price(code, "NX")        # 넥스트에 없는 종목은 None
            nxo = (p or {}).get("open") or 0 if p else 0
            if p and not p.get("open"):      # 넥스트 종목인데 아직 첫 체결 전 → 다음에 다시
                return None
            _nx_open_cache[key] = nxo
        if nxo:
            _first_cache[key] = (nxo, "넥스트")
            return _first_cache[key]
    d = day.replace("-", "")
    try:
        r = requests.get(f"https://api.stock.naver.com/chart/domestic/item/{code}/minute"
                         f"?startDateTime={d}0800&endDateTime={d}1530", headers=df._NAVER_RT_HEADERS, timeout=10)
        rows = [x for x in (r.json() or []) if str(x.get("localDateTime", ""))[:8] == d and x.get("openPrice")]
    except Exception as e:
        log.debug(f"cond 시초가 {code}: {e}")
        return None
    if not rows:
        _first_cache[key] = None
        return None
    rows.sort(key=lambda x: x["localDateTime"])
    t = rows[0]["localDateTime"]
    _first_cache[key] = (rows[0]["openPrice"], f"{t[8:10]}:{t[10:12]}")
    return _first_cache[key]


def scan_gap(quotes: dict, names: dict[str, str]) -> None:
    if not loaded_today():
        return
    try:
        _scan_gap(quotes, names)
        _count("gap")
    except Exception as e:
        log.exception(f"조건검색 시초가 갭상승 실패: {e}")
        _count("gap", e)


def _scan_gap(quotes: dict, names: dict[str, str]) -> None:
    """시초가 갭상승 — 어제 5%↑ 종목의 오늘 첫 체결가가 어제 종가보다 2%↑ (08:00~15:30 10분마다)."""
    if not loaded_today():
        return
    p = next(x for x in PRESETS if x["id"] == "gapup")
    now = now_kst()
    today = now.strftime("%Y-%m-%d")
    st = DAILY.get("stocks") or {}
    cands = []
    for code, rec in st.items():
        q = quotes.get(code) or {}
        if len(rec["c"]) < 2 or not q.get("price"):
            continue
        yday = pct(rec["c"][-1], rec["c"][-2])
        if yday is None or yday < 5 or "스팩" in (names.get(code) or ""):
            continue
        c = Ctx(code, names.get(code, code), q, None, now.hour * 60 + now.minute)
        c.gap = {"yday": yday, "base": rec["c"][-1], "open": None, "at": None}
        cands.append(c)
    with ThreadPoolExecutor(max_workers=6) as ex:
        firsts = list(ex.map(lambda c: _first_trade(c.code, today), cands))
    stage = []
    for c, f in zip(cands, firsts):
        if f:
            c.gap["open"], c.gap["at"] = f
            if (pct(f[0], c.gap["base"]) or 0) >= 2:
                stage.append(c)
    stage.sort(key=lambda c: -(c.q.get("value") or 0))
    final = []

    def vals(c):
        return {k: fn(c) for k, (_l, fn) in p["conds"].items()}
    for c in stage[:KIS_CAP]:
        _kis_fill(c, p["kis"])
        v = vals(c)
        if eval_node(p["node"], v) is True:
            final.append((c.code, v))
    ctxs = {c.code: c for c in cands}
    hits = _record("gapup", today, now, final, ctxs)
    for h in hits:
        g = ctxs[h["code"]].gap
        h["open"], h["open_at"], h["open_gap"], h["yday"] = g["open"], g["at"], round(pct(g["open"], g["base"]), 2), round(g["yday"], 2)
    RESULTS["gapup"] = {"ts": time.time(), "hm": now.strftime("%H:%M"),
                        "funnel": {"universe": len(st), "stage1": len(cands), "stage2": len(stage),
                                   "checked": min(len(stage), KIS_CAP), "final": len(final)},
                        "hits": hits, "notes": list(p.get("notes", []))}
    log.info(f"조건검색 시초가 갭상승 {len(final)} (어제 5%↑ {len(cands)})")


# ── 잡힌 기록 ──────────────────────────────────────────────────────────────
def _db():
    con = sqlite3.connect(HITS_DB, timeout=10)
    con.execute("""CREATE TABLE IF NOT EXISTS hits (day TEXT, preset TEXT, code TEXT, name TEXT,
        first_hm TEXT, first_price REAL, last_hm TEXT, last_price REAL, scans INTEGER DEFAULT 1,
        close REAL, r1 REAL, r3 REAL, r5 REAL, PRIMARY KEY (day, preset, code))""")
    return con


def _record(pid, today, now, final, ctxs) -> list[dict]:
    hm = now.strftime("%H:%M")
    with _db() as con:
        for code, _v in final:
            q = ctxs[code].q
            con.execute("""INSERT INTO hits (day, preset, code, name, first_hm, first_price, last_hm, last_price)
                VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(day, preset, code) DO UPDATE SET
                last_hm=excluded.last_hm, last_price=excluded.last_price, scans=scans+1""",
                        (today, pid, code, ctxs[code].name, hm, q["price"], hm, q["price"]))
        rows = con.execute("SELECT code, first_hm, first_price, scans FROM hits WHERE day=? AND preset=?",
                           (today, pid)).fetchall()
    first = {r[0]: r for r in rows}
    out = []
    for code, v in final:
        c, q = ctxs[code], ctxs[code].q
        f = first.get(code)
        out.append({"code": code, "ticker": _ticker(code), "name": c.name, "price": q["price"], "chg": q.get("change_pct"),
                    "value": q.get("value"), "first_hm": f[1] if f else hm, "first_price": f[2] if f else q["price"],
                    "scans": f[3] if f else 1, "cttr": c.kval("cttr"),
                    "ask_ratio": round(c.kval("ask_ratio"), 1) if c.kval("ask_ratio") else None,
                    "conds": {k: v[k] for k in v if v[k] is True}})
    out.sort(key=lambda h: -(h["value"] or 0))
    return out


def history(preset: str | None, days: int = 20) -> list[dict]:
    with _db() as con:
        q = "SELECT day, preset, code, name, first_hm, first_price, last_hm, scans, close, r1, r3, r5 FROM hits"
        args = []
        if preset:
            q += " WHERE preset=?"
            args.append(preset)
        q += " ORDER BY day DESC, first_hm DESC LIMIT ?"
        args.append(days * 60)
        rows = con.execute(q, args).fetchall()
    keys = ("day", "preset", "code", "name", "first_hm", "first_price", "last_hm", "scans", "close", "r1", "r3", "r5")
    out = [dict(zip(keys, r), ticker=_ticker(r[2])) for r in rows]
    alldays = sorted({r["day"] for r in out}, reverse=True)[:days]
    return [r for r in out if r["day"] in alldays]


def fill_returns() -> None:
    """잡힌 가격 대비 당일 종가·1·3·5거래일 뒤 종가 수익률(%) — 아침 일봉을 받은 뒤 채운다."""
    st = DAILY.get("stocks") or {}
    with _db() as con:
        rows = con.execute("SELECT day, preset, code, first_price FROM hits WHERE r5 IS NULL").fetchall()
        for day, pid, code, fp in rows:
            rec = st.get(code)
            if not rec or day not in rec["t"] or not fp:
                continue
            i, c = rec["t"].index(day), rec["c"]

            def r(k):
                return round((c[i + k] / fp - 1) * 100, 2) if i + k < len(c) else None
            con.execute("UPDATE hits SET close=?, r1=?, r3=?, r5=? WHERE day=? AND preset=? AND code=?",
                        (r(0), r(1), r(3), r(5), day, pid, code))


def last_day_hits() -> dict:
    """서버를 다시 켠 뒤 장 밖 — 마지막 기록일의 잡힌 종목을 결과 대신 보여준다."""
    out = {}
    with _db() as con:
        row = con.execute("SELECT MAX(day) FROM hits").fetchone()
        if not row or not row[0]:
            return out
        for p in PRESETS:
            rs = con.execute("SELECT code, name, first_hm, first_price, last_hm, last_price, scans FROM hits "
                             "WHERE day=? AND preset=? ORDER BY first_hm", (row[0], p["id"])).fetchall()
            out[p["id"]] = {"day": row[0], "hits": [dict(zip(("code", "name", "first_hm", "first_price", "last_hm",
                                                                "last_price", "scans"), r), ticker=_ticker(r[0])) for r in rs]}
    return out


def state() -> dict:
    return {"presets": presets_public(), "results": RESULTS, "scan": SCAN, "load": LOAD,
            "loaded": loaded_today(), "prev_day": DAILY.get("prev_day"),
            "last_day": None if RESULTS else last_day_hits()}
