# StockView — Finviz 클론 작업계획서

작성일: 2026-05-27  
수정일: 2026-06-11 (Phase 4-8 ~ 4-15 완료 반영, 서버 재시작 및 전 탭 검증 완료)

---

## 1. 프로젝트 개요

| 항목 | 내용 |
|------|------|
| 프로젝트명 | StockView |
| 목표 | Finviz 스타일의 미국 주식 시장 분석 웹앱 |
| 대상 시장 | **미국(US) 주식 전용** (S&P 500 대표 종목) |
| 데이터 | 더미 데이터 (Phase 1) → yfinance + 뉴스 API (Phase 3) |
| 스택 | Flask + Vanilla JS + D3.js + Lightweight Charts |

---

## 2. 기술 스택

### 백엔드
- **Flask** — REST API 서버
- **yfinance** — 주가·차트 실시간 데이터 (무료)
- **feedparser** — RSS 뉴스 파싱 (무료)
- **APScheduler** — 백그라운드 자동 갱신 스케줄러
- **threading.Lock** — 캐시 동시 접근 제어

### 프론트엔드
- **Vanilla JS** — SPA 방식 뷰 전환 (show/hide)
- **D3.js v7** (CDN) — 히트맵 트리맵 렌더링
- **Lightweight Charts v4** (TradingView OSS, CDN) — 캔들스틱 차트
- **setInterval** — 자동 새로고침 (30초)

---

## 3. 디렉토리 구조

```
finviz-app/
├── app.py                  ← Flask 백엔드 + API
├── data_fetcher.py         ← yfinance + RSS 데이터 수집 (Phase 3 신규)
├── cache.py                ← 캐시 레이어 (Phase 3 신규)
├── PLAN.md                 ← 이 파일
├── requirements.txt
├── templates/
│   └── index.html
└── static/
    ├── css/
    │   └── style.css
    └── js/
        ├── main.js
        ├── heatmap.js
        ├── screener.js
        ├── chart.js
        ├── brief.js
        ├── watchlist.js
        └── portfolio.js
```

---

## 4. 더미 데이터 설계 (Phase 1 — 완료)

| 섹터 | 수 |
|------|-----|
| Technology | 14 |
| Finance | 10 |
| Healthcare | 8 |
| Energy | 4 |
| Consumer Disc. | 6 |
| Consumer Staples | 4 |
| Industrial | 5 |
| Communication | 3 |
| Real Estate | 2 |
| Materials | 2 |
| Utilities | 2 |

**합계: 60개** → 300개로 확장 예정

---

## 5. 페이지별 기능 명세 (Phase 1 — 완료)

### 5-1. 홈 / 5-2. 스크리너 / 5-3. 히트맵 / 5-4. 차트 / 5-5. 뉴스
→ 구현 완료. 세부 명세는 이전 버전 참조.

---

## 6. API 명세

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/` | 메인 SPA 페이지 |
| GET | `/api/stocks` | 전체 종목 목록 (2,942개) |
| GET | `/api/indices` | 주요 지수 7개 |
| GET | `/api/news` | 뉴스 목록 (최대 50건) |
| GET | `/api/reports` | 리포트 목록 (최대 36건) |
| GET | `/api/brief?period=daily\|weekly\|monthly` | Market Brief 요약 집계 |
| GET | `/api/index-members` | 인덱스 구성 종목 (S&P500/Nasdaq100/Dow30/Russell2000) |
| GET | `/api/chart/<ticker>?interval=` | OHLCV 차트 데이터 (분봉~일봉) |
| GET | `/api/stock/<ticker>` | 개별 종목 상세 |
| GET | `/api/cache/status` | 캐시 상태 확인 |

---

## 7. 구현 순서 (단계별)

### Phase 1 — 기반 구조 ✅ 완료
- [x] PLAN.md 작성
- [x] `app.py` — Flask + 더미 데이터 + REST API
- [x] `index.html` — SPA 5탭 구조
- [x] `style.css` — 다크 테마
- [x] `main.js` / `screener.js` / `heatmap.js` / `chart.js`
- [x] 한글 종목명 (name_ko) 전 탭 표시

### Phase 2 — 종목 데이터 확장 ✅ 완료
- [x] `fetch_stocks.py` — Wikipedia S&P500 파싱 + yfinance 배치 수집 스크립트
- [x] `screener_api.py` — FastAPI + Pandas 고급 스크리너 (별도 서비스)
- 주: Python 3.15 알파 환경 제약으로 pandas/numpy 미설치, app.py 직접 통합 방식 선택

### Phase 3 — 실시간 데이터 연동 ✅ 완료 (2026-06-02)
→ **아래 상세 계획 참조**

**완료 항목:**
- [x] `cache.py` — Thread-Safe TTL 캐시 (stale-while-revalidate 포함)
- [x] `data_fetcher.py` — Yahoo Finance API 직접 호출 (yfinance 대체), RSS + VADER
- [x] `app.py` 수정 — 캐시 기반 서빙, APScheduler (주가 5분, 지수 5분, 뉴스 10분)
- [x] `main.js` 수정 — 30초 자동 새로고침, 헤더 갱신 시각 표시
- [x] `/api/cache/status` 엔드포인트 추가

---

---

# Phase 3 — 실시간 데이터 연동 상세 계획

> 목표: 더미 데이터를 **yfinance(주가·차트) + RSS(뉴스)**로 교체  
> 예상 작업 기간: 3~4일  
> 외부 API 키: **불필요** (모두 무료·무인증 소스 사용)

---

## A. 데이터 소스 결정

### A-1. 주가 데이터 — yfinance

| 항목 | 내용 |
|------|------|
| 라이브러리 | `yfinance` (pip install yfinance) |
| 제공 데이터 | 현재가, 변동, 변동률, 거래량, 시총, PER, EPS, 52주 고저, OHLCV 히스토리 |
| 요청 방식 | `yf.Ticker("AAPL").fast_info` (현재가 빠른 조회) |
| 히스토리 | `yf.Ticker("AAPL").history(period="1y", interval="1d")` |
| 한계 | Yahoo Finance 비공개 API 래핑 → 간헐적 불안정, Rate Limit 없음 |
| 폴백 | yfinance 실패 시 기존 더미 데이터 반환 |

```python
# 사용 예시
import yfinance as yf

