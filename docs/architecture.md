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
| `data/kr_stocks.json` | KR | 국내주식 기본 데이터 4,318종목(주식·ETF·ETN, 11-09 생성). `scripts/fetch_kr_stocks.py`(약 2~3분, `--dry-run`은 비교만)로 재생성 — 목록·시총 네이버 `marketValue`, 업종 네이버 `industry`, PER/EPS `integration`, 52주 Yahoo. 종목코드는 영문 섞인 신규 코드(`0126Z0`) 포함 → 코드 추출은 `df.kr_code()` |
| `data/pe_eps_cache.json` | US | PE/EPS 캐시 (서버가 24h마다 갱신, git 추적) |
| `data/kr_per_cache.json` | KR | KR PER/EPS (서버가 24h마다 갱신, gitignore) |
| `data/market_flow.json` | 공용 | 시장 전체 일별 거래량·거래대금 `{KOSPI·KOSDAQ·US: {날짜: {volume, amount}}}` — 서버가 매일 장 마감 뒤 한 줄씩 쌓음(거래대금 과거치는 무료 출처 없음), gitignore (11-18) |
| `data/market_breadth.json` | 공용 | 미국·국내(주식만) 상승·하락·보합 종목 수 `{us, kr: {n, up, down, flat, at, date, kospi?, kosdaq?}}` — 정규장 동안 1분마다 덮어쓰고 마감 뒤엔 그대로(정규장 종가 기준), gitignore (11-23) |
| `data/us_stock_flow.sqlite` | 공용 | 미국 종목별 누적 거래량·실제 체결 금액 스냅숏 `snap(tk, day, slot, volume, amount)` — 시장 거래와 같은 뉴욕 09:29·16:01·20:05에 약 5,000종목 저장(SQLite, 표준 라이브러리), 차이로 정규장·프리·애프터. `/api/us-stock-flow/<종목>`·`/api/stock-daily/<종목>`(📋 일별 시세)이 읽음, 작업 PC는 집 서버 값, gitignore (11-23) |
| `data/news_archive.sqlite` | 공용 | 뉴스 기록 `news(url, title, title_ko, source, market, category, ts, day, sentiment)` + 종목 묶음 `news_tk(tk, url)` — 뉴스·국내 뉴스·Finnhub 갱신과 종목 뉴스 조회 때 쌓음(본문 없음, 링크만), 번역 끝나면 title_ko 채움. `/api/news-archive?date=`·`/api/news-archive/days`·`/api/stock-news-archive/<종목>`이 읽음, 작업 PC는 집 서버 기록, gitignore (11-24). 같은 파일에 증권사 텔레그램 리서치 `tg_posts(ch, msg, ts, broker, title, text, links, analyst, opinion, target, cur, single)` + `tg_tk(tk, ch, msg)`. 리포트 목록 `reports(src naver·hk, rid, cat, day, broker, tk, title, summary, opinion, target, chg, analyst, url, pdf)`. 실적·공시 이벤트 `events(kind, tk, day, data)` — us_earn(분기·EPS·예상·서프라이즈·장 전/후·1·5일 반응), 11-25. 국내 공시 `dart(rcept_no, day, tk, corp, title, kind, tone, data)` — DART 분류(결정 008)·잠정실적 숫자, events에 kr_prelim·kr_buyback 등 |
| `data/dart_corp_codes.json` | 공용 | DART 종목코드 → 회사코드 대응표(상장사 약 4,000) — corpCode.xml에서, 7일마다 새로, gitignore (11-25) |
| `data/us_names_ko.json` | US | 미국 종목 한글명 (네이버 해외주식 목록, 서버가 주 1회 갱신, gitignore). 표시 우선순위: 네이버 → `NAME_KO` 수동 사전 → 빈칸 (`df.name_ko()`) |
| `data/news_translations.json` | 공용 | 뉴스 영어 제목 → 한글 번역 저장 `{titles: {원문: [한글, 서비스, 시각]}, usage: {YYYY-MM: {ms, google}}, log}` — 14일 지나면 지움, 서비스별 월 글자 수 상한(Microsoft 190만·Google 45만) 계산에 사용, gitignore (11-22, 결정 007) |
| `data/signal_history.json`, `voice_briefing.json`, `audio/` | 공통 | 서버 런타임 상태 (gitignore) |
| `api/` | — | API 키 파일 (gitignore, **절대 커밋 금지**) |

## 3. 스케줄러 (app.py)

