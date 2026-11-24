import gzip
import hashlib
import json
import logging
import os
import queue
import random
import re
import time
import sqlite3
import threading
import requests
from contextlib import closing
from datetime import date, datetime, timedelta
from flask import Flask, render_template, jsonify, request, send_from_directory
from flask_socketio import SocketIO
from apscheduler.schedulers.background import BackgroundScheduler

from cache import Cache
import data_fetcher as df

PE_EPS_FILE  = os.path.join(os.path.dirname(__file__), "data", "pe_eps_cache.json")

# AI 음성 브리핑 스위치 — 켜면 서버 시작 270초 뒤 + 24시간마다 Claude API·Google TTS 유료 호출.
# 다시 쓰려면 True로 바꾸고 서버 재시작. (2026-11-04 꺼둠)
VOICE_BRIEFING_ENABLED = False

KR_STOCKS_FILE = os.path.join(os.path.dirname(__file__), "data", "kr_stocks.json")

def _load_kr_base() -> list:
    try:
        if os.path.exists(KR_STOCKS_FILE):
            with open(KR_STOCKS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        log.warning(f"kr_stocks.json 로드 실패: {e}")
    return []

KR_PER_FILE = os.path.join(os.path.dirname(__file__), "data", "kr_per_cache.json")

def _load_kr_per() -> dict:
    """{"updated_at": 유닉스초, "data": {code: {"pe", "eps"}}} — refresh_kr_per()가 1일 1회 갱신."""
    try:
        if os.path.exists(KR_PER_FILE):
            with open(KR_PER_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        log.warning(f"kr_per_cache.json 로드 실패: {e}")
    return {}

def _apply_kr_per(rows: list) -> list:
    """kr_stocks.json의 옛 EPS 앵커(07-02 수집)를 kr_per_cache.json의 최신 값으로 교체.
    PER은 현재가/EPS로 재계산, 적자(EPS<=0)는 네이버 PER(0)을 그대로 쓴다."""
    per_map = (_load_kr_per().get("data") or {})
    if not per_map:
        return rows
    out = []
    for s in rows:
        v = per_map.get(s.get("code"))
        if v:
            s = dict(s)
            eps, price = v.get("eps") or 0, s.get("price") or 0
            s["eps"] = eps
            s["pe"]  = round(price / eps, 1) if eps > 0 and price > 0 else (v.get("pe") or 0)
        out.append(s)
    return out

def _load_pe_eps() -> dict:
    try:
        if os.path.exists(PE_EPS_FILE):
            with open(PE_EPS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        log.warning(f"pe_eps_cache.json 로드 실패: {e}")
    return {}

def _save_pe_eps(data: dict):
    try:
        with open(PE_EPS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except Exception as e:
        log.warning(f"PE/EPS 파일 저장 실패: {e}")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

app      = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading", logger=False, engineio_logger=False)
cache    = Cache()

# ── 응답 압축(gzip) ───────────────────────────────────────────────────────────
# 5,000건짜리 JSON 목록 등을 70~85% 줄여 전송한다. 환경변수 DISABLE_GZIP=1 이면 끈다.
# - 대상: JSON/HTML/JS/CSS/SVG/텍스트 (오디오 등 이미 압축된 파일은 제외)
# - Socket.IO 경로, HEAD 요청, 오류/304/206 응답, 1KB 미만 응답은 건드리지 않는다
# - 무료 서버(0.1 vCPU)에서 같은 큰 응답을 매번 다시 압축하지 않도록 결과를 캐시한다
_GZIP_TYPES   = {"application/json", "text/html", "text/css", "application/javascript",
                 "text/javascript", "image/svg+xml", "text/plain"}
_GZIP_MIN     = 1024
_GZIP_LEVEL   = 5
_GZIP_CACHE_MAX = 24
_gzip_cache: "dict[str, bytes]" = {}
_gzip_lock = threading.Lock()


def _gzip_bytes(data: bytes) -> bytes:
    key = hashlib.md5(data).hexdigest()
    with _gzip_lock:
        hit = _gzip_cache.get(key)
    if hit is not None:
        return hit
    gz = gzip.compress(data, compresslevel=_GZIP_LEVEL, mtime=0)
    with _gzip_lock:
        if len(_gzip_cache) >= _GZIP_CACHE_MAX:
            _gzip_cache.pop(next(iter(_gzip_cache)))      # 가장 오래된 항목부터 제거
        _gzip_cache[key] = gz
    return gz


@app.after_request
def _compress_response(resp):
    try:
        if os.environ.get("DISABLE_GZIP") == "1":
            return resp
        if request.method == "HEAD" or request.path.startswith("/socket.io"):
            return resp
        if resp.status_code != 200 or "Content-Encoding" in resp.headers:
            return resp
        if resp.mimetype not in _GZIP_TYPES:
            return resp
        resp.headers.add("Vary", "Accept-Encoding")
        if "gzip" not in request.headers.get("Accept-Encoding", "").lower():
            return resp
        if resp.direct_passthrough:                       # 정적 파일(send_file) 응답
            resp.direct_passthrough = False
        data = resp.get_data()
        if len(data) < _GZIP_MIN:
            return resp
        gz = _gzip_bytes(data)
        if len(gz) >= len(data):
            return resp
        resp.set_data(gz)
        resp.headers["Content-Encoding"] = "gzip"
        resp.headers["Content-Length"] = str(len(gz))
        etag = resp.headers.get("ETag")
        if etag and not etag.startswith("W/"):
            resp.headers["ETag"] = "W/" + etag            # 압축본은 약한 ETag로 표시
    except Exception as e:                                # 압축 실패가 응답 실패로 번지지 않게
        log.debug(f"gzip 건너뜀: {e}")
    return resp

# APScheduler 스레드에서 직접 emit하면 WebSocket 전송이 불안정하므로
# 전용 큐 + start_background_task 워커를 통해 emit한다
_emit_queue: queue.Queue = queue.Queue()

def _emit_worker():
    while True:
        event, data = _emit_queue.get()
        try:
            socketio.emit(event, data)
        except Exception as e:
            log.debug(f"emit 오류 ({event}): {e}")

# ── 백그라운드 갱신 함수 ─────────────────────────────────────────────────────

def _apply_market_caps(stocks: list[dict]) -> list[dict]:
    """캐시된 시가총액을 종목 목록에 반영"""
    market_caps: dict = cache.get("market_caps") or {}
    if not market_caps:
        return stocks
    return [{**s, "market_cap": market_caps.get(s["ticker"], s.get("market_cap"))} for s in stocks]


def refresh_stocks():
    """
    종목 가격 갱신.
    - Nasdaq 경로: Nasdaq API 재호출로 최신 가격·시총 일괄 갱신
    - S&P500 폴백 경로: Yahoo Finance 병렬 조회
    갱신 완료 시 WebSocket으로 클라이언트에 Push.
    """
    base = cache.get("stocks_base") or STOCKS
    if len(base) >= 1000:
        nasdaq = df.fetch_nasdaq_stocks(min_market_cap_b=0.0)
        if nasdaq:
            cache.set("stocks_base", nasdaq, ttl=3600)
            cache.set("stocks",      _apply_us_quotes(nasdaq), ttl=300)
            cache.set("market_caps",
                      {s["ticker"]: s["market_cap"] for s in nasdaq if s.get("market_cap")},
                      ttl=3600)
            _emit_queue.put(("stocks_update", {"count": len(nasdaq)}))
            return
    updated = df.refresh_prices_parallel(base)
    if updated:
        cache.set("stocks", _apply_market_caps(updated), ttl=300)
        _emit_queue.put(("stocks_update", {"count": len(updated)}))


# ── 미국 종목 실시간 시세 (네이버) ────────────────────────────────────────────
# Nasdaq 스크리너 API는 장중에도 전일 종가를 돌려줘(11-06: 앱 AAPL +5.31% = 전일, 실제 -1.27%)
# 가격·등락률·거래량·시총을 네이버 미국 시장 전체 목록으로 1분마다 덮어쓴다. 섹터·업종 등은 Nasdaq 그대로.
_US_QUOTE_FIELDS = ("price", "change", "change_pct", "volume", "value", "session", "session_open", "session_at")   # value = 실제 거래대금 누적(달러, 11-23)
_EXT_MIN_GAP = 110   # 시간외(프리·애프터)에는 전체 목록을 2분에 한 번만 (정규장은 1분)


def _apply_us_quotes(rows: list) -> list:
    """시가총액은 Nasdaq 값(회사 전체 기준)을 가격 변동 비율만큼만 조정 — 네이버 값은 주식 종류별이라
    BRK/B·GOOGL처럼 종류가 여럿인 회사가 작게 나옴(BRK/B $1,277B → $814B)."""
    quotes = cache.get("us_quotes") or {}
    if not quotes:
        return rows
    out = []
    for s in rows:
        q = quotes.get(df._norm_us_ticker(s.get("ticker", "")))
        if q:
            new = {k: q[k] for k in _US_QUOTE_FIELDS if q.get(k) is not None}
            old_p, cap = s.get("price"), s.get("market_cap")
            if cap and old_p and q.get("price"):
                new["market_cap"] = round(cap * q["price"] / old_p, 3)
            s = {**s, **new}
        out.append(s)
    return out


def _us_market_window() -> bool:
    """미국 정규장 앞뒤 여유 포함 (뉴욕 평일 09:25~16:20). 그 밖에는 값이 안 바뀌니 요청하지 않는다."""
    from zoneinfo import ZoneInfo
    ny = datetime.now(ZoneInfo("America/New_York"))
    hm = ny.hour * 60 + ny.minute
    return ny.weekday() < 5 and 9 * 60 + 25 <= hm <= 16 * 60 + 20


def _us_quote_window() -> bool:
    """현재가 갱신 시간 = 프리마켓~애프터마켓 (뉴욕 평일 04:00~20:05, 11-20). 정규장은 _us_market_window."""
    from zoneinfo import ZoneInfo
    ny = datetime.now(ZoneInfo("America/New_York"))
    hm = ny.hour * 60 + ny.minute
    return ny.weekday() < 5 and 4 * 60 <= hm <= 20 * 60 + 5


_us_quotes_ts = 0.0


def refresh_us_quotes(force: bool = False):
    """미국 전 종목 시세 갱신 — 정규장 1분, 프리·애프터 2분 (시간외 가격이 현재가). force=True면 장 밖에도 한 번
    (서버 시작 시 최신 값 반영)."""
    global _us_quotes_ts
    try:
        if not force:
            if not _us_quote_window():
                return
            if not _us_market_window() and time.time() - _us_quotes_ts < _EXT_MIN_GAP:
                return
        _us_quotes_ts = time.time()
        quotes = df.fetch_us_quotes_naver()
        if len(quotes) < 3000:   # 대량 실패(차단·개편) 시 이전 값 유지
            log.warning(f"refresh_us_quotes: {len(quotes)}종목만 수신 — 반영 안 함")
            return
        cache.set("us_quotes", quotes, ttl=6 * 3600)
        rows = cache.get("stocks")
        if rows:
            cache.set("stocks", _apply_us_quotes(rows), ttl=300)
            _emit_queue.put(("stocks_update", {"count": len(rows)}))
    except Exception as e:
        log.error(f"refresh_us_quotes 실패: {e}")


# ── 국내 종목 실시간 시세 (네이버) ────────────────────────────────────────────
_KR_QUOTE_FIELDS = ("price", "change", "change_pct", "volume", "value", "market_cap", "kind",
                    "session", "session_open", "session_at")
_kr_quotes_ts = 0.0     # 마지막 네이버 국내 시세 수신 시각
_kr_yahoo_last = 0.0    # 마지막 Yahoo 국내 갱신 시작 시각


def _apply_kr_quotes(rows: list) -> list:
    quotes = cache.get("kr_quotes") or {}
    if not quotes:
        return rows
    out = []
    for s in rows:
        q = quotes.get(s.get("code"))
        if q:
            s = {**s, **{k: q[k] for k in _KR_QUOTE_FIELDS if q.get(k) is not None}}
            eps = s.get("eps") or 0
            if eps > 0:   # PER = 현재가 ÷ EPS (EPS가 앵커, .claude/rules/kr.md)
                s["pe"] = round(s["price"] / eps, 1)
        out.append(s)
    return out


def _kr_market_window() -> bool:
    """국내 정규장 앞뒤 여유 포함 (평일 08:55~15:45 KST)."""
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo("Asia/Seoul"))
    hm = now.hour * 60 + now.minute
    return now.weekday() < 5 and 8 * 60 + 55 <= hm <= 15 * 60 + 45


def _kr_quote_window() -> bool:
    """현재가 갱신 시간 = 넥스트레이드 프리~애프터 (평일 07:55~20:05 KST, 11-20). 정규장은 _kr_market_window."""
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo("Asia/Seoul"))
    hm = now.hour * 60 + now.minute
    return now.weekday() < 5 and 7 * 60 + 55 <= hm <= 20 * 60 + 5


def refresh_kr_quotes(force: bool = False):
    """국내 전 종목 시세 갱신 — 정규장 1분, 넥스트레이드 프리·애프터 2분 (시간외 가격이 현재가).
    force=True면 장 밖에도 한 번 (서버 시작 시 최신 값 반영)."""
    global _kr_quotes_ts
    try:
        if not force:
            if not _kr_quote_window():
                return
            if not _kr_market_window() and time.time() - _kr_quotes_ts < _EXT_MIN_GAP:
                return
        quotes = df.fetch_kr_quotes_naver()
        if len(quotes) < 2500:   # 대량 실패 시 이전 값 유지
            log.warning(f"refresh_kr_quotes: {len(quotes)}종목만 수신 — 반영 안 함")
            return
        cache.set("kr_quotes", quotes, ttl=6 * 3600)
        _kr_quotes_ts = time.time()
        rows = cache.get("kr_stocks")
        if rows:
            cache.set("kr_stocks", _apply_kr_quotes(rows), ttl=300)
            _emit_queue.put(("kr_stocks_update", {"count": len(rows)}))
    except Exception as e:
        log.error(f"refresh_kr_quotes 실패: {e}")


# ── 화면 종목 실시간 시세 (10초) ───────────────────────────────────────────────
# 브라우저가 지금 보는 종목(관심종목·포트폴리오·차트)을 rt_subscribe로 알려주면, 10초마다 네이버 실시간 시세로
# 그 종목만 서버 캐시에 반영하고 rt_quotes로 보낸다(전체 목록 1.6MB를 다시 받지 않게). 지수도 같은 주기로 rt_indices.
# 여러 명이 봐도 서버가 한 번만 받아 나눠준다. 장 밖에는 요청하지 않는다.
RT_INTERVAL = 10
_rt_subs: dict[str, set] = {}
_rt_lock = threading.Lock()


@socketio.on("rt_subscribe")
def _on_rt_subscribe(data):
    tickers = {str(t).upper()[:20] for t in ((data or {}).get("tickers") or [])[:300] if t}
    with _rt_lock:
        _rt_subs[request.sid] = tickers


@socketio.on("disconnect")
def _on_rt_disconnect(*_args):
    with _rt_lock:
        _rt_subs.pop(request.sid, None)


def _rt_patch_rows(key: str, quotes: dict, is_kr: bool):
    rows = cache.get(key)
    if not rows:
        return
    out, hit = [], False
    for s in rows:
        q = quotes.get(s.get("ticker"))
        if q:
            hit = True
            new = dict(q)
            if is_kr:
                eps = s.get("eps") or 0
                if eps > 0:
                    new["pe"] = round(q["price"] / eps, 1)
            elif s.get("market_cap") and s.get("price"):
                new["market_cap"] = round(s["market_cap"] * q["price"] / s["price"], 3)
            s = {**s, **new}
        out.append(s)
    if hit:
        cache.set(key, out, ttl=300)


def _rt_tick():
    with _rt_lock:
        tickers = set().union(*_rt_subs.values()) if _rt_subs else set()
    us_open, kr_open = _us_market_window(), _kr_market_window()
    us_live, kr_live = _us_quote_window(), _kr_quote_window()   # 종목 현재가는 프리·애프터까지 (지수는 정규장만)
    quotes_kr, quotes_us = {}, {}
    if kr_live:
        kr = [t for t in tickers if t.endswith((".KS", ".KQ"))]
        if kr:
            quotes_kr = df.fetch_rt_kr(kr)
    if us_live:
        uq = cache.get("us_quotes") or {}
        pairs = {}
        for t in tickers:
            if t.endswith((".KS", ".KQ")) or t.startswith("^") or "=" in t:
                continue
            q = uq.get(df._norm_us_ticker(t))
            if q and q.get("reuters"):
                pairs[q["reuters"]] = t
        if pairs:
            quotes_us = df.fetch_rt_us(pairs)
    if quotes_kr:
        _rt_patch_rows("kr_stocks", quotes_kr, is_kr=True)
    if quotes_us:
        _rt_patch_rows("stocks", quotes_us, is_kr=False)
    if quotes_kr or quotes_us:
        _emit_queue.put(("rt_quotes", {"quotes": {**quotes_us, **quotes_kr}}))

    idx_patch = {}
    if kr_open:
        idx_patch.update(df.fetch_kr_indices_naver())
    if us_open:
        idx_patch.update(df.fetch_us_indices_naver())
    idx = cache.get("indices")
    if idx_patch and idx:
        idx = [{**x, **idx_patch[x.get("name")]} if x.get("name") in idx_patch else x for x in idx]
        cache.set("indices", idx, ttl=90)
        _emit_queue.put(("rt_indices", {"indices": idx}))


def _rt_loop():
    while True:
        socketio.sleep(RT_INTERVAL)
        try:
            _rt_tick()
        except Exception as e:
            log.warning(f"실시간 시세 갱신 실패: {e}")


def refresh_kr_stocks():
    """국내주식 가격 갱신 (Yahoo Finance). kr_stocks.json 기반.

    시총 큰 종목부터 chunk 단위로 갱신하고 chunk마다 캐시에 즉시 반영한다.
    이전 주기에 갱신된 행(updated_at 있음)은 이어서 쓰므로, 다음 주기 도중에 파일의 옛 값으로 되돌아가지 않는다.
    """
    global _kr_yahoo_last
    # 네이버 시세(1분)가 살아 있으면 Yahoo 3,900여 건 갱신은 30분에 한 번만 (52주 최고·최저 등 보조 값용)
    if time.time() - _kr_quotes_ts < 180 and time.time() - _kr_yahoo_last < 1800:
        return
    _kr_yahoo_last = time.time()
    base = _load_kr_base()
    if not base:
        return
    prev = {s.get("ticker"): s for s in (cache.get("kr_stocks") or []) if s.get("updated_at")}
    if prev:
        base = [prev.get(s.get("ticker"), s) for s in base]
    base = _apply_kr_per(base)

    def _publish(rows):
        cache.set("kr_stocks", _apply_kr_quotes(rows), ttl=300)

    updated = df.fetch_kr_prices(base, on_progress=_publish)
    if updated:
        cache.set("kr_stocks", _apply_kr_quotes(updated), ttl=300)
        _emit_queue.put(("kr_stocks_update", {"count": len(updated)}))
        log.info(f"국내주식 가격 갱신: {len(updated)}개")


def refresh_kr_per(force: bool = False):
    """국내주식 PER/EPS 1일 1회 재수집 (네이버) → data/kr_per_cache.json.
    서버 재시작마다 3,900여 건을 다시 요청하지 않도록 20시간 이내 캐시면 건너뛴다."""
    try:
        saved = _load_kr_per()
        if not force and time.time() - (saved.get("updated_at") or 0) < 20 * 3600:
            return
        codes = [s["code"] for s in _load_kr_base() if s.get("code")]
        if not codes:
            return
        new_data = df.fetch_kr_per_eps(codes)
        if len(new_data) < len(codes) * 0.5:   # 대량 실패(차단 등) 시 기존 캐시를 덮어쓰지 않음
            log.warning(f"refresh_kr_per: {len(new_data)}/{len(codes)}개만 성공 — 저장 안 함")
            return
        merged = dict(saved.get("data") or {})
        merged.update(new_data)
        with open(KR_PER_FILE, "w", encoding="utf-8") as f:
            json.dump({"updated_at": int(time.time()), "data": merged}, f)
        rows = cache.get("kr_stocks")
        if rows:
            cache.set("kr_stocks", _apply_kr_per(rows), ttl=300)
        log.info(f"국내주식 PER/EPS 갱신: {len(new_data)}개")
    except Exception as e:
        log.error(f"refresh_kr_per 실패: {e}")


def refresh_us_names_ko(force: bool = False):
    """미국 종목 한글명 주 1회 재수집 (네이버 해외주식 목록) → data/us_names_ko.json.
    6일 이내 캐시면 건너뛴다. 받은 뒤 지금 캐시의 종목 행에도 바로 반영한다."""
    try:
        saved = df.load_us_names_ko()
        if not force and time.time() - (saved.get("updated_at") or 0) < 6 * 86400:
            return
        names = df.fetch_us_names_ko_naver()
        if len(names) < 3000:   # 대량 실패(차단·개편) 시 기존 파일을 덮어쓰지 않음
            log.warning(f"refresh_us_names_ko: 한글명 {len(names)}개만 수집 — 저장 안 함")
            return
        with open(df.US_NAMES_KO_FILE, "w", encoding="utf-8") as f:
            json.dump({"updated_at": int(time.time()), "data": names}, f, ensure_ascii=False)
        df.set_us_names_ko(names)
        for key in ("stocks_base", "stocks"):
            rows = cache.get(key)
            if rows:
                ttl = 3600 if key == "stocks_base" else 300
                cache.set(key, [{**s, "name_ko": df.name_ko(s["ticker"]) or s.get("name_ko", "")} for s in rows], ttl=ttl)
        log.info(f"미국 종목 한글명 갱신: {len(names)}개")
    except Exception as e:
        log.error(f"refresh_us_names_ko 실패: {e}")


def refresh_pe_eps():
    """Yahoo Finance 종목 페이지 HTML 파싱으로 PE/EPS 수집 (1일 1회).
    이미 있는 종목은 건너뛰고 누락 종목부터 시총 상위 순으로 처리.
    결과는 파일에 저장해 서버 재시작 후에도 유지.
    """
    try:
        stocks = cache.get("stocks") or []
        if len(stocks) < 100:   # 종목 로드 미완료 시 스킵
            log.warning(f"refresh_pe_eps 스킵: stocks {len(stocks)}개 (아직 로드 중)")
            return
        sorted_stocks = sorted(stocks, key=lambda x: x.get("market_cap", 0), reverse=True)
        all_tickers = [s["ticker"] for s in sorted_stocks]

        existing = _load_pe_eps()
        missing  = [t for t in all_tickers if t not in existing]
        refresh  = [t for t in all_tickers if t in existing]
        ordered  = (missing + refresh)[:200]   # 누락 먼저, 기존 갱신은 뒤에

        new_data = df.fetch_pe_eps_yahoo(ordered)
        if new_data:
            existing.update(new_data)
            _save_pe_eps(existing)
            cache.set("pe_eps", existing, ttl=86400)
            log.info(f"PE/EPS 갱신: {len(new_data)}개 신규 / 누적 {len(existing)}개")
    except Exception as e:
        log.error(f"refresh_pe_eps 실패: {e}")


def refresh_extra_fields():
    """PE/EPS/52W 데이터 갱신 (6시간마다). stocks 캐시가 채워진 후 실행."""
    try:
        stocks = cache.get("stocks") or []
        if not stocks:
            return
        tickers = [s["ticker"] for s in stocks]
        extras  = df.fetch_extra_fields(tickers)
        if extras:
            cache.set("extra_fields", extras, ttl=6 * 3600)
            log.info(f"extra_fields 갱신: {len(extras)}개")
    except Exception as e:
        log.error(f"refresh_extra_fields 실패: {e}")


def refresh_market_caps():
    """시가총액 수집 (Yahoo Finance HTML, 6시간마다)"""
    base = cache.get("stocks_base") or STOCKS
    tickers = [s["ticker"] for s in base]
    market_caps = df.fetch_all_market_caps(tickers)
    if market_caps:
        cache.set("market_caps", market_caps, ttl=21600)  # 6시간
        # 현재 stocks 캐시에도 즉시 반영
        stocks = cache.get("stocks")
        if stocks:
            cache.set("stocks", _apply_market_caps(stocks), ttl=300)


# ── 뉴스 기록 쌓기 (11-24) ──────────────────────────────────────────────────
# 뉴스는 10분마다 메모리에서 통째로 바뀌어 지난 기사가 사라졌다 → 받은 기사를 SQLite 한 파일에 계속 쌓는다.
# 제목·한글 제목·출처·시장·분야·시각·감성·링크만(본문은 저작권 문제로 저장 안 함). 종목 뉴스는 news_tk로 종목과 묶는다.
# 날짜별 지난 뉴스(뉴스 탭 날짜 고르기)·종목별 30일 뉴스가 읽는다. 작업 PC는 집 서버 기록을 받아 보여 준다.
NEWS_ARCHIVE_DB = os.path.join(os.path.dirname(__file__), "data", "news_archive.sqlite")
_na_lock = threading.Lock()


def _na_db():
    con = sqlite3.connect(NEWS_ARCHIVE_DB, timeout=10)
    con.execute("CREATE TABLE IF NOT EXISTS news (url TEXT PRIMARY KEY, title TEXT, title_ko TEXT, source TEXT, market TEXT,"
                " category TEXT, ts INTEGER, day TEXT, sentiment TEXT)")
    con.execute("CREATE INDEX IF NOT EXISTS news_day ON news(day, ts)")
    con.execute("CREATE TABLE IF NOT EXISTS news_tk (tk TEXT, url TEXT, PRIMARY KEY (tk, url)) WITHOUT ROWID")
    # 증권사 텔레그램 리서치 (11-24) — 글 하나 = (채널, 글 번호)
    con.execute("CREATE TABLE IF NOT EXISTS tg_posts (ch TEXT, msg INTEGER, ts INTEGER, day TEXT, broker TEXT, title TEXT,"
                " text TEXT, links TEXT, analyst TEXT, opinion TEXT, target REAL, cur TEXT, single INTEGER, PRIMARY KEY (ch, msg))")
    con.execute("CREATE INDEX IF NOT EXISTS tg_posts_ts ON tg_posts(ts)")
    con.execute("CREATE TABLE IF NOT EXISTS tg_tk (tk TEXT, ch TEXT, msg INTEGER, PRIMARY KEY (tk, ch, msg)) WITHOUT ROWID")
    # 리포트 목록 (11-24) — 네이버 리서치(src naver: company·industry·market·economy)·한경 컨센서스(src hk: company·industry)
    con.execute("CREATE TABLE IF NOT EXISTS reports (src TEXT, rid INTEGER, cat TEXT, ts INTEGER, day TEXT, broker TEXT, tk TEXT,"
                " name TEXT, title TEXT, summary TEXT, opinion TEXT, target REAL, cur TEXT, chg TEXT, analyst TEXT, url TEXT, pdf TEXT,"
                " PRIMARY KEY (src, rid))")
    con.execute("CREATE INDEX IF NOT EXISTS reports_day ON reports(day)")
    con.execute("CREATE INDEX IF NOT EXISTS reports_tk ON reports(tk, day)")
    # 실적·공시 이벤트 기록 (11-25) — 나중에 '이벤트 뒤 사면 이겼나' 검증(C2·D)에 쓴다. data = JSON(숫자·반응)
    con.execute("CREATE TABLE IF NOT EXISTS events (kind TEXT, tk TEXT, day TEXT, data TEXT, PRIMARY KEY (kind, tk, day)) WITHOUT ROWID")
    return con


def _archive_news(items: list, tk: str | None = None):
    """기사 목록을 기록에 더한다(이미 있는 링크는 그대로). tk를 주면 그 종목에 묶고, 기사 자체 ticker도 묶는다."""
    from zoneinfo import ZoneInfo
    kst = ZoneInfo("Asia/Seoul")
    rows, tks = [], []
    for n in items or []:
        url, title = n.get("url"), (n.get("title") or "").strip()
        if not url or not title or url.startswith("#"):
            continue
        ts = int(n.get("timestamp") or time.time())
        ko = n.get("title_ko") or (df.news_title_ko(title) if df.news_needs_tr(title) else None)
        rows.append((url, title, ko, n.get("source") or "", n.get("market") or ("KR" if tk and isinstance(tk, str) and tk.endswith((".KS", ".KQ")) else "US"),
                     n.get("category") or "", ts, datetime.fromtimestamp(ts, kst).strftime("%Y-%m-%d"), n.get("sentiment") or ""))
        for t in {tk, n.get("ticker")} - {None, ""}:
            if not (tk and t == tk and n.get("rel") == 0):   # 관련도 낮은 종목 기사는 종목에 묶지 않음
                tks.append((t, url))
    if not rows:
        return
    try:
        with _na_lock, closing(_na_db()) as con:
            con.executemany("INSERT OR IGNORE INTO news VALUES (?,?,?,?,?,?,?,?,?)", rows)
            con.executemany("INSERT OR IGNORE INTO news_tk VALUES (?,?)", tks)
            con.commit()
    except sqlite3.Error as e:
        log.warning(f"뉴스 기록 저장 실패: {e}")


def _archive_fill_ko(titles: list[str]):
    """번역이 끝난 제목의 한글 제목을 기록에도 채운다 (번역 파일은 14일 뒤 지워지므로)."""
    pairs = [(ko, t) for t in dict.fromkeys(titles) if df.news_needs_tr(t) and (ko := df.news_title_ko(t))]
    if not pairs or not os.path.exists(NEWS_ARCHIVE_DB):
        return
    try:
        with _na_lock, closing(_na_db()) as con:
            con.executemany("UPDATE news SET title_ko=? WHERE title=? AND title_ko IS NULL", pairs)
            con.commit()
    except sqlite3.Error as e:
        log.warning(f"뉴스 기록 한글 제목 채우기 실패: {e}")


def _archive_rows(sql: str, args: tuple) -> list[dict]:
    if not os.path.exists(NEWS_ARCHIVE_DB):
        return []
    with _na_lock, closing(_na_db()) as con:
        cur = con.execute(sql, args)
        cols = [c[0] for c in cur.description]
        out = [dict(zip(cols, r)) for r in cur.fetchall()]
    for n in out:
        n["timestamp"] = n.pop("ts")
        if not n.get("title_ko"):
            ko = df.news_title_ko(n["title"]) if df.news_needs_tr(n.get("title", "")) else None   # 기록 뒤에 번역된 제목
            if ko:
                n["title_ko"] = ko
            else:
                n.pop("title_ko", None)
    return out


# ── 증권사 텔레그램 리서치 수집 (11-24) ───────────────────────────────────────
# 증권사 공식 리서치 채널 공개 미리보기(최근 약 20개 글)를 평일 07~22시 15분마다(그 밖엔 1시간마다) 읽어 새 글만 쌓는다.
# 글마다 종목·투자의견·목표주가를 뽑아(df.tg_extract) 종목과 묶는다. 점검: scripts/tg_extract_check.py
_tg_last = 0.0


def _tg_maps():
    kr = [s for s in (cache.get("kr_stocks") or []) if s.get("code")]
    us = cache.get("stocks") or []
    return ({s["code"]: s["ticker"] for s in kr}, {s["ticker"] for s in us if s.get("ticker")},
            {s["name"]: s["ticker"] for s in kr if s.get("name") and (s.get("kind") or "stock") == "stock"},
            {s["name_ko"]: s["ticker"] for s in us if s.get("name_ko") and not s.get("non_common")})


def refresh_broker_research(force: bool = False):
    global _tg_last
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo("Asia/Seoul"))
    busy = now.weekday() < 5 and 7 <= now.hour < 22
    if not force and not busy and time.time() - _tg_last < 55 * 60:
        return
    kr_codes, us_set, kr_names, us_names = _tg_maps()
    if len(kr_codes) < 1000 or len(us_set) < 1000:   # 종목 목록이 아직 없으면 종목을 못 묶으니 다음에
        return
    _tg_last = time.time()
    kst = ZoneInfo("Asia/Seoul")
    new = 0
    for ch, broker in df.TELEGRAM_RESEARCH:
        posts = df.fetch_tg_channel(ch)
        if not posts:
            continue
        rows, tks = [], []
        for p in posts:
            e = df.tg_extract(p["text"], kr_codes, us_set, kr_names, us_names)
            rows.append((ch, p["msg"], p["ts"], datetime.fromtimestamp(p["ts"], kst).strftime("%Y-%m-%d"), broker, e["title"],
                         p["text"], json.dumps(p["links"], ensure_ascii=False), e["analyst"], e["opinion"],
                         e["target"], e["cur"], int(e["single"])))
            tks += [(t, ch, p["msg"]) for t in e["codes"] + e["us"]]
        try:
            with _na_lock, closing(_na_db()) as con:
                before = con.total_changes
                con.executemany("INSERT OR IGNORE INTO tg_posts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
                new += con.total_changes - before
                con.executemany("INSERT OR IGNORE INTO tg_tk VALUES (?,?,?)", tks)
                con.commit()
        except sqlite3.Error as e:
            log.warning(f"증권사 리서치 저장 실패 ({ch}): {e}")
        time.sleep(0.5)
    if new:
        log.info(f"증권사 텔레그램 리서치: 새 글 {new}건")


# ── 리포트 목록 수집 (11-24) — 네이버 리서치 4종 + 한경 컨센서스, 평일 07~22시 30분마다(그 밖 3시간) ──────────
_rp_last = 0.0


def refresh_report_lists(force: bool = False):
    global _rp_last
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo("Asia/Seoul"))
    busy = now.weekday() < 5 and 7 <= now.hour < 22
    if not force and time.time() - _rp_last < (25 * 60 if busy else 170 * 60):
        return
    kr = [x for x in (cache.get("kr_stocks") or []) if x.get("code")]
    if len(kr) < 1000:
        return
    _rp_last = time.time()
    code2tk = {x["code"]: x["ticker"] for x in kr}
    ts = int(time.time())
    try:
        with _na_lock, closing(_na_db()) as con:
            have = {(a, b) for a, b in con.execute("SELECT src, rid FROM reports WHERE day >= ?",
                                                      ((now - timedelta(days=10)).strftime("%Y-%m-%d"),))}
    except sqlite3.Error:
        have = set()
    rows = []
    details = 0
    for cat in df.NAVER_RESEARCH_CATS:
        for x in df.fetch_naver_research(cat, 100):
            if ("naver", x["rid"]) in have:
                continue
            det = {}
            if cat in ("company", "industry") and details < 40:   # 새 리포트만 상세(요약 본문·PDF·목표가) 한 번씩
                det = df.fetch_naver_research_detail(cat, x["rid"]); details += 1
                time.sleep(0.2)
            text = det.get("text") or ""
            rows.append(("naver", x["rid"], cat, ts, x["date"], x["broker"], code2tk.get(x["code"], ""), x["name"], x["title"],
                         text[:1500], det.get("opinion"), det.get("target"), det.get("cur"), df.report_change(text),
                         "", x["url"], det.get("pdf", "")))
    sd, ed = (now - timedelta(days=3)).strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")
    for rt, cat in (("CO", "company"), ("IN", "industry")):
        for x in df.fetch_hankyung_reports(sd, ed, rt):
            if ("hk", x["rid"]) in have:
                continue
            rows.append(("hk", x["rid"], cat, ts, x["date"], x["broker"], code2tk.get(x["code"], ""), x["name"], x["title"],
                         x["summary"], x["opinion"], x["target"], "KRW" if x["target"] else None, df.report_change(x["title"] + " " + x["summary"]),
                         x["analyst"], x["pdf"], x["pdf"]))
    try:
        with _na_lock, closing(_na_db()) as con:
            if rows:
                con.executemany("INSERT OR IGNORE INTO reports VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
                con.commit()
            # 상세를 아직 못 받은 최근 네이버 종목·산업 리포트를 이어서 (한 번에 40건 한도라 남은 것)
            todo = con.execute("SELECT cat, rid FROM reports WHERE src='naver' AND cat IN ('company','industry') AND (summary IS NULL OR summary='')"
                               " AND day >= ? ORDER BY day DESC LIMIT ?", ((now - timedelta(days=5)).strftime("%Y-%m-%d"), max(0, 40 - details))).fetchall()
        upd = []
        for cat, rid in todo:
            det = df.fetch_naver_research_detail(cat, rid)
            time.sleep(0.2)
            text = det.get("text") or ""
            if text:
                upd.append((text[:1500], det.get("opinion"), det.get("target"), det.get("cur"), df.report_change(text), det.get("pdf", ""), rid))
        if upd:
            with _na_lock, closing(_na_db()) as con:
                con.executemany("UPDATE reports SET summary=?, opinion=?, target=?, cur=?, chg=?, pdf=? WHERE src='naver' AND rid=?", upd)
                con.commit()
        if rows or upd:
            log.info(f"리포트 목록: 새 {len(rows)}건 · 상세 {details + len(upd)}건")
    except sqlite3.Error as e:
        log.warning(f"리포트 목록 저장 실패: {e}")


def _names_map() -> dict:
    names = {s["ticker"]: s.get("name") for s in (cache.get("kr_stocks") or [])}
    names.update({s["ticker"]: s.get("name_ko") or s.get("name") for s in (cache.get("stocks") or [])})
    return names


def _feed_rows(days: int, tk: str | None = None, src: str = "", cat: str = "", q: str = "", day: str = "", limit: int = 600) -> list[dict]:
    """텔레그램·네이버·한경을 한 형식으로 [{src, cat, title, broker, bkey, timestamp, day, stocks, opinion, target, cur, chg,
    analyst, url, pdf, text, single}] (최신 먼저). day를 주면 그날(한국 날짜)만."""
    out = []
    since = int(time.time()) - days * 86400
    since_day = datetime.fromtimestamp(since).strftime("%Y-%m-%d")
    if src in ("", "tg") and cat in ("", "company", "industry"):
        where, args = ("WHERE p.day = ?", [day]) if day else ("WHERE p.ts >= ?", [since])
        if tk:
            where = "JOIN tg_tk k ON k.ch = p.ch AND k.msg = p.msg " + where + " AND k.tk = ?"; args.append(tk)
        if q:
            where += " AND (p.text LIKE ? OR p.title LIKE ?)"; args += [f"%{q}%", f"%{q}%"]
        for p in _tg_rows(where, tuple(args), limit):
            c = "company" if p["stocks"] else "industry"
            if cat and c != cat:
                continue
            out.append({"src": "tg", "cat": c, "title": p["title"], "broker": p["broker"], "timestamp": p["timestamp"],
                        "stocks": p["stocks"], "opinion": p["opinion"] if p["single"] else None, "target": p["target"], "cur": p["cur"],
                        "chg": df.report_change(p["text"]) if p["single"] else None, "analyst": p["analyst"], "url": p["url"],
                        "pdf": (p["links"] or [""])[0], "text": p["text"][:600], "single": p["single"]})
    if src in ("", "naver", "hk") and os.path.exists(NEWS_ARCHIVE_DB):
        where, args = (["day = ?"], [day]) if day else (["day >= ?"], [since_day])
        if src:
            where.append("src = ?"); args.append(src)
        if cat:
            where.append("cat = ?"); args.append(cat)
        if tk:
            where.append("tk = ?"); args.append(tk)
        if q:
            where.append("(title LIKE ? OR summary LIKE ? OR name LIKE ?)"); args += [f"%{q}%"] * 3
        with _na_lock, closing(_na_db()) as con:
            cur = con.execute("SELECT * FROM reports WHERE " + " AND ".join(where) + f" ORDER BY day DESC, ts DESC LIMIT {int(limit)}", args)
            cols = [c[0] for c in cur.description]
            rr = [dict(zip(cols, r)) for r in cur.fetchall()]
        names = _names_map()
        for r in rr:
            from zoneinfo import ZoneInfo
            d0 = int(datetime.strptime(r["day"], "%Y-%m-%d").replace(tzinfo=ZoneInfo("Asia/Seoul")).timestamp()) if r["day"] else r["ts"]
            out.append({"src": r["src"], "cat": r["cat"], "title": r["title"], "broker": r["broker"],
                        "timestamp": min(r["ts"], d0 + 86399) if r["day"] else r["ts"],
                        "stocks": [{"ticker": r["tk"], "name": names.get(r["tk"]) or r["name"]}] if r["tk"] else [],
                        "opinion": r["opinion"], "target": r["target"], "cur": r["cur"], "chg": r["chg"], "analyst": r["analyst"],
                        "url": r["url"], "pdf": r["pdf"], "text": (r["summary"] or "")[:600], "single": bool(r["tk"])})
    for x in out:
        x["bkey"] = df.broker_key(x["broker"])
    out.sort(key=lambda x: -x["timestamp"])
    return out[:limit]


def _tg_rows(where: str, args: tuple, limit: int = 400) -> list[dict]:
    if not os.path.exists(NEWS_ARCHIVE_DB):
        return []
    with _na_lock, closing(_na_db()) as con:
        cur = con.execute(f"SELECT p.ch, p.msg, p.ts, p.broker, p.title, p.text, p.links, p.analyst, p.opinion, p.target, p.cur,"
                          f" p.single, (SELECT group_concat(tk) FROM tg_tk t WHERE t.ch = p.ch AND t.msg = p.msg) AS tks"
                          f" FROM tg_posts p {where} ORDER BY p.ts DESC LIMIT {int(limit)}", args)
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    names = {s["ticker"]: s.get("name") for s in (cache.get("kr_stocks") or [])}
    names.update({s["ticker"]: s.get("name_ko") or s.get("name") for s in (cache.get("stocks") or [])})
    for r in rows:
        r["timestamp"] = r.pop("ts")
        r["url"] = f"https://t.me/{r['ch']}/{r['msg']}"
        r["links"] = json.loads(r["links"] or "[]")
        r["stocks"] = [{"ticker": t, "name": names.get(t) or t} for t in (r.pop("tks") or "").split(",") if t]
        r["single"] = bool(r["single"])
        r["text"] = (r["text"] or "")[:1500]
    return rows


def refresh_news():
    log.info("뉴스 갱신 시작...")
    try:
        news_data = df.fetch_news()
        if news_data:
            cache.set("news", news_data, ttl=600)
            _archive_news(news_data)
            log.info(f"뉴스 갱신 완료: {len(news_data)}건")
            _emit_queue.put(("news_update", {"count": len(news_data)}))
    except Exception as e:
        log.warning(f"뉴스 갱신 실패: {e}")
    refresh_news_translations()


def refresh_kr_market_news():
    """국내 경제/증시 RSS 뉴스 갱신 -- 10분 캐시 (해외 뉴스와 동일 주기)"""
    log.info("국내 뉴스 갱신 시작...")
    try:
        kr_news_data = df.fetch_kr_market_news()
        if kr_news_data:
            cache.set("kr_market_news", kr_news_data, ttl=600)
            _archive_news(kr_news_data)
            log.info(f"국내 뉴스 갱신 완료: {len(kr_news_data)}건")
    except Exception as e:
        log.warning(f"국내 뉴스 갱신 실패: {e}")


# 11-22: AlphaVantage 뉴스(NEWS_SENTIMENT)는 11-04부터 프리미엄 전용이라 수집 중단 → Finnhub 시총 상위 종목 뉴스로 대체
def refresh_finnhub_company_news():
    """Finnhub 시총 상위 15종목 뉴스 — 30분마다 (종목당 1요청, 무료 분당 60회 안)"""
    try:
        stocks = cache.get("stocks") or []
        top = [s["ticker"] for s in sorted(stocks, key=lambda s: s.get("market_cap") or 0, reverse=True)
               if s.get("market_cap")][:15]
        if not top:
            top = ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AVGO", "BRK-B", "JPM"]
        data = df.fetch_finnhub_top_company_news(top)
        if data:
            cache.set("finnhub_company_news", data, ttl=3600)
            _archive_news(data)
    except Exception as e:
        log.warning(f"Finnhub 종목 뉴스 갱신 실패: {e}")
    refresh_news_translations()


def refresh_news_translations():
    """영어 뉴스 제목 한글 번역 — 뉴스 갱신 직후 백그라운드로. 새로 번역됐으면 화면에 알린다."""
    try:
        titles = [n["title"] for key in ("news", "finnhub_news", "finnhub_company_news")
                  for n in (cache.get(key) or [])]
        if df.translate_news_titles(titles):
            _emit_queue.put(("news_update", {"translated": True}))
            _archive_fill_ko(titles)
    except Exception as e:
        log.warning(f"뉴스 번역 실패: {e}")


def refresh_finnhub_news():
    """Finnhub 일반 뉴스 갱신 — 10분 캐시"""
    log.info("Finnhub 뉴스 갱신 시작...")
    try:
        fh_data = df.fetch_finnhub_news()
        if fh_data:
            cache.set("finnhub_news", fh_data, ttl=600)
            _archive_news(fh_data)
            log.info(f"Finnhub 뉴스 갱신 완료: {len(fh_data)}건")
    except Exception as e:
        log.warning(f"Finnhub 뉴스 갱신 실패: {e}")
    refresh_news_translations()


def refresh_reports():
    log.info("리포트 갱신 시작...")
    try:
        data = df.fetch_reports()
        if data:
            cache.set("reports", data, ttl=900)
            log.info(f"리포트 갱신 완료: {len(data)}건")
    except Exception as e:
        log.warning(f"리포트 갱신 실패: {e}")


def refresh_earnings():
    """이번 주 + 다음 주 어닝스 캘린더 수집 (1시간 캐시)."""
    try:
        today = date.today()
        # 이번 주 월~금
        mon = today - timedelta(days=today.weekday())
        this_week = [mon + timedelta(days=i) for i in range(5)]
        # 다음 주 월~금
        next_mon = mon + timedelta(weeks=1)
        next_week = [next_mon + timedelta(days=i) for i in range(5)]

        all_items: list[dict] = []
        for d in this_week + next_week:
            items = df.fetch_earnings_calendar(d.strftime("%Y-%m-%d"))
            all_items.extend(items)

        cache.set("earnings", all_items, ttl=3600)
        log.info(f"어닝스 캘린더 갱신: {len(all_items)}건")
        # 11-25: 발표가 끝난 큰 종목(시총 $10B↑, 60개까지)에 주가 반응 — 일봉을 받아야 해서 뒤에서 계산해 다시 저장
        all_items = _earn_tab_reactions(all_items)
        cache.set("earnings", all_items, ttl=3600)
    except Exception as e:
        log.warning(f"refresh_earnings 실패: {e}")


def refresh_indices():
    log.info("지수 갱신 시작...")
    try:
        idx = df.fetch_indices()
        if idx:
            kr_idx = df.fetch_kr_indices_naver()   # 코스피·코스닥은 네이버 실시간 값으로 (Yahoo 등락률 오류)
            if kr_idx:
                idx = [{**x, **kr_idx[x.get("name")]} if x.get("name") in kr_idx else x for x in idx]
            # ttl을 갱신 주기(30초)보다 길게 — 같으면 만료~재수집 사이 1~2초 동안 /api/indices가
            # 더미 INDICES(달러/원 1,350 등)를 돌려줘 티커 테이프·포트폴리오 환율이 순간 틀렸음
            cache.set("indices", idx, ttl=90)
            log.info(f"지수 갱신 완료: {len(idx)}개")
            _emit_queue.put(("indices_update", {"count": len(idx)}))
            log.info("indices_update 큐 등록")
    except Exception as e:
        log.warning(f"지수 갱신 실패: {e}")


def refresh_fear_greed():
    """CNN Fear & Greed Index 갱신 — 30분마다."""
    data = df.fetch_fear_greed()
    if data:
        cache.set("fear_greed", data, ttl=1800)
        log.info(f"Fear & Greed 갱신: {data['score']} ({data['rating']})")


# ── 시장 전체 거래량·거래대금 매일 저장 (11-18) ────────────────────────────
# 거래대금 과거치는 무료 출처가 없어(네이버 지수 거래대금은 오늘 값만) 서버가 매일 한 줄씩 쌓는다.
# data/market_flow.json = {"KOSPI": {날짜: {volume, amount}}, "KOSDAQ": {...}, "US": {날짜: {volume, amount, count}}}
MARKET_FLOW_FILE = os.path.join(os.path.dirname(__file__), "data", "market_flow.json")
_market_flow_lock = threading.Lock()


def _load_market_flow() -> dict:
    try:
        with open(MARKET_FLOW_FILE, encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_market_flow_row(market: str, day: str, row: dict) -> None:
    with _market_flow_lock:
        d = _load_market_flow()
        d.setdefault(market, {})[day] = row
        tmp = MARKET_FLOW_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, MARKET_FLOW_FILE)


# 미국: 네이버 누적 거래량·거래대금은 정규장 시작(09:30) 때 0부터 다시 세고 애프터마켓까지 계속 더해진다
# (11-20: 16:20 110.6억주 → 19:30 123.8억주). 프리마켓은 들어가지 않는다 — 11-23 09:29 기록이 전 거래일 하루 전체 값
# (125.8억주)이라 정규장(16:01 − 09:29)이 마이너스가 됐음. → 뉴욕 16:01(정규장 = 그 시각 누적)·20:05(애프터 = 차이)만 기록.
# 행 = {"s1601": {volume, amount, count}, "s2005": {...}} (11-23엔 쓰지 않는 s0929도 있음) — 11-19·20은 예전 한 번 저장(구분 전).
_US_SNAPS = (("s1601", 16 * 60 + 1), ("s2005", 20 * 60 + 5))


def record_us_market_flow(slot: str | None = None):
    """미국 시장 누적 거래량·실제 거래대금 기록. slot 지정(스케줄러) 또는 None(서버 시작 때 — 기록 시각 10분 안이면).
    이미 기록한 칸은 덮어쓰지 않는다. 휴장일(그날 체결 없음)은 건너뛴다."""
    from zoneinfo import ZoneInfo
    ny = datetime.now(ZoneInfo("America/New_York"))
    hm = ny.hour * 60 + ny.minute
    if ny.weekday() >= 5:
        return
    if slot is None:
        slot = next((k for k, t in _US_SNAPS if t <= hm <= t + 10), None)
        if slot is None:
            return
    day = ny.strftime("%Y-%m-%d")
    row = dict((_load_market_flow().get("US") or {}).get(day) or {})
    if slot in row:
        return
    stocks = cache.get("stocks") or []
    if len(stocks) < 1000:   # 서버 시작 직후 예시 데이터
        return
    quotes = df.fetch_us_quotes_naver()   # 기록 시각의 값이 필요해 새로 받는다(약 70요청·20초, 하루 세 번)
    a = quotes.get("AAPL") or {}
    if str(a.get("traded_at") or "")[:10] != day:      # 오늘 체결이 없으면 휴장
        log.info(f"시장 거래 기록 US {day} {slot}: 오늘 체결 없음(휴장) — 건너뜀")
        return
    r = df.us_market_flow(stocks, quotes, day)   # 오늘 체결 없는 종목(전날 누적이 남음)은 뺌
    if not r["volume"]:
        return
    row[slot] = r
    _save_market_flow_row("US", day, row)
    _save_us_stock_snaps(day, slot, stocks, quotes)
    log.info(f"시장 거래 기록 US {day} {slot}: 누적 거래량 {r['volume']:,}주 · 거래대금 ${r['amount'] / 1e9:.1f}B ({r['count']}종목)")


# 미국 종목별 누적 거래량·실제 거래대금 (11-23) — 시장 합계와 같은 시각(09:29·16:01·20:05)에 종목마다 저장해
# 차이로 프리·정규장·애프터를 나눈다. 종목 약 5,000개 × 하루 3번이라 JSON 대신 SQLite(표준 라이브러리) 한 파일.
US_STOCK_FLOW_DB = os.path.join(os.path.dirname(__file__), "data", "us_stock_flow.sqlite")
_usf_lock = threading.Lock()


def _usf_db():
    con = sqlite3.connect(US_STOCK_FLOW_DB, timeout=10)
    con.execute("CREATE TABLE IF NOT EXISTS snap (tk TEXT, day TEXT, slot TEXT, volume INTEGER, amount REAL,"
                " PRIMARY KEY (tk, day, slot)) WITHOUT ROWID")
    return con


def _save_us_stock_snaps(day: str, slot: str, stocks: list, quotes: dict):
    rows = []
    for s in stocks:
        q = quotes.get(df._norm_us_ticker(s.get("ticker", "")))
        if q and q.get("volume") and str(q.get("traded_at") or "")[:10] == day:   # 오늘 체결이 있는 종목만
            rows.append((s["ticker"], day, slot, int(q["volume"]), float(q.get("value") or 0)))
    try:
        with _usf_lock, closing(_usf_db()) as con:
            con.executemany("INSERT OR IGNORE INTO snap VALUES (?,?,?,?,?)", rows)
            con.commit()
        log.info(f"종목별 거래 기록 US {day} {slot}: {len(rows):,}종목")
    except sqlite3.Error as e:
        log.warning(f"종목별 거래 기록 실패: {e}")


def _us_stock_flow_local(ticker: str, since: str) -> dict:
    """{날짜: 정규장 volume·amount + 프리·애프터} — _us_flow_split과 같은 방식."""
    if not os.path.exists(US_STOCK_FLOW_DB):
        return {}
    try:
        with _usf_lock, closing(_usf_db()) as con:
            cur = con.execute("SELECT day, slot, volume, amount FROM snap WHERE tk=? AND day>=?", (ticker, since))
            days: dict = {}
            for day, slot, vol, amt in cur:
                days.setdefault(day, {})[slot] = {"volume": vol, "amount": amt}
    except sqlite3.Error as e:
        log.warning(f"종목별 거래 기록 읽기 실패: {e}")
        return {}
    return {d: _us_flow_split(v) for d, v in days.items()}


def _us_flow_split(row: dict) -> dict:
    """US 하루 기록 → 정규장(volume·amount)·애프터. 예전 한 번 저장 행은 mixed(구분 전).
    정규장 = 16:01 누적 그대로 (네이버 누적엔 프리마켓이 안 들어감 — 11-23 확인, s0929는 전 거래일 값이라 쓰지 않음)."""
    if "volume" in row and "s1601" not in row:
        return {"volume": row.get("volume"), "amount": row.get("amount"), "mixed": True}
    s1, s2 = row.get("s1601") or {}, row.get("s2005") or {}
    out = {"volume": None, "amount": None}
    if s1:
        out["volume"], out["amount"] = s1["volume"], s1["amount"]
    if s1 and s2:
        out["after_volume"] = max(0, s2["volume"] - s1["volume"])
        out["after_amount"] = max(0, s2["amount"] - s1["amount"])
    return out


def refresh_dynamic_indices():
    """Nasdaq100·Dow30(Wikipedia) + Russell2000(IWM CSV) 구성종목 갱신 — 주 1회."""
    log.info("지수 구성종목 동적 갱신 시작 (Nasdaq100·Dow30·Russell2000)...")

    n100 = df.fetch_nasdaq100_list()
    if n100:
        cache.set("nasdaq100_tickers", n100, ttl=7 * 86400)
        log.info(f"Nasdaq100 갱신 완료: {len(n100)}개")
    else:
        log.warning("Nasdaq100 갱신 실패 — 기존 캐시/정적 폴백 유지")

    d30 = df.fetch_dow30_list()
    if d30:
        cache.set("dow30_tickers", d30, ttl=7 * 86400)
        log.info(f"Dow30 갱신 완료: {len(d30)}개")
    else:
        log.warning("Dow30 갱신 실패 — 기존 캐시/정적 폴백 유지")

    r2000 = df.fetch_russell2000_iwm()
    if r2000:
        cache.set("russell2000_tickers", r2000, ttl=7 * 86400)
        log.info(f"Russell2000 갱신 완료: {len(r2000)}개")
    else:
        log.warning("Russell2000 IWM 실패 — 시총 근사값 폴백 유지")


def refresh_daily_signals():
    """매수/매도 신호 추천 갱신 — 1일 1회. US/KR 각 시총 상위 500개 대상 (chart.js와 동일 신호 로직)."""
    us_stocks = cache.get("stocks") or []
    kr_stocks = cache.get("kr_stocks") or []
    if len(us_stocks) < 100 or len(kr_stocks) < 100:
        log.warning("refresh_daily_signals 스킵: 종목 데이터 아직 로드 중")
        return
    try:
        result = df.build_daily_recommendations(us_stocks, kr_stocks, top_n=500)
        cache.set("daily_signals", result, ttl=90000)
        vs = result["volume_surges"]
        cp = result["candle_patterns"]
        log.info(
            f"일일 신호 추천 갱신 완료: "
            f"US 매수 {len(result['us']['buy'])}/매도 {len(result['us']['sell'])}, "
            f"KR 매수 {len(result['kr']['buy'])}/매도 {len(result['kr']['sell'])}, "
            f"거래량 급증 US {len(vs['us'])}/KR {len(vs['kr'])}, "
            f"캔들패턴 US {len(cp['us']['bullish'])+len(cp['us']['bearish'])}/"
            f"KR {len(cp['kr']['bullish'])+len(cp['kr']['bearish'])}"
        )
    except Exception as e:
        log.error(f"refresh_daily_signals 실패: {e}")


def _compute_market_mood(items: list[dict]) -> dict:
    """뉴스/리포트 감성 분포 -> Market Mood (긍정/부정/중립 비율 + 라벨). /api/brief와 refresh_voice_briefing 공용."""
    sentiments = [i.get("sentiment", "neutral") for i in items]
    pos  = sentiments.count("positive")
    neg  = sentiments.count("negative")
    neut = sentiments.count("neutral")
    total = len(sentiments) or 1
    return {
        "positive": round(pos  / total * 100),
        "negative": round(neg  / total * 100),
        "neutral":  round(neut / total * 100),
        "label": "Bullish" if pos > neg * 1.5 else "Bearish" if neg > pos * 1.5 else "Mixed",
    }


def _dedup_stories(items: list[dict], max_per_source: int = 2, top_n: int = 5) -> list[dict]:
    """중복 제거 + 소스 다양성 + 감성 강도/최신순 가중. /api/brief와 refresh_voice_briefing 공용."""
    seen_words: list[set] = []
    source_count: dict[str, int] = {}
    result = []
    sorted_items = sorted(
        items,
        key=lambda x: (abs(x.get("score", 0)), x.get("timestamp", 0)),
        reverse=True,
    )
    for item in sorted_items:
        if len(result) >= top_n:
            break
        src = item.get("source", "")
        if source_count.get(src, 0) >= max_per_source:
            continue
        # 핵심 단어 기반 중복 체크 (4글자 이상 단어, 한글/영문 공용)
        words = {w.lower() for w in item.get("title", "").split() if len(w) >= 4}
        is_dup = any(len(words & prev) >= 3 for prev in seen_words)
        if is_dup:
            continue
        seen_words.append(words)
        source_count[src] = source_count.get(src, 0) + 1
        result.append(item)
    return result


def refresh_voice_briefing():
    """AI 음성 브리핑 갱신 — 1일 1회. Claude API 대본생성 + Google Cloud TTS 합성.
    오늘 이미 생성된 게 디스크에 있으면 재사용(서버 재시작마다 재과금되는 것 방지)."""
    cached = df.load_cached_voice_briefing()
    if cached:
        cache.set("voice_briefing", cached, ttl=90000)
        log.info(f"음성 브리핑: 오늘 생성분 재사용 ({len(cached['turns'])}개 발화, API 재호출 없음)")
        return

    us_news = cache.get("news") or []
    kr_news = cache.get("kr_market_news") or []
    if len(us_news) < 5 and len(kr_news) < 5:
        log.warning("refresh_voice_briefing 스킵: 뉴스 데이터 아직 로드 중")
        return
    try:
        mood = _compute_market_mood(us_news)
        fear_greed = cache.get("fear_greed")
        # 헤드라인 선정: 캐시 순서 그대로 앞 3개가 아니라, 감성강도+최신순+소스다양성+중복제거 적용
        us_top = _dedup_stories(us_news, max_per_source=1, top_n=3)
        kr_top = _dedup_stories(kr_news, max_per_source=2, top_n=3)
        result = df.build_voice_briefing(us_top, kr_top, mood, fear_greed)
        if result:
            cache.set("voice_briefing", result, ttl=90000)
            log.info(f"음성 브리핑 갱신 완료: {len(result['turns'])}개 발화")
        else:
            log.warning("음성 브리핑 갱신 실패 — 기존 캐시 유지")
    except Exception as e:
        log.error(f"refresh_voice_briefing 실패: {e}")


def _load_sp500_tickers_background():
    """Wikipedia에서 실제 S&P 500 구성 종목 티커 Set을 캐시에 저장 (24시간)."""
    sp500 = df.fetch_sp500_list()
    if sp500:
        tickers = {s["ticker"] for s in sp500}
        cache.set("sp500_tickers", tickers, ttl=86400)
        log.info(f"S&P 500 구성종목 캐시 저장: {len(tickers)}개")
    else:
        log.warning("S&P 500 Wikipedia 파싱 실패 — sp500_tickers 미설정")


def _load_sp500_background():
    """
    서버 시작 후 백그라운드 종목 목록 로드 (우선순위):
    1) Nasdaq API (2500개+, 가격·시총 포함, 단 1회 요청) ← 우선
    2) Wikipedia S&P500 (503개) ← Nasdaq 실패 시 폴백
    3) 기존 60개 더미 ← 최후 폴백
    Nasdaq 성공 시 가격·시총이 이미 포함되므로 별도 갱신 불필요.
    Wikipedia S&P500 티커는 Nasdaq 성공 여부와 무관하게 별도 캐시에 저장.
    """
    # 1) Nasdaq API 시도
    nasdaq = df.fetch_nasdaq_stocks(min_market_cap_b=0.0)
    if nasdaq:
        cache.set("stocks_base", nasdaq, ttl=3600)
        cache.set("stocks",      _apply_us_quotes(nasdaq), ttl=300)
        cache.set("market_caps",
                  {s["ticker"]: s["market_cap"] for s in nasdaq if s.get("market_cap")},
                  ttl=3600)
        log.info(f"Nasdaq 종목 로드 완료: {len(nasdaq)}개 (S&P500+Russell2000 수준)")
        # Nasdaq 성공해도 S&P500 실제 구성종목은 Wikipedia에서 별도 로드
        threading.Thread(target=_load_sp500_tickers_background, daemon=True).start()
        return

    # 2) Wikipedia S&P500 폴백
    log.warning("Nasdaq API 실패 → Wikipedia S&P500 폴백")
    sp500 = df.fetch_sp500_list()
    if sp500:
        cache.set("stocks_base", sp500, ttl=86400)
        cache.set("stocks",      sp500, ttl=300)
        tickers = {s["ticker"] for s in sp500}
        cache.set("sp500_tickers", tickers, ttl=86400)
        log.info(f"S&P500 기본 목록 로드: {len(sp500)}개")
    else:
        log.warning("Wikipedia 파싱도 실패 → 기존 60개 유지")
    # 가격 갱신 (S&P500 경로에서만 필요)
    refresh_stocks()
    threading.Thread(target=refresh_market_caps, daemon=True).start()


def initial_load():
    """
    앱 시작 시 캐시 초기화.
    1) 60개 더미 데이터로 즉시 서빙 (사용자가 바로 페이지를 볼 수 있음)
    2) 백그라운드에서 S&P500 503개 목록 로드 + 실시간 가격 갱신
    """
    # 즉시 서빙용 60개 더미 초기화
    base60 = [{**s, "name_ko": df.name_ko(s["ticker"]) or s.get("name_ko", "")} for s in STOCKS]
    cache.set("stocks_base", base60, ttl=86400)
    cache.set("stocks",      base60, ttl=300)
    cache.set("news",    NEWS,    ttl=600)
    cache.set("reports", [],     ttl=900)
    cache.set("indices", INDICES, ttl=30)

    # emit 큐 워커 시작 (socketio 관리 스레드에서 emit 처리)
    socketio.start_background_task(_emit_worker)
    socketio.start_background_task(_rt_loop)   # 화면 종목·지수 10초 실시간 (장중만 요청)

    # 백그라운드 갱신 스레드 시작
    # 느린 서버(0.1 vCPU)에서 시작 직후 한꺼번에 몰리지 않도록 작업을 몇 초씩 나눠 시작한다.
    # 사용자가 바로 보는 데이터(지수, 미국 종목, 뉴스)는 즉시, 부가 데이터는 뒤로 미룬다.
    def _start_after(delay: float, fn):
        def _run():
            if delay:
                import time as _t; _t.sleep(delay)
            fn()
        threading.Thread(target=_run, daemon=True).start()

    _start_after(0,  refresh_indices)
    _start_after(0,  _load_sp500_background)
    _start_after(2,  refresh_finnhub_news)
    _start_after(4,  refresh_news)
    _start_after(90, lambda: refresh_broker_research(force=True))   # 종목 목록이 들어온 뒤
    _start_after(120, lambda: refresh_report_lists(force=True))
    _start_after(6,  refresh_fear_greed)
    _start_after(8,  refresh_kr_market_news)
    _start_after(12, refresh_reports)
    _start_after(16, refresh_earnings)
    _start_after(40, refresh_finnhub_company_news)   # 시총이 들어온 뒤
    _start_after(24, refresh_dynamic_indices)
    _start_after(28, refresh_us_names_ko)
    _start_after(15, lambda: refresh_us_quotes(force=True))   # 미국 시세: 시작 시 한 번(장 밖이어도 최신 종가)    # 한글명(6일 이내 파일이면 스킵, 첫 수집 약 30초)
    # extra_fields는 stocks 로드 후 실행 — 약간 지연해서 시작
    def _delayed_extra():
        import time as _t; _t.sleep(30)
        refresh_extra_fields()
    threading.Thread(target=_delayed_extra, daemon=True).start()

    # PE/EPS는 파일 캐시 먼저 로드, stocks 로드 후 60초 지연해서 시작
    saved = _load_pe_eps()
    if saved:
        cache.set("pe_eps", saved, ttl=86400)
        log.info(f"PE/EPS 파일 캐시 로드: {len(saved)}개")
    def _delayed_pe_eps():
        import time as _t; _t.sleep(180)
        refresh_pe_eps()
    threading.Thread(target=_delayed_pe_eps, daemon=True).start()

    # 미국 시장 거래량·거래대금: 서버를 장 마감 뒤에 다시 켰을 때 그날 값이 빠지지 않게 한 번 (미국 종목 로드 후).
    # 국내는 11-21부터 저장하지 않고 다음 금융 과거치를 불러온다(/api/market-flow)
    def _delayed_market_flow():
        import time as _t; _t.sleep(150)
        record_us_market_flow()
    threading.Thread(target=_delayed_market_flow, daemon=True).start()

    # 일일 신호 추천: US·KR 종목 로드 후 240초 지연해서 시작 (PE/EPS 등과 겹치지 않게)
    def _delayed_daily_signals():
        import time as _t; _t.sleep(240)
        refresh_daily_signals()
    threading.Thread(target=_delayed_daily_signals, daemon=True).start()

    # AI 음성 브리핑: 뉴스 로드 후 270초 지연해서 시작 (daily_signals 등과 겹치지 않게)
    if VOICE_BRIEFING_ENABLED:
        def _delayed_voice_briefing():
            import time as _t; _t.sleep(270)
            refresh_voice_briefing()
        threading.Thread(target=_delayed_voice_briefing, daemon=True).start()
    else:
        log.info("AI 음성 브리핑: 꺼짐 (VOICE_BRIEFING_ENABLED=False) — 유료 API 호출 안 함")

    # 국내주식: 파일 기반 베이스 로드 후 백그라운드 가격 갱신
    kr_base = _load_kr_base()
    if kr_base:
        cache.set("kr_stocks", _apply_kr_per(kr_base), ttl=300)
        log.info(f"국내주식 파일 캐시 로드: {len(kr_base)}개")
        _start_after(5, refresh_kr_stocks)        # 3,936종목 시세 갱신은 초반 부하를 피해 5초 뒤 시작
        _start_after(20, lambda: refresh_kr_quotes(force=True))   # 네이버 국내 시세: 시작 시 한 번(장 밖이어도 최신 종가)
        _start_after(300, refresh_kr_per)         # PER/EPS 재수집(캐시 20시간 이내면 스킵) — 음성 브리핑(270초) 뒤
    else:
        log.info("kr_stocks.json 없음 — scripts/fetch_kr_stocks.py 실행 필요")


# ── 시장 상승·하락·보합 종목 수 (11-23) ─────────────────────────────────────
# 정규장 동안만 1분마다 새로 세고, 장이 끝나면 마지막 값(정규장 종가 기준)을 고정해 보여 준다.
# 장 마감 뒤에는 시세가 시간외 가격으로 바뀌므로 브라우저가 직접 세면 애프터마켓이 섞였다.
MARKET_BREADTH_FILE = os.path.join(os.path.dirname(__file__), "data", "market_breadth.json")
_breadth: dict = {}
try:
    with open(MARKET_BREADTH_FILE, encoding="utf-8") as _f:
        _breadth = json.load(_f)
except (OSError, ValueError):
    _breadth = {}


def _breadth_regular(market: str) -> bool:
    """정규장 시간인지 — 미국 뉴욕 09:30~16:01, 국내 09:00~15:31 (평일). 마감 직후 1분은 종가 반영용."""
    from zoneinfo import ZoneInfo
    if market == "us":
        t = datetime.now(ZoneInfo("America/New_York")); lo, hi = 9 * 60 + 30, 16 * 60 + 1
    else:
        t = datetime.now(ZoneInfo("Asia/Seoul")); lo, hi = 9 * 60, 15 * 60 + 31
    hm = t.hour * 60 + t.minute
    return t.weekday() < 5 and lo <= hm <= hi


def _breadth_count(rows: list) -> dict:
    up = down = flat = 0
    for s in rows:
        p = s.get("change_pct") or 0
        if p > 0: up += 1
        elif p < 0: down += 1
        else: flat += 1
    return {"n": len(rows), "up": up, "down": down, "flat": flat}


def _breadth_rows(market: str) -> list:
    if market == "us":
        return [s for s in (cache.get("stocks") or []) if s.get("ticker")]
    return [s for s in (cache.get("kr_stocks") or []) if (s.get("kind") or "stock") == "stock"]   # ETF·ETN 제외


def _breadth_make(market: str, rows: list) -> dict:
    from zoneinfo import ZoneInfo
    tz = "America/New_York" if market == "us" else "Asia/Seoul"
    d = _breadth_count(rows)
    d.update(at=int(time.time()), date=datetime.now(ZoneInfo(tz)).strftime("%Y-%m-%d"))
    if market == "kr":
        d["kospi"] = _breadth_count([s for s in rows if s.get("market") == "KOSPI"])
        d["kosdaq"] = _breadth_count([s for s in rows if s.get("market") == "KOSDAQ"])
    return d


def refresh_market_breadth():
    """1분마다: 정규장인 시장만 새로 세서 저장하고 화면에 알린다."""
    changed = False
    for m in ("us", "kr"):
        if not _breadth_regular(m):
            continue
        rows = _breadth_rows(m)
        if len(rows) < 1000:      # 서버 시작 직후 예시 데이터 등
            continue
        # 휴장일: 정규장 시간인데 대부분 종목이 시간외 값이면(시장이 안 열림) 세지 않는다 — 직전 거래일 값 유지
        if sum(1 for s in rows if s.get("session")) > len(rows) * 0.3:
            continue
        _breadth[m] = _breadth_make(m, rows)
        changed = True
    if changed:
        try:
            with open(MARKET_BREADTH_FILE, "w", encoding="utf-8") as f:
                json.dump(_breadth, f, ensure_ascii=False)
        except OSError as e:
            log.warning(f"상승·하락 저장 실패: {e}")
        _emit_queue.put(("breadth_update", _breadth_payload()))


def _breadth_payload() -> dict:
    out = {}
    for m in ("us", "kr"):
        d = _breadth.get(m)
        if d:
            d = dict(d, live=_breadth_regular(m) and time.time() - d.get("at", 0) < 300, approx=False)
        else:   # 정규장 기록이 아직 없음(처음 설치) → 지금 시세로 세되 시간외가 섞였을 수 있다고 표시
            rows = _breadth_rows(m)
            if len(rows) < 1000:
                continue
            d = dict(_breadth_make(m, rows), live=False, approx=True)
        out[m] = d
    return out


# ── 스케줄러 ─────────────────────────────────────────────────────────────────
# 느린 서버에서 30초 주기 작업이 밀릴 때 'missed' 경고가 쌓이지 않도록 1회로 합치고 60초까지 허용
_scheduler = BackgroundScheduler(job_defaults={"coalesce": True, "misfire_grace_time": 60})
_scheduler.add_job(refresh_stocks,          "interval", minutes=5,  id="stocks")
_scheduler.add_job(refresh_us_quotes,       "interval", minutes=1,  id="us_quotes")   # 장중만 실제 수집 (네이버, 약 70요청)
_scheduler.add_job(refresh_kr_stocks,       "interval", minutes=5,  id="kr_stocks")   # 네이버 시세가 살아 있으면 30분에 한 번만 실제 실행
_scheduler.add_job(refresh_kr_quotes,       "interval", minutes=1,  id="kr_quotes")   # 장중만 실제 수집 (네이버, 약 44요청)
_scheduler.add_job(refresh_market_breadth,  "interval", minutes=1,  id="market_breadth")   # 정규장만 실제로 셈 (11-23)
_scheduler.add_job(lambda: refresh_kr_quotes(force=True), "cron", day_of_week="mon-fri", hour=16, minute=5,
                   timezone="Asia/Seoul", id="kr_quotes_close")   # 장 마감 확정 종가 (15:30~15:45 야후 값이 늦을 수 있어 한 번 더)
_scheduler.add_job(refresh_indices,         "interval", seconds=30, id="idx")
_scheduler.add_job(refresh_news,            "interval", minutes=10, id="news")
_scheduler.add_job(refresh_broker_research, "interval", minutes=15, id="broker_research")   # 평일 07~22시 15분, 그 밖 1시간 (11-24)
_scheduler.add_job(refresh_report_lists,    "interval", minutes=30, id="report_lists")      # 네이버 리서치·한경, 평일 30분·그 밖 3시간 (11-24)
_scheduler.add_job(refresh_kr_market_news,  "interval", minutes=10, id="kr_market_news")
_scheduler.add_job(refresh_reports,         "interval", minutes=15, id="reports")
_scheduler.add_job(refresh_earnings,        "interval", hours=1,    id="earnings")
_scheduler.add_job(refresh_market_caps,     "interval", hours=6,    id="market_caps")
_scheduler.add_job(refresh_extra_fields,    "interval", hours=6,    id="extra_fields")
_scheduler.add_job(refresh_pe_eps,          "interval", hours=24,   id="pe_eps")
_scheduler.add_job(refresh_kr_per,          "interval", hours=24,   id="kr_per")
_scheduler.add_job(refresh_us_names_ko,     "interval", hours=24,   id="us_names_ko")  # 6일 지난 경우만 실제 수집
_scheduler.add_job(refresh_finnhub_company_news, "interval", minutes=30, id="finnhub_company_news")
_scheduler.add_job(refresh_finnhub_news,    "interval", minutes=10, id="finnhub_news")
_scheduler.add_job(refresh_dynamic_indices, "interval", weeks=1,    id="dyn_indices")
_scheduler.add_job(refresh_fear_greed,      "interval", minutes=30, id="fear_greed")
for _slot, _t in _US_SNAPS:   # 미국 시장 누적 거래량·거래대금: 프리 끝·정규장 끝·애프터 끝 (11-21)
    _scheduler.add_job(record_us_market_flow, "cron", day_of_week="mon-fri", hour=_t // 60, minute=_t % 60,
                       timezone="America/New_York", id=f"market_flow_us_{_slot}", args=[_slot])
_scheduler.add_job(refresh_daily_signals,   "interval", hours=24,   id="daily_signals")
if VOICE_BRIEFING_ENABLED:
    _scheduler.add_job(refresh_voice_briefing, "interval", hours=24, id="voice_briefing")


# ── Flask 라우트 ─────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")


def _get_merged_us_stocks() -> list:
    """cache의 stocks에 extra_fields(52W)·pe_eps를 병합한 목록 (여러 엔드포인트에서 공용)."""
    data   = cache.get("stocks") or STOCKS
    extras = cache.get("extra_fields") or {}   # 52W
    pe_eps = cache.get("pe_eps") or {}          # PE/EPS
    if not extras and not pe_eps:
        return data
    merged = []
    for s in data:
        tick = s["ticker"]
        row  = dict(s)
        if extras.get(tick):
            row.update(extras[tick])
        if pe_eps.get(tick):
            row.update(pe_eps[tick])
        merged.append(row)
    return merged


@app.route("/api/market-breadth")
def market_breadth():
    """미국·국내 상승·하락·보합 종목 수 — 정규장 중엔 1분마다, 마감 뒤엔 정규장 종가 기준 고정 (11-23)."""
    return jsonify(_breadth_payload())


@app.route("/api/stocks")
def stocks():
    sector = request.args.get("sector", "all")
    data   = _get_merged_us_stocks()
    result = data if sector == "all" else [s for s in data if s["sector"] == sector]
    return jsonify(result)


@app.route("/api/indices")
def indices():
    return jsonify(cache.get("indices") or INDICES)


@app.route("/api/news")
def news():
    rss_news     = cache.get("news") or NEWS
    finnhub_news = (cache.get("finnhub_news") or []) + (cache.get("finnhub_company_news") or [])
    kr_news      = cache.get("kr_market_news") or []
    # 중복 제거: 제목 기준
    seen   = {n["title"] for n in rss_news}
    extras = []
    for n in finnhub_news + kr_news:
        if n["title"] not in seen:
            seen.add(n["title"])
            extras.append(n)
    merged = []
    for n in list(rss_news) + extras:   # 캐시 원본은 건드리지 않고 복사본에 분야·한글 제목을 붙인다 (11-22)
        n = dict(n)
        n.setdefault("market", "US")
        n.setdefault("category", "econ")
        ko = df.news_title_ko(n["title"]) if df.news_needs_tr(n["title"]) else None
        if ko:
            n["title_ko"] = ko
        merged.append(n)
    # 최신순 정렬
    merged.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
    for i, n in enumerate(merged, 1):
        n["id"] = i
    return jsonify(merged)


@app.route("/api/news/translation")
def news_translation_status():
    """제목 번역 서비스별 이번 달 사용량·상태 (11-22) — scripts/news_translate_status.py가 읽는다."""
    return jsonify(df.translation_status())


@app.route("/api/kr-stocks")
def kr_stocks():
    """국내주식 목록 (KOSPI + KOSDAQ)."""
    data   = cache.get("kr_stocks") or []
    market = request.args.get("market", "all")  # all | KOSPI | KOSDAQ
    search = request.args.get("q", "").strip().lower()
    if market != "all":
        data = [s for s in data if s.get("market") == market]
    if search:
        data = [s for s in data if search in s.get("code","").lower()
                or search in s.get("name","").lower()]
    return jsonify(data)


@app.route("/api/kr-investor/<code>")
def kr_investor(code: str):
    """국내주식 수급 동향: 외국인·기관·개인 최근 5일 (Naver, 1시간 lazy 캐시)"""
    code = df.kr_code(code)
    if not code:
        return jsonify([])
    key = f"kr_investor_{code}"
    cached = cache.get(key)
    if cached is not None:
        return jsonify(cached)
    data = df.fetch_kr_investor(code)
    cache.set(key, data, ttl=3600 if data else 120)   # 빈 결과(일시 차단 등)는 오래 캐시하지 않는다
    return jsonify(data)


@app.route("/api/kr-disclosures")
def kr_disclosures():
    """KRX KIND 오늘 공시 목록 (30분 lazy 캐시)"""
    key = "kr_disclosures"
    cached = cache.get(key)
    if cached is not None:
        return jsonify(cached)
    data = df.fetch_kr_disclosures(page_size=100)
    cache.set(key, data, ttl=1800)
    return jsonify(data)


@app.route("/api/kr-news/<code>")
def kr_news(code: str):
    """국내주식 종목별 뉴스 (네이버 증권 모바일 API, 30분 lazy 캐시)"""
    code = df.kr_code(code)
    if not code:
        return jsonify([])
    key    = f"kr_news_{code}"
    cached = cache.get(key)
    if cached is not None:
        return jsonify(cached)
    name = next((s.get("name") for s in (cache.get("kr_stocks") or [])
                 if s.get("code") == code), "")
    # 1순위: 네이버 증권 모바일 API(키 불필요, 종목에 묶인 기사 — 11-18) → 2순위: 네이버 검색 API(공식, 키 있을 때만)
    # → 3순위: Google News RSS (광고성 기사가 섞여 마지막 예비로만)
    result = df.fetch_kr_stock_news(code)
    if not result:
        result = df.fetch_kr_stock_news_naver_api(name)
        if result:
            log.info(f"KR 뉴스: 네이버 검색API {len(result)}건 ({name})")
    if not result:
        result = df.fetch_kr_stock_news_google(name)
        if result:
            log.info(f"KR 뉴스: Google News 대체 {len(result)}건 ({name})")
    cache.set(key, result, ttl=1800 if result else 120)   # 빈 결과는 짧게만 캐시
    tk = next((s.get("ticker") for s in (cache.get("kr_stocks") or []) if s.get("code") == code), None)
    _archive_news([dict(n, market="KR") for n in result], tk)
    return jsonify(result)


@app.route("/api/stock-news/<ticker>")
def stock_news(ticker: str):
    """종목별 뉴스 (Finnhub company-news, 30분 lazy 캐시) + 영어 제목 한글 번역(title_ko, 11-24).
    번역하는 서버(집 서버)는 처음 받을 때 바로 번역하고, 번역 안 하는 서버(작업 PC)는 집 서버의 한글 제목을 붙인다."""
    ticker = _canon_us_ticker(ticker)
    key    = f"stock_news_{ticker}"
    data = cache.get(key)
    if data is None:
        # 11-24: 회사 이름을 넘겨 관련도 순으로 고른다(제목에 티커·이름 → 요약에만 → 없으면 뺌) — scripts/news_relevance_check.py
        name = next((s.get("name") for s in (cache.get("stocks") or []) if s.get("ticker") == ticker), "") or ticker
        data = df.fetch_finnhub_company_news(ticker, name)
        cache.set(key, data, ttl=1800)
        _archive_news(data, ticker)
        if df.NEWS_TR_ENABLED and data:
            try:
                if df.translate_news_titles([n["title"] for n in data[:10] if n.get("title")]):
                    _archive_fill_ko([n["title"] for n in data[:10]])
            except Exception as e:
                log.warning(f"종목 뉴스 번역 실패 ({ticker}): {e}")
    out = []
    home_ko = None
    for n in data:
        ko = df.news_title_ko(n.get("title", "")) if df.news_needs_tr(n.get("title", "")) else None
        out.append(dict(n, title_ko=ko) if ko else n)
    if not df.NEWS_TR_ENABLED and any(df.news_needs_tr(n.get("title", "")) and not n.get("title_ko") for n in out):
        home = _home_json(f"/api/stock-news/{ticker}", {}, f"stock_news_home_{ticker}", None) or []
        home_ko = {h.get("title"): h.get("title_ko") for h in home if h.get("title_ko")}
        out = [dict(n, title_ko=home_ko[n["title"]]) if not n.get("title_ko") and n.get("title") in home_ko else n for n in out]
    return jsonify(out)


@app.route("/api/news-archive")
def news_archive_api():
    """쌓아 둔 지난 뉴스 (11-24). ?date=YYYY-MM-DD(한국 날짜) → 그날 기사, 최신순 최대 1,000건. 작업 PC는 집 서버 기록."""
    day = (request.args.get("date") or "")[:10]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        return jsonify({"error": "date=YYYY-MM-DD"}), 400
    home = _home_json("/api/news-archive", {"date": day}, f"na_home_{day}", None)
    if home is not None:
        return jsonify(home)
    return jsonify(_archive_rows("SELECT n.url, title, title_ko, source, market, category, ts, sentiment,"
                                 " (SELECT tk FROM news_tk t WHERE t.url = n.url LIMIT 1) AS ticker"
                                 " FROM news n WHERE day = ? ORDER BY ts DESC LIMIT 1000", (day,)))


@app.route("/api/broker-research")
def broker_research_api():
    """증권사 텔레그램 리서치 글 (최근 days일, 기본 7) — 뉴스 탭 🏦 증권사 리포트. ?ch=채널 &q=검색어. 작업 PC는 집 서버 기록."""
    days = max(1, min(int(request.args.get("days") or 7), 90))
    ch, q = (request.args.get("ch") or "").strip(), (request.args.get("q") or "").strip()
    home = _home_json("/api/broker-research", {"days": days, "ch": ch, "q": q}, f"br_home_{days}_{ch}_{q}", None)
    if home is not None:
        return jsonify(home)
    where, args = "WHERE p.ts >= ?", [int(time.time()) - days * 86400]
    if ch:
        where += " AND p.ch = ?"; args.append(ch)
    if q:
        where += " AND (p.text LIKE ? OR p.title LIKE ?)"; args += [f"%{q}%", f"%{q}%"]
    return jsonify(_tg_rows(where, tuple(args)))


@app.route("/api/broker-research/<ticker>")
def broker_research_stock_api(ticker):
    """한 종목의 증권사 리포트(텔레그램·네이버 리서치·한경) + 요약: 120일 안 증권사별 가장 최근 목표가 평균·현재가 대비 상승 여력·의견 수.
    같은 증권사 리포트가 여러 출처에 있으면 한 번만 센다(한경 > 네이버 > 텔레그램). 미국 종목은 Nasdaq 컨센서스(analyst)도."""
    raw = ticker.strip()
    t = raw.upper() if raw.upper().endswith((".KS", ".KQ")) else _canon_us_ticker(raw)
    days = max(7, min(int(request.args.get("days") or 180), 730))
    home = _home_json(f"/api/broker-research/{t}", {"days": days}, f"brs_home_{t}_{days}", "posts")
    if home is not None:
        return jsonify(home)
    posts = _feed_rows(days, tk=t, cat="company", limit=200)
    is_kr = t.endswith((".KS", ".KQ"))
    src_list = cache.get("kr_stocks" if is_kr else "stocks") or []
    price = next((x.get("price") for x in src_list if x.get("ticker") == t), None)
    want = "KRW" if is_kr else "USD"
    rank = {"hk": 0, "naver": 1, "tg": 2}
    latest = {}
    for p in sorted(posts, key=lambda x: (-x["timestamp"], rank.get(x["src"], 3))):
        if not (p["single"] and p["target"] and (p["cur"] or want) == want and time.time() - p["timestamp"] < 120 * 86400):
            continue
        if price and not (0.3 <= p["target"] / price <= 5):
            continue
        latest.setdefault(p["bkey"], p)
    tg = [p["target"] for p in latest.values()]
    ops = {}
    for p in latest.values():
        if p.get("opinion"):
            ops[p["opinion"]] = ops.get(p["opinion"], 0) + 1
    mean = sum(tg) / len(tg) if tg else None
    out = {"ticker": t, "posts": posts, "summary": {
        "brokers": len(latest), "target_mean": round(mean, 2) if mean else None, "cur": want, "price": price,
        "upside": round((mean / price - 1) * 100, 1) if mean and price else None, "opinions": ops,
        "targets": [{"broker": p["broker"], "target": p["target"], "timestamp": p["timestamp"], "opinion": p["opinion"], "src": p["src"]}
                    for p in latest.values()]}}
    if not is_kr:
        out["analyst"] = _us_analyst(t)
    return jsonify(out)


def _us_analyst(t: str) -> dict:
    key = f"nasdaq_analyst_{t}"
    d = cache.get_fresh(key)
    if d is None:
        d = df.fetch_nasdaq_analyst(t)
        cache.set(key, d, ttl=6 * 3600 if d else 1800)
    return d or {}


# ── 미국 종목 실적 (11-25) ─────────────────────────────────────────────────────
def _earn_reaction(bars: list, day: str, hour: str) -> dict:
    """실적 발표 주가 반응 — 장 후(amc): 발표일 종가 → 다음 거래일 종가, 장 전(bmo): 전 거래일 종가 → 발표일 종가,
    모름: 전 거래일 종가 → 다음 거래일 종가(이틀 창). 5일 반응은 기준 종가 → 5거래일 뒤 종가."""
    days = [str(b.get("time"))[:10] for b in bars]
    if not days or day > days[-1]:
        return {}
    i = next((k for k, d in enumerate(days) if d >= day), None)   # 발표일(또는 그 뒤 첫 거래일)
    if i is None:
        return {}
    on = days[i] == day
    if hour == "amc" and on:
        b, a = i, i + 1
    elif hour == "bmo" and on:
        b, a = i - 1, i
    else:
        b, a = i - 1, (i + 1 if on else i)
    if b < 0 or a >= len(bars):
        return {}
    base = bars[b]["close"]
    out = {"r1": round((bars[a]["close"] / base - 1) * 100, 2)}
    if a + 4 < len(bars):
        out["r5"] = round((bars[a + 4]["close"] / base - 1) * 100, 2)
    return out


@app.route("/api/earnings-stock/<ticker>")
def earnings_stock_api(ticker):
    """미국 종목 실적 한눈에 — 다음 발표일(남은 일수·장 전/후), 분기·연간 EPS 예상, 최근 4분기 서프라이즈와 발표 뒤 주가 반응,
    요약(예상 상회 횟수·평균 반응). 6시간 캐시. 발표 결과는 events 표에도 쌓는다."""
    t = _canon_us_ticker(ticker.strip())
    if t.endswith((".KS", ".KQ")):
        return jsonify({"ticker": t, "market": "KR"})
    key = f"earn_stock_{t}"
    hit = cache.get_fresh(key)
    if hit is not None:
        return jsonify(hit)
    cal = df.fetch_finnhub_earnings_hist(t)
    nq = df.fetch_nasdaq_eps(t)
    today = date.today().isoformat()
    nxt = next((x for x in cal if x["date"] >= today), None)
    hours = {x["date"]: x["hour"] for x in cal}
    hist = {x["date"]: {"date": x["date"], "period": x["period"], "eps": x["eps"], "est": x["est"], "pct": x["pct"]} for x in nq["surprise"]}
    for x in cal:   # Finnhub에만 있는 최근 결과
        if x["date"] < today and x["eps_act"] is not None and x["date"] not in hist and x["eps_est"]:
            hist[x["date"]] = {"date": x["date"], "period": f"{x['year']} Q{x['quarter']}", "eps": x["eps_act"], "est": round(x["eps_est"], 2),
                               "pct": round((x["eps_act"] / x["eps_est"] - 1) * 100, 2) if x["eps_est"] else None}
    rows = sorted(hist.values(), key=lambda x: x["date"], reverse=True)[:8]
    bars = _chart_rows(t, "2y", "1d", None)
    for r in rows:
        r["hour"] = hours.get(r["date"], "")
        r.update(_earn_reaction(bars, r["date"], r["hour"]))
    beats = [r for r in rows if r.get("pct") is not None and r["pct"] > 0]
    reacts = [r["r1"] for r in rows if r.get("r1") is not None]
    out = {"ticker": t, "market": "US", "next": None, "quarterly": nq["quarterly"], "yearly": nq["yearly"], "history": rows,
           "summary": {"n": len([r for r in rows if r.get("pct") is not None]), "beats": len(beats),
                       "avg_abs_move": round(sum(abs(x) for x in reacts) / len(reacts), 2) if reacts else None,
                       "avg_move_beat": round(sum(r["r1"] for r in beats if r.get("r1") is not None) / max(1, len([r for r in beats if r.get("r1") is not None])), 2) if beats else None}}
    if nxt:
        out["next"] = {"date": nxt["date"], "hour": nxt["hour"], "days": (date.fromisoformat(nxt["date"]) - date.today()).days,
                       "eps_est": nxt["eps_est"], "rev_est": nxt["rev_est"]}
    try:   # 이벤트 기록 (이미 있으면 반응 값만 갱신)
        evs = [("us_earn", t, r["date"], json.dumps({k: r.get(k) for k in ("period", "eps", "est", "pct", "hour", "r1", "r5")})) for r in rows]
        if evs:
            with _na_lock, closing(_na_db()) as con:
                con.executemany("INSERT OR REPLACE INTO events VALUES (?,?,?,?)", evs)
                con.commit()
    except sqlite3.Error as e:
        log.warning(f"실적 이벤트 저장 실패: {e}")
    cache.set(key, out, ttl=6 * 3600 if (rows or nxt) else 1800)
    return jsonify(out)


@app.route("/api/earnings-soon")
def earnings_soon_api():
    """실적 발표가 가까운 미국 종목 {티커: {date, time, days}} — 이번 주·다음 주 캘린더(Nasdaq)에서 오늘 이후. D-n 배지용."""
    today = date.today()
    out = {}
    for x in cache.get("earnings") or []:
        try:
            d = date.fromisoformat(x["date"])
        except (ValueError, KeyError):
            continue
        if d >= today and x["symbol"] not in out:
            out[x["symbol"].replace(".", "/")] = {"date": x["date"], "time": x.get("time"), "days": (d - today).days}
    return jsonify(out)


@app.route("/api/reports-feed")
def reports_feed_api():
    """뉴스 탭 🏦 증권사 리포트 목록 — 텔레그램·네이버 리서치·한경을 합쳐. ?days=7&src=tg|naver|hk&cat=company|industry|market|economy&q="""
    days = max(1, min(int(request.args.get("days") or 7), 90))
    src, cat, q = (request.args.get("src") or ""), (request.args.get("cat") or ""), (request.args.get("q") or "").strip()
    home = _home_json("/api/reports-feed", {"days": days, "src": src, "cat": cat, "q": q}, f"rf_home_{days}_{src}_{cat}_{q}", None)
    if home is not None:
        return jsonify(home)
    return jsonify(_feed_rows(days, src=src, cat=cat, q=q))


@app.route("/api/report-digest")
def report_digest_api():
    """📋 오늘의 리포트 정리 (11-24, 규칙 기반·무료). ?date=YYYY-MM-DD(한국 날짜, 기본 오늘).
    목표가 상향·하향·신규(리포트 문구 또는 같은 증권사의 이전 목표가와 비교) · 의견 변경 · 업종 의견 · 많이 다뤄진 종목 · 증권사별 건수."""
    from zoneinfo import ZoneInfo
    day = (request.args.get("date") or datetime.now(ZoneInfo("Asia/Seoul")).strftime("%Y-%m-%d"))[:10]
    home = _home_json("/api/report-digest", {"date": day}, f"rd_home_{day}", "date")
    if home is not None:
        return jsonify(home)
    items = _feed_rows(1, day=day, limit=1000)
    prices = {x["ticker"]: x.get("price") for x in (cache.get("kr_stocks") or [])}
    prices.update({x["ticker"]: x.get("price") for x in (cache.get("stocks") or [])})
    # 같은 증권사·종목의 이전 목표가·의견 (그날 이전, 최근 1년)
    prev = {}
    if os.path.exists(NEWS_ARCHIVE_DB):
        with _na_lock, closing(_na_db()) as con:
            for broker, tk, target, opinion, d in con.execute(
                    "SELECT broker, tk, target, opinion, day FROM reports WHERE tk != '' AND day < ? AND day >= ? ORDER BY day",
                    (day, (datetime.strptime(day, "%Y-%m-%d") - timedelta(days=365)).strftime("%Y-%m-%d"))):
                k = (df.broker_key(broker), tk)
                cur = prev.get(k, {})
                prev[k] = {"target": target or cur.get("target"), "opinion": opinion or cur.get("opinion")}
    # 같은 증권사·같은 종목 리포트는 하나로 합친다 — 목표가·의견은 한경 > 네이버 > 텔레그램, 변화 문구(상향·하향·신규)는 있는 출처에서
    rank = {"hk": 0, "naver": 1, "tg": 2}
    merged = {}
    for p in sorted(items, key=lambda x: rank.get(x["src"], 3)):
        if not (p["single"] and p["stocks"]):
            continue
        k = (p["bkey"], p["stocks"][0]["ticker"])
        m = merged.get(k)
        if m is None:
            merged[k] = dict(p)
            continue
        for f in ("target", "cur", "opinion", "chg", "url"):
            if not m.get(f) and p.get(f):
                m[f] = p[f]
        if m.get("chg") in (None, "keep") and p.get("chg") in ("up", "down", "new"):
            m["chg"] = p["chg"]
    rows = []
    for (bk, tk), p in merged.items():
        k = (bk, tk)
        pv = prev.get(k, {})
        chg = p["chg"]
        if chg in (None, "keep") and p["target"] and pv.get("target"):
            chg = "up" if p["target"] > pv["target"] * 1.001 else "down" if p["target"] < pv["target"] * 0.999 else chg
        price = prices.get(tk)
        rows.append({"ticker": tk, "name": p["stocks"][0]["name"], "broker": p["broker"], "src": p["src"], "title": p["title"],
                     "opinion": p["opinion"], "prev_opinion": pv.get("opinion"), "target": p["target"], "prev_target": pv.get("target"),
                     "cur": p["cur"] or "KRW", "chg": chg, "price": price, "url": p["url"],
                     "upside": round((p["target"] / price - 1) * 100, 1) if p["target"] and price and 0.3 <= p["target"] / price <= 5 else None})
    by = lambda c: sorted([r for r in rows if r["chg"] == c], key=lambda r: -(r["upside"] or -999))
    op_changes = [r for r in rows if r["opinion"] and r["prev_opinion"] and r["opinion"] != r["prev_opinion"]]
    industry = []
    for p in items:
        m = re.search(r"([가-힣A-Za-z/·&\s]{2,20})\s*\(\s*(Overweight|Neutral|Underweight|비중\s*확대|중립|비중\s*축소|Positive|Negative)\s*\)", p["title"], re.I)
        if p["cat"] == "industry" or m:
            industry.append({"title": p["title"], "broker": p["broker"], "src": p["src"], "url": p["url"],
                             "sector": m.group(1).strip() if m else "", "view": (m.group(2) if m else "")})
    cnt = {}
    for p in items:
        for st in p["stocks"]:
            c = cnt.setdefault(st["ticker"], {"ticker": st["ticker"], "name": st["name"], "count": 0, "brokers": set()})
            c["count"] += 1; c["brokers"].add(p["bkey"])
    top = sorted(cnt.values(), key=lambda c: (-len(c["brokers"]), -c["count"]))[:10]
    for c in top:
        c["brokers"] = len(c["brokers"])
    brokers = {}
    for p in items:
        brokers[p["bkey"]] = brokers.get(p["bkey"], 0) + 1
    return jsonify({"date": day, "total": len(items), "stock_reports": len(rows),
                    "up": by("up"), "down": by("down"), "new": by("new"), "opinion_changes": op_changes,
                    "industry": industry[:40], "top": top, "brokers": sorted(brokers.items(), key=lambda x: -x[1])[:20],
                    "rows": sorted(rows, key=lambda r: -(r["upside"] or -999))})


@app.route("/api/news-archive/days")
def news_archive_days_api():
    """기록이 있는 날짜와 기사 수 (최근 90일) [{day, count}]."""
    home = _home_json("/api/news-archive/days", {}, "na_home_days", None)
    if home is not None:
        return jsonify(home)
    if not os.path.exists(NEWS_ARCHIVE_DB):
        return jsonify([])
    with _na_lock, closing(_na_db()) as con:
        rows = con.execute("SELECT day, COUNT(*) FROM news GROUP BY day ORDER BY day DESC LIMIT 90").fetchall()
    return jsonify([{"day": d, "count": c} for d, c in rows])


@app.route("/api/stock-news-archive/<ticker>")
def stock_news_archive_api(ticker):
    """종목에 묶어 쌓아 둔 뉴스 (최근 days일, 기본 30) — 차트 오른쪽 칸 '지난 30일 뉴스'."""
    raw = ticker.strip()
    t = raw.upper() if raw.upper().endswith((".KS", ".KQ")) else _canon_us_ticker(raw)
    days = max(1, min(int(request.args.get("days") or 30), 365))
    home = _home_json(f"/api/stock-news-archive/{t}", {"days": days}, f"sna_home_{t}_{days}", None)
    if home is not None:
        return jsonify(home)
    since = int(time.time()) - days * 86400
    return jsonify(_archive_rows("SELECT n.url, title, title_ko, source, market, category, ts, sentiment FROM news n"
                                 " JOIN news_tk t ON t.url = n.url WHERE t.tk = ? AND n.ts >= ? ORDER BY n.ts DESC LIMIT 200",
                                 (t, since)))


@app.route("/api/reports")
def reports():
    return jsonify(cache.get("reports") or [])


def _earn_tab_reactions(items: list) -> list:
    """실적발표 탭의 발표가 끝난 종목(시총 $10B 이상)에 주가 반응(r1)을 붙인다 — 일봉은 캐시된 것 재사용."""
    today = date.today().isoformat()
    out = []
    n = 0
    for x in items:
        x = dict(x)
        if x.get("eps_actual") and x["date"] <= today and (x.get("market_cap") or 0) >= 10 and n < 60:
            n += 1
            hour = "amc" if x.get("time") == "After Close" else "bmo" if x.get("time") == "Before Open" else ""
            try:
                x.update(_earn_reaction(_chart_rows(_canon_us_ticker(x["symbol"]), "3mo", "1d", None), x["date"], hour))
                time.sleep(0.3)   # 야후 429 방지
            except Exception:
                pass
        out.append(x)
    return out


@app.route("/api/earnings")
def earnings():
    period = request.args.get("period", "week")  # today | week | next_week
    all_items = cache.get("earnings") or []

    today = date.today()
    mon   = today - timedelta(days=today.weekday())
    if period == "today":
        target_dates = {today.strftime("%Y-%m-%d")}
    elif period == "next_week":
        next_mon = mon + timedelta(weeks=1)
        target_dates = {(next_mon + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(5)}
    else:
        target_dates = {(mon + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(5)}

    result = [item for item in all_items if item["date"] in target_dates]
    return jsonify(result)


# ── 지수 구성 종목 ──────────────────────────────────────────────────────────────
_DOW30 = {
    "AAPL","AMGN","AXP","BA","CAT","CRM","CSCO","CVX","DIS","DOW",
    "GS","HD","HON","IBM","JNJ","JPM","KO","MCD","MMM","MRK",
    "MSFT","NKE","NVDA","PG","TRV","UBER","UNH","V","VZ","WMT",
}

_NASDAQ100 = {
    "AAPL","ABNB","ADBE","ADI","ADP","ADSK","AEP","AMGN","AMZN","ANSS",
    "ARM","ASML","AVGO","AZN","BIIB","BKNG","BKR","CCEP","CDNS","CDW",
    "CEG","CHTR","CMCSA","COST","CPRT","CRWD","CSCO","CSX","CTAS","CTSH",
    "DDOG","DXCM","EA","EXC","FANG","FAST","FTNT","GEHC","GILD","GOOG",
    "GOOGL","HON","IDXX","INTU","ISRG","KDP","KHC","KLAC","LRCX","LULU",
    "MAR","MCHP","MDLZ","META","MELI","MNST","MRNA","MRVL","MSFT","MU",
    "NFLX","NVDA","NXPI","ODFL","ON","ORLY","PANW","PAYX","PCAR","PDD",
    "PEP","PLTR","PYPL","QCOM","REGN","ROP","ROST","SBUX","SNPS","TCOM",
    "TEAM","TMUS","TSLA","TTD","TXN","VRSK","VRTX","WBD","WDAY","XEL",
    "ZS","AXON","MSTR","INTC","SIRI","NTES",
}


@app.route("/api/index-members")
def index_members():
    all_stocks = cache.get("stocks") or []
    by_cap = sorted(all_stocks, key=lambda x: x.get("market_cap") or 0, reverse=True)

    # S&P 500: Wikipedia 실제 구성종목 우선, 미로드 시 시총 상위 503개 폴백
    sp500_set = cache.get("sp500_tickers") or {s["ticker"] for s in by_cap[:503]}

    # Nasdaq 100: Wikipedia 동적 로드 우선, 미로드 시 정적 Set 폴백
    nasdaq100_set = cache.get("nasdaq100_tickers") or _NASDAQ100

    # Dow 30: Wikipedia 동적 로드 우선, 미로드 시 정적 Set 폴백
    dow30_set = cache.get("dow30_tickers") or _DOW30

    # Russell 2000: IWM CSV 동적 로드 우선, 미로드 시 시총 근사 폴백
    russell2000_set = cache.get("russell2000_tickers") or {
        s["ticker"] for s in by_cap[1000:] if s["ticker"] not in sp500_set
    }

    return jsonify({
        "dow30":       sorted(dow30_set),
        "nasdaq100":   sorted(nasdaq100_set),
        "sp500":       sorted(sp500_set),
        "russell2000": sorted(russell2000_set),
    })


_EMPTY_DAILY_SIGNALS = {
    "us": {"buy": [], "sell": []}, "kr": {"buy": [], "sell": []},
    "volume_surges": {"us": [], "kr": []},
    "candle_patterns": {"us": {"bullish": [], "bearish": []}, "kr": {"bullish": [], "bearish": []}},
    "rsi_divergences": {"us": {"bullish": [], "bearish": []}, "kr": {"bullish": [], "bearish": []}},
    "generated_at": 0,
}


@app.route("/api/daily-signals")
def daily_signals():
    """오늘의 매수/매도 추천 (US/KR 각각, 신호 강도 기준 단기/중기/장기)."""
    data = cache.get("daily_signals")
    return jsonify(data or _EMPTY_DAILY_SIGNALS)


@app.route("/api/volume-surges")
def volume_surges():
    """거래량 급증 종목 (US/KR 각각, 20일 평균 대비 2배 이상) — 일일 신호 배치와 함께 계산됨."""
    data = cache.get("daily_signals") or _EMPTY_DAILY_SIGNALS
    return jsonify(data.get("volume_surges") or {"us": [], "kr": []})


@app.route("/api/candle-patterns")
def candle_patterns():
    """오늘의 캔들 패턴 스캐너 (US/KR 각각, 상승성/하락성) — 일일 신호 배치와 함께 계산됨."""
    data = cache.get("daily_signals") or _EMPTY_DAILY_SIGNALS
    empty = {"bullish": [], "bearish": []}
    return jsonify(data.get("candle_patterns") or {"us": empty, "kr": empty})


@app.route("/api/rsi-divergence")
def rsi_divergence():
    """RSI 다이버전스 스캐너 (US/KR 각각, 상승형/하락형) — 일일 신호 배치와 함께 계산됨."""
    data = cache.get("daily_signals") or _EMPTY_DAILY_SIGNALS
    empty = {"bullish": [], "bearish": []}
    return jsonify(data.get("rsi_divergences") or {"us": empty, "kr": empty})


@app.route("/api/52w-movers")
def week52_movers():
    """52주 신고가/신저가 근접 종목 (US/KR 각각) — 캐시된 데이터로 즉시 계산."""
    kr = cache.get("kr_stocks") or []
    return jsonify({
        "us": df.get_52w_movers(_get_merged_us_stocks()),
        "kr": df.get_52w_movers(kr, is_kr=True),
    })


@app.route("/api/earnings-signals")
def earnings_signals():
    """실적 발표 임박 + 매수/매도 신호 결합 종목 (US 전용, Nasdaq 어닝스 캘린더 소스)."""
    earnings_items = cache.get("earnings") or []
    signals = cache.get("daily_signals") or {}
    return jsonify(df.get_earnings_signal_combo(earnings_items, signals.get("us") or {}))


@app.route("/api/brief")
def brief():
    import time as _time
    from collections import Counter

    period = request.args.get("period", "daily")
    now = _time.time()
    if period == "daily":
        cutoff = now - 86400
    elif period == "weekly":
        cutoff = now - 7 * 86400
    else:  # monthly
        cutoff = now - 30 * 86400

    all_news    = cache.get("news")    or []
    all_reports = cache.get("reports") or []

    news_in    = [n for n in all_news    if n.get("timestamp", 0) >= cutoff]
    reports_in = [r for r in all_reports if r.get("timestamp", 0) >= cutoff]
    combined   = news_in + reports_in

    # ─ Market Mood (감성 분포)
    mood = _compute_market_mood(combined)

    # ─ Top Stories: 중복 제거 + 소스 다양성 + 감성 강도 가중
    top_stories = _dedup_stories(news_in)

    # ─ Most Mentioned Stocks
    tickers = [i["ticker"] for i in combined if i.get("ticker")]
    top_tickers = [{"ticker": t, "count": c} for t, c in Counter(tickers).most_common(8)]

    # ─ Report Highlights: 중복 제거 + 소스 다양성
    report_highlights = _dedup_stories(reports_in, max_per_source=1, top_n=5)

    return jsonify({
        "period":          period,
        "total_items":     len(combined),
        "news_count":      len(news_in),
        "report_count":    len(reports_in),
        "mood":            mood,
        "top_stories":     top_stories,
        "top_tickers":     top_tickers,
        "report_highlights": report_highlights,
    })


VALID_PERIODS   = {"1mo", "3mo", "6mo", "1y", "2y"}
VALID_INTERVALS = {"1m", "5m", "15m", "30m", "60m", "1d", "mo", "yr"}
_CUSTOM_YEARS_RANGE = range(1, 31)  # 기간 직접 입력(연수) 허용 범위 — 2Y 버튼 이상 커버

# interval별 캐시 TTL (초): 분봉일수록 짧게, 월봉·연봉은 하루종일 안 변해도 무방
_CHART_TTL = {
    "1m":  30,
    "5m":  60,
    "15m": 120,
    "30m": 300,
    "60m": 600,
    "1d":  300,
    "mo":  3600,
    "yr":  3600,
}

@app.route("/api/chart/<ticker>")
def chart(ticker):
    t        = _canon_us_ticker(ticker)
    period   = request.args.get("period",   "1y")
    interval = request.args.get("interval", "1d")
    years    = request.args.get("years", type=int)
    if period   not in VALID_PERIODS:   period   = "1y"
    if interval not in VALID_INTERVALS: interval = "1d"
    if years is not None and years not in _CUSTOM_YEARS_RANGE:
        years = None
    ohlcv = _chart_rows(t, period, interval, years)
    return jsonify(ohlcv if ohlcv else _generate_ohlcv_dummy(t))


def _chart_rows(t: str, period: str, interval: str, years: int | None) -> list[dict]:
    """차트 OHLCV (캐시 우선). /api/chart와 /api/chart-warmup 공용. 실패 시 []."""
    ttl  = _CHART_TTL.get(interval, 300)
    key  = f"chart_{t}_{interval}_{years}y-custom" if years else f"chart_{t}_{interval}_{period}"
    cached = cache.get_fresh(key)
    if cached:
        return cached
    ohlcv = df.fetch_ohlcv(t, period=period, interval=interval, years=years)
    if ohlcv:
        cache.set(key, ohlcv, ttl=ttl)
    return ohlcv or []


# 기간 버튼 → 연수 (warmup 조회 범위 계산용)
_PERIOD_YEARS = {"1mo": 1, "3mo": 1, "6mo": 1, "1y": 1, "2y": 2}
_WARMUP_BARS  = 460   # 448일선 + 여유. 화면 첫 봉부터 긴 이평선이 그려지도록 그 앞 데이터를 따로 준다


@app.route("/api/chart-warmup/<ticker>")
def chart_warmup(ticker):
    """일봉 차트의 화면 기간 **앞쪽** 봉(최대 460개). 긴 이동평균선·파란점선 계산에만 쓰고 화면엔 안 그린다.
    /api/chart 응답 모양을 바꾸지 않으려고 따로 둔 엔드포인트 — 일봉(1d)만 지원, 그 외는 []."""
    t        = _canon_us_ticker(ticker)
    period   = request.args.get("period", "1y")
    years    = request.args.get("years", type=int)
    if period not in VALID_PERIODS: period = "1y"
    if years is not None and years not in _CUSTOM_YEARS_RANGE:
        years = None
    rows = _chart_rows(t, period, "1d", years)
    if not rows:
        return jsonify([])
    key = f"chartwarm_{t}_{years}y-custom" if years else f"chartwarm_{t}_{period}"
    hit = cache.get_fresh(key)
    if hit is not None:
        return jsonify(hit)
    ext_years = (years or _PERIOD_YEARS.get(period, 1)) + 2   # 448거래일 ≈ 1.8년
    ext  = df.fetch_ohlcv(t, interval="1d", years=ext_years, _kr_fill=False)
    first = rows[0]["time"]
    warm = [r for r in ext if r["time"] < first][-_WARMUP_BARS:]
    cache.set(key, warm, ttl=6 * 3600 if warm else 300)   # 과거 봉이라 자주 안 바뀜
    return jsonify(warm)


def _canon_us_ticker(raw: str) -> str:
    """URL에는 '/'를 못 넣어 프론트가 BRK/B → BRK-B로 보냄. 목록에 그 표기가 없으면
    BRK/B·LEN.B·OXY.WS 중 목록에 있는 표기로 되돌린다(관심종목 저장값과 같은 키 유지)."""
    t = (raw or "").upper()
    if "-" not in t or t.endswith((".KS", ".KQ")):
        return t
    tickers = {s["ticker"] for s in _get_merged_us_stocks()}
    if t in tickers:
        return t
    alts = [t.replace("-", "/"), t.replace("-", ".")]
    if t.endswith("-WT"):
        alts += [t[:-3] + ".WS", t[:-3] + "/WS"]
    return next((a for a in alts if a in tickers), t)


@app.route("/api/stock/<ticker>")
def stock_detail(ticker):
    t    = _canon_us_ticker(ticker)
    # US 종목 먼저 검색 (_get_merged_us_stocks가 extra_fields·pe_eps 병합까지 처리)
    stock = next((s for s in _get_merged_us_stocks() if s["ticker"] == t), None)
    if stock:
        return jsonify(stock)
    # KR 종목 검색 (.KS / .KQ)
    kr_data = cache.get("kr_stocks") or []
    kr_stock = next((s for s in kr_data if s["ticker"] == t), None)
    if kr_stock:
        return jsonify(dict(kr_stock))
    # 목록(미국 5,000·국내 3,936)에 없는 미국 티커 — ETF 등. Yahoo 현재가로 기본 정보만 만들어 차트가 열리게
    # (11-06 홈 섹터 ETF 칩 → XLK 차트가 "not found"로 비던 문제)
    if re.fullmatch(r"[A-Z][A-Z.\-]{0,9}", t):
        key = f"quote_extra_{t}"
        hit = cache.get_fresh(key)
        if hit is None:
            q = df.fetch_quote(t)
            hit = {}
            if q and q.get("price"):
                sector_ko = dict(df.SECTOR_ETFS).get(t)
                is_etf = q.get("instrument_type") == "ETF" or bool(sector_ko) or t in df.US_ETF_KO
                # 11-12: 이름은 야후 정식 이름(longName), 한글명은 US_ETF_KO·섹터 ETF 표.
                # sector "ETF"면 프론트가 종합 진단·재무제표 요청을 생략(예전엔 404 2건)
                hit = {"ticker": t, "name": q.get("long_name") or t,
                       "name_ko": df.US_ETF_KO.get(t) or (f"{sector_ko} 섹터" if sector_ko else ""),
                       "sector": "ETF" if is_etf else "",
                       "price": q["price"], "change": q["change"], "change_pct": q["change_pct"], "volume": q["volume"],
                       "market_cap": None, "pe": None, "eps": None,
                       "week52_high": q.get("week52_high"), "week52_low": q.get("week52_low")}
            cache.set(key, hit, ttl=60 if hit else 300)
        if hit:
            return jsonify(hit)
    return jsonify({"error": "Not found"}), 404


@app.route("/api/stock-analysis/<ticker>")
def stock_analysis(ticker):
    """종목 종합 진단 — 기술적 신호·밸류에이션·52주 위치·거래량·수급(KR)/뉴스감성(US)을
    항목별로 판정해 요약. 단일 매수/매도 결론을 자동 산출하지 않고 근거만 제공."""
    t = _canon_us_ticker(ticker)
    key = f"stock_analysis_{t}"
    cached = cache.get_fresh(key)
    if cached is not None:
        return jsonify(cached)

    us_stocks = _get_merged_us_stocks()
    stock = next((s for s in us_stocks if s["ticker"] == t), None)
    if stock:
        earnings_items = cache.get("earnings") or []
        result = df.build_stock_analysis(t, stock, us_stocks, is_kr=False, earnings_items=earnings_items)
    else:
        kr_data = cache.get("kr_stocks") or []
        stock = next((s for s in kr_data if s["ticker"] == t), None)
        if not stock:
            return jsonify({"error": "Not found"}), 404
        result = df.build_stock_analysis(t, stock, kr_data, is_kr=True)

    cache.set(key, result, ttl=600)
    return jsonify(result)


@app.route("/api/financials/<ticker>")
def financials(ticker):
    """재무제표 -- KR: 네이버 스크래핑 / US: SEC EDGAR API. 성공 12h / 없음 6h lazy 캐시.
    재무제표 없는 종목(ETF/ADR/SPAC 등)이 US 5,000개 중 상당수라, 404도 캐시해
    차트 열 때마다 SEC EDGAR가 반복 호출되는 것을 막는다(초당 10요청 제한)."""
    t = _canon_us_ticker(ticker)
    key = f"financials_{t}"
    cached = cache.get(key)
    if cached is not None:
        if cached.get("__notfound__"):
            return jsonify({"error": "Not found"}), 404
        return jsonify(cached)

    if t.endswith((".KS", ".KQ")):
        code = df.kr_code(t)
        result = df.fetch_kr_financials(code) if code else None
    else:
        result = df.fetch_us_financials(t)

    if result is None:
        cache.set(key, {"__notfound__": True}, ttl=21600)
        return jsonify({"error": "Not found"}), 404

    cache.set(key, result, ttl=43200)
    return jsonify(result)


@app.route("/api/voice-briefing")
def voice_briefing():
    """오늘의 AI 음성 브리핑 대본+오디오파일 목록. 24시간 배치 캐시(daily_signals와 동일 패턴)."""
    if not VOICE_BRIEFING_ENABLED:
        return jsonify({"turns": [], "generated_at": None, "disabled": True})
    data = cache.get("voice_briefing")
    if not data:
        return jsonify({"turns": [], "generated_at": None})
    return jsonify(data)


@app.route("/api/voice-briefing/audio/<path:filename>")
def voice_briefing_audio(filename):
    return send_from_directory(df.BRIEFING_AUDIO_DIR, filename)


@app.route("/api/fear-greed")
def fear_greed_api():
    data = cache.get("fear_greed")
    if data is None:
        data = df.fetch_fear_greed()
        if data:
            cache.set("fear_greed", data, ttl=1800)
    return jsonify(data or {})


def _home_json(path: str, params: dict, key: str, need: str) -> dict | None:
    """api/home-server-url.txt(집 서버 주소, git 제외)가 있는 서버만: 집 서버 API 결과를 받아온다(5분 캐시).
    미국 기록은 24시간 켜진 집 서버에만 제대로 쌓인다. 집 서버 자신에는 이 파일이 없어 None → 자기 기록으로."""
    try:
        with open(os.path.join(os.path.dirname(__file__), "api", "home-server-url.txt"), encoding="utf-8") as f:
            base = f.readline().strip().rstrip("/")
    except OSError:
        return None
    if not base.startswith("http"):
        return None
    hit = cache.get_fresh(key)
    if hit is not None:
        return hit or None
    try:
        r = requests.get(f"{base}{path}", params=params, timeout=6)
        d = r.json() if r.ok else None
        if need is None:      # 목록 응답 그대로 (종목 뉴스 등)
            d = d if isinstance(d, list) else None
        elif not (isinstance(d, dict) and d.get(need) is not None):
            d = None
    except Exception as e:
        log.info(f"집 서버 {path} 못 받음 — 이 서버 기록 사용: {e}")
        d = None
    if isinstance(d, dict):
        d["from_home"] = True
    cache.set(key, d or {}, ttl=300 if d else 120)
    return d


def _us_flow_from_home(days: int) -> dict | None:
    return _home_json("/api/market-flow", {"market": "US", "days": days}, f"us_flow_home_{days}", "rows")


@app.route("/api/us-stock-flow/<ticker>")
def us_stock_flow_api(ticker):
    """미국 종목 하나의 일별 정규장·프리·애프터 거래량·실제 거래대금 (11-23부터 쌓임). 작업 PC는 집 서버 값."""
    t = _canon_us_ticker(ticker)
    since = (date.today() - timedelta(days=400)).isoformat()
    home = _home_json(f"/api/us-stock-flow/{t}", {}, f"usf_home_{t}", "days")
    if home:
        return jsonify(home)
    return jsonify({"ticker": t, "days": _us_stock_flow_local(t, since)})


@app.route("/api/stock-daily/<ticker>")
def stock_daily_api(ticker):
    """차트 탭 📋 일별 시세 (11-23): 일별 시가·고가·저가·종가·거래량 + 실제 거래대금.
    국내 = 다음 금융 종목 일별(KRX, 과거 거래대금까지). 미국 = 일봉(야후) + 11-23부터 쌓은 종목별 실제 거래대금(정규장)."""
    raw = ticker.strip()
    is_kr = raw.upper().endswith((".KS", ".KQ")) or (len(raw) == 6 and raw[:1].isdigit())
    if is_kr:
        code = df.kr_code(raw)
        key = f"stock_days_kr_{code}"
        rows = cache.get_fresh(key)
        if rows is None:
            rows = df.fetch_kr_stock_days_daum(code, 260)
            cache.set(key, rows, ttl=(600 if _kr_market_window() else 3600) if rows else 120)
        return jsonify({"ticker": raw, "market": "KR", "rows": rows, "amount_source": "daum"})
    t = _canon_us_ticker(raw)
    ohlcv = _chart_rows(t, "2y", "1d", None)[-260:]
    flow = (us_stock_flow_api(t).get_json() or {}).get("days") or {}
    rows = []
    for c in ohlcv:
        d = str(c.get("time"))[:10]
        f = flow.get(d) or {}
        rows.append({"date": d, "open": c.get("open"), "high": c.get("high"), "low": c.get("low"), "close": c.get("close"),
                     "volume": c.get("volume"), "amount": f.get("amount"),
                     "after_amount": f.get("after_amount")})
    amt = [r["date"] for r in rows if r.get("amount")]
    return jsonify({"ticker": t, "market": "US", "rows": rows, "amount_source": "naver",
                    "amount_since": min(amt) if amt else None})


@app.route("/api/market-flow")
def market_flow_api():
    """시장 전체 일별 거래량·거래대금. ?market=KOSPI|KOSDAQ|US&days=60
    국내: 다음 금융 지수 일별(거래대금·거래량 약 12,400일, 1시간 캐시)을 불러온다 — 11-21부터 서버 저장 안 함.
    다음이 실패하면 예전에 쌓아 둔 값 + 네이버 거래량 과거치로. 미국: 서버가 매일 쌓은 값(무료 과거치 없음)."""
    market = (request.args.get("market") or "KOSPI").upper()
    if market not in ("KOSPI", "KOSDAQ", "US"):
        return jsonify({"error": "market은 KOSPI·KOSDAQ·US"}), 400
    days = max(5, min(int(request.args.get("days") or 60), 400))
    if market == "US":   # 미국 기록은 24시간 켜진 집 서버에만 제대로 쌓인다 → 다른 서버(작업 PC 등)는 집 서버 값을 보여 준다 (11-23)
        home = _us_flow_from_home(days)
        if home:
            return jsonify(home)
    stored = _load_market_flow().get(market) or {}
    if market == "US":
        rows = {d: _us_flow_split(v) for d, v in stored.items()}
        stored = {d: v for d, v in stored.items() if rows[d].get("amount")}
    else:
        rows = {d: {"volume": v.get("volume"), "amount": v.get("amount")} for d, v in stored.items()}
    if market != "US":
        dkey = f"market_hist_daum_{market}"
        daum = cache.get_fresh(dkey)
        if daum is None:
            daum = df.fetch_kr_market_history_daum(market, 500)
            cache.set(dkey, daum, ttl=3600 if daum else 300)
        if daum:
            rows = {d: dict(v) for d, v in daum.items()}   # 다음 값이 기준 (11-18·19 서버 저장값과 일치 확인)
            stored = {}
        else:
            key = f"market_vol_hist_{market}"
            hist = cache.get(key)
            if hist is None:
                hist = df.fetch_kr_market_volume_history(market, 420)
                cache.set(key, hist, ttl=21600 if hist else 300)
            for d, v in (hist or {}).items():
                rows.setdefault(d, {"volume": v, "amount": None})
    out = [{"date": d, **rows[d]} for d in sorted(rows)][-(days + 20):]   # 앞 20일은 20일 평균 계산용
    amt = [r["date"] for r in out if r.get("amount")]
    return jsonify({"market": market, "rows": out, "source": "daum" if market != "US" and not stored and amt else "stored",
                    "amount_since": min(amt) if amt else None, "amount_days": len(amt)})


@app.route("/api/market-investors")
def market_investors_api():
    """코스피·코스닥 투자자별 순매수 (다음 금융). ?market=KOSPI|KOSDAQ&days=260
    rows: 일별(오래된 날 먼저, 1시간 캐시), now: 가장 최근 장중 잠정치(60초 캐시). 미국은 공개 데이터가 없어 지원 안 함."""
    market = (request.args.get("market") or "KOSPI").upper()
    if market not in ("KOSPI", "KOSDAQ"):
        return jsonify({"error": "market은 KOSPI·KOSDAQ"}), 400
    days = max(5, min(int(request.args.get("days") or 260), 300))
    key = f"inv_days_{market}"
    rows = cache.get_fresh(key)
    if rows is None:
        rows = df.fetch_kr_investor_days(market, 300)
        cache.set(key, rows, ttl=3600 if rows else 120)
    nkey = f"inv_now_{market}"
    now = cache.get_fresh(nkey)
    if now is None:
        now = df.fetch_kr_investor_now(market) or {}
        cache.set(nkey, now, ttl=60)
    rows = list(rows or [])
    if now.get("date") and (not rows or rows[-1]["date"] < now["date"]):   # 오늘 일별 줄이 아직 없으면 장중 값으로
        rows.append({k: v for k, v in now.items() if k != "time"})
    return jsonify({"market": market, "rows": rows[-days:], "now": now or None})


@app.route("/api/heatmap-perf")
def heatmap_perf():
    period = request.args.get("period", "1w")
    if period not in ("1w", "1m", "3m", "6m", "ytd"):
        period = "1w"
    market = request.args.get("market", "us")
    is_kr  = market == "kr"
    key = f"heatmap_perf_{'kr_' if is_kr else ''}{period}"
    cached = cache.get_fresh(key)
    if cached is not None:
        return jsonify(cached)
    stocks = (cache.get("kr_stocks") or []) if is_kr else (cache.get("stocks") or STOCKS)
    tickers = [s["ticker"] for s in stocks]
    perf = df.fetch_heatmap_perf(tickers, period=period, max_workers=80)
    # 거의 전량 실패(Yahoo 레이트리밋 등 일시적 오류)면 짧게만 캐시해 곧 재시도되게 함
    ttl = (3600 if period == "1w" else 7200) if len(perf) >= len(tickers) * 0.5 else 60
    cache.set(key, perf or {}, ttl=ttl)
    return jsonify(perf or {})


@app.route("/api/sector-etf")
def sector_etf():
    """홈 섹터 줄: S&P 500 섹터 ETF 11개 등락률 (1d·1w·1m). 요청 11번 — 1분 캐시."""
    period = request.args.get("period", "1d")
    if period not in ("1d", "1w", "1m"):
        period = "1d"
    key = f"sector_etf_{period}"
    cached = cache.get_fresh(key)
    if cached is not None:
        return jsonify(cached)
    data = df.fetch_sector_etf_perf(period)
    cache.set(key, data, ttl=60 if len(data) >= 8 else 15)   # 대부분 실패면 짧게만 캐시
    return jsonify(data)


@app.route("/api/economic-calendar")
def economic_calendar():
    days = min(int(request.args.get("days", 21)), 60)
    return jsonify(df.fetch_economic_calendar(days_ahead=days))


@app.route("/api/cache/status")
def cache_status():
    return jsonify(cache.status())


# ── 더미 OHLCV 폴백 ──────────────────────────────────────────────────────────
def _generate_ohlcv_dummy(ticker: str, days: int = 180) -> list[dict]:
    """실시간 OHLCV 조회 실패(Yahoo 레이트리밋/차단/폐지 티커 등) 시 폴백용 랜덤 워크.
    각 봉에 "_dummy": True 태그를 달아, 프론트가 예시 데이터 배너를 띄우고
    SIGNAL 카드 등 오해 소지 있는 계산을 숨기게 한다."""
    stock = next((s for s in STOCKS if s["ticker"] == ticker), None)
    base_price = stock["price"] if stock else 100.0
    seed = int(hashlib.md5(ticker.encode()).hexdigest(), 16) % (10 ** 8)
    rng  = random.Random(seed)
    price = base_price * 0.82
    data  = []
    for i in range(days, 0, -1):
        d_str = (datetime.now() - timedelta(days=i)).strftime("%Y-%m-%d")
        op   = price
        cl   = round(op * (1 + rng.gauss(0.0005, 0.018)), 2)
        hi   = round(max(op, cl) * (1 + rng.uniform(0, 0.012)), 2)
        lo   = round(min(op, cl) * (1 - rng.uniform(0, 0.012)), 2)
        vol  = int((stock["volume"] if stock else 1000000) * rng.uniform(0.5, 1.5))
        data.append({"time": d_str, "open": round(op, 2), "high": hi, "low": lo,
                     "close": cl, "volume": vol, "_dummy": True})
        price = cl
    return data


# ── 미국 주식 더미 데이터 (59개 종목) ─────────────────────────────────────────
STOCKS = [
    # Technology (14)
    {"ticker":"AAPL",  "name":"Apple Inc.",               "sector":"Technology",       "price": 175.50, "change":  1.25, "change_pct":  0.72, "volume": 52000000, "market_cap":2750, "pe": 28.5, "eps":  6.16, "week52_high":198.23, "week52_low":124.17},
    {"ticker":"MSFT",  "name":"Microsoft Corp.",           "sector":"Technology",       "price": 415.20, "change": -2.30, "change_pct": -0.55, "volume": 18000000, "market_cap":3080, "pe": 35.2, "eps": 11.80, "week52_high":430.82, "week52_low":309.45},
    {"ticker":"NVDA",  "name":"NVIDIA Corp.",              "sector":"Technology",       "price": 875.40, "change": 28.50, "change_pct":  3.37, "volume": 35000000, "market_cap":2160, "pe": 68.3, "eps": 12.81, "week52_high":974.00, "week52_low":373.18},
    {"ticker":"GOOGL", "name":"Alphabet Inc.",             "sector":"Technology",       "price": 168.90, "change":  0.75, "change_pct":  0.45, "volume": 22000000, "market_cap":2090, "pe": 25.8, "eps":  6.55, "week52_high":193.31, "week52_low":120.21},
    {"ticker":"META",  "name":"Meta Platforms",            "sector":"Technology",       "price": 515.30, "change": -8.20, "change_pct": -1.57, "volume": 14000000, "market_cap":1310, "pe": 26.4, "eps": 19.52, "week52_high":531.49, "week52_low":279.40},
    {"ticker":"TSLA",  "name":"Tesla Inc.",                "sector":"Technology",       "price": 182.60, "change":  5.30, "change_pct":  2.99, "volume": 98000000, "market_cap": 580, "pe": 42.1, "eps":  4.34, "week52_high":299.29, "week52_low":138.80},
    {"ticker":"AMD",   "name":"Advanced Micro Devices",    "sector":"Technology",       "price": 162.30, "change":  4.10, "change_pct":  2.59, "volume": 45000000, "market_cap": 262, "pe":312.0, "eps":  0.52, "week52_high":227.30, "week52_low": 93.12},
    {"ticker":"INTC",  "name":"Intel Corp.",               "sector":"Technology",       "price":  35.20, "change": -0.80, "change_pct": -2.22, "volume": 55000000, "market_cap": 148, "pe":  8.5, "eps":  4.14, "week52_high": 51.28, "week52_low": 18.51},
    {"ticker":"AVGO",  "name":"Broadcom Inc.",             "sector":"Technology",       "price":1580.00, "change": 22.50, "change_pct":  1.44, "volume":  3500000, "market_cap": 736, "pe": 52.4, "eps": 30.15, "week52_high":1977.44,"week52_low":746.22},
    {"ticker":"ORCL",  "name":"Oracle Corp.",              "sector":"Technology",       "price": 128.50, "change":  1.20, "change_pct":  0.94, "volume":  8000000, "market_cap": 350, "pe": 33.2, "eps":  3.87, "week52_high":164.71, "week52_low": 99.26},
    {"ticker":"CRM",   "name":"Salesforce Inc.",           "sector":"Technology",       "price": 265.40, "change":  3.80, "change_pct":  1.45, "volume":  5500000, "market_cap": 258, "pe": 45.8, "eps":  5.79, "week52_high":318.71, "week52_low":195.58},
    {"ticker":"ADBE",  "name":"Adobe Inc.",                "sector":"Technology",       "price": 520.30, "change": -6.40, "change_pct": -1.22, "volume":  3200000, "market_cap": 238, "pe": 46.2, "eps": 11.26, "week52_high":638.25, "week52_low":433.95},
    {"ticker":"QCOM",  "name":"Qualcomm Inc.",             "sector":"Technology",       "price": 168.40, "change":  2.30, "change_pct":  1.38, "volume": 10000000, "market_cap": 188, "pe": 23.5, "eps":  7.17, "week52_high":230.63, "week52_low":106.94},
    {"ticker":"MU",    "name":"Micron Technology",         "sector":"Technology",       "price": 130.20, "change":  4.50, "change_pct":  3.58, "volume": 20000000, "market_cap": 144, "pe": 36.8, "eps":  3.54, "week52_high":157.54, "week52_low": 53.40},
    # Finance (10)
    {"ticker":"JPM",   "name":"JPMorgan Chase",            "sector":"Finance",          "price": 198.40, "change":  2.10, "change_pct":  1.07, "volume": 12000000, "market_cap": 572, "pe": 11.8, "eps": 16.82, "week52_high":220.82, "week52_low":135.19},
    {"ticker":"BAC",   "name":"Bank of America",           "sector":"Finance",          "price":  38.50, "change":  0.45, "change_pct":  1.18, "volume": 42000000, "market_cap": 295, "pe": 12.5, "eps":  3.08, "week52_high": 44.44, "week52_low": 24.96},
    {"ticker":"GS",    "name":"Goldman Sachs",             "sector":"Finance",          "price": 485.20, "change": -3.80, "change_pct": -0.78, "volume":  2800000, "market_cap": 164, "pe": 16.2, "eps": 29.95, "week52_high":532.88, "week52_low":288.56},
    {"ticker":"MS",    "name":"Morgan Stanley",            "sector":"Finance",          "price": 102.30, "change":  1.20, "change_pct":  1.19, "volume": 11000000, "market_cap": 168, "pe": 18.4, "eps":  5.56, "week52_high":116.38, "week52_low": 69.54},
    {"ticker":"V",     "name":"Visa Inc.",                 "sector":"Finance",          "price": 282.50, "change":  1.85, "change_pct":  0.66, "volume":  6800000, "market_cap": 580, "pe": 31.5, "eps":  8.97, "week52_high":290.96, "week52_low":213.83},
    {"ticker":"MA",    "name":"Mastercard Inc.",           "sector":"Finance",          "price": 482.30, "change":  3.20, "change_pct":  0.67, "volume":  3200000, "market_cap": 454, "pe": 36.8, "eps": 13.10, "week52_high":496.30, "week52_low":344.67},
    {"ticker":"WFC",   "name":"Wells Fargo",               "sector":"Finance",          "price":  58.30, "change":  0.90, "change_pct":  1.57, "volume": 22000000, "market_cap": 208, "pe": 12.1, "eps":  4.82, "week52_high": 67.18, "week52_low": 38.38},
    {"ticker":"BLK",   "name":"BlackRock Inc.",            "sector":"Finance",          "price": 798.40, "change":  8.20, "change_pct":  1.04, "volume":  1100000, "market_cap": 119, "pe": 21.8, "eps": 36.62, "week52_high":845.69, "week52_low":632.35},
    {"ticker":"C",     "name":"Citigroup Inc.",            "sector":"Finance",          "price":  62.40, "change": -0.60, "change_pct": -0.95, "volume": 18000000, "market_cap": 119, "pe":  9.8, "eps":  6.37, "week52_high": 73.87, "week52_low": 38.18},
    {"ticker":"AXP",   "name":"American Express",          "sector":"Finance",         "price": 232.80, "change":  2.50, "change_pct":  1.09, "volume":  3500000, "market_cap": 168, "pe": 19.5, "eps": 11.94, "week52_high":242.51, "week52_low":142.06},
    # Healthcare (8)
    {"ticker":"JNJ",   "name":"Johnson & Johnson",         "sector":"Healthcare",       "price": 147.80, "change": -1.20, "change_pct": -0.81, "volume":  9500000, "market_cap": 356, "pe": 24.3, "eps":  6.08, "week52_high":175.97, "week52_low":143.13},
    {"ticker":"UNH",   "name":"UnitedHealth Group",        "sector":"Healthcare",       "price": 492.50, "change":  5.80, "change_pct":  1.19, "volume":  3100000, "market_cap": 453, "pe": 21.5, "eps": 22.91, "week52_high":558.47, "week52_low":419.45},
    {"ticker":"PFE",   "name":"Pfizer Inc.",               "sector":"Healthcare",       "price":  28.30, "change": -0.40, "change_pct": -1.39, "volume": 35000000, "market_cap": 160, "pe": 45.6, "eps":  0.62, "week52_high": 43.01, "week52_low": 25.20},
    {"ticker":"ABBV",  "name":"AbbVie Inc.",               "sector":"Healthcare",       "price": 172.40, "change":  1.90, "change_pct":  1.11, "volume":  7200000, "market_cap": 304, "pe": 52.3, "eps":  3.30, "week52_high":182.04, "week52_low":120.57},
    {"ticker":"LLY",   "name":"Eli Lilly and Co.",         "sector":"Healthcare",       "price": 820.50, "change": 15.30, "change_pct":  1.90, "volume":  3800000, "market_cap": 780, "pe":112.4, "eps":  7.30, "week52_high":862.64, "week52_low":423.82},
    {"ticker":"MRK",   "name":"Merck & Co.",               "sector":"Healthcare",       "price": 128.60, "change":  0.80, "change_pct":  0.63, "volume":  8900000, "market_cap": 326, "pe": 19.2, "eps":  6.70, "week52_high":134.63, "week52_low": 97.02},
    {"ticker":"TMO",   "name":"Thermo Fisher Scientific",  "sector":"Healthcare",       "price": 565.30, "change": -4.20, "change_pct": -0.74, "volume":  1800000, "market_cap": 218, "pe": 31.5, "eps": 17.95, "week52_high":609.86, "week52_low":440.32},
    {"ticker":"ABT",   "name":"Abbott Laboratories",       "sector":"Healthcare",       "price": 108.40, "change":  1.10, "change_pct":  1.02, "volume":  5500000, "market_cap": 188, "pe": 31.8, "eps":  3.41, "week52_high":118.36, "week52_low": 88.47},
    # Energy (4)
    {"ticker":"XOM",   "name":"Exxon Mobil Corp.",         "sector":"Energy",           "price": 112.30, "change": -0.90, "change_pct": -0.80, "volume": 18000000, "market_cap": 453, "pe": 13.8, "eps":  8.14, "week52_high":123.75, "week52_low": 95.77},
    {"ticker":"CVX",   "name":"Chevron Corp.",             "sector":"Energy",           "price": 155.20, "change":  1.40, "change_pct":  0.91, "volume": 11000000, "market_cap": 296, "pe": 15.2, "eps": 10.21, "week52_high":172.72, "week52_low":135.86},
    {"ticker":"COP",   "name":"ConocoPhillips",            "sector":"Energy",           "price": 118.50, "change":  2.10, "change_pct":  1.80, "volume":  7500000, "market_cap": 147, "pe": 14.5, "eps":  8.17, "week52_high":135.94, "week52_low": 95.43},
    {"ticker":"SLB",   "name":"SLB (Schlumberger)",        "sector":"Energy",           "price":  48.20, "change": -0.50, "change_pct": -1.03, "volume": 14000000, "market_cap":  68, "pe": 15.8, "eps":  3.05, "week52_high": 59.32, "week52_low": 42.18},
    # Consumer Disc. (6)
    {"ticker":"AMZN",  "name":"Amazon.com Inc.",           "sector":"Consumer Disc.",   "price": 192.50, "change":  3.20, "change_pct":  1.69, "volume": 28000000, "market_cap":2020, "pe": 58.2, "eps":  3.31, "week52_high":201.20, "week52_low":101.26},
    {"ticker":"HD",    "name":"Home Depot Inc.",           "sector":"Consumer Disc.",   "price": 342.80, "change": -4.20, "change_pct": -1.21, "volume":  4200000, "market_cap": 340, "pe": 22.5, "eps": 15.23, "week52_high":396.52, "week52_low":274.97},
    {"ticker":"COST",  "name":"Costco Wholesale",          "sector":"Consumer Disc.",   "price": 858.30, "change":  8.50, "change_pct":  1.00, "volume":  2200000, "market_cap": 380, "pe": 52.8, "eps": 16.26, "week52_high":923.83, "week52_low":680.82},
    {"ticker":"NKE",   "name":"Nike Inc.",                 "sector":"Consumer Disc.",   "price":  95.40, "change": -1.80, "change_pct": -1.85, "volume": 10000000, "market_cap": 144, "pe": 27.4, "eps":  3.48, "week52_high":123.21, "week52_low": 70.75},
    {"ticker":"MCD",   "name":"McDonald's Corp.",          "sector":"Consumer Disc.",   "price": 285.60, "change":  1.20, "change_pct":  0.42, "volume":  4800000, "market_cap": 204, "pe": 24.8, "eps": 11.51, "week52_high":317.97, "week52_low":245.73},
    {"ticker":"SBUX",  "name":"Starbucks Corp.",           "sector":"Consumer Disc.",   "price":  78.30, "change": -2.10, "change_pct": -2.61, "volume":  9500000, "market_cap":  88, "pe": 23.5, "eps":  3.33, "week52_high":115.48, "week52_low": 71.61},
    # Consumer Staples (4)
    {"ticker":"WMT",   "name":"Walmart Inc.",              "sector":"Consumer Staples", "price":  68.40, "change":  0.55, "change_pct":  0.81, "volume": 15000000, "market_cap": 548, "pe": 36.1, "eps":  1.89, "week52_high": 74.46, "week52_low": 47.19},
    {"ticker":"PG",    "name":"Procter & Gamble",          "sector":"Consumer Staples", "price": 165.20, "change":  0.80, "change_pct":  0.49, "volume":  7200000, "market_cap": 391, "pe": 26.4, "eps":  6.26, "week52_high":173.31, "week52_low":131.96},
    {"ticker":"KO",    "name":"Coca-Cola Co.",             "sector":"Consumer Staples", "price":  62.40, "change":  0.30, "change_pct":  0.48, "volume": 13000000, "market_cap": 269, "pe": 26.5, "eps":  2.36, "week52_high": 66.87, "week52_low": 51.55},
    {"ticker":"PEP",   "name":"PepsiCo Inc.",              "sector":"Consumer Staples", "price": 175.30, "change": -0.70, "change_pct": -0.40, "volume":  5800000, "market_cap": 240, "pe": 24.8, "eps":  7.07, "week52_high":196.88, "week52_low":155.83},
    # Industrial (5)
    {"ticker":"BA",    "name":"Boeing Co.",                "sector":"Industrial",       "price": 188.20, "change": -2.50, "change_pct": -1.31, "volume":  9800000, "market_cap": 115, "pe":   0.0,"eps":-19.45, "week52_high":267.54, "week52_low":159.70},
    {"ticker":"CAT",   "name":"Caterpillar Inc.",          "sector":"Industrial",       "price": 352.40, "change":  4.20, "change_pct":  1.21, "volume":  3500000, "market_cap": 175, "pe": 17.2, "eps": 20.49, "week52_high":388.63, "week52_low":208.37},
    {"ticker":"HON",   "name":"Honeywell Intl.",           "sector":"Industrial",       "price": 196.30, "change":  1.80, "change_pct":  0.93, "volume":  4200000, "market_cap": 127, "pe": 23.4, "eps":  8.39, "week52_high":229.43, "week52_low":181.86},
    {"ticker":"UPS",   "name":"United Parcel Service",     "sector":"Industrial",       "price": 148.20, "change": -3.40, "change_pct": -2.24, "volume":  6800000, "market_cap": 126, "pe": 20.1, "eps":  7.37, "week52_high":193.02, "week52_low":130.66},
    {"ticker":"RTX",   "name":"RTX Corp.",                 "sector":"Industrial",       "price": 105.30, "change":  0.90, "change_pct":  0.86, "volume":  7200000, "market_cap": 140, "pe": 40.5, "eps":  2.60, "week52_high":106.48, "week52_low": 63.76},
    # Communication (3)
    {"ticker":"NFLX",  "name":"Netflix Inc.",              "sector":"Communication",    "price": 628.50, "change": 12.30, "change_pct":  1.99, "volume":  4200000, "market_cap": 271, "pe": 48.2, "eps": 13.04, "week52_high":700.64, "week52_low":344.73},
    {"ticker":"DIS",   "name":"Walt Disney Co.",           "sector":"Communication",    "price": 112.40, "change": -1.60, "change_pct": -1.40, "volume": 12000000, "market_cap": 205, "pe": 72.8, "eps":  1.54, "week52_high":123.74, "week52_low": 78.73},
    {"ticker":"T",     "name":"AT&T Inc.",                 "sector":"Communication",    "price":  18.20, "change":  0.10, "change_pct":  0.55, "volume": 55000000, "market_cap": 130, "pe": 12.5, "eps":  1.46, "week52_high": 20.77, "week52_low": 14.46},
    # Real Estate (2)
    {"ticker":"AMT",   "name":"American Tower Corp.",      "sector":"Real Estate",      "price": 198.40, "change":  2.80, "change_pct":  1.43, "volume":  2400000, "market_cap":  93, "pe": 48.7, "eps":  4.07, "week52_high":242.72, "week52_low":154.58},
    {"ticker":"PLD",   "name":"Prologis Inc.",             "sector":"Real Estate",      "price": 128.30, "change": -1.10, "change_pct": -0.85, "volume":  5800000, "market_cap": 119, "pe": 37.2, "eps":  3.45, "week52_high":140.44, "week52_low":100.59},
    # Materials (2)
    {"ticker":"LIN",   "name":"Linde plc",                 "sector":"Materials",        "price": 458.20, "change":  3.50, "change_pct":  0.77, "volume":  1800000, "market_cap": 218, "pe": 33.8, "eps": 13.56, "week52_high":479.24, "week52_low":352.72},
    {"ticker":"APD",   "name":"Air Products & Chemicals",  "sector":"Materials",        "price": 265.40, "change": -2.20, "change_pct": -0.82, "volume":  1500000, "market_cap":  59, "pe": 23.6, "eps": 11.25, "week52_high":336.86, "week52_low":233.56},
    # Utilities (2)
    {"ticker":"NEE",   "name":"NextEra Energy",            "sector":"Utilities",        "price":  68.30, "change":  0.40, "change_pct":  0.59, "volume":  9500000, "market_cap": 139, "pe": 21.4, "eps":  3.19, "week52_high": 85.76, "week52_low": 44.67},
    {"ticker":"DUK",   "name":"Duke Energy Corp.",         "sector":"Utilities",        "price": 102.40, "change":  0.60, "change_pct":  0.59, "volume":  4200000, "market_cap":  66, "pe": 20.8, "eps":  4.92, "week52_high":108.38, "week52_low": 87.65},
]

# ── 지수 더미 데이터 ────────────────────────────────────────────────────────────
INDICES = [
    {"name":"S&P 500",      "value":  5248.32, "change":   18.54, "change_pct":  0.35},
    {"name":"NASDAQ",       "value": 16428.82, "change":  -45.23, "change_pct": -0.27},
    {"name":"Dow Jones",    "value": 39387.76, "change":  125.08, "change_pct":  0.32},
    {"name":"Russell 2000", "value":  2082.47, "change":    8.34, "change_pct":  0.40},
    {"name":"KOSPI",        "value":  2700.00, "change":   15.00, "change_pct":  0.56},
    {"name":"KOSDAQ",       "value":   870.00, "change":    3.50, "change_pct":  0.40},
    {"name":"US500",        "value":  5230.00, "change":   18.00, "change_pct":  0.34},
    {"name":"US30",         "value": 38950.00, "change":  120.00, "change_pct":  0.31},
    {"name":"US Tech 100",  "value": 18350.00, "change":  -55.00, "change_pct": -0.30},
    {"name":"WTI Crude",    "value":    82.45, "change":    0.87, "change_pct":  1.07},
    {"name":"Gold",         "value":  2325.80, "change":  -12.30, "change_pct": -0.53},
    {"name":"Bitcoin",      "value": 67500.00, "change":  850.00, "change_pct":  1.28},
    {"name":"10Y Yield",    "value":     4.42, "change":    0.03, "change_pct":  0.68},
    {"name":"DXY",          "value":   104.52, "change":   -0.18, "change_pct": -0.17},
    {"name":"EUR/USD",      "value":    1.082, "change":  -0.001, "change_pct": -0.11},
    {"name":"VIX",          "value":    13.52, "change":   -0.48, "change_pct": -3.43},
]

# ── 뉴스 더미 데이터 ────────────────────────────────────────────────────────────
NEWS = [
    {"id": 1, "title":"NVIDIA Surges After Reporting Record Q1 Revenue, Beats Estimates by Wide Margin",   "source":"Bloomberg",       "time":"10m ago",  "ticker":"NVDA", "sentiment":"positive"},
    {"id": 2, "title":"Fed Holds Rates Steady, Signals Just One Cut Possible This Year",                    "source":"Reuters",         "time":"35m ago",  "ticker":None,   "sentiment":"neutral"},
    {"id": 3, "title":"Apple Set to Unveil AI-Powered Features Across iPhone Lineup at WWDC",              "source":"WSJ",             "time":"1h ago",   "ticker":"AAPL", "sentiment":"positive"},
    {"id": 4, "title":"Tesla Faces Expanded Recall on Cybertruck Over Safety Concerns",                     "source":"CNBC",            "time":"2h ago",   "ticker":"TSLA", "sentiment":"negative"},
    {"id": 5, "title":"Eli Lilly's Obesity Drug Zepbound Shows Strong Demand, Raises Full-Year Outlook",   "source":"Financial Times", "time":"3h ago",   "ticker":"LLY",  "sentiment":"positive"},
    {"id": 6, "title":"Meta Confirms 2025 Launch Date for AR Glasses, Shares Jump 3%",                     "source":"TechCrunch",      "time":"4h ago",   "ticker":"META", "sentiment":"positive"},
    {"id": 7, "title":"JPMorgan Raises S&P 500 Year-End Target to 5,500 Amid Earnings Optimism",           "source":"Bloomberg",       "time":"5h ago",   "ticker":"JPM",  "sentiment":"positive"},
    {"id": 8, "title":"Starbucks CEO Steps Down Amid Slowing Sales and Customer Traffic Decline",           "source":"Reuters",         "time":"6h ago",   "ticker":"SBUX", "sentiment":"negative"},
    {"id": 9, "title":"US CPI Comes in Slightly Above Expectations, Weighing on Rate Cut Bets",             "source":"AP",              "time":"7h ago",   "ticker":None,   "sentiment":"negative"},
    {"id":10, "title":"Netflix Adds 9.3M Subscribers in Q1, Surpassing Wall Street Forecasts",             "source":"CNBC",            "time":"8h ago",   "ticker":"NFLX", "sentiment":"positive"},
    {"id":11, "title":"Intel Announces $8.5B in Federal Grants to Boost US Chip Manufacturing",            "source":"WSJ",             "time":"9h ago",   "ticker":"INTC", "sentiment":"positive"},
    {"id":12, "title":"Boeing Faces New FAA Investigation Over Quality Control at 737 MAX Plant",           "source":"Financial Times", "time":"10h ago",  "ticker":"BA",   "sentiment":"negative"},
]


if __name__ == "__main__":
    initial_load()
    _scheduler.start()
    # Render 등 호스팅 서비스는 PORT 환경변수로 포트를 지정하고, 0.0.0.0으로 바인딩해야
    # 외부에서 접속 가능하다. 로컬 실행 시(.env 미설정)에는 기존처럼 5001 포트를 사용.
    # [보안] 0.0.0.0은 Render(RENDER 환경변수 자동 설정)에서만 — 로컬은 127.0.0.1로 고정해
    # 같은 네트워크(공용 와이파이 등)의 다른 기기가 접속하지 못하게 한다.
    _port = int(os.environ.get("PORT", 5001))
    _host = "0.0.0.0" if os.environ.get("RENDER") else "127.0.0.1"
    socketio.run(app, host=_host, port=_port, debug=False, allow_unsafe_werkzeug=True)