ticker = yf.Ticker("AAPL")
info = ticker.fast_info          # 빠른 현재가 조회
hist = ticker.history(period="1y")   # 1년치 OHLCV
```

### A-2. 뉴스 데이터 — Yahoo Finance RSS + Finviz RSS

| 소스 | URL | 특징 |
|------|-----|------|
| Yahoo Finance 전체뉴스 | `https://finance.yahoo.com/news/rssindex` | 일반 시장 뉴스 |
| Yahoo Finance 종목별 | `https://finance.yahoo.com/rss/headline?s={ticker}` | 티커별 뉴스 |
| Seeking Alpha RSS | `https://seekingalpha.com/market_currents.xml` | 시장 분석 |
| CNBC | `https://www.cnbc.com/id/100003114/device/rss/rss.html` | 미국 경제뉴스 |

```python
# 사용 예시
import feedparser

feed = feedparser.parse("https://finance.yahoo.com/news/rssindex")
for entry in feed.entries[:20]:
    print(entry.title, entry.published, entry.link)
```

### A-3. 감성 분석 — VADER (로컬, 무료)

| 항목 | 내용 |
|------|------|
| 라이브러리 | `vaderSentiment` (pip install vaderSentiment) |
| 방식 | 뉴스 제목 텍스트 → compound score → positive/negative/neutral 분류 |
| 기준 | compound ≥ 0.05 → positive / ≤ -0.05 → negative / 나머지 → neutral |
| 장점 | 서버리스, API 키 불필요, 금융 뉴스에 최적화된 사전 |

```python
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

analyzer = SentimentIntensityAnalyzer()
score = analyzer.polarity_scores("Apple surges after record earnings beat")
# → {'compound': 0.72, ...} → 'positive'
```

---

## B. 백엔드 아키텍처 변경

### B-1. 캐시 레이어 설계 (cache.py 신규)

```
캐시 종류         TTL(유효시간)    갱신 방식
─────────────────────────────────────────────
주가 스냅샷       5분              APScheduler 백그라운드
차트 OHLCV       1시간            요청 시 갱신 (lazy)
뉴스 목록         10분             APScheduler 백그라운드
지수              5분              APScheduler 백그라운드
```

```python
# cache.py 구조 예시
import time
from threading import Lock

class Cache:
    def __init__(self):
        self._data = {}     # {"key": {"value": ..., "ts": timestamp}}
        self._lock = Lock()

    def get(self, key):
        with self._lock:
            item = self._data.get(key)
            if item and (time.time() - item["ts"]) < item["ttl"]:
                return item["value"]
        return None

    def set(self, key, value, ttl=300):
        with self._lock:
            self._data[key] = {"value": value, "ts": time.time(), "ttl": ttl}
```

### B-2. data_fetcher.py 신규 모듈

```python
# data_fetcher.py 구조
import yfinance as yf
import feedparser
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

TICKERS = ["AAPL", "MSFT", "NVDA", ...]   # 300개 티커 리스트

def fetch_stock_snapshot(ticker: str) -> dict:
    """단일 종목 현재가 스냅샷 (fast_info 사용)"""
    ...

def fetch_all_stocks() -> list[dict]:
    """전체 종목 일괄 조회 (yf.download 배치 사용)"""
    ...

def fetch_ohlcv(ticker: str, period="1y") -> list[dict]:
    """차트용 OHLCV 히스토리"""
    ...

def fetch_news() -> list[dict]:
    """RSS 피드 파싱 + VADER 감성 분석"""
    ...

def fetch_indices() -> list[dict]:
    """지수 데이터 (^GSPC, ^IXIC, ^DJI, ^RUT, ^VIX, CL=F, GC=F)"""
    ...
```

### B-3. app.py 변경 사항

- `STOCKS` 하드코딩 딕셔너리 → `cache.get("stocks")` 조회
- `generate_ohlcv()` 더미 함수 → `data_fetcher.fetch_ohlcv()` 호출
- `NEWS` 하드코딩 → `cache.get("news")` 조회
- 캐시 미스 시 더미 데이터 폴백

```python
# app.py 변경 후 예시
@app.route("/api/stocks")
def stocks():
    data = cache.get("stocks") or STOCKS_FALLBACK   # 캐시 없으면 더미
    sector = request.args.get("sector", "all")
    result = data if sector == "all" else [s for s in data if s["sector"] == sector]
    return jsonify(result)
```

### B-4. APScheduler 설정

```python
from apscheduler.schedulers.background import BackgroundScheduler

scheduler = BackgroundScheduler()

# 5분마다 주가 갱신
scheduler.add_job(refresh_stocks,  'interval', minutes=5,  id='stocks')
# 10분마다 뉴스 갱신
scheduler.add_job(refresh_news,    'interval', minutes=10, id='news')
# 5분마다 지수 갱신
scheduler.add_job(refresh_indices, 'interval', minutes=5,  id='indices')

scheduler.start()
```

---

## C. 데이터 수집 세부 구현

### C-1. 주가 배치 조회 전략

yfinance는 단일 종목 조회보다 **배치 조회**가 훨씬 빠름:

```python
import yfinance as yf

# ❌ 느림 — 300번 개별 요청
for t in TICKERS:
    yf.Ticker(t).fast_info

# ✅ 빠름 — 한 번에 300개 다운로드
data = yf.download(TICKERS, period="2d", interval="1d",
                   group_by="ticker", auto_adjust=True)
# 전일 종가 기준 change_pct 계산 후 스냅샷 구성
```

예상 소요 시간: 300종목 배치 조회 약 **8~15초**  
→ 백그라운드 스케줄러에서 실행하므로 사용자 응답에 영향 없음

### C-2. 뉴스 RSS 파싱 상세

```python
RSS_FEEDS = [
    {"url": "https://finance.yahoo.com/news/rssindex",           "source": "Yahoo Finance"},
    {"url": "https://www.cnbc.com/id/100003114/device/rss/rss.html", "source": "CNBC"},
    {"url": "https://feeds.reuters.com/reuters/businessNews",    "source": "Reuters"},
]

def fetch_news():
    analyzer = SentimentIntensityAnalyzer()
    results = []
    for feed_info in RSS_FEEDS:
        feed = feedparser.parse(feed_info["url"])
        for i, entry in enumerate(feed.entries[:10]):
            title = entry.get("title", "")
            score = analyzer.polarity_scores(title)["compound"]
            sentiment = "positive" if score >= 0.05 else \
                        "negative" if score <= -0.05 else "neutral"

            # 제목에서 티커 추출 시도 (간단한 패턴 매칭)
            ticker = extract_ticker_from_title(title)

            results.append({
                "id":        len(results) + 1,
                "title":     title,
                "source":    feed_info["source"],
                "time":      format_time_ago(entry.get("published_parsed")),
                "ticker":    ticker,
                "sentiment": sentiment,
                "url":       entry.get("link", ""),
            })
    return results[:30]  # 최대 30건 반환
```