| 작업 | 주기 | 비고 |
|------|------|------|
| `refresh_indices` | 30초 | 지수 19개, `indices_update`. 캐시 ttl 90초(갱신 주기보다 길게 — 같으면 순간 더미 값 반환). 코스피·코스닥은 네이버 실시간 값으로 덮어씀(Yahoo 등락률 오류). 달러/원은 포트폴리오 원화 환산에도 사용 |
| `_rt_loop` (백그라운드) | **10초** | 화면 종목 실시간: 브라우저가 `rt_subscribe`로 보낸 종목(관심종목·포트폴리오·차트) + 지수(코스피·코스닥·S&P·나스닥·다우)를 네이버 polling으로 받아 캐시에 반영 → `rt_quotes`·`rt_indices`. 종목은 프리~애프터(국내 07:55~20:05, 미국 뉴욕 04:00~20:05), 지수는 정규장만. 여러 명이 봐도 한 번만 받음 |
| `refresh_us_quotes` | 정규장 1분 · 프리/애프터 2분 (뉴욕 평일 04:00~20:05) | 미국 전 종목 가격·등락률·거래량을 네이버 미국 시장 목록(약 70요청, 24초)으로 덮어씀 — **Nasdaq 스크리너 API는 장중에도 전일 종가**. 시가총액은 Nasdaq 값을 가격 비율로만 조정. 정규장 밖이면 `overMarketPriceInfo`의 시간외 가격이 현재가(`session`·`session_open`·`session_at`, 11-20). 시작 15초 후 한 번 |
| `refresh_kr_quotes` | 정규장 1분 · 넥스트레이드 프리/애프터 2분 (평일 07:55~20:05 KST) + 평일 16:05 한 번 | 국내 전 종목 시세·시가총액을 네이버 국내 시장 목록(약 44요청, 10초)으로. 시작 20초 후 한 번. **정규장 밖이면 시간외 가격이 현재가**(11-20, 등락은 전일 KRX 종가 대비, `session`=pre/after): 목록의 `overMarketPriceInfo`, 없으면 종목별 실시간 시세(약 38요청)의 체결 시각이 정규장 밖일 때 closePrice(넥스트레이드 체결가). 체결 시각이 `closePriceSendTime`(16:30)이면 KRX 확정 종가(KRX 전용 종목). 11-17의 야후 KRX 종가 교체는 이걸로 대체(`fetch_kr_close_yahoo`는 남아 있으나 미사용) |
| `refresh_stocks` / `refresh_kr_stocks` | 5분 | `stocks_update` / `kr_stocks_update`. Nasdaq(섹터·업종 등 기본 정보) 위에 마지막 네이버 시세를 덮어씀. KR Yahoo 갱신은 네이버 시세가 살아 있으면 30분에 한 번만(52주 최고·최저용) |
| `refresh_news`, `refresh_kr_market_news`, `refresh_finnhub_news` | 10분 | `news_update`. 피드마다 분야 `category`(econ·world·tech·energy·policy·general, `auto:` 피드는 제목 단어로) — 경제 200건·다른 분야 각 60건까지 (11-22) |
| `refresh_finnhub_company_news` | 30분 | 시총 상위 15종목 Finnhub 종목별 뉴스(종목당 4건, 3일 이내) — AlphaVantage 대체 (11-22) |
| `refresh_news_translations` | 위 뉴스 갱신 직후 | 영어 제목 번역: Microsoft Translator F0 → (안 되면) Google Cloud Translation → 원문. **환경변수 `STOCKVIEW_TRANSLATE=1`인 서버만**(집 서버 systemd) 새로 번역 — 작업 PC·병렬 서버는 저장된 번역만 표시(11-23). 새로 번역되면 `news_update`. 상태 `/api/news/translation`, 터미널 `scripts/news_translate_status.py` (11-22) |
| `refresh_reports` | 15분 | |
| `refresh_fear_greed` | 30분 | CNN Fear & Greed. 현재 점수·지난 값 4개 + `history`(1년 추이, 하루 1개) + `components`(구성 지표 7개 점수·판정, 11-20부터 `series` 원본 값 1년 [[ms, 값]] 미국 거래일당 1개 + 모멘텀·VIX는 `compare` 비교선 125일·50일 평균) — 홈 상단 배지·상세 창(지표를 누르면 원본 데이터), Brief 게이지에서 사용 (11-17) — 응답 약 65 KB |
| `record_us_market_flow(slot)` | 뉴욕 평일 09:29·16:01·20:05 + 서버 시작 때(기록 시각 10분 안이면) | 미국 보통주 **누적** 거래량·**실제 체결 금액**(네이버 `accumulatedTradingValueRaw`) 합계를 그 시각에 새로 받아 `data/market_flow.json` `US[날짜].s0929·s1601·s2005`에 기록(이미 있는 칸은 덮어쓰지 않음, AAPL 오늘 체결 없으면 휴장). 네이버 누적값엔 시간외가 계속 더해져(11-20 16:20 110.6억주 → 19:30 123.8억주) `/api/market-flow`가 차이로 나눔: 프리 = s0929, **정규장 = s1601 − s0929**(막대·평균 기준), 애프터 = s2005 − s1601. 11-19·20은 예전 한 번 저장(현재가×거래량 추정, `mixed`). **작업 PC 등 `api/home-server-url.txt`가 있는 서버는 미국 값을 집 서버 `/api/market-flow`에서 받아 보여 줌(11-23)**. **국내는 11-21부터 저장하지 않음** — 코스피·코스닥은 다음 금융 지수 일별(`finance.daum.net/api/market_index/days`, 거래대금 백만원·거래량 천주, 500일, 1시간 캐시, 15:40 전엔 오늘 줄 제외)을 불러오고, 실패하면 예전 저장값 + 네이버 거래량 과거치(fchart). 16:10 네이버 값은 장 마감 뒤 확정 전 중간값이었음(11-20 코스피 16:10 14.11조 → 확정 14.95조) (11-18, 11-21 변경) |
| `refresh_market_breadth` | 1분마다 (정규장만 실제로 셈: 뉴욕 09:30~16:01, 국내 09:00~15:31) | 상승·하락·보합 종목 수를 세서 `data/market_breadth.json`에 저장하고 `breadth_update`로 알림. 정규장 시간인데 30% 넘는 종목이 시간외 값이면 휴장으로 보고 건너뜀. `/api/market-breadth`는 `live`(장중)·`approx`(정규장 기록 전, 지금 시세로 셈) 표시 — 홈 상태 줄 배지 (11-23) |
| (요청 시) `/api/market-investors?market=KOSPI\|KOSDAQ&days=` | 일별 1시간 · 장중 60초 캐시 | 코스피·코스닥 투자자별 **순매수**(원) — 다음 금융 `finance.daum.net/api/investor/{시장}/days\|times?details=true`(Referer 필수, 없으면 403). 개인·외국인·기관 + 기관 세부 7개(금융투자·보험·투신·사모·은행·기타금융·연기금)·기타법인·기타외국인, 일별 약 10년(한 번에 300일)·장중 1~2분 갱신(20:00까지). 오늘 일별 줄이 없으면 장중 값을 붙임. 총 매수·매도 금액·주식 수는 KRX 정보데이터시스템만 있고 로그인 필요(11-20). 네이버 `m.stock.naver.com/api/index/{시장}/trend`(개인·외국인·기관 3개만)와 날마다 수십억~수백억 차이 — 홈 📊 시장 거래 창 (11-20) |
| `refresh_earnings` | 1시간 | |
| `refresh_market_caps`, `refresh_extra_fields`(52W) | 6시간 | |
| `refresh_pe_eps`, `refresh_kr_per` | 24시간 | KR PER은 시작 300초 후 |
| `refresh_us_names_ko` | 24시간 확인, 6일 지났을 때만 수집 | 시작 28초 후. 3,000개 미만이면 저장 안 함 |
| `refresh_daily_signals` | 24시간 | 시작 240초 후. **그 전까지 신호 관련 API는 비어 있음(정상)** |
| `refresh_voice_briefing` | 24시간 | **기본 꺼짐** (`VOICE_BRIEFING_ENABLED = False`, 꺼지면 등록 자체를 안 함). 켜면 시작 270초 후, 오늘 생성분 있으면 재사용 |
| `refresh_dynamic_indices` | 1주 | |

