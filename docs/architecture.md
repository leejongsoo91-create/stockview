# StockView 아키텍처

> 갱신: 2026-11-02 · 구조가 바뀌는 작업(새 API, 새 스케줄러, 새 데이터 파일)을 하면 이 문서도 함께 고친다.

## 1. 한눈에 보기

```
 외부 데이터 소스                    서버 (python app.py, 127.0.0.1:5001)                  브라우저 (SPA)
┌──────────────────┐   requests   ┌──────────────────────────────────────┐   REST    ┌───────────────────────┐
│ Yahoo Finance    │─────────────▶│ data_fetcher.py  (수집·가공·신호계산) │◀──────────│ templates/index.html  │
│ Nasdaq API       │              │        │                             │  /api/*   │ static/js/*.js (탭별) │
│ 네이버 (금융·API)│              │        ▼                             │           │ static/css/style.css  │
│ KRX KIND         │              │ cache.py  (TTL 캐시, stale 허용)      │──────────▶│                       │
│ SEC EDGAR        │              │        ▲                             │ WebSocket │ localStorage          │
│ RSS 20여 개      │              │ app.py  APScheduler 주기 갱신 ────────│ *_update  │ (관심종목·포트폴리오) │
│ Claude API / TTS │              │         Flask 라우트 + socketio       │           └───────────────────────┘
└──────────────────┘              └──────────────────────────────────────┘
                                        ▲ 읽기 전용
                                  data/*.json  ◀── scripts/*.py (수동 실행)
```

**흐름:** APScheduler가 주기적으로 `data_fetcher`를 호출 → 결과를 `cache`에 저장 → 소켓으로 `*_update` 알림 → 브라우저가 `/api/*`를 다시 불러 화면 갱신. 요청 시점에는 거의 항상 캐시만 읽는다.

## 2. 파일 역할

> US = 미국주식 전용 / KR = 국내주식 포함 / 공통 = US+KR

| 파일 | 구분 | 역할 |
|------|------|------|
| `app.py` (~1,290줄) | 공통 | Flask 라우트, APScheduler, socketio 큐 emit, 캐시 병합 헬퍼 |
| `data_fetcher.py` (~3,590줄) | 공통 | 모든 외부 수집·파싱·신호 계산·음성 브리핑. `# ── 섹션명 ──` 헤더로 구분, **모듈 분리 금지** |
| `cache.py` | 공통 | Thread-Safe TTL 캐시 (stale-while-revalidate, 200회마다 방치 항목 정리) |
| `templates/index.html` | 공통 | SPA 단일 HTML (9탭) |
| `static/js/main.js` | 공통 | 뷰 전환, 홈, 뉴스, 소켓, 공용 헬퍼(`signalBadgeHtml`, `makeNotesStore`, CSV 등) |
| `static/js/screener.js` | US+KR | 상단 US / 하단 `// ══ 국내주식 ══` 이하 KR |
| `static/js/heatmap.js` | US+KR | D3 트리맵 (US 3단계, KR 2단계) |
| `static/js/chart.js` | US+KR | Lightweight Charts, 지표·신호·그리기 도구·종합진단·재무제표 (`isKr` 분기) |
| `static/js/brief.js` | US+KR | Brief 탭 (추천·스캐너·음성 브리핑) |
| `static/js/watchlist.js` / `portfolio.js` | 공통 | localStorage 기반 관심종목 / 손익 |
| `static/js/earnings.js` | US | 실적 캘린더 |
| `static/css/style.css` | 공통 | 다크/라이트 테마 전체 (섹션 순서 규칙은 `.claude/rules/css.md`) |
| `scripts/*.py` | — | 수동 실행 도구 (수집·백테스트). **app.py에서 import 금지** |
| `data/kr_stocks.json` | KR | 국내주식 기본 데이터 (`fetch_kr_stocks.py` 생성, **현재 소스 폐기로 재생성 불가** → ROADMAP) |
| `data/pe_eps_cache.json` | US | PE/EPS 캐시 (서버가 24h마다 갱신, git 추적) |
| `data/kr_per_cache.json` | KR | KR PER/EPS (서버가 24h마다 갱신, gitignore) |
| `data/signal_history.json`, `voice_briefing.json`, `audio/` | 공통 | 서버 런타임 상태 (gitignore) |
| `api/` | — | API 키 파일 (gitignore, **절대 커밋 금지**) |

## 3. 스케줄러 (app.py)

| 작업 | 주기 | 비고 |
|------|------|------|
| `refresh_indices` | 30초 | 지수 19개, `indices_update` |
| `refresh_stocks` / `refresh_kr_stocks` | 5분 | `stocks_update` / `kr_stocks_update` |
| `refresh_news`, `refresh_kr_market_news`, `refresh_finnhub_news` | 10분 | `news_update` |
| `refresh_reports` | 15분 | |
| `refresh_fear_greed` | 30분 | |
| `refresh_earnings` | 1시간 | |
| `refresh_market_caps`, `refresh_extra_fields`(52W) | 6시간 | |
| `refresh_av_news` | 12시간 | |
| `refresh_pe_eps`, `refresh_kr_per` | 24시간 | KR PER은 시작 300초 후 |
| `refresh_daily_signals` | 24시간 | 시작 240초 후. **그 전까지 신호 관련 API는 비어 있음(정상)** |
| `refresh_voice_briefing` | 24시간 | **기본 꺼짐** (`VOICE_BRIEFING_ENABLED = False`, 꺼지면 등록 자체를 안 함). 켜면 시작 270초 후, 오늘 생성분 있으면 재사용 |
| `refresh_dynamic_indices` | 1주 | |