### C-3. 티커 추출 함수

```python
import re

# 300개 티커 세트
TICKER_SET = set(["AAPL", "MSFT", "NVDA", ...])

def extract_ticker_from_title(title: str) -> str | None:
    """뉴스 제목에서 종목 티커 추출"""
    # 대문자 2~5글자 패턴 매칭
    candidates = re.findall(r'\b[A-Z]{2,5}\b', title)
    for c in candidates:
        if c in TICKER_SET:
            return c
    return None
```

### C-4. 차트 OHLCV 구현

```python
def fetch_ohlcv(ticker: str, period="1y") -> list[dict]:
    try:
        hist = yf.Ticker(ticker).history(period=period, interval="1d")
        result = []
        for date, row in hist.iterrows():
            result.append({
                "time":   date.strftime("%Y-%m-%d"),
                "open":   round(float(row["Open"]),   2),
                "high":   round(float(row["High"]),   2),
                "low":    round(float(row["Low"]),    2),
                "close":  round(float(row["Close"]),  2),
                "volume": int(row["Volume"]),
            })
        return result
    except Exception as e:
        # 실패 시 더미 데이터 폴백
        return generate_ohlcv_dummy(ticker)
```

---

## D. 프론트엔드 변경

### D-1. 자동 새로고침 (main.js)

```javascript
// 30초마다 홈 데이터 갱신
function startAutoRefresh() {
  setInterval(async () => {
    if (currentView === 'home') {
      const [indices, stocks] = await Promise.all([
        api('/api/indices'), api('/api/stocks')
      ]);
      buildTickerTape(indices, stocks);
      renderIndices(indices);
      renderMovers(stocks);
    }
  }, 30_000);
}
```

### D-2. 마지막 갱신 시각 표시

```javascript
// 헤더에 "Last updated: 14:32:05" 형식으로 표시
function updateTimestamp() {
  const el = document.getElementById('last-updated');
  if (el) el.textContent = 'Updated: ' + new Date().toLocaleTimeString('ko-KR');
}
```

### D-3. 데이터 로딩 상태 표시

- 차트 로드 중: 스피너 표시
- 뉴스 로드 중: 스켈레톤 카드 표시
- API 오류 시: 오류 메시지 + 재시도 버튼

---

## E. 구현 단계 (작업 순서)

### 단계 1 — 환경 준비 (30분)
```bash
pip install yfinance feedparser vaderSentiment APScheduler
```
- `requirements.txt` 업데이트
- yfinance 연결 테스트 (`python -c "import yfinance as yf; print(yf.Ticker('AAPL').fast_info)"`)
- RSS 파싱 테스트

### 단계 2 — cache.py 작성 (1시간)
- `Cache` 클래스 구현 (get/set/invalidate)
- TTL 관리, Thread-Safe Lock
- 단위 테스트 (Python REPL에서 직접 확인)

### 단계 3 — data_fetcher.py 작성 (2~3시간)
- `fetch_all_stocks()` — yfinance 배치 조회 + 필드 매핑
- `fetch_ohlcv(ticker)` — 1년치 차트 데이터
- `fetch_indices()` — 7개 지수
- `fetch_news()` — RSS + VADER 감성분석
- 각 함수별 예외 처리 + 더미 폴백

### 단계 4 — app.py 수정 (1시간)
- `cache.py`, `data_fetcher.py` import
- 앱 시작 시 초기 데이터 로드
- APScheduler 설정 및 시작
- 각 `/api/*` 엔드포인트를 캐시 조회 방식으로 변경
- `/api/cache/status` 디버그 엔드포인트 추가

### 단계 5 — 프론트엔드 수정 (1시간)
- `main.js` — 자동 새로고침 (30초 polling)
- 갱신 시각 표시 UI 추가
- 로딩/에러 상태 처리

### 단계 6 — 통합 테스트 (1시간)
- 서버 재시작 후 모든 탭 동작 확인
- 실제 주가 데이터 표시 확인
- 뉴스 RSS 파싱 확인
- 캐시 갱신 주기 확인 (로그 출력)
- 네트워크 오프라인 시 폴백 확인

---

## F. 에러 처리 및 폴백 전략

| 상황 | 처리 방법 |
|------|-----------|
| yfinance 연결 실패 | 더미 데이터(STOCKS_FALLBACK) 반환 |
| RSS 파싱 실패 | 기존 NEWS_FALLBACK 반환 |
| 개별 종목 조회 실패 | 해당 종목만 더미 데이터 |
| 스케줄러 예외 | 로그 기록 후 다음 주기에 재시도 |
| 캐시 만료 상태에서 갱신 실패 | 만료된 캐시라도 반환 (stale-while-revalidate) |

```python
def refresh_stocks():
    try:
        data = fetch_all_stocks()
        cache.set("stocks", data, ttl=300)
        print(f"[{datetime.now()}] 주가 갱신 완료: {len(data)}개")
    except Exception as e:
        print(f"[{datetime.now()}] 주가 갱신 실패: {e}")
        # 기존 캐시 유지 (갱신 실패해도 이전 데이터 유지)
```

---

## G. 주요 고려사항 및 제약

| 항목 | 내용 |
|------|------|
| Rate Limit | yfinance 자체 제한 없으나 과도한 요청 시 IP 차단 가능 → 배치 조회 필수 |
| 장마감 시간 | 미국 주식 09:30~16:00 EST (한국시간 22:30~05:00) — 장외 시간엔 종가 표시 |
| 주말/공휴일 | yfinance가 자동으로 직전 거래일 데이터 반환 |
| 한글 종목명 | yfinance는 영문명만 제공 → `name_ko` 매핑 테이블 별도 유지 필요 |
| 뉴스 중복 | 여러 RSS 소스에서 같은 뉴스 중복 가능 → 제목 해시로 중복 제거 |
| VADER 정확도 | 금융 특화 감성 분석기지만 완벽하지 않음 → 추후 FinBERT 교체 가능 |