서버 시작 시 `initial_load()`가 작업들을 2~4초 간격으로 시차 실행한다.

## 4. API 엔드포인트

| 그룹 | 경로 |
|------|------|
| 시세 | `/api/stocks`, `/api/kr-stocks`, `/api/indices`, `/api/index-members`, `/api/stock/<ticker>`(목록에 없는 미국 티커는 Yahoo 현재가로 응답), `/api/heatmap-perf`, `/api/sector-etf?period=1d\|1w\|1m`(홈 섹터 줄, SPDR 섹터 ETF 11개, 1분 캐시) |
| 차트·분석 | `/api/chart/<ticker>`, `/api/chart-warmup/<ticker>`(일봉 화면 기간 앞쪽 봉 최대 460개 — 긴 이평선·파란점선 계산 전용), `/api/stock-analysis/<ticker>`, `/api/financials/<ticker>` |
| 뉴스·공시 | `/api/news`(항목에 `category`, 번역됐으면 `title_ko`), `/api/news/translation`, `/api/reports`, `/api/stock-news/<ticker>`, `/api/kr-news/<code>`, `/api/kr-disclosures`, `/api/kr-investor/<code>` |
| Brief·신호 | `/api/brief`, `/api/daily-signals`, `/api/volume-surges`, `/api/candle-patterns`, `/api/rsi-divergence`, `/api/52w-movers`, `/api/earnings-signals`, `/api/fear-greed`, `/api/voice-briefing`, `/api/voice-briefing/audio/<file>` |
| 캘린더 | `/api/earnings`, `/api/economic-calendar` |
| 운영 | `/api/cache/status` |

