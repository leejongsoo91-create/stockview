import gzip
import hashlib
import json
import logging
import os
import queue
import random
import re
import threading
from datetime import date, datetime, timedelta
from flask import Flask, render_template, jsonify, request, send_from_directory
from flask_socketio import SocketIO
from apscheduler.schedulers.background import BackgroundScheduler

from cache import Cache
import data_fetcher as df

PE_EPS_FILE  = os.path.join(os.path.dirname(__file__), "data", "pe_eps_cache.json")
KR_STOCKS_FILE = os.path.join(os.path.dirname(__file__), "data", "kr_stocks.json")

def _load_kr_base() -> list:
    try:
        if os.path.exists(KR_STOCKS_FILE):
            with open(KR_STOCKS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        log.warning(f"kr_stocks.json 로드 실패: {e}")
    return []

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
            cache.set("stocks",      nasdaq, ttl=300)
            cache.set("market_caps",
                      {s["ticker"]: s["market_cap"] for s in nasdaq if s.get("market_cap")},
                      ttl=3600)
            _emit_queue.put(("stocks_update", {"count": len(nasdaq)}))
            return
    updated = df.refresh_prices_parallel(base)
    if updated:
        cache.set("stocks", _apply_market_caps(updated), ttl=300)
        _emit_queue.put(("stocks_update", {"count": len(updated)}))


def refresh_kr_stocks():
    """국내주식 가격 갱신 (Yahoo Finance). kr_stocks.json 기반.

    시총 큰 종목부터 chunk 단위로 갱신하고 chunk마다 캐시에 즉시 반영한다.
    이전 주기에 갱신된 행(updated_at 있음)은 이어서 쓰므로, 다음 주기 도중에 파일의 옛 값으로 되돌아가지 않는다.
    """
    base = _load_kr_base()
    if not base:
        return
    prev = {s.get("ticker"): s for s in (cache.get("kr_stocks") or []) if s.get("updated_at")}
    if prev:
        base = [prev.get(s.get("ticker"), s) for s in base]

    def _publish(rows):
        cache.set("kr_stocks", rows, ttl=300)

    updated = df.fetch_kr_prices(base, on_progress=_publish)
    if updated:
        cache.set("kr_stocks", updated, ttl=300)
        _emit_queue.put(("kr_stocks_update", {"count": len(updated)}))
        log.info(f"국내주식 가격 갱신: {len(updated)}개")


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


def refresh_news():
    log.info("뉴스 갱신 시작...")
    try:
        news_data = df.fetch_news()
        if news_data:
            cache.set("news", news_data, ttl=600)
            log.info(f"뉴스 갱신 완료: {len(news_data)}건")
            _emit_queue.put(("news_update", {"count": len(news_data)}))
    except Exception as e:
        log.warning(f"뉴스 갱신 실패: {e}")


def refresh_kr_market_news():
    """국내 경제/증시 RSS 뉴스 갱신 -- 10분 캐시 (해외 뉴스와 동일 주기)"""
    log.info("국내 뉴스 갱신 시작...")
    try:
        kr_news_data = df.fetch_kr_market_news()
        if kr_news_data:
            cache.set("kr_market_news", kr_news_data, ttl=600)
            log.info(f"국내 뉴스 갱신 완료: {len(kr_news_data)}건")
    except Exception as e:
        log.warning(f"국내 뉴스 갱신 실패: {e}")


def refresh_av_news():
    """Alpha Vantage 뉴스 갱신 — 12시간 캐시 (하루 25회 한도 보호)"""
    log.info("AlphaVantage 뉴스 갱신 시작...")
    try:
        av_data = df.fetch_alphavantage_news()
        if av_data:
            cache.set("av_news", av_data, ttl=43200)
            log.info(f"AlphaVantage 뉴스 갱신 완료: {len(av_data)}건")
    except Exception as e:
        log.warning(f"AlphaVantage 뉴스 갱신 실패: {e}")


def refresh_finnhub_news():
    """Finnhub 일반 뉴스 갱신 — 10분 캐시"""
    log.info("Finnhub 뉴스 갱신 시작...")
    try:
        fh_data = df.fetch_finnhub_news()
        if fh_data:
            cache.set("finnhub_news", fh_data, ttl=600)
            log.info(f"Finnhub 뉴스 갱신 완료: {len(fh_data)}건")
    except Exception as e:
        log.warning(f"Finnhub 뉴스 갱신 실패: {e}")


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
    except Exception as e:
        log.warning(f"refresh_earnings 실패: {e}")


def refresh_indices():
    log.info("지수 갱신 시작...")
    try:
        idx = df.fetch_indices()
        if idx:
            cache.set("indices", idx, ttl=30)
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
        cache.set("stocks",      nasdaq, ttl=300)
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
    base60 = [{**s, "name_ko": df.NAME_KO.get(s["ticker"], s.get("name_ko", ""))} for s in STOCKS]
    cache.set("stocks_base", base60, ttl=86400)
    cache.set("stocks",      base60, ttl=300)
    cache.set("news",    NEWS,    ttl=600)
    cache.set("reports", [],     ttl=900)
    cache.set("indices", INDICES, ttl=30)

    # emit 큐 워커 시작 (socketio 관리 스레드에서 emit 처리)
    socketio.start_background_task(_emit_worker)

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
    _start_after(6,  refresh_fear_greed)
    _start_after(8,  refresh_kr_market_news)
    _start_after(12, refresh_reports)
    _start_after(16, refresh_earnings)
    _start_after(20, refresh_av_news)
    _start_after(24, refresh_dynamic_indices)
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

    # 일일 신호 추천: US·KR 종목 로드 후 240초 지연해서 시작 (PE/EPS 등과 겹치지 않게)
    def _delayed_daily_signals():
        import time as _t; _t.sleep(240)
        refresh_daily_signals()
    threading.Thread(target=_delayed_daily_signals, daemon=True).start()

    # AI 음성 브리핑: 뉴스 로드 후 270초 지연해서 시작 (daily_signals 등과 겹치지 않게)
    def _delayed_voice_briefing():
        import time as _t; _t.sleep(270)
        refresh_voice_briefing()
    threading.Thread(target=_delayed_voice_briefing, daemon=True).start()

    # 국내주식: 파일 기반 베이스 로드 후 백그라운드 가격 갱신
    kr_base = _load_kr_base()
    if kr_base:
        cache.set("kr_stocks", kr_base, ttl=300)
        log.info(f"국내주식 파일 캐시 로드: {len(kr_base)}개")
        _start_after(5, refresh_kr_stocks)        # 3,936종목 시세 갱신은 초반 부하를 피해 5초 뒤 시작
    else:
        log.info("kr_stocks.json 없음 — scripts/fetch_kr_stocks.py 실행 필요")


# ── 스케줄러 ─────────────────────────────────────────────────────────────────
# 느린 서버에서 30초 주기 작업이 밀릴 때 'missed' 경고가 쌓이지 않도록 1회로 합치고 60초까지 허용
_scheduler = BackgroundScheduler(job_defaults={"coalesce": True, "misfire_grace_time": 60})
_scheduler.add_job(refresh_stocks,          "interval", minutes=5,  id="stocks")
_scheduler.add_job(refresh_kr_stocks,       "interval", minutes=5,  id="kr_stocks")
_scheduler.add_job(refresh_indices,         "interval", seconds=30, id="idx")
_scheduler.add_job(refresh_news,            "interval", minutes=10, id="news")
_scheduler.add_job(refresh_kr_market_news,  "interval", minutes=10, id="kr_market_news")
_scheduler.add_job(refresh_reports,         "interval", minutes=15, id="reports")
_scheduler.add_job(refresh_earnings,        "interval", hours=1,    id="earnings")
_scheduler.add_job(refresh_market_caps,     "interval", hours=6,    id="market_caps")
_scheduler.add_job(refresh_extra_fields,    "interval", hours=6,    id="extra_fields")
_scheduler.add_job(refresh_pe_eps,          "interval", hours=24,   id="pe_eps")
_scheduler.add_job(refresh_av_news,         "interval", hours=12,   id="av_news")
_scheduler.add_job(refresh_finnhub_news,    "interval", minutes=10, id="finnhub_news")
_scheduler.add_job(refresh_dynamic_indices, "interval", weeks=1,    id="dyn_indices")
_scheduler.add_job(refresh_fear_greed,      "interval", minutes=30, id="fear_greed")
_scheduler.add_job(refresh_daily_signals,   "interval", hours=24,   id="daily_signals")
_scheduler.add_job(refresh_voice_briefing,  "interval", hours=24,   id="voice_briefing")


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
    av_news      = cache.get("av_news") or []
    finnhub_news = cache.get("finnhub_news") or []
    kr_news      = cache.get("kr_market_news") or []
    for n in av_news + finnhub_news:
        n["market"] = "US"
    # 중복 제거: 제목 기준
    seen   = {n["title"] for n in rss_news}
    extras = []
    for n in av_news + finnhub_news + kr_news:
        if n["title"] not in seen:
            seen.add(n["title"])
            extras.append(n)
    merged = list(rss_news) + extras
    # 최신순 정렬
    merged.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
    for i, n in enumerate(merged, 1):
        n["id"] = i
    return jsonify(merged)


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
    code = re.sub(r"[^0-9]", "", code)[:6]
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
    """국내주식 종목별 뉴스 (Naver Finance, 30분 lazy 캐시)"""
    code = re.sub(r"[^0-9]", "", code)[:6]
    if not code:
        return jsonify([])
    key    = f"kr_news_{code}"
    cached = cache.get(key)
    if cached is not None:
        return jsonify(cached)
    name = next((s.get("name") for s in (cache.get("kr_stocks") or [])
                 if s.get("code") == code), "")
    # 1순위: 네이버 검색 API(공식, 키 필요) → 2순위: 네이버 금융 스크래핑 → 3순위: Google News RSS
    result = df.fetch_kr_stock_news_naver_api(name)
    if result:
        log.info(f"KR 뉴스: 네이버 검색API {len(result)}건 ({name})")
    else:
        result = df.fetch_kr_stock_news(code)
    if not result:
        result = df.fetch_kr_stock_news_google(name)
        if result:
            log.info(f"KR 뉴스: Google News 대체 {len(result)}건 ({name})")
    cache.set(key, result, ttl=1800 if result else 120)   # 빈 결과는 짧게만 캐시
    return jsonify(result)


@app.route("/api/stock-news/<ticker>")
def stock_news(ticker: str):
    """종목별 뉴스 (Finnhub company-news, 30분 lazy 캐시)"""
    ticker = ticker.upper()
    key    = f"stock_news_{ticker}"
    cached = cache.get(key)
    if cached is not None:
        return jsonify(cached)
    data = df.fetch_finnhub_company_news(ticker)
    cache.set(key, data, ttl=1800)
    return jsonify(data)


@app.route("/api/reports")
def reports():
    return jsonify(cache.get("reports") or [])


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
    t        = ticker.upper()
    period   = request.args.get("period",   "1y")
    interval = request.args.get("interval", "1d")
    years    = request.args.get("years", type=int)
    if period   not in VALID_PERIODS:   period   = "1y"
    if interval not in VALID_INTERVALS: interval = "1d"
    if years is not None and years not in _CUSTOM_YEARS_RANGE:
        years = None
    ttl  = _CHART_TTL.get(interval, 300)
    key  = f"chart_{t}_{interval}_{years}y-custom" if years else f"chart_{t}_{interval}_{period}"
    cached = cache.get_fresh(key)
    if cached:
        return jsonify(cached)
    ohlcv = df.fetch_ohlcv(t, period=period, interval=interval, years=years)
    if ohlcv:
        cache.set(key, ohlcv, ttl=ttl)
        return jsonify(ohlcv)
    return jsonify(_generate_ohlcv_dummy(t))


@app.route("/api/stock/<ticker>")
def stock_detail(ticker):
    t    = ticker.upper()
    # US 종목 먼저 검색 (_get_merged_us_stocks가 extra_fields·pe_eps 병합까지 처리)
    stock = next((s for s in _get_merged_us_stocks() if s["ticker"] == t), None)
    if stock:
        return jsonify(stock)
    # KR 종목 검색 (.KS / .KQ)
    kr_data = cache.get("kr_stocks") or []
    kr_stock = next((s for s in kr_data if s["ticker"] == t), None)
    if kr_stock:
        return jsonify(dict(kr_stock))
    return jsonify({"error": "Not found"}), 404


@app.route("/api/stock-analysis/<ticker>")
def stock_analysis(ticker):
    """종목 종합 진단 — 기술적 신호·밸류에이션·52주 위치·거래량·수급(KR)/뉴스감성(US)을
    항목별로 판정해 요약. 단일 매수/매도 결론을 자동 산출하지 않고 근거만 제공."""
    t = ticker.upper()
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
    t = ticker.upper()
    key = f"financials_{t}"
    cached = cache.get(key)
    if cached is not None:
        if cached.get("__notfound__"):
            return jsonify({"error": "Not found"}), 404
        return jsonify(cached)

    if t.endswith((".KS", ".KQ")):
        code = re.sub(r"[^0-9]", "", t)[:6]
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
    _port = int(os.environ.get("PORT", 5001))
    socketio.run(app, host="0.0.0.0", port=_port, debug=False, allow_unsafe_werkzeug=True)