---

## H. 의존성 패키지

```txt
# requirements.txt (Phase 3 추가분)
flask
yfinance>=0.2.38
feedparser>=6.0.11
vaderSentiment>=3.3.2
APScheduler>=3.10.4
```

---

## I. 향후 확장

### Phase 4-1 — S&P500 전체 종목 확장 ✅ 완료 (2026-06-02)
- [x] `data_fetcher.py` — `fetch_sp500_list()`: Wikipedia HTML 파싱 (html.parser 내장)
- [x] `data_fetcher.py` — `refresh_prices_parallel()`: ThreadPoolExecutor 30 workers 병렬 조회
- [x] `app.py` — `_load_sp500_background()`: 서버 시작 즉시 60개 서빙 → 백그라운드에서 503개로 교체
- 성과: 503개 파싱 + 가격 전체 갱신 **5.5초** 완료

### Phase 4-2 — 관심종목 워치리스트 ✅ 완료 (2026-06-02)
- [x] `static/js/watchlist.js` — 신규 생성: localStorage 저장/불러오기, ★ 토글, 워치리스트 테이블 렌더링
- [x] `templates/index.html` — Watchlist 탭 버튼(카운트 배지 포함) + view-watchlist 뷰 추가, watchlist.js 로드
- [x] `static/css/style.css` — ★ 버튼 스타일, 워치리스트 테이블/빈 상태/배지 스타일
- [x] `static/js/screener.js` — 각 종목 행 앞에 ★ 버튼 열 추가
- [x] `static/js/main.js` — 홈 Gainers/Losers에 ★ 버튼 추가, Watchlist 탭 전환 등록, 카운트 배지 초기화

### Phase 4-3 — 히트맵 시가총액 비례 박스 크기 ✅ 완료 (2026-06-02)
- [x] `data_fetcher.py` — `fetch_all_market_caps()`: Yahoo Finance HTML 병렬 파싱 (25 workers, ~25초/503개)
- [x] `app.py` — `refresh_market_caps()`: 6시간 주기 갱신, `_apply_market_caps()`: 가격 갱신 시 시가총액 자동 병합
- [x] 히트맵(heatmap.js)은 기존 `d.market_cap` 기반 트리맵 코드 그대로 사용

### Phase 4-4 — 차트 분봉/시봉 인트라데이 지원 ✅ 완료 (2026-06-03)
- [x] `data_fetcher.py` — `fetch_ohlcv(interval=)` 추가, 인트라데이 시 UTC 타임스탬프 반환
- [x] `app.py` — `?interval=` 파라미터 추가, interval별 캐시 TTL (1m=30s ~ 1d=300s)
- [x] `chart.js` — interval 버튼 이벤트, interval별 캔들 갱신 주기, 기간 버튼 show/hide
- [x] `index.html` — 1m/5m/15m/30m/1H/1D 버튼 행 추가

### Phase 4-5 — 종목 확장 (S&P500 → Russell2000 포함 2,936개) ✅ 완료 (2026-06-03)
- [x] `data_fetcher.py` — `fetch_nasdaq_stocks()`: Nasdaq API 단 1회로 2937개 + 가격·시총 즉시 수집 (1.9초)
- [x] `app.py` — Nasdaq 우선 / S&P500 폴백, `refresh_stocks()` Nasdaq 경로 분기
- [x] `heatmap.js` — Top N 필터 (200/500/1000/전체) 추가, 2500개 렌더링 지원
- [x] `index.html` — 히트맵 Top N 필터 버튼 추가

### Phase 4-6 — 지수 실시간 차트 ✅ 완료 (2026-06-04)
- [x] `main.js` — `_INDEX_SYMBOL` 매핑, 홈 지수 카드 클릭 → 차트 이동
- [x] `chart.js` — `_isIndex()` 분기, `encodeURIComponent(^GSPC)`, 지수 사이드바·30초 갱신
- [x] `index.html` — Indices 빠른 버튼 행 (S&P/NQ/DOW/RUT/VIX/OIL/GOLD)
- [x] `style.css` — 지수 버튼 금색 스타일, 카드 hover 효과

### Phase 4-7 — 포트폴리오 손익 계산 ✅ 완료 (2026-06-04)
- [x] `static/js/portfolio.js` — PT 저장소(localStorage), 종목 추가/수정/삭제, 손익 계산, 요약 카드, 30초 자동 갱신
- [x] `templates/index.html` — Portfolio 탭 버튼, view-portfolio 뷰, 종목 추가/수정 모달
- [x] `static/css/style.css` — 요약 카드, 테이블, 모달, 빈 상태 스타일
- [x] `static/js/main.js` — Portfolio 탭 전환 등록, 타이머 정리

### Phase 4-8 — WebSocket 실시간 지수 푸시 ✅ 완료 (2026-06-07)
- [x] `data_fetcher.py` — `fetch_indices()` ThreadPoolExecutor 병렬 조회 (7개 동시, ~0.35s)
- [x] `app.py` — `flask-socketio` threading 모드 + queue-based emit 패턴 도입
  - `_emit_queue` + `_emit_worker()`: APScheduler 백그라운드 스레드 → 큐 → socketio 전용 워커가 emit
  - `initial_load()`에서 `socketio.start_background_task(_emit_worker)` 시작
  - APScheduler `refresh_indices` 30초 간격 (기존 5분 → 30초)
  - `indices_update` / `stocks_update` / `news_update` 이벤트 모두 큐 방식으로 통일
- [x] 검증: 브라우저 WebSocket 수신 간격 **29.9s / 30.0s** (목표 30초 정확 달성)
- 기술 노트: eventlet은 Python 3.15 알파에서 RLock 그린화 실패로 ~90초 후 크래시 → threading + queue 패턴으로 해결

### Phase 4-9 — 뉴스 클릭 링크 연결 ✅ 완료 (2026-06-07)
- [x] `static/js/main.js` — `renderHomeNews()`: 홈 뉴스 6개 카드 클릭 시 `window.open(url, '_blank')` 추가
- [x] `static/js/main.js` — `renderNews()`: 뉴스 탭 카드 전체 클릭 시 `window.open(url, '_blank')` 추가, `cursor:pointer` 인라인 스타일 추가
- 종목 배지(AAPL 등) 클릭은 기존 차트 탭 이동 동작 유지