서버 시작 시 `initial_load()`가 작업들을 2~4초 간격으로 시차 실행한다.

## 4. API 엔드포인트

| 그룹 | 경로 |
|------|------|
| 시세 | `/api/stocks`, `/api/kr-stocks`, `/api/indices`, `/api/index-members`, `/api/stock/<ticker>`, `/api/heatmap-perf` |
| 차트·분석 | `/api/chart/<ticker>`, `/api/stock-analysis/<ticker>`, `/api/financials/<ticker>` |
| 뉴스·공시 | `/api/news`, `/api/reports`, `/api/stock-news/<ticker>`, `/api/kr-news/<code>`, `/api/kr-disclosures`, `/api/kr-investor/<code>` |
| Brief·신호 | `/api/brief`, `/api/daily-signals`, `/api/volume-surges`, `/api/candle-patterns`, `/api/rsi-divergence`, `/api/52w-movers`, `/api/earnings-signals`, `/api/fear-greed`, `/api/voice-briefing`, `/api/voice-briefing/audio/<file>` |
| 캘린더 | `/api/earnings`, `/api/economic-calendar` |
| 운영 | `/api/cache/status` |

신호 계열(`daily-signals`, `volume-surges`, `candle-patterns`, `rsi-divergence`, `52w-movers`, `earnings-signals`)은 전부 `daily_signals` 캐시 하나에서 파생된다.

## 5. 브라우저 저장소 (localStorage)
`WL`(관심종목) · `PT`(포트폴리오) · `WLG`/`PTG`(그룹) · `WLN`/`PTN`(메모·목표가) · `NB`(뉴스·리포트·공시 북마크, `report_type`/`is_disclosure`로 구분) · `stockview_chart_drawings`(차트 그리기). **키 이름·포맷을 바꾸면 기존 사용자 데이터가 깨지므로 호환 유지.**

## 6. 외부 데이터 소스 주의사항

| 소스 | 주의 |
|------|------|
| Yahoo Finance | JSON 배치 API(`v7/quote`, `quoteSummary`)는 크럼 없이 401 → HTML 스크래핑·v8 chart만 사용. 병렬 과다 시 429 → 동시성 5 + 지연, 실패율 50%↑면 캐시 60초 |
| 네이버 금융 | 페이지마다 인코딩이 다름(EUC-KR / UTF-8 혼재) → 새 페이지는 `Content-Type` 먼저 확인. 옛 HTML 페이지가 계속 폐기되는 중 → `m.stock.naver.com/api/...` JSON API 우선 |
| KRX KIND | 07-12에 EUC-KR → UTF-8로 바뀐 전례 |
| SEC EDGAR | User-Agent에 이메일 형식 문자열 필수(없으면 403). `fy`/`fp` 라벨이 불안정 → 기간 종료일(`end`)로 그룹핑 |
| RSS | 피드가 자주 죽음(404/403). 국내 RSS는 커스텀 User-Agent 필요한 곳 많음 |

## 7. 개발 시 함정 (실제로 겪은 것)
- **`templates/index.html`을 고치면 서버 재시작 필요** — debug off라 Jinja 템플릿이 캐시됨. JS/CSS는 재시작 불필요
- **`data_fetcher.py`는 CRLF** — 파이썬으로 다시 쓸 때 줄바꿈 유지 (LF로 쓰면 전체 diff 발생)
- Lightweight Charts: `fixRightEdge:true`와 `rightOffset`은 같이 못 씀. 메인+RSI+MACD+STO 4개 패널을 같이 고쳐야 세로선이 맞음
- 신호 로직은 JS(`_calcSignals`)와 Python(`compute_today_signal`) **이중 구현** — 한쪽만 고치면 화면과 Brief가 어긋남
- 공유 저장소(`NB` 등)에 새 소비자를 붙이면 상대방 항목 필터링 누락으로 교차 오염 발생한 전례
- 포트 5001: Claude가 띄운 서버와 사용자가 띄운 서버가 동시에 돌면 충돌. 병렬 작업은 5002+ (`parallel-work` 스킬)

## 8. 환경 제약
- Python **3.15.0a7** 알파: numpy·pandas·torch·grpc 계열 설치 불가 → `requests`로 직접 호출 (`yfinance` 미사용)
- `scripts/screener_api.py`(FastAPI+pandas)는 현재 환경에서 실행 불가
- 설치된 주요 패키지: flask, flask-socketio, feedparser, vaderSentiment, APScheduler, requests, google-auth, anthropic