신호 계열(`daily-signals`, `volume-surges`, `candle-patterns`, `rsi-divergence`, `52w-movers`, `earnings-signals`)은 전부 `daily_signals` 캐시 하나에서 파생된다.

## 5. 브라우저 저장소 (localStorage)
`WL`(관심종목) · `PT`(포트폴리오) · `WLG`/`PTG`(그룹) · `WLN`/`PTN`(메모·목표가) · `NB`(뉴스·리포트·공시 북마크, `report_type`/`is_disclosure`로 구분) · `stockview_chart_drawings`(차트 그리기) · `NXV`(뉴스 탭 보기 설정: 분야·오른쪽 칸·한글/원문, 11-22). **키 이름·포맷을 바꾸면 기존 사용자 데이터가 깨지므로 호환 유지.**

## 6. 외부 데이터 소스 주의사항

| 소스 | 주의 |
|------|------|
| Yahoo Finance | JSON 배치 API(`v7/quote`, `quoteSummary`)는 크럼 없이 401 → HTML 스크래핑·v8 chart만 사용. 병렬 과다 시 429 → 동시성 5 + 지연, 실패율 50%↑면 캐시 60초 |
| 네이버 금융 | 페이지마다 인코딩이 다름(EUC-KR / UTF-8 혼재) → 새 페이지는 `Content-Type` 먼저 확인. 옛 HTML 페이지가 계속 폐기되는 중 → `m.stock.naver.com/api/...` JSON API 우선 |
| 국내 일봉 | 야후 v8 chart는 최신 거래일 봉 종가가 하루 가까이 비어 있음 → `fetch_ohlcv`가 야후 뒤에 야후 meta(regularMarketPrice·DayHigh·DayLow·Volume)의 KRX 값으로 최신 1봉 보충(`_kr_latest_bar_rt`, 11-17 — 네이버 실시간 값은 15:30 이후 넥스트레이드 가격이 섞여 폐기). **장 마감 몇 시간 뒤엔 meta 고가·저가·거래량이 0** → 종가만 meta, 시가·고가·저가는 네이버 **분봉 중 09:00~15:30만**(그 밖은 넥스트레이드), 거래량은 네이버 일봉 `accumulatedTradingVolume`(KRX 정규장 거래량과 같음) — `_kr_naver_day_bar`, 11-18. 야후 분봉은 15:00까지만 있어 15시대 고가·저가를 놓쳐 쓰지 않음. 네이버 차트 API(`api.stock.naver.com/chart/domestic`)는 고가·저가·종가에 넥스트레이드 애프터마켓 가격이 섞여 야후 실패 시에만 사용 (11-14) |
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
- 실행 환경: WSL Ubuntu `/root/stockview/.venv` (Python **3.12.3**). Windows 쪽 Python 3.14/3.15는 서버와 무관
- numpy·pandas 미설치 → `requests`로 직접 호출 (`yfinance` 미사용). 예전 Python 3.15.0a7 알파에서 설치가 안 돼 생긴 구조를 유지
- `scripts/screener_api.py`(FastAPI+pandas)는 `.venv`에 pandas가 없어 현재 실행 불가
- 설치된 주요 패키지: flask, flask-socketio, feedparser, vaderSentiment, APScheduler, requests, google-auth, anthropic