### Phase 4-10 — 히트맵 한글명 확장 + 티커 표시 개선 ✅ 완료 (2026-06-07)
- [x] `data_fetcher.py` — `NAME_KO` 딕셔너리 ~80개 → **~250개**로 확장 (전 섹터 S&P 500 주요 종목)
- [x] `static/js/heatmap.js` — 텍스트 숨김 임계값 완화 (`cw<28||ch<18` → `cw<14||ch<10`)
- [x] `static/js/heatmap.js` — 폰트 크기 범위 `9~14px` → `7~13px`, 변동률 표시 기준 완화
- [x] `static/js/heatmap.js` — SVG `<defs>` + `clipPath` 적용: 텍스트가 셀 경계 밖으로 삐져나가지 않도록 클리핑

### Phase 4-11 — 뉴스 RSS 소스 확장 ✅ 완료 (2026-06-07)
- [x] `data_fetcher.py` — `RSS_FEEDS` 3개 → 7개로 확장: Yahoo Finance / CNBC / MarketWatch / Seeking Alpha / Motley Fool / NYT Business / Financial Times
- [x] Reuters(URL 사망) / Barron's(403) / Forbes(404) 제거, 실제 접근 가능 소스만 유지
- [x] 소스당 수집 기사 수 12 → 8로 조정 (7개 소스 균등 참여), 총 반환 기사 수 30 → 50으로 확대

### Phase 4-12 — 뉴스/리포트 탭 분리 ✅ 완료 (2026-06-07)
- [x] `data_fetcher.py` — `REPORT_FEEDS` (Globe Newswire/PR Newswire/Fed) + `fetch_reports()` 신규
- [x] `app.py` — `/api/reports` 엔드포인트, `refresh_reports()` 15분 스케줄러, 서버 시작 시 초기 로드
- [x] `templates/index.html` — News 탭 내부에 📰 News / 📋 Reports 서브탭 분리
- [x] `static/js/main.js` — 서브탭 전환 로직, `loadReports()` / `renderReports()` 함수, report_type 필터 (All / Earnings / Press Release / Fed)
- [x] `static/css/style.css` — 서브탭 언더라인 스타일, report-card, 3종 배지 색상 (초록/파랑/노랑)
- 검증: `/api/reports` Earnings 12건 / Press Release 12건 / Fed 12건 = 총 36건

### Phase 4-13 — Market Brief 탭 ✅ 완료 (2026-06-07)
- [x] `data_fetcher.py` — `_to_timestamp()` 헬퍼 추가, `fetch_news()` / `fetch_reports()` 반환 딕셔너리에 `timestamp` (Unix 초) 필드 추가
- [x] `app.py` — `/api/brief?period=daily|weekly|monthly` 엔드포인트: 기간 필터링 후 Market Mood(감성 분포), Top Stories(최신 5건), Most Mentioned Stocks(상위 8 티커), Report Highlights(최신 5건) 집계
- [x] `templates/index.html` — 내비게이션에 📊 Brief 탭 버튼 추가, `view-brief` 뷰 HTML (period selector, 4개 카드 그리드)
- [x] `static/js/brief.js` — 신규 파일: 기간 선택, `/api/brief` fetch, 각 섹션 렌더링
- [x] `static/js/main.js` — `_briefInited` 플래그 + `initBrief()` 호출 추가
- [x] `static/css/style.css` — Brief 전용 스타일 (mood bar, ticker tag, story item, responsive)
- 검증: `/api/brief?period=daily` → total_items 54건, mood Mixed, top_tickers 정상 반환

### Phase 4-14 — Heatmap 인덱스 탭 (S&P 500 / Nasdaq 100 / Dow 30 / Russell 2000) ✅ 완료 (2026-06-10)
- [x] `app.py` — `_DOW30`(30개) / `_NASDAQ100`(96개) 하드코딩, `/api/index-members` 엔드포인트 (sp500 = 시총 상위 503개 자동 추출, russell2000 = 나머지)
- [x] `templates/index.html` — 히트맵 상단에 All / S&P 500 / Nasdaq 100 / Dow 30 / Russell 2000 탭 + 종목 수 카운터
- [x] `static/js/heatmap.js` — 인덱스 필터 + Top N 복합 필터, 탭 클릭 시 재렌더링
- [x] `static/css/style.css` — 인덱스 탭 스타일
- 검증: dow30=30개, nasdaq100=96개, sp500=503개, russell2000=2426개

### Phase 4-15 — Heatmap 세부 업종 분류 + 섹터 호버 하이라이트 ✅ 완료 (2026-06-10)
- [x] `data_fetcher.py` — Nasdaq API `industry` 필드 파싱, `_clean_industry()` 헬퍼로 80개+ 업종명 단축 매핑 (실제 API 반환값 기준)
- [x] `static/js/heatmap.js` — sector → industry → stock 3단계 트리맵, 업종 레이블 표시 (충분한 크기일 때)
- [x] `

잊잊static/js/heatmap.js` — 섹터 투명 rect 호버: 흰 테두리 + 평균등락률·상승/하락 종목수·시총·업종수 툴팁
- [x] `static/js/heatmap.js` — 업종(industry) rect 호버: 테두리 + 평균등락률·종목수·대표 티커 툴팁
- [x] `static/css/style.css` — sector-group / industry-group hover transition 스타일
- 검증: industry 필드 2927/2927개 채워짐, Nasdaq 100에서 Software·Semiconductors·Hardware 업종 분류 확인

### Phase 4-16 ~ 4-26 — 완료 항목

| Phase | 기능 | 완료일 |
|-------|------|--------|
| 4-16 | 52W High/Low 실데이터 연동 (Yahoo Finance v8 chart API) | 2026-06-11 |
| 4-17 | PE/EPS FMP API 연동 (`pe_eps_cache.json` 파일 캐시, 24시간 갱신) | 2026-06-11 |
| 4-18 | Screener Industry 필터 추가 | 2026-06-12 |
| 4-19 | Heatmap 업종 레이블 섹터 헤더 겹침 수정 | 2026-06-12 |
| 4-20 | Brief Top Stories 중복 제거 + 소스 다양성 | 2026-06-12 |
| 4-21 | Earnings Calendar 탭 (📅, Nasdaq API, This Week/Next Week/Today) | 2026-06-12 |
| 4-22 | PE/EPS 536개 수집 완료 (Yahoo Finance HTML 방식, 일일 한도 없음) | 2026-06-12 |
| 4-23 | Screener Finviz 스타일 개편 (2행 필터, 3뷰 탭 Overview/Fundamental/Performance, 섹터 배지, P/E 색상, 52W 바) | 2026-06-13 |
| 4-24 | Heatmap 데이터 품질 개선 — GOOG/GOOGM/GOOGN/BRK.A 중복 클래스 주식 제거, 17개 종목 섹터 오버라이드 (GE/EMR/OTIS→Industrial, NEE→Utilities, MMM→Industrial, QCOM→Semiconductors, PANW/FTNT/CRWD→Cybersecurity) | 2026-06-13 |
| 4-25 | Heatmap 섹터·업종 배경 색상 오버레이 — 평균 등락률 기반 반투명 초록/빨강 배경 상시 표시, hover 시 강조 + 상위 상승/하락 종목 목록 툴팁 | 2026-06-13 |
| 4-26 | URL hash 탭 직접 진입 (`#screener`, `#heatmap` 등 URL로 탭 바로 열기) | 2026-06-13 |

### Phase 4-27 ~ 4-63 — 완료 항목 (이전 세션)

국내주식(KR) 기본 기능 추가, 스크리너 KR 탭, 차트 KR 지원 등 다수 완료.

### Phase 4-64 — KR 기본 데이터 강화 (52W High/Low, PER, EPS) ✅ 완료 (2026-06-22)
- [x] `scripts/fetch_kr_stocks.py` — 52W High/Low Yahoo Finance v8 range=1y 수집, PER Naver 시가총액 페이지 파싱
- [x] `data_fetcher.py` — `_fetch_kr_price_one()` 52W/PER/EPS 필드 보존 및 갱신
- [x] `static/js/chart.js` — `renderStockInfo()` KR 종목 ₩ 표기, fmtKrCap, 52W 한국 원화 표시
- [x] `app.py` — `/api/stock/<ticker>` KR 종목 조회 폴백 추가

### Phase 4-65 — KR 업종 분류 ✅ 완료 (2026-06-22)
- [x] `scripts/fetch_kr_stocks.py` — Naver Finance 업종 목록(79개) 수집 → 업종별 종목 매핑 → 488개 전 종목 업종 필드 채움
- [x] `static/js/screener.js` — KR 모드에서 `filter-sector` 드롭다운을 업종명으로 동적 채우기, `_populateKrSectorFilter()`, `_restoreUsSectorFilter()` 추가
- [x] `static/js/screener.js` — `_getKrFiltered()` 업종 필터링 로직 추가 (KOSPI/KOSDAQ 시장 필터 + 업종명 필터 겸용)
- [x] `static/js/screener.js` — `bindScreenerEvents()` guard 추가, KR/US 모드 이벤트 분기
- [x] `data/kr_stocks.json` — 488개 종목 업종 필드 포함 재생성
- 업종 분포: 반도체와반도체장비(61개), 기타(77개), 은행(26개), 제약(20개) 등 79개 업종

### Phase 4-66 — KR 스크리너 멀티뷰 ✅ 완료 (2026-06-22)
- [x] `static/js/screener.js` — `_initKrViewTabs()` 추가, Overview/Fundamental/Performance 3개 탭
- [x] `static/js/screener.js` — `renderKrScreener()` colSets 3종 (overview/fundamental/performance) 지원
- [x] `static/js/screener.js` — 탭별 컬럼 동적 전환 (No, 종목코드, 종목명, 시장, 업종, 현재가, 등락률, P/E, EPS, 52W, 시가총액 등)

### Phase 4-67 — KR 종목 모달 ✅ 완료 (2026-06-22)
- [x] `static/js/screener.js` — `openKrStockModal()` 추가, 기존 stock-modal HTML 재사용
- [x] KRW 가격 표기, 업종 배지, 52W 한국어 라벨, KR 뉴스 연동
- [x] `/api/kr-news/{code}` 호출로 모달 내 KR 뉴스 표시

### Phase 4-68 — KR CSV 내보내기 ✅ 완료 (2026-06-22)
- [x] `static/js/screener.js` — `exportKrCSV()` 추가
- [x] KR 컬럼(종목코드, 종목명, 시장, 업종, 현재가, 등락률, 거래량, 시가총액, P/E, EPS, 52W고, 52W저)
- [x] KR 모드에서 export 버튼 → `exportKrCSV()` 연결

### Phase 4-69 — KR 차트 업종 배지 ✅ 완료 (2026-06-22)
- [x] `static/js/chart.js` — `renderStockInfo()` 업종/Sector 라벨 KR 분기 처리
- [x] `static/css/style.css` — `.info-sector-badge` 스타일 추가 (보라색 배지)
- [x] KR 종목 차트 사이드바에 업종 배지 표시

### Phase 4-70 — KR 히트맵 ✅ 완료 (2026-06-22)
- [x] `templates/index.html` — 히트맵 탭 상단에 US/KR 시장 전환 버튼 추가
- [x] `static/js/heatmap.js` — `_hmMarket` 변수, `.hm-mkt-btn` 이벤트 핸들러 추가
- [x] `static/js/heatmap.js` — `renderKrHeatmap()` 2-레벨 트리맵 (업종→종목) 구현
- [x] `static/js/heatmap.js` — 리사이즈 이벤트 KR 모드 분기 수정
- [x] `static/css/style.css` — `.hm-market-bar`, `.hm-mkt-btn` 스타일 추가

### Phase 4-71 — KR 종목별 뉴스 ✅ 완료 (2026-06-22)
- [x] `app.py` — `/api/kr-news/<code>` 엔드포인트 추가 (Naver Finance EUC-KR 파싱)
- [x] 네이버 금융 `news_news.naver?code=XXXXXX` AJAX 스크래핑, TTL 30분 캐시
- [x] KR 모달에서 종목별 최신 뉴스 5건 표시

### Phase 4-73 — RSI/MACD 기술적 지표 ✅ 완료 (2026-06-24)
- [x] `static/js/chart.js` — MACD 지표 패널 추가 (EMA 12/26/9, 히스토그램 + MACD·Signal 라인)
- [x] `templates/index.html` — MACD 버튼 + `#macd-panel` div 추가
- [x] `static/css/style.css` — `#macd-panel` 스타일 공유

### Phase 4-74 — KR 외인·기관 수급 동향 ✅ 완료 (2026-06-24)
- [x] `data_fetcher.py` — `fetch_kr_investor()` (Naver frgn.naver EUC-KR 스크래핑)
- [x] `app.py` — `/api/kr-investor/<code>` 엔드포인트 추가 (1시간 캐시)
- [x] `static/js/chart.js` — `_loadKrInvestor()` 사이드바 수급 테이블 렌더링
- [x] `static/css/style.css` — `.investor-table` 그리드 스타일 추가

### Phase 4-75 — DART/KRX 공시 피드 ✅ 완료 (2026-06-24)
- [x] `data_fetcher.py` — `fetch_kr_disclosures()` (KRX KIND POST EUC-KR 파싱)
- [x] `app.py` — `/api/kr-disclosures` 엔드포인트 추가 (30분 캐시)
- [x] `templates/index.html` — News 탭에 "📢 공시" 서브탭 + `#disclosures-panel` 추가
- [x] `static/js/main.js` — `loadDisclosures()` / `renderDisclosures()` 렌더링 로직 추가
- [x] `static/css/style.css` — `.disclosure-card` 그리드 스타일 추가

### Phase 4-76 — KR 전종목 검색 확장 ✅ 완료 (2026-06-30)
- [x] `scripts/fetch_kr_stocks.py` — 전페이지 자동 순회 수집 (488개 → 3,945개, KOSPI 2,171 + KOSDAQ 1,774)
- [x] `data/kr_stocks.json` 재생성, `data/kr_stocks_backup.json` 이전 488종목 백업

### Phase 4-77 — KR 전략B (신호 정확도 개선) ✅ 완료 (2026-06-30)
- [x] `static/js/chart.js` `_calcSignals()` — KR 전용 매도 신호 약세 캔들(슈팅스타/베어리시 인걸핑) 확인 필터, 300종목 백테스트로 KR 매도 60.6%→68.0% 개선
- [x] US 매수 75.4%, KR 매수 70.0%, KR 매도(전략B) 68.0% — 65% 목표 달성. US 매도는 구조적 한계로 개선 포기

### Phase 4-78 — KR 등락률 버그 수정 ✅ 완료 (2026-06-30 ~ 07-03)
- [x] KR 스크리너 -100%/±30% 초과 등락률 이상값 버그 수정 (`screener.js`, `data_fetcher.py`), 전종목 재수집
- [x] 스크리너 미방문 상태에서 글로벌 검색 결과 없음 버그 수정

### Phase 4-79 — 차트 매수/매도 신호 시각적 강조 ✅ 완료 (2026-07-03)
- [x] `static/js/chart.js` `_applySignalMarkers()` — 마커 크기 확대(1/2→1.5/3), 텍스트에 신호 시점 가격 추가
- [x] `static/js/chart.js` `_renderSignalCard()` — 사이드바 SIGNAL 카드에 `.sc-banner` 색상 배경 배너 적용, 점수 폰트 확대(15px→20px)
- [x] `static/css/style.css` — `.sc-banner` 스타일 신규 추가

### Phase 4-80 — 미국주식 5,000개 확장 + Finnhub 키 교체 ✅ 완료 (2026-07-03)
- [x] `data_fetcher.py` `fetch_nasdaq_stocks()` — 시총 하한 필터 해제(0.3B→0.0), 시총 내림차순 상위 5,000개로 고정 (기존 2,960개)
- [x] `app.py` 2곳(`refresh_stocks()`, `_load_sp500_background()`) 호출부 `min_market_cap_b=0.0`으로 변경
- [x] 만료된 `FINNHUB_KEY` 신규 키로 교체, 종목별 뉴스 401 에러 해결
- 주의: 5,000개 중 약 900개는 시총 데이터 없는 SPAC 워런트/유닛/우선주(`AACIW`, `ABR^D` 등) — 사용자 확인 후 포함 결정

### Phase 4-81 — RSS 죽은 피드 5종 정리 ✅ 완료 (2026-07-06 ~ 07-07)
- [x] Benzinga URL 교체 (`/feeds/news` 404 → `/feed` 정상)
- [x] Investopedia 소스 제거 (공개 RSS 서비스 종료, 대체 URL 없음)
- [x] Barron's → WSJ Markets(Dow Jones `feeds.a.dj.com`)로 교체 (기존 URL 403 Cloudflare 차단)
- [x] Business Wire 소스 제거 (커스텀 UA 요청 시 무응답 타임아웃, 대체 서브도메인은 채널 코드 전부 무효)
- [x] Reddit r/stocks·r/investing·r/wsb 요청 사이 5초 지연 추가 (429 완화 시도, 완전 해결은 아님 — 아래 참고)

### Phase 4-82 — Chart 탭 검색창 한글/영문 종목명 검색 ✅ 완료 (2026-07-07)
- [x] `static/js/chart.js` `_resolveChartTicker()` 추가 — 정확한 티커/코드 일치 → 한글(`name`)/영문(`name_ko`) 종목명 검색 → 실패 시 원문 티커 취급 순으로 매칭
- [x] `templates/index.html` — `#chart-input` placeholder에 "삼성전자" 등 이름 검색 힌트 추가
- 헤더 전역 검색(`main.js` `_gsSearch`)과 동일한 `window._scStocks`/`_krStocks` 데이터 재사용

### Phase 4-83 — 히트맵 성과 데이터 커버리지 확대 + KR 기간 필터 추가 ✅ 완료 (2026-07-09)
- [x] `app.py` `/api/heatmap-perf` — 시총 상위 500개 하드코딩 제거, 전체 종목 대상 + `max_workers=80`으로 상향 (5,000개도 약 20초에 수집)
- [x] `app.py` — `market` 파라미터 추가로 KR 종목(3,936개)도 1주/1개월 성과 조회 가능
- [x] `app.py` — 성공률 50% 미만(Yahoo 레이트리밋 등 일시 실패)이면 60초만 캐시해 자동 재시도되도록 수정 (기존엔 빈 결과가 1시간 캐시되는 버그였음)
- [x] `templates/index.html`, `static/js/heatmap.js`, `static/css/style.css` — KR 인덱스 바에 1D/1W/1M 버튼 및 `_krHmPeriod`/`_krHmPerfData` 로직 추가 (US와 동일 패턴)

### Phase 4-84 — PE/EPS 수집 스크립트 커버리지 확대 ✅ 완료 (2026-07-10)
- [x] `scripts/collect_pe_eps.py` — 후보 티커 600→5,000개 확대 (진짜 원인은 600개 상한이었음), 순차 처리→병렬(5 workers+0.3초 지연), 429 연속 감지 시 조기 중단하는 서킷브레이커, cp949 콘솔 인코딩 오류 수정
- [x] 1차 시도(20 workers, 무지연)는 Yahoo 429 차단 유발 → 설정 조정 후 2차 시도 정상 완료
- [x] 데이터: PE/EPS 캐시 1,277개 → **3,255개** (커버리지 25% → 65%)

### Phase 4-85 — console.log 디버그 잔재 정리 ✅ 완료 (2026-07-10)
- [x] `static/js/main.js` — WebSocket 이벤트(connect/disconnect/stocks_update/indices_update/news_update) 핸들러 5곳의 조건 없는 `console.log` 제거

### Phase 4-86 — 예외 처리 로깅 보강 ✅ 완료 (2026-07-10)
- [x] `app.py` `_load_kr_base()`/`_load_pe_eps()` — 파일 로드 실패 시 `log.warning` 추가
- [x] `data_fetcher.py` `fetch_extra_fields()`(52W)/`fetch_heatmap_perf()` — 예외·429 차단 건수를 배치 완료 로그에 집계 포함
- [x] `data_fetcher.py` `fetch_kr_prices()` — 완료 로그 자체가 없었음, 실패 건수 경고 로그 신규 추가
- [x] `data_fetcher.py` AlphaVantage 뉴스 타임스탬프 파싱 실패 시 1970년(epoch 0) 대신 현재 시각 폴백 (정렬 왜곡 버그 수정)
- 기사/가격 단위로 매우 자주 호출되는 정상적 폴백(`_to_timestamp`, `_time_ago`, `_parse_usd`, iShares 쿠키 프라이밍)은 로그 추가 시 노이즈만 커져서 의도적으로 그대로 둠

### Phase 4-87 — 스크리너 "정상 종목만 보기" 필터 추가 ✅ 완료 (2026-07-10)
- [x] `templates/index.html`/`static/js/screener.js`/`static/css/style.css` — 체크박스 필터(US 전용, 옵트인) 추가, 필터 프리셋에도 반영
- [x] `_isAbnormalListing()`: `market_cap` 없음 또는 종목명에 Warrant/Rights/Preferred 포함 시 제외
- [x] 검증 중 발견: "Units" 키워드 포함 시 Energy Transfer($68B)/MPLX($58B) 같은 실제 대형 MLP가 "Common Units"라는 정상 표현 때문에 오탐 → 키워드에서 제외하여 수정
- 결과: 5,000개 중 1,070개 제외(대부분 SPAC 워런트/유닛/우선주/예탁증권), 정상 대형주는 유지 확인

### Phase 4-76 이후 — 예정 항목
| 항목 | 우선순위 | 설명 |
|------|---------|------|
| 차트 더미(가짜) OHLCV 데이터 표시 개선 | 중간 | `app.py:843,915` `_generate_ohlcv_dummy()` — 실제 차트 조회 실패 시 랜덤 생성 데이터를 표시 여부 구분 없이 반환. "데이터 없음" 배너 등 필요하나, `chart.js`의 MA/RSI/MACD/신호 계산 다수가 빈 데이터를 가정 안 해서 방어 코드 추가 범위가 커 보류 중 |
| Reddit RSS 429 근본 해결 | 보류 | 5초 지연으로도 r/investing·r/wsb 지속 실패 — 사용자 확인 후 현행 유지 결정, 재작업 불필요 |
| Russell 2000 정확한 구성종목 | 보류 | iShares 사이트가 JS SPA로 개편되어 스크래핑 불가 확인, 대체 무료 소스 못 찾음 — 현재 시총 근사 폴백 유지하기로 결정 |
| US 매도 신호 개선 | 보류 | 구조적 한계로 개선 포기 처리됨 |
| FinBERT 감성 분석 | 막힘 | 이 환경(Python 3.15 알파)엔 torch/transformers 설치 불가 확인 — 로컬 구동 불가능, 하려면 외부 호스팅 API 연동으로 설계 전환 필요 |
| 재무제표 페이지 | 막힘 | Yahoo financials 페이지(404)·quoteSummary API(401 Invalid Crumb) 둘 다 차단 확인 — 대체 무료 데이터 소스 조사 선행 필요 |

---

## J. 실행 방법 (Phase 3 이후)

```bash
# 의존성 설치
pip install flask yfinance feedparser vaderSentiment APScheduler

# 서버 실행
python app.py
# → http://127.0.0.1:5001
# → 시작 시 자동으로 실시간 데이터 로드 + 스케줄러 시작
```

---

---

## K. 현재 구현 상태 요약 (2026-07-10 기준)

| 탭 | 상태 | 주요 기능 |
|----|------|-----------|
| Home | ✅ | 지수 7개, Top Gainers/Losers, Latest News, 티커 테이프 |
| Screener | ✅ | US 5,000개 + KR 3,945개, 2행 8개 필터 + "정상 종목만 보기" 옵트인 체크박스, Overview·Fundamental·Performance 3뷰 탭, 섹터 배지, P/E 색상, 52W 바 (PE/EPS 커버리지 65%) |
| Heatmap | ✅ | 인덱스 탭 5개, 섹터→업종→종목 3단계, 섹터·업종 평균등락률 배경색 오버레이, hover 시 상위 상승/하락 종목 툴팁, 1주/1개월 성과 US·KR 전체 종목 커버 |
| Chart | ✅ | 분봉~연봉, 지수 지원, Key Statistics 사이드바, RSI/MACD/STO 복합 신호(마커+SIGNAL 배너 카드로 강조 표시), 검색창 한글/영문 종목명 지원 |
| News | ✅ | 뉴스/리포트/공시 서브탭, VADER 감성 배지, RSS 14개 소스 (죽은 피드 5종 정리 완료) |
| Brief | ✅ | Daily/Weekly/Monthly, Market Mood 바, 중복 제거 Top Stories |
| Watchlist | ✅ | localStorage 기반 ★ 저장, 실시간 가격 반영 |
| Portfolio | ✅ | 매수가·수량 입력, 평가손익 계산, 30초 갱신 |
| Earnings | ✅ | Nasdaq API, This Week/Next Week/Today, EPS 예상치·전년 비교 |

*최종 수정: 2026-07-10*
