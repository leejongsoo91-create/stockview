# 작업 상세 이력 (2026-06 ~ 2026-11-01 보관본)

> 2026-11-02 파일 구조 개편 때 Claude 로컬 메모리(`project_stockview.md`, `project_signal_accuracy.md`)에서 옮겨온 **읽기 전용 보관본**이다. 새 기록은 여기에 추가하지 않는다 → 완료 이력은 [../CHANGELOG.md](../CHANGELOG.md), 결정은 [../decisions/](../decisions/).
> 공개 저장소이므로 클라우드 프로젝트 ID·서비스계정·개인 경로 등 식별 정보는 제거했다.

---

# Part 1. 프로젝트 진행 상세 (원본: project_stockview.md)

StockView — Finviz 스타일 미국+국내 주식 시장 분석 웹앱 (Flask + Vanilla JS)

**Why:** 사용자가 직접 개발 중인 개인 프로젝트. Finviz와 유사한 스크리너, 차트, 히트맵, 뉴스 기능을 구현.

**How to apply:** 작업 요청 시 PLAN.md와 이 메모리를 참고해 현재 Phase 번호부터 이어서 작업. "불러오기" 명령 시 이 메모리 기준으로 최신 상태 보고.

## 핵심 정보
- 실행: `python app.py` → http://127.0.0.1:5001
- Python 3.15 alpha (pandas/numpy 설치 불가 → requests 직접 사용)
- 데이터: Yahoo Finance API (직접 HTTP), Naver Finance (EUC-KR 스크래핑), KRX KIND, Nasdaq 스크리너 API, Finnhub/AlphaVantage 뉴스

## 완료된 주요 Phase
- Phase 1~3: Flask SPA 기본 구조, S&P500 데이터, 실시간 연동
- Phase 4-1 ~ 4-65: 스크리너 필터/프리셋, 포트폴리오, 관심종목, KR 업종 분류 등
- Phase 4-70: KR 히트맵
- Phase 4-71: KR 종목별 뉴스 (Naver Finance)
- Phase 4-73: RSI/MACD 기술적 지표 차트 패널
- Phase 4-74: KR 외인·기관 수급 동향 (Naver frgn.naver)
- Phase 4-75: KRX KIND 공시 피드 (News 탭 "📢 공시" 서브탭)
- Phase 4-76: 코스피·코스닥 전종목 검색 (488개 → 3,945개)
- Phase 4-77 (2026-06-30): KR 전략B 적용 — 매도 신호 약세 캔들 확인 필터 (chart.js), [[project-signal-accuracy]] 참고
- Phase 4-78 (2026-06-30~07-03): KR 스크리너 등락률 버그 수정(±30%초과, -100%), 전종목 재수집, 스크리너 미방문 상태 글로벌 검색 버그 수정
- Phase 4-79 (2026-07-03): 차트 매수/매도 신호 시각적 강조 — `chart.js` `_applySignalMarkers()` 마커 확대+가격표시, `_renderSignalCard()` `.sc-banner` 색상 배경 배너
- Phase 4-80 (2026-07-03): 미국주식 2,960→5,000개 확장 (`fetch_nasdaq_stocks()` 시총 하한 해제), Finnhub API 키 교체(만료 키로 인한 종목뉴스 401 해결)
- Phase 4-81 (2026-07-06~07-07): RSS 죽은 피드 5종 정리 — Benzinga URL 교체, Investopedia/Business Wire 제거, Barron's→WSJ Markets 교체, Reddit 5초 지연(부분 개선, 완전 해결 아님)
- Phase 4-82 (2026-07-07): Chart 탭 검색창 한글/영문 종목명 검색 — `chart.js` `_resolveChartTicker()`, 헤더 전역검색과 동일 데이터(`window._scStocks`/`_krStocks`) 재사용
- Phase 4-83 (2026-07-09): 히트맵 성과 데이터 전체 종목 확대 + KR 1주/1개월 기간 필터 추가 — `/api/heatmap-perf` 500개 제한 제거(전체 5,000개, ~20초), `market=kr` 파라미터로 KR도 지원, 저성공률(50% 미만) 결과는 60초만 캐시하도록 수정(기존엔 Yahoo 레이트리밋으로 빈 결과가 1시간 캐시되는 버그였음)
- Phase 4-84 (2026-07-10): PE/EPS 수집 스크립트 커버리지 확대 — 후보 티커 600→5,000개(진짜 원인), 병렬화(5 workers+지연)+429 서킷브레이커. 캐시 1,277→**3,255개**(25%→65%)
- Phase 4-85 (2026-07-10): `main.js` WebSocket console.log 디버그 잔재 5곳 제거
- Phase 4-86 (2026-07-10): 조용히 삼켜지던 예외 처리에 로깅 보강 — `_load_kr_base`/`_load_pe_eps`/`fetch_extra_fields`/`fetch_kr_prices`/`fetch_heatmap_perf`/AlphaVantage 타임스탬프(1970년 폴백 버그도 수정)
- Phase 4-87 (2026-07-10): 스크리너 "정상 종목만 보기" 필터 추가(US 전용, 옵트인) — `market_cap` 없음 또는 이름에 Warrant/Rights/Preferred 포함 시 제외. "Units" 키워드는 Energy Transfer/MPLX 같은 실제 대형 MLP 오탐 발생해 제외 목록에서 뺌
- Phase 4-88 (2026-07-10): **Brief 탭 "오늘의 매수/매도 추천"** (US/KR 각각, 단기·중기·장기) — `chart.js` `_calcSignals()`를 서버 배치용으로 포팅(`compute_daily_signals`/`build_daily_recommendations`), 24시간 스케줄러, US·KR 시총 상위 500개씩 대상, 신호강도(±1/2/3)로 단/중/장기 라벨링 후 점수순 정렬. 배치 20초 내 완료(Yahoo 차단 없음)
- Phase 4-89 (2026-07-10): **Brief 탭 "52주 신고가/신저가 근접 종목"** (US/KR) — 캐시 데이터만으로 즉시 계산(네트워크 불필요). 검증 중 발견: 비정상 종목(워런트/우선주) 필터 없이는 pos%가 25,988%까지 튀는 버그 있었음 → 스크리너 필터 재사용 + 0~100% 범위 검증으로 수정
- Phase 4-90 (2026-07-10): **Brief 탭 "실적 발표 임박 + 신호 결합"** (US 전용) — 기존 어닝스 캘린더 캐시 + daily_signals 캐시 교차 매칭, 날짜순 정렬. KR은 실적 캘린더 데이터 소스 없어 미지원
- Phase 4-91 (2026-07-12): Watchlist·Portfolio에 오늘의 신호 배지 연동 — `main.js` `loadDailySignalMap`/`signalBadgeHtml` 공용 헬퍼
- Phase 4-92 (2026-07-12): Chart 탭 검색을 US/KR 시장 선택 후 검색하도록 개선 — 자동 교차검색으로 인한 이름 겹침 오매칭 방지
- Phase 4-93 (2026-07-12): 공시 텍스트 깨짐 수정 — KRX KIND가 EUC-KR→UTF-8로 응답 인코딩 바뀐 걸 코드가 못 따라가고 있었음
- Phase 4-94 (2026-07-13): 공시 패널 100건 확대 + 카테고리 서브탭(전체/실적발표/기업공시/시장감시) — `_classify_disclosure()`
- Phase 4-95 (2026-07-12): **Brief 탭 "거래량 급증 종목"** (US/KR) — `compute_daily_metrics()`에 `volume_ratio` 통합, KR은 ETF 제외 → Brief 추천 4종 세트 완성
- Phase 4-96 (2026-07-13): 스크리너(US/KR)에 Signal 컬럼 + "신호 있는 종목만" 필터 — Watchlist/Portfolio와 동일 데이터 재사용
- Phase 4-97 (2026-07-13): 히트맵(US/KR)에 오늘의 신호 오버레이 — 매수 초록/매도 빨강 테두리
- Phase 4-98 (2026-07-13): **캔들 패턴 스캐너**(US/KR, 상승/하락) — `_candle_pattern_today()`, 기존 배치 일봉 재사용(추가 요청 없음)
- Phase 4-99 (2026-07-13): 관심종목(Watchlist) 그룹/태그 기능 — `WLG` 저장소, 순수 프론트엔드
- Phase 4-100 (2026-07-16): 차트 탭 MA120·MA240 이동평균선 토글 추가
- Phase 4-101 (2026-07-17): **[중요 버그 수정]** `compute_today_signal()`이 chart.js 마커 표시 기준(`\|score\|>=2` threshold)을 누락해, 미검증 약한 신호(`\|score\|=1`)가 Brief/스크리너/워치리스트/히트맵 전반에 그대로 노출되던 버그 발견·수정 (커밋 `0695b11`). 500종목 백테스트로 순위 로직 검증하던 중 발견됨 — 상세는 [[project-signal-accuracy]] 참고. 부수로 Brief 매도 리스트에 "약한 신호(score=2) 숨기기" 체크박스 추가(커밋 `02a5ba3`)
- Phase 4-114 (2026-07-19): **[버그 수정, 2단계]** 차트 오른쪽 여백 없음 — 1차 시도(`abae7db`): `timeScale`에 `rightOffset:15` 추가했으나 실제로는 **전혀 반영 안 됨**(같은 `timeScale`에 있던 `fixRightEdge:true`가 `rightOffset`을 완전히 무력화시키는 걸 몰랐음). 2차 시도(사용자가 "키움증권 참고해서 다시 확인해달라"고 재지적, `31cf694`로 15→40 값만 올렸다가 이것도 무효였음을 Playwright로 실제 브라우저 JS 상태 조사해서 발견 → `d878778`): 메인+RSI+MACD+STO 4개 패널 전부 `fixRightEdge:true` 제거. 부수 발견: 메인만 고쳤으면 서브패널 3개가 각자 다른 값으로 클램프되어 메인과 세로선이 어긋났을 것(실측: 290/237/225/249로 전부 다르게 잘림) — 4곳 다 고쳐서 정렬까지 맞춤. **교훈: lightweight-charts에서 `fixRightEdge:true`와 `rightOffset`은 같이 못 씀, 여백이 필요하면 `fixRightEdge` 빼야 함**
- Phase 4-113 (2026-07-19): **차트 그리기 도구** — 추세선·수평선·수직선·피보나치 되돌림. 수평선은 LWC 내장 `createPriceLine()` 재사용, 나머지는 `<canvas>` 오버레이 직접 렌더링. 왼쪽 드래그를 HTS 줌 제스처(Phase 4-105)와 나눠 써서 도구 활성 시에만 그리기 모드, 평소엔 줌 유지. 그린 선 클릭→선택→손잡이 드래그로 끝점 수정 가능(선 전체 이동은 제외), 종목별 localStorage 저장(`stockview_chart_drawings`). Node.js 시뮬레이션 8개 시나리오(생성/취소/선택/드래그편집/삭제/저장복원/전체삭제) 전부 검증. 커밋 `a23f0df`. **오래 미뤄뒀던 항목 — "줌만 먼저 검토" 요청 이후 몇 세션 지나 완료**
- Phase 4-112 (2026-07-18~19): **"쉬움" 등급 백로그 11개 일괄 구현** — 07-18 코드감사(Explore 에이전트, 32개 후보 발굴)에서 "쉬움" 분류 11개 전부 구현. 1~4번 개별 커밋(`e1e6089`/`5880a83`/`5ef6590`/`35d8779`), 5~11번은 여러 파일에 걸쳐 있어 하나로 묶어 커밋(`1ce0671`):
  1. 홈 워치리스트/포트폴리오 요약 위젯
  2. 워치리스트 CSV 내보내기/가져오기
  3. 포트폴리오 CSV 내보내기/가져오기
  4. 워치리스트 종목별 메모/목표가 (`WLN` 저장소)
  5. 뉴스 북마크 (`NB` 저장소, ★ 토글 + "🔖 북마크" 필터탭)
  6. 전역 키보드 단축키 (`/`=검색포커스, 숫자1~9=탭전환)
  7. 스크리너 "⭐ 관심종목만" 필터 (US+KR)
  8. 스크리너 Shift+클릭 2차 정렬 (US+KR, `_sortCol2`/`_sortDir2`)
  9. 접근성 aria-label 보강 (`html lang="ko"` 수정 포함)
  10. 히트맵 기간 3M/6M/YTD 추가 (`fetch_heatmap_perf`가 range-agnostic이라 `range_map`만 확장)
  11. 실적 탭 섹터/시총 필터

  전 항목 Node.js 시뮬레이션 단위테스트 통과, 히트맵 3M/6M/YTD는 실제 Yahoo API 라이브 검증. 32개 후보 중 나머지 21개(보통/어려움 등급)는 미착수 — 다음 "확인해서 말해줘" 요청 시 이 리스트 참고
- Phase 4-111 (2026-07-18): **Chart 탭 검색창에 미리보기 드롭다운 추가** — 헤더 전역검색(`initGlobalSearch`)엔 이미 있던 입력 중 드롭다운을 Chart 탭 검색(`#chart-input`)에도 추가. `.gs-item` 스타일·`window._scStocks`/`_krStocks` 재사용, `_chartSearchMarket`(US/KR 토글) 반영. 커밋 `d12504c`
- Phase 4-110 (2026-07-18): **종합 진단에 수박지표(오리지널) US 전용 항목 추가** (7→8개) — 백테스트로 검증된 로직(`_watermelon_original_shell()`/`watermelon_signal()`, 껍질 0→양수 제로크로스)을 `build_stock_analysis()`에 이식. EMA448 필요해 OHLCV 조회 1y→2y 확대. KR은 백테스트에서 랜덤 수준이라 US 전용. 합성데이터로 백테스트 스크립트와 결과 100% 일치 검증. 커밋 `4893481`
- Phase 4-109 (2026-07-18): **종합 진단 5개 → 7개 항목 확장** — 캔들 패턴(기존 `_candle_pattern_today()` 재사용) + 골든/데드크로스(`_detect_ma_cross()` 신규, MA50/MA200 최근 10거래일 내 교차 이벤트 우선, 없으면 정배열/역배열 상태만 표시) 추가. 프론트는 items 배열을 개수 무관 렌더링이라 수정 불필요. TSLA·KR 000660.KS 실API로 7개 항목 검증. 커밋 `5eabc69`
- Phase 4-108 (2026-07-18): **종목 종합 진단 패널** (Chart 탭 사이드바) — 임의 종목 검색 시 기술적신호·밸류에이션(업종평균PE 신규계산)·52주위치·거래량·수급(KR)/뉴스감성(US) 5개 항목을 항목별 매수/매도우호 판정+근거로 표시, 요약은 "N개 중 매수 M·매도 K·중립 J" 카운트만 — 단일 자동결론 안 냄(사용자 요청). `build_stock_analysis()`는 기존 함수 조합만, 신규 수집 없음. KR 뉴스 스크래핑을 app.py 인라인→`fetch_kr_stock_news()`로 추출. US/KR 양쪽 실API 검증완료(AAPL/MSFT/NVDA, 005930.KS). 커밋 `90e5553`
- Phase 4-107 (2026-07-18): **차트 월봉·연봉 인터벌 추가** — Yahoo는 월봉(`interval=1mo`)만 지원하고 연봉은 API에 없어서, 월봉을 받아 `_resample_yearly()`로 연 단위 직접 집계(시가=1월분 시가, 종가=12월분 종가, 고저=연중 극값, 거래량=합산). 지난번 만든 "기간 직접입력(연수)"을 월봉·연봉에도 재사용. 실제 API로 AAPL 연봉 11개(2016~2026)·KR 종목(005930.KS)까지 검증. 커밋 `46857ab`
- Phase 4-106 (2026-07-18): **차트 기간 직접 입력(연수)** — 1M/3M/6M/1Y/2Y 버튼(Yahoo range 프리셋 한계)에 더해, 1~30년 임의 연수를 입력하면 Yahoo 차트 API의 `period1`/`period2`(유닉스 타임스탬프)로 정확히 그 기간을 조회. `fetch_ohlcv(years=)` 인자 추가, `/api/chart` 캐시키 분리. 실제 Yahoo API로 AAPL 7년(1757일치, 2019-07-22~) 검증 완료, 범위초과(50년)는 1y로 안전 폴백 확인. 커밋 `5d8b5e6`
- Phase 4-105 (2026-07-18): **차트 마우스 드래그 방향 기반 구간 확대/축소(국내 HTS 방식)** — TradingView(Ctrl+휠 또는 도구버튼)와 달리 키움 영웅문 등 국내 HTS 관례(좌→우 드래그=확대, 우→좌 드래그=전체보기, 더블클릭=직전화면 복귀)를 그대로 이식. 웹서치로 TradingView vs 국내HTS 관례 비교 후 사용자가 HTS 방식 선택. 라이브러리 기본 좌클릭패닝(`handleScroll.pressedMouseMove`)은 끄고 방향감지 제스처로 대체. 커밋 `e1c9df3`. **다음 예정: 차트 그리기 도구(추세선·수평선·수직선·피보나치되돌림, 종목별 localStorage 저장, 끝점 드래그 편집) — 사용자가 줌 기능 먼저 검토 후 이어서 진행하기로 함, 큰 작업(2.5~3시간)이라 별도 계획 필요**
- Phase 4-104 (2026-07-18): **[버그 수정]** 차트 자동 갱신 시 사용자가 확대(줌인)한 화면이 몇십 초~몇 분마다 초기화되던 버그 — `_renderCandles()`가 매번 `fitContent()`를 호출해 전체 기간으로 리셋했음(1분/5분봉처럼 짧은 인터벌일수록 체감 심함). 최초 로드시에만 fit하고 자동 갱신 시엔 유지하도록 `{fit:false}` 옵션 추가. 커밋 `d853abd`
- Phase 4-103 (2026-07-18): **[버그 수정]** 위시리스트 "+ 그룹" 버튼으로 만든 빈 그룹이 즉시 "전체"로 리셋되어 사라지던 버그 — `WLG.allGroups()`가 종목에 실제 배정된 그룹명만 인정하던 게 원인. 그룹명 전용 저장소(`stockview_watchlist_group_names`) 추가해 종목 미배정 상태에서도 그룹 유지. 커밋 `8bf792f`
- Phase 4-102 (2026-07-18): **Brief 탭 "신호" 서브탭** — 개요/신호 2개 서브탭 분리, 신호 탭에서 US/KR 매수·매도 신호 20개씩(기존 개요 카드는 10개 유지) + 신호 연속 유지일수 배지(오늘 신규="NEW", 이어지는 신호="N일째") 표시. `data/signal_history.json`(gitignore 대상, 앱이 직접 쓰는 런타임 상태)에 종목별 연속일수 기록, 7일 미출현 시 자동 정리. 커밋 `450455e`. **"N일째"는 달력 일(day) 단위** — `refresh_daily_signals` 24시간 배치가 도는 날짜 기준으로 전날에도 신호가 있었으면 +1, 끊겼다 재출현하면 1로 리셋(장중 갱신과 무관). 단위 테스트로 연속/리셋/정리 로직 검증 완료, 실행 중인 서버의 `/api/daily-signals`로 `held_days`/`is_new` 필드가 실제로 채워지는 것도 확인(GEV/EXC/SOFI/LII 등 held_days=1)

## 신규 기능 아이디어 발굴 + 1~3번 구현 (2026-07-23, 커밋 `72c35fd`)
버그감사·코드정리감사와 별개로 "새로 추가할만한 기능"을 general-purpose 에이전트로 조사(이미 있는 데이터/패턴 재사용 관점, 새 외부API 불필요한 것만). 11개 후보 중 가장 가벼운 1~3번 구현 완료:
1. Watchlist/Portfolio 신호배지에 "N일째"/"NEW" 표시 — `/api/daily-signals`가 이미 계산하던 `held_days`/`is_new`를 Brief 탭만 쓰고 있었음, `_heldBadgeHtml`을 brief.js→main.js(공용 위치)로 옮겨 `signalBadgeHtml()`에 반영
2. Reports 탭 북마크 추가 — News의 `NB` 저장소 공유 재사용(`report_type` 필드로 구분)
3. Portfolio에 메모/목표가(도달%표시)/그룹 추가 — Watchlist의 `WLN`/`WLG`와 동일 구조로 `PTN`/`PTG` 신설(별도 키), 그룹필터는 표 행만 거르고 요약카드·차트는 전체 기준 유지

**구현 중 발견한 버그(같이 수정):** 북마크를 News/Reports가 같은 `NB` 저장소로 공유하게 만들면서, 뉴스 북마크 필터에 리포트 항목이 섞여 보이는 교차오염이 생겼음(반대도 마찬가지) — 양쪽 다 `report_type` 필드 유무로 상대방 항목을 걸러내도록 수정. 이런 "공유 저장소를 새 소비자가 늘어날 때 필터링 누락" 패턴은 다음에 비슷한 통합(예: 북마크를 공시 탭에도 확장한다면) 때도 주의 필요

**남은 후보 (미착수, 4~11번)**: 포트폴리오 히스토리에 벤치마크 비교선, KR 공시 종목 하이퍼링크, Watchlist/Portfolio 다중종목 비교차트, KR 종합진단 실적임박 추가, 스크리너 다중선택→워치리스트 일괄추가, CSV 옆 인쇄용 리포트, Portfolio vs 지수 섹터비중 비교, Watchlist 그룹별 평균수익률 — 전부 "보통" 난이도 이상이라 다음에 이어서 진행 가능

## 신규기능 4~11번 중 7개 구현 완료 + 모바일 지원 + 검색 버그 수정 (2026-08-18, 커밋 `cbea323`/`6aa37ee`)
위 "남은 후보" 8개 중 7개(4~6, 8~11번) 구현·검증·커밋 완료. **7번(KR 종합진단 실적임박 추가)만 미착수로 남음** — backend 데이터 소스 필요해서 보류.

- 커밋 전 세션에서 이미 코드로 구현은 돼 있었으나 미검증 상태였음 → 이번 세션에서 API 응답 형식 대조(`/api/chart`, `/api/kr-disclosures` vs `/api/kr-stocks` 실측 94/100 매칭 등)로 검증 후 커밋
- **Tailscale 모바일 접속 구축**: `app.py`의 `socketio.run` host를 Tailscale 전용 IP로 고정(0.0.0.0 아님) — 상세는 [[project-remote-access]]
- **Claude Code Remote Control**로 이 코딩 세션 자체도 모바일에서 이어서 작업 가능하게 설정함(`/remote-control`) — StockView 접속과는 별개 기능, PC가 켜져 있어야 동작(절전모드 끔, 화면만 꺼지게 전원설정 변경)
- **모바일 반응형 디자인 추가** — 원래 반응형 CSS 전무했음. 폰으로 실제 접속해보고 발견: `.home-overview`(지수/선물/채권 3열 그리드)에 media query가 아예 없어서 좁은 화면에서 그리드가 못 줄어들고 페이지 전체가 `body{overflow-x:hidden}`에 잘려나가던 게 핵심 원인. 헤더 탭 메뉴, Heatmap 툴바, Chart/Screener/Watchlist/Portfolio 헤더 줄도 같은 패턴(`flex-wrap` 없음)이라 함께 수정. 8개 탭 중 Home·Heatmap은 폰 실기기로 시각 확인, 나머지는 코드 검토 기반 예방적 수정(사용자가 "지금까지는 괜찮다" 확인)
- **[버그 수정] 종목 검색 결과 정렬** — 헤더 전역검색/차트탭 검색 둘 다 시가총액 내림차순 배열에서 앞쪽 N개만 자르는 방식이라, 짧은 티커가 대형주 회사명에 우연히 포함되면(예: `BE`⊂Al**pha*be*t*, `MA`⊂...) 검색 결과에서 영영 안 보이는 버그. 실측: 4자 이하 티커 4,465개 중 **396개(9%)** 영향받음(`MA`/`C`/`T`/`D`/`O`/`A`/`P`/`F`/`Q` 등 1글자 티커가 특히 심각). `_gsTickerRank()` 공용 정렬 헬퍼로 정확일치>시작일치>부분일치 우선순위 적용, 396개 전수 재검증하여 해결 확인
- `data/pe_eps_cache.json`은 서버 실행 중 자동 갱신되는 캐시라 커밋 대상에서 제외(사용자 승인)

## 국내주식 데이터
- `data/kr_stocks.json`: KOSPI 2,171 + KOSDAQ 1,774 = **3,945종목**
- `data/kr_stocks_backup.json`: 이전 488종목 백업
- 수집: `python scripts/fetch_kr_stocks.py` (전페이지 자동 순회, 약 10분)

## 미국주식 데이터 (2026-07-03 확장)
- `fetch_nasdaq_stocks()` (`data_fetcher.py`): 시총 내림차순 상위 **5,000개** 고정 (이전 2,960개, 시총 0.3B 하한 있었음 → 하한 해제)
- 이 중 약 900개는 시총 데이터 없는 SPAC 워런트/유닛/우선주(`AACIW`, `ABR^D` 등) — 사용자가 "5000개까지 채우기" 선택하며 인지하고 승인함
- PE/EPS 캐시(`data/pe_eps_cache.json`)는 **3,255개 커버 (65%)** — Phase 4-84에서 확대 완료. 나머지 ~1,745개는 대부분 적자기업/워런트/우선주 등 애초에 PE 자체가 없는 케이스로 추정

## 신호 데이터 앱 전반 연동 (2026-07-10~13, 이번 세션 핵심 흐름)
"매일 브리핑탭에 매수/매도 종목 추천" 요청 하나에서 시작해 대화 중 "다른 타입 추천도 있지 않나?" → "새로운 아이디어도 보자"로 계속 확장된 결과, `/api/daily-signals`(chart.js 신호 로직을 서버 배치로 포팅한 핵심 데이터)가 앱 전체에 퍼짐:
- **Brief 추천 4종**: 오늘의 매수/매도(4-88) · 52주 근접(4-89) · 실적+신호 결합(4-90, US전용) · 거래량 급증(4-95)
- **캔들 패턴 스캐너**(4-98): 신호와 별개로 오늘 봉의 캔들 패턴만 스캔
- **신호 데이터 재사용처**: Watchlist·Portfolio 배지(4-91), Screener Signal 컬럼+필터(4-96), Heatmap 신호 테두리(4-97)

엔드포인트: `/api/daily-signals`, `/api/52w-movers`, `/api/earnings-signals`, `/api/volume-surges`, `/api/candle-patterns` — 전부 `daily_signals` 캐시(24시간 배치, `refresh_daily_signals()`) 하나에서 파생. **서버 재시작 후 최대 240초간 비어있음(정상)**. 프론트 공용 헬퍼는 `main.js`의 `loadDailySignalMap()`/`signalBadgeHtml()`.

## 관심종목(Watchlist) 그룹/태그 (Phase 4-99, 2026-07-13)
`WLG` 저장소(localStorage `stockview_watchlist_groups`, 티커→그룹명) — 기존 `WL`(워치리스트 티커 목록) 구조는 안 건드림. 그룹 필터 탭 + 행별 드롭다운, 순수 프론트엔드.

## 알려진 이슈 / 대기 중인 개선 백로그 (2026-07-13 기준)
지난 코드 감사(2026-07-07) 10건 전부 처리 완료(또는 확정 보류). 이번 세션 브레인스토밍 아이디어(스크리너 신호컬럼·캔들스캐너·히트맵오버레이·워치리스트그룹)도 전부 완료. 남은 것:
1. **차트 더미 데이터 표시** (`app.py:843,915` `_generate_ohlcv_dummy()`) — 실제 차트 조회 실패 시 랜덤 생성 OHLCV를 구분 표시 없이 반환. 백엔드 수정은 쉽지만 `chart.js`의 MA/RSI/MACD/신호 계산 다수가 빈 데이터 미대응이라 프론트 방어 코드 범위가 커서 보류 중 (실익 대비 작업량 크다고 판단) — **유일하게 남은 "바로 시작 가능한" 백로그**
2. FinBERT 감성 분석 — **환경 제약으로 막힘**: torch/transformers 설치 불가(Python 3.15 alpha). 외부 호스팅 API 연동 없이는 불가능
3. 재무제표 페이지 — **데이터 소스 막힘**: Yahoo financials HTML(404), quoteSummary API(401 Invalid Crumb) 둘 다 막힘. 대체 무료 소스 조사 필요
4. Reddit RSS 429 / Russell 2000 정확한 구성종목 / US 매도 신호 개선 — **전부 사용자가 현행 유지로 확정, 재작업 불필요**
5. **외부(핸드폰) 접속 지원** — **검토만 완료, 미결정**. Tailscale/Cloudflare Tunnel/포트포워딩+DDNS/AWS배포 4가지 비교함, 사용자가 생각해보고 결정하기로 함. 상세는 [[project-remote-access]] 참고
6. **국내주식 이전 분기 실적 조회 (공시 탭)** — **DART Open API 키 발급 대기 중, 보류**. KRX KIND "오늘 공시"는 당일만 제공, 과거 기간 검색용 상세검색(`/disclosure/details.do`)은 세션 쿠키 붙여도 계속 에러 반환(폼 검증 엄격, 스크립트 재현 실패 확인). 대안은 금융감독원 공식 **DART Open API**(opendart.fss.or.kr, 무료 즉시 발급) — **다음에 이 주제 나오면 "DART API 키 있으신가요?"부터 물어볼 것**

**참고:** `/api/heatmap-perf`처럼 수천 개 종목을 짧은 시간에 병렬 조회하는 엔드포인트는 Yahoo Finance가 일시적으로 요청을 통째로 막을 수 있음(429) — US/KR 히트맵 성과를 연달아 빠르게 조회하거나, PE/EPS 스크립트를 과도한 동시성(20 workers)으로 돌리면 재현됨. 완화 패턴: (a) 실패율 50% 이상이면 캐시 TTL을 60초로 낮춰 자동 재시도(`/api/heatmap-perf`), (b) 동시성을 보수적으로(5 workers+지연) 유지하고 429 연속 감지 시 조기 중단(`collect_pe_eps.py`). Yahoo의 JSON 배치 API(`v7/finance/quote`, `quoteSummary`)는 이제 크럼 인증 없이 401 — HTML 스크래핑이 사실상 유일한 무료 경로.

**Why:** 2026-07-07 세션에서 "더 개선할 거 확인해줘" 요청으로 Explore 에이전트를 통한 전수 코드 감사 실시. 2026-07-10까지 순차적으로 대부분 처리.

**How to apply:** 다음 세션에서 "불러오기" 시 이 백로그를 "진행 예정 작업 목록"에 반영. 사용자가 특정 항목을 선택하면 CLAUDE.md 작업계획서 규칙에 따라 진행.

## 신규 코드 감사 결과 (2026-07-22) — 우선순위순
general-purpose 에이전트로 app.py/data_fetcher.py/cache.py/static/js 전체/index.html 재감사. 실제 코드 확인한 것만, 기존 알려진 항목(더미데이터/FinBERT/재무제표/Reddit/외부접속/DART)은 제외:
1. ~~KR 스크리너 "정상종목만" 체크박스 무동작~~ — **완료(2026-07-22, 커밋 `1daf589`)**. `_isAbnormalKrListing()` 추가(이름이 "스팩" 포함 또는 "우"/"우B"로 끝나면 비정상 — 한국 증시 우선주 표기 관례), `_getKrFiltered()`에 적용. KR 3,936개 중 136개(스팩43+우선주93) 제외 확인
2. ~~필터 프리셋이 US/KR 시장 구분 없이 저장·적용됨~~ — **완료(2026-07-22, 커밋 `1daf589`)**. `_currentFilterValues()`에 `market` 필드 추가, 시장전환 로직을 `_switchScMarket()`으로 추출해 `_applyFilterValues()`가 저장 당시 시장으로 자동 전환(데이터로드 대기) 후 필터 적용하도록 수정. Playwright로 US↔KR 양방향 프리셋 저장/적용 실측 검증 완료(구버전 프리셋도 `market` 없으면 US로 간주해 하위호환)
3. ~~스크리너 CSV 내보내기 버튼 KR→US 전환 후 다운로드 2회~~ — **완료(2026-07-22, 커밋 `4f33de6`)**. `addEventListener`(영구)와 시장전환마다 덮어쓰는 `.onclick` 두 메커니즘이 동시에 걸려있던 게 원인. 단일 리스너가 `_scMarket` 보고 분기하도록 통합, 죽은 코드(`_krBound`/`_origClick`)도 정리. Playwright로 KR→US 왕복 다운로드 이벤트 실측(정확히 2클릭=2다운로드) 검증
4. ~~Earnings 탭 업종 필터가 스크리너 탭 미방문 시 항상 빈 결과~~ — **완료(2026-07-22, 커밋 `4f33de6`)**. `_getEarnSector()`가 스크리너 방문시에만 채워지는 `window._scStocks`에 의존하던 게 원인. `_ensureScStocksLoaded()` 추가해 `/api/stocks` 직접 로드. Playwright로 스크리너 미방문 상태 Earnings 직행 후 업종필터 정상 동작(19건) 검증
5. ~~가격 알림이 해당 티커 차트 탭을 계속 보고 있을 때만 동작~~ — **완료(2026-07-22, 커밋 `200f10c`)**. `chart.js`에 `_checkAllAlerts()` 추가, `main.js:834-855` `stocks_update` 소켓 핸들러(5분 주기, US 전종목 푸시)에서 호출하도록 연결. Playwright로 Home 탭에 있는 상태에서 알림이 정상 발화·제거되는 것 실측 검증. **KR 종목은 실시간 가격 소켓 푸시 자체가 없어 범위 밖 — KR 알림은 여전히 차트 탭을 열어야 동작(기존과 동일)**
6. ~~워치리스트 목표가가 저장만 되고 활용 안 됨~~ — **완료(2026-07-22, 커밋 `200f10c`)**. `_wlTargetStatusHtml()` 추가, 현재가 대비 목표가까지 남은 % 또는 "달성 ✓" 배지를 목표가 입력란 옆에 표시. 목표가는 상승 목표로 간주(방향 지정 없음, 차트 탭 알림의 above/below와는 다른 단순 지표). Playwright로 미달성(+23.1% 남음)/달성(달성 ✓) 양쪽 상태 실측 검증
7. ~~`/api/stock/<ticker>` 병합 로직 중복 구현~~ — **완료(2026-07-22, 커밋 `505acd9`)**. `stock_detail()`이 `_get_merged_us_stocks()` 재사용하도록 리팩터링. AAPL/005930.KS/존재안함(404) 실API 검증
8. ~~`cache.py` Cache 클래스가 만료 키를 영구 정리 안 함~~ — **완료(2026-07-22, 커밋 `505acd9`)**. `set()` 200회마다 TTL×10 초과 방치 항목만 정리하는 경량 스윕 추가(주기 갱신 캐시는 안 지워짐, 락 재사용, 새 스레드/스케줄러 없음). 단위테스트로 "재조회되는 캐시는 유지/방치된 캐시만 정리" 양쪽 검증
9. ~~차트 그리기 도구 색상이 `#58a6ff` 고정~~ — **완료(2026-07-23, 커밋 `d8b18af`)**. 색상 선택기 추가, 새 그림 + 선택된 그림에 즉시 반영. Playwright로 신규색상/선택후변경 양쪽 검증
10. ~~`loadDailySignalMap()`이 세션당 1회만 로드~~ — **완료(2026-07-23, 커밋 `d8b18af`)**. 마지막 로드 날짜 기록, 날짜 바뀌면 재조회. 같은날 재호출은 캐시 유지·날짜변경 시 재조회 실측 검증(API 호출 횟수로 확인)
11. ~~WebSocket disconnect 시 UI 피드백 없음~~ — **완료(2026-07-23, 커밋 `d8b18af`)**. 헤더 "Live·시각" 표시가 끊기면 "⚠ 연결 끊김"(빨강)으로 바뀌고 재연결 시 복구. 소켓 인스턴스를 캡처하는 init script로 disconnect/connect 양쪽 실측 검증
12. ~~차트 드래그줌·그리기 도구가 마우스 이벤트만 지원~~ — **완료(2026-07-23, 커밋 `d8b18af`)**. mousedown/move/up→Pointer Events 전환(마우스+터치+펜 통합), 터치는 더블탭으로 전체보기 복귀. **부수 변경: 라이브러리 기본 휠/핀치 줌(`handleScale`) 껐음** — 이제 줌은 커스텀 드래그 제스처로만 동작(마우스 휠 줌 제거는 의도됨, 이전부터 알려진 "휠로 여백 초과 스크롤 가능" 리스크도 같이 해결). Playwright로 마우스 드래그줌 회귀 없음 + pointerType:'touch' 합성 이벤트로 터치 드래그줌·더블탭 복귀 검증(실기기 미검증, Chrome 시뮬레이션만)

**07-22~23 신규 감사 백로그 12건 전부 완료.** 남은 백로그는 위 "2026-07-13 기준" 섹션(더미데이터/FinBERT/재무제표/외부접속/DART/Reddit 등)만 남음

## 코드 정리(유지보수성) 감사 + 배치 A~D 처리 (2026-07-23, 커밋 `78eaef3`)
버그 감사와 별개로 "수정하기 좋게 정리됐는지"를 general-purpose 에이전트로 재감사(app.py/data_fetcher.py/style.css/screener.js/chart.js/watchlist.js 실제 확인). 발견 12건 중 저위험 8건을 배치 A~D로 즉시 처리:
- import 정리(app.py 흩어진 로컬 import 통합), `getFilteredStocks`→`_getFilteredStocks` 네이밍 통일, `STOCKS`의 죽은 `name_ko` 필드 제거(60개 티커 전부 `NAME_KO`에 있어 fallback 발동 안 함 — 직접 검증)
- `style.css` CHART 스타일이 HEATMAP 섹션에 오배치된 것 이동
- `CLAUDE.md` CSS 섹션 순서에 누락돼 있던 EARNINGS·BRIEF 추가(문서-실제 일치화 — **실제 파일 재배치는 안 함**, 340줄 규모라 리스크 대비 실익 낮다고 판단)
- app.py 더미데이터(STOCKS/INDICES/NEWS, 110줄) 파일 하단으로 이동, `fetch_nasdaq_stocks()` 내부 인라인 매핑 딕셔너리 3개(~150줄) 모듈 상수로 이동
- 기술신호 이중구현(data_fetcher.py↔chart.js) 지점에 상호 참조 주석 추가

**보류 결정한 것(리스크>효과 판단):**
- KR 함수 네이밍 불일치(`_calc52wPosKr` vs `_getKrFiltered` 등 Kr 위치 제각각) — 기존 함수 일괄 리네임은 호출부 많아 보류, 신규 함수부터만 적용 권장
- `_renderSignalCard`(chart.js, 226줄) 비대 함수 — 관찰만, 다음에 그 부분 고칠 때 소단위 분리 권장

**작업 중 발견·수정한 실수:** 매핑 딕셔너리를 모듈 레벨로 옮기는 스크립트에서 로그 문자열 `f"...{{e}}"` 이중중괄호 버그를 직접 만들었다가 즉시 발견해 수정(원래 의도는 `{e}` 단일 보간인데 스크립트 작성 중 이스케이프 실수로 리터럴 `{e}` 텍스트가 될 뻔함) — 관련 없어 보이는 파일도 반드시 재검증 필요하다는 사례
- 검증: Python 3개 딕셔너리 재배치 전/후 `ast.literal_eval` 값 byte-level 동일성 확인, `python -m py_compile` 통과, `import app`/`import data_fetcher` 단독 임포트 성공, 서버 재시작 후 실제 Nasdaq 5000종목 정상 로드 로그 확인, Playwright로 전체 8개 탭 회귀(콘솔 에러 0) + US/KR 스크리너 필터 동작 확인

**부수 발견 (작업항목 아님):** `CLAUDE.md`의 "heatmap.js | US 전용" 표기가 실제 코드(KR 트리맵 이미 구현됨, Phase 4-70)와 어긋난 문서 오기재 — 다음에 CLAUDE.md 만질 일 있으면 같이 고칠 것

## 신규 코드 감사(2026-08-18) + 버그 6건 수정 (커밋 `de6db7f`)
general-purpose 에이전트로 app.py/data_fetcher.py/cache.py/static/js 전체/index.html/style.css 재감사, 버그 6건·신규기능후보 2건·코드정리 4건·UX개선 2건 발굴. 이 중 "버그" 6건을 CLAUDE.md 작업계획서 규칙에 따라 즉시 수정:
1. KR 스크리너 보는 중 US 소켓(`main.js` stocks_update)·30초 타이머·새로고침버튼이 `_scMarket` 미확인하고 무조건 US 데이터로 갱신 → 3곳 모두 시장 분기 추가, `main.js`에 `kr_stocks_update` 신규 핸들러 추가
2. 차트 탭 KR 종목 "관련뉴스"가 `/api/stock-news`(US 전용) 호출 → `_isKrStock()`으로 분기해 `/api/kr-news/{ticker}` 사용(백엔드가 이미 티커에서 숫자만 추출하는 구조라 `.KS`/`.KQ` 붙은 채로 넘겨도 정상 동작 확인)
3. `refresh_kr_stocks()`(app.py)가 소켓 이벤트를 emit 안 해 KR 가격 알림이 백그라운드에서 전혀 안 울리던 버그 → `kr_stocks_update` emit 추가 + 프론트 구독
4. 워치리스트 탭에 자동 갱신 자체가 없던 버그 → 포트폴리오와 동일 패턴(소켓 핸들러 + WebSocket 미연결시 30초 폴백 타이머 `_startWlRefresh`) 추가
5. CSS 미정의 변수 `--card`/`--fg` 사용(7곳) → `--bg-card`/`--text`로 치환. `grep`으로 파일 전체 재검증해 잔여 미정의 변수 없음 확인
6. Earnings 탭 다크 전용 hex 하드코딩(`.earn-*`) → 테마 변수 치환, `.loading-msg`(5곳에서 쓰이는데 정의 자체가 없던 스타일) 신규 추가

**검증 방식:** Chrome 확장 미설치로 브라우저 실제 클릭 검증은 못함(사용자가 설치 중단 선택) — 대신 서버 실제 구동 후 `/api/kr-news/005930.KS` 등 API 응답 200 확인, 로그로 `refresh_kr_stocks` 정상 완료(3936개) 확인, `py_compile`/`node --check` 전체 통과, CSS 변수 전수 grep으로 미정의 변수 0건 확인. **브라우저 시각 확인은 미완료 — 다음에 크롬 확장 설치되면 재확인 권장**

**남은 후보(미착수):** 신규기능 2건(포트폴리오 CSV에 그룹/메모/목표가 컬럼 추가, Home 위젯에 목표가 달성 반영), 코드정리 4건(죽은 코드 `FMP_KEY`/`fetch_quote_v7`/`fetch_pe_eps_fmp` 개명, API키 평문 커밋 정리, WL/PT 저장소 중복 통합, 공시 새로고침버튼 인라인→클래스 전환), UX개선 2건(KR 히트맵 클릭시 모달 우선, 경제지표 캘린더 2026-12 이후 데이터 추가)

## 2026-08-20 세션: 재감사(버그1건) + 신규기능 9건 전부 구현·커밋 (`23af2b4`)
전날(08-18) 감사 이후 상태를 general-purpose 포크 2개(버그재감사 / 신규기능 브레인스토밍)로 병렬 조사 후, 발굴된 항목을 CLAUDE.md 작업계획서 규칙에 따라 순서대로 전부 구현:

**버그 수정**
- **라이트 테마 하드코딩 색상 29곳** — `--green`/`--red`/`--accent` 변수가 있는데도 `style.css` 여러 곳(HOME 경제캘린더/SCREENER/HEATMAP 수급표/CHART 이동평균/진단카드/BRIEF 신호목록 등)이 다크 hex(`#3fb950`/`#f85149`/`#58a6ff`)를 직접 사용 → 전부 `var()`로 치환. 08-18에 고친 `--card`/`--fg` 버그와 같은 계열, 범위가 더 넓었음

**신규 기능 8건 구현 (기존 데이터/API/패턴 재사용 위주로 선정)**
1. 공시(KRX KIND) 탭 북마크 — News/Reports와 `NB` 저장소 공유, `is_disclosure` 필드로 3자 교차오염 방지(News 필터도 같이 수정)
2. Brief 신호탭 "신호 유지일수 TOP 10" — US+KR 통합, `held_days` 내림차순, `is_new` 제외
3. Brief F&G 카드 CSS 재배치 — `.brief-fg-card`(래퍼)만 FEAR&GREED 공통 섹션→BRIEF 섹션으로 이동. 나머지 7개 base 클래스(`.fg-score-big` 등)는 Home 위젯도 같이 쓰는 공용이라 원위치 유지(첫 시도는 전부 옮겼다가 Home 쪽에서 쓰는 걸 뒤늦게 발견해 되돌림 — 재검증 습관 덕분에 잡음)
4. 스크리너 다중선택 → 비교차트 — 기존 `_scSelected`(워치리스트 일괄추가용) 그대로 재사용해 `openCompareChart()` 연결
5. 신호 배지에 주봉(13주 이평) 추세 배지 — `_sig_weekly_trend()`가 내부 계산만 되고 버려지던 걸 `compute_daily_metrics()` 반환값에 포함, `signalBadgeHtml()`(Screener/Watchlist/Portfolio 공용)에 노출
6. 히트맵(US/KR) "내 워치리스트/포트폴리오만 보기" 필터 — `WL.has()`/`PT.tickers()` 재사용, 빈 상태 안내 가드 추가
7. Brief 개요 탭에 경제지표 캘린더 카드 — `loadEconomicCalendar()`를 elId 파라미터화해 Home과 공유
8. WebSocket 끊김 시 30초 폴백 폴링 — `stocks_update` 핸들러를 `_refreshCurrentView()`로 추출, disconnect/connect에서 타이머 제어
9. **KR 외국인 수급 상위 스캐너 신설** ("어려움" 등급) — `get_kr_investor_leaders()` 신규, KR 시총 상위 500풀(기존 daily_signals 배치가 이미 순회하던 풀 재사용) 대상으로 네이버 `frgn.naver` 페이지를 종목당 1회씩 추가 조회(워커 10개), 순매수/순매도 상위 15개 산출. `build_daily_recommendations()`에 `kr_investor_leaders` 필드로 통합, 24시간 배치 주기 그대로 사용

**미착수로 남은 아이디어(이번 세션에서 후보로만 나왔고 미구현):** 스크리너(US/KR) CSV 내보내기, RSI 다이버전스 단독 스캐너 — 둘 다 "쉬움" 등급이라 다음 요청 시 우선 후보

**작업 중 발견한 중요 사항 — Jinja 템플릿 캐싱**: `templates/index.html`을 수정해도 Flask가 `TEMPLATES_AUTO_RELOAD=False`(기본값, debug off라서)로 프로세스 시작 시 컴파일된 템플릿을 캐싱해 서버 재시작 전까지 반영이 안 됨. 실제로 #8 작업 중 curl로 확인하다가 발견(정적 JS/CSS는 매 요청 새로 읽어서 문제없음, `.html` 템플릿만 해당). **앞으로 index.html을 고치면 반드시 서버 재시작 필요** — 이 프로젝트의 새로운 운영 규칙으로 기억할 것

**검증 방식**: `#7`(weekly_trend)과 `#11`(investor_leaders)은 실행 중인 서버의 `/api/daily-signals` 응답으로 실데이터 확인(예: 삼성전자 005930.KS `foreign_net:-2,923,301`(순매도) vs `change_pct:-9.84%`로 방향 일치). `#8`/`#9`/`#10`은 브라우저 클릭 검증 없이 코드 재검토로 대체(크롬 확장 미설치, 08-18과 동일한 제약 지속 중). 전체 `py_compile`/`node --check`/HTML div짝/CSS 중괄호짝 통과

**남은 백로그**: 08-18 세션에서 발굴된 미착수 8건(신규기능 2건 + 코드정리 4건 + UX개선 2건)은 이번 세션에서 손대지 않음 — 다음 "불러오기" 때 계속 참고 대상. 이번 세션 자체 감사에서는 새 버그 1건(라이트테마) 외 추가 발견 없었음

## Phase 4-115 (2026-08-25): 재무제표 페이지 신설 — 기존 "막힘" 항목 해제
오랫동안 "막힘"으로 보류돼있던 재무제표 기능을, 새 무료 데이터 소스로 구현. Chart 탭 사이드바에 `#financials-card` 패널 추가(종합진단 패널 바로 아래).

- **KR**: `data_fetcher.fetch_kr_financials(code)` — 네이버 금융 `main.naver` 페이지의 "기업실적분석" 표를 직접 스크래핑(매출액/영업이익/당기순이익/영업이익률/순이익률/ROE/부채비율/유보율/EPS/PER/BPS/PBR/배당 등 15개 항목, 연간4+분기6). **중요 발견**: 이 페이지는 `frgn.naver`/`news_news.naver`(여전히 EUC-KR)와 달리 이미 **UTF-8로 인코딩이 바뀌어 있었음** — `resp.encoding="euc-kr"`로 하드코딩했다가 데이터 전부 깨져서(테이블 매치 실패) 원인 파악 후 수정. Naver Finance 페이지마다 인코딩이 다를 수 있다는 뜻 — 새 페이지 스크래핑 시 반드시 `Content-Type` 헤더 먼저 확인할 것
- **US**: `data_fetcher.fetch_us_financials(ticker)` — SEC EDGAR `companyfacts` API(무료, 키 불필요) 사용. 티커→CIK 매핑은 `sec.gov/files/company_tickers.json`(메모리 캐시). **중요**: SEC는 User-Agent에 이메일 형식 문자열이 없으면 403(Rate Threshold)을 반환함 — 실제 이메일 인증은 안 하지만 `"이름 x@y.z"` 형식은 지켜야 함(개인 이메일 대신 `admin@stockview-personal.app` 같은 placeholder 사용, 실제 도메인 아님). 또한 XBRL의 `fy`/`fp` 필드는 회사·개정판마다 라벨링이 안정적이지 않아(NVDA에서 실측: 회계연도가 한 칸씩 밀려 보임) 반드시 실제 회계기간 종료일(`end` 필드)로 그룹핑해야 함 — `fy` 그대로 쓰면 값이 뒤바뀜
- 기존에 있던 죽은 코드 `FMP_KEY`(financialmodelingprep.com 키)를 실제로 테스트해보니 403 Forbidden(만료/무효) — 이번 구현엔 사용 안 함, 여전히 죽은 코드로 남아있음(08-18 백로그 "코드정리 4건" 중 하나로 언제 정리할지는 미정)
- 엔드포인트: `/api/financials/<ticker>` (US/KR 자동분기, 12시간 캐시)
- **검증**: AAPL/MSFT/NVDA 실제 공시 매출·순이익과 일치 확인(예: MSFT FY2025 매출 $281.7B), 삼성전자(005930) 매출 2024.12 3,008,709억원=300.9조원으로 실제 수치와 일치 확인. `curl`로 API 응답 실측, 404(존재안함 티커) 확인. **브라우저 시각 확인은 여전히 미완료**(chromium-cli/claude-in-chrome 둘 다 이 환경에 미설치 확인됨 — 08-18부터 지속된 제약)
- **함께 결정한 것**: FinBERT는 Hugging Face 호스팅 Inference API로 연결하기로 사용자가 결정(로컬 torch 설치 대신) — 사용자가 huggingface.co에서 무료 토큰 발급 예정, **토큰 받으면 이어서 연동 작업 필요** (아직 미착수)

## Phase 4-116 (2026-08-25): News 탭 국내/해외 뉴스 구분
News 탭이 지금까지 전부 영어권(RSS 15개+AV+Finnhub) 소스뿐이었음 — 사용자 요청으로 국내 경제뉴스 RSS 8개 추가하고 전체/해외/국내 필터 토글 신설.

- **국내 RSS 소스 선정**: 실제 접속 테스트(curl+feedparser, `requests`로 커스텀 User-Agent 넣어야 정상 응답하는 곳 많았음)로 최종 8개 확정 — 연합뉴스 경제, 이데일리 증권, 뉴시스 경제, 동아일보 경제, 아시아경제, 서울경제 금융, Investing.com 한국, 인포스탁데일리. `data_fetcher.KR_RSS_FEEDS`
- **시도했으나 제외**: 한국경제(hankyung feed 전부 feedparser로 0 entries), 매일경제(403), 헤럴드경제(RSS가 홈페이지로 리다이렉트, 사실상 서비스종료), 조선비즈/이투데이/뉴스1/머니투데이/와우TV 등(404 또는 빈 피드)
- **서울경제 이용약관 참고**: RSS 페이지에 "개인 사용자 비상업적 이용만 허용, AI학습 금지" 명시 — StockView는 개인용 비상업 앱이라 문제없다고 판단하고 사용자에게 고지 후 진행
- `data_fetcher.fetch_kr_market_news()` — 종목별 KR뉴스(`fetch_kr_stock_news`)와 동일하게 VADER 감성분석 미적용(한글 미지원), `sentiment:"neutral"` 고정
- `/api/news`가 `market` 필드("US"/"KR")로 태깅해 병합 반환, News 필터바에 전체/🌐해외/🇰🇷국내 토글 추가(`_activeMarket`, `main.js`)
- 검증: `/api/news` 실측 249건(US 169 + KR 80) market 필드 정상 분리 확인, 페이지 렌더링에 토글 버튼 3개 존재 확인. 브라우저 클릭 검증은 여전히 미완료(크롬 자동화 도구 미설치 지속)
- **커밋 완료 (2026-08-25, `de20423`)**: 4-115(재무제표)와 함께 재검증 후 커밋. `py_compile`/`node --check` 통과, 서버 재구동해 `/api/financials/AAPL`(200)·`/api/financials/005930.KS`(200)·`/api/news`(market 분리 KR80/US100) 재확인. `socketio.run` host 파라미터 제거(Tailscale IP→127.0.0.1, [[project-remote-access]] 08-24 결정 반영)도 이 커밋에 포함. `data/pe_eps_cache.json`은 관례대로 커밋 제외

## Phase 4-117 (2026-08-26): AI 음성 브리핑 — 구현+피드백 반영+커밋 완료 (커밋 `00629a9`)
사용자가 "오늘의 뉴스를 팟캐스트처럼 2명이 대화하며 정리해주는 음성"을 요청 → 아직 코드 작업 없이 **UI 시안 + 대본 포맷 확정, TTS 엔진 재선정**까지 완료한 상태. 다음 세션에서 이어갈 것.

**확정된 사항**
- **UI**: Brief 탭 최상단(기존 3열 그리드 위)에 전체폭 카드 "🎙️ 오늘의 AI 음성 브리핑" 추가. 재생버튼+진행바+배속토글+"대본 보기"펼치기. 시안: https://claude.ai/code/artifact/a074a3d3-ad0d-43bd-a18a-9597143df7fb (재사용 가능한 Artifact, 이전 세션에서 만든 것 — 로컬 파일은 세션 스크래치패스라 다음 세션엔 없음, 필요시 URL 재조회)
- **대본 포맷 (2026-08-25 세부 확정)**: 오프닝→시장개요→해외뉴스→국내뉴스→클로징 순, 호스트/애널리스트 2인 대화체. 초안(헤드라인 3+3개, 헤드라인당 1턴 반응)을 사용자에게 보여줬으나 "내용이 부실하다"는 피드백 → **헤드라인 6개(해외3+국내3), 헤드라인당 3턴 이상**(사실 제시→1차 해석→되묻기→추가 해석, 앞선 헤드라인과 연결지어 해석)으로 확장. 예상 음성 길이 4~6분(기존 1.5분 대비 3배+)
- **대본 생성 방식 (재선정, 2026-08-25)**: 이 정도 깊이의 "되묻기→추가해석"은 순수 템플릿 치환으로는 자연스럽게 안 나옴(뻔한 문구 반복 위험) → **Claude API(`claude-opus-5`)로 뉴스 데이터를 프롬프트에 넣어 대본 자체를 생성하는 방식으로 변경**. 단순 텍스트 생성(뉴스요약→대화체 변환) 태스크라 tool use/agent 불필요, 단발 `messages.create` 호출로 충분. Anthropic API 키 발급 절차 안내 중(다음 메시지에서 이어감)
- **TTS 엔진 (재선정, 2026-08-25)**: 처음엔 네이버 CLOVA Voice로 선택했으나, 사용자가 콘솔에서 실제 요금표 확인 후 **CLOVA Voice Premium이 사용량과 무관하게 월 90,000원(VAT별도) 고정 기본료**를 부과한다는 것 발견(무료 100만자/월은 그 기본료 안에 포함된 것일 뿐, 서비스 자체가 무료가 아니었음) → 개인용 소량앱(예상 월 2.4~3.6만자)엔 부적합 판단, **Google Cloud TTS로 최종 변경**. 웹서치로 4개 서비스(Google/Azure/Polly/ElevenLabs) 비교 후 선정 — Google이 유일하게 (a)고정기본료 없는 순수종량제 (b)무료한도 만료 없음(Polly는 가입후 12개월만 무료) (c)이 앱 사용량 대비 압도적으로 넉넉한 무료한도(WaveNet 400만자/월, Neural2 100만자/월)를 모두 만족. 신규가입 시 $300 크레딧도 별도 제공
- **키 발급 방식**: Google Cloud Console → 프로젝트 생성 → Text-to-Speech API 활성화 → 서비스계정 키(JSON) 발급 (CLOVA의 Client ID/Secret 방식과 다름)

**Google Cloud TTS 키 발급 및 검증 완료 (2026-08-25)**
- 키 파일 위치: `api/google-tts-key.json` (`.gitignore`의 `api/` 규칙으로 커밋 제외 확인됨). 다운로드 폴더 원본은 확인 후 삭제 완료
- `pip install google-auth` 설치 완료(cp311-abi3 wheel이 Python 3.15 alpha에서도 정상 설치됨 — grpc 의존성 있는 `google-cloud-texttospeech` 패키지 대신 `google-auth`+`requests`로 REST API(`texttospeech.googleapis.com/v1/text:synthesize`) 직접 호출하는 방식 채택, 환경 제약(pandas/numpy 계열 바이너리 휠 미지원) 우회)
- 실제 테스트: `ko-KR-Wavenet-A` 음성으로 한국어 문장 합성 → 200 OK, 21KB MP3 정상 생성 확인 (테스트 파일은 삭제함)

**Anthropic API 키 발급 및 검증 완료 (2026-08-26)**
- 키 파일 위치: `api/anthropic-key.txt`. 사용자가 처음 저장했을 때 파일명이 `apianthropic-key.txt.txt`로 꼬여서 `api/anthropic-key.txt`로 정리해서 옮김 — 파일 저장 요청 시 실제 저장 여부를 항상 `ls`로 재확인할 것(경로/이름 오타 흔함)
- 최초 테스트는 크레딧 부족(400 "credit balance too low")으로 실패 → 사용자가 Plans & Billing에서 충전 후 재시도, `claude-opus-5` 정상 응답 확인(`pip install anthropic` 1.0.0 설치, 이 환경에서도 정상 설치됨)
- **대본 생성 방식**: 뉴스 데이터를 프롬프트에 넣어 `claude-opus-5`로 대화체 대본 자체를 생성(단발 `messages.create`, tool use 불필요)

**구현 완료 (2026-08-26)** — 아래 7개 파일 수정, 아직 git 커밋 전(미추적 diff 상태):
- `requirements.txt`: `google-auth`, `anthropic` 추가
- `data_fetcher.py`: `generate_briefing_script()`(Claude API 대본생성) / `_google_tts_token()`, `synthesize_tts()`(Google TTS 합성) / `build_voice_briefing()`(오케스트레이션+`data/audio/` 저장+이전파일정리). 상수: `ANTHROPIC_KEY_FILE`, `GOOGLE_TTS_KEY_FILE`, `BRIEFING_AUDIO_DIR`, `_BRIEFING_VOICES`(host=ko-KR-Wavenet-A, analyst=ko-KR-Wavenet-C)
- `app.py`: `_compute_market_mood()` 헬퍼로 추출(기존 `/api/brief` 인라인 로직과 공용화), `refresh_voice_briefing()`(24h 배치, daily_signals와 동일 패턴, 시작 270초 지연), `/api/voice-briefing`·`/api/voice-briefing/audio/<file>` 라우트
- `templates/index.html`: Brief 탭 최상단 `#voice-briefing-card` 마크업
- `static/js/brief.js`: `loadVoiceBriefing()`+플레이어(발화별 mp3 순차재생, `_vbPreloadDurations()`로 실제 재생시간 기반 진행바 계산, 배속, 대본 하이라이트)
- `static/css/style.css`: `.voice-briefing-card` 등 스타일 (BRIEF 섹션)
- `.gitignore`: `data/audio/` 추가

**테스트 중 발견·수정한 버그 2건**:
1. `max_tokens=4096`이 thinking 토큰까지 포함해 부족 → `stop_reason: max_tokens`로 대본이 JSON 배열 완성 전에 잘림. `max_tokens=16000`+`output_config:{"effort":"medium"}`로 수정
2. `refresh_voice_briefing()`이 국내뉴스를 `cache.get("news")`(해외 RSS 전용 캐시)에서 `market=="KR"`로 필터링 시도 — 이 캐시엔애초에 KR 항목이 없어 국내뉴스가 항상 빈 배열이었음. `cache.get("kr_market_news")`(Phase 4-116에서 만든 별도 캐시키)를 직접 읽도록 수정, 실측으로 오늘자 실제 KR 헤드라인(쿠팡/소노그룹/서울시 등)이 대본에 반영됨을 확인

**실제 서버 검증 완료**: 서버 기동 후 270초 지연 스레드가 정상 발화, `claude-opus-5` 대본생성(30~46턴, 입력 900~1000/출력 5000~6700 토큰 — 예상보다 다소 큼, 상세분량 요청 반영된 결과로 추정) → Google TTS 발화별 mp3 합성 → `/api/voice-briefing` 응답(turns 배열)·`/api/voice-briefing/audio/turn_XXX.mp3`(200 OK) 전부 실측 확인. **브라우저 시각 확인(재생 버튼 클릭 등)은 미완료**(크롬 자동화 도구 미설치 지속) — 서버는 로컬 5001에 계속 띄워둔 상태이니 사용자가 직접 Brief 탭에서 재생 확인 가능
- 프론트 진행바는 각 발화 mp3의 `loadedmetadata`로 실제 길이를 모아 계산(발화당 평균치로 근사하지 않음) — 정확도를 위한 설계 결정

**08-26 세션 중 추가 피드백 3건 반영 완료 (전부 실서버 재생성으로 검증됨)**
1. **음성 품질 "어색함" 피드백** → Google TTS 음성 목록 실조회(`voices` API, ko-KR 41종 확인) 결과 최신 생성형 계열 **Chirp3-HD**(30종) 존재 확인, 샘플 청취 후 사용자 승인 → `_BRIEFING_VOICES`를 `ko-KR-Wavenet-A/C` → **`ko-KR-Chirp3-HD-Kore`(host)/`ko-KR-Chirp3-HD-Charon`(analyst)**로 교체. 합성 속도는 WaveNet보다 느림(45턴 기준 체감 2~3분 소요, 감안 필요)
2. **대본 구체성 부족 피드백**("드러켄밀러·캐시 우드 같은 종목 매수" 언급에서 종목명이 안 나옴) → `_BRIEFING_SYSTEM_PROMPT`에 "구체성 원칙" 섹션 추가(헤드라인의 고유명사·숫자·티커 반드시 반영, 채움말 금지, 헤드라인에 없는 정보는 "명시 안 됨"으로 투명하게 처리 — 지어내지 않기). 실측 결과 이 특정 사례는 **원본 헤드라인 자체("2 tech giant stocks")에 종목명이 없어서** 애초에 알 수 없는 케이스였고, 수정 후엔 "헤드라인에 종목명이 없다"고 명확히 짚어주는 방식으로 개선됨(생략 대신 투명한 처리)
3. **호스트/애널리스트 이름 교체 요청** → `_BRIEFING_SYSTEM_PROMPT`+`brief.js`의 `_renderVbScript()` 양쪽에서 재윤/수아 역할 스왑: **호스트=수아, 애널리스트=재윤**(이전엔 반대)
4. **"헤드라인만으로 대본 만드는 게 이상하다" 피드백** → 전체 기사 스크래핑(느림·사이트별 파싱 필요·비용 증가) 대신 **RSS summary/description 필드 추가**로 결정(추가 네트워크 요청 없이 이미 받는 피드 데이터 재사용, 저위험·저비용). `_clean_summary()` 헬퍼 신설(HTML태그 제거+280자 제한), `fetch_news()`/`fetch_kr_market_news()` 양쪽에 `summary` 필드 추가, `_fmt_headline()`이 프롬프트에 요약문도 함께 전달하도록 수정. 실측 결과 체감 효과 큼 — 예: 쿠팡 건에서 "할인 비용 전가 의혹으로 조사 나섰다가 거부로 철수" 같은 헤드라인엔 없던 구체적 경위가 대본에 반영됨, 소노그룹 건에서도 "1조 9천억원대 탈루 혐의" 같은 정확한 숫자가 반영됨

**같은 날 늦게(23시경) 세션 재개 — "음성 브리핑 관련해서 보완이 필요한거 체크해봐" 요청으로 코드 감사 진행, 발견 4건 전부 수정·검증·커밋 완료**
1. **🔴 재시작할 때마다 무조건 재과금** — `refresh_voice_briefing()`이 "오늘 이미 만들었는지" 확인 없이 매번 Claude+TTS 재호출(오늘 테스트 중 서버 8~10회 재시작하며 실제로 낭비됨, 회당 약 $0.13~0.21). **수정**: `data_fetcher.py`에 `BRIEFING_MANIFEST_FILE`(`data/voice_briefing.json`) 도입, `build_voice_briefing()` 성공 시 디스크에 저장, `load_cached_voice_briefing()`이 오늘 날짜+오디오파일 존재 여부 확인 후 유효하면 반환. `app.py`의 `refresh_voice_briefing()`이 이걸 먼저 체크. **실측 검증**: 재시작 후 로그에서 `anthropic.com` 호출 0건, "오늘 생성분 재사용" 로그 확인
2. **🟡 헤드라인 선정이 사실상 피드 목록 순서상 처음 3개** — `/api/brief`에 이미 있던 감성강도+최신순+소스다양성+중복제거 로직(`_dedup_stories`, 원래 `brief()` 라우트 내부 중첩함수)을 app.py 모듈 레벨 공용 헬퍼로 추출해 `refresh_voice_briefing()`에서도 재사용(US: 소스당1개/top3, KR: 소스당2개/top3)
3. **🟡 턴 수 예측 불가(30~46턴 관측)** — 시스템 프롬프트에 "헤드라인당 3~5턴, 전체 30턴 이내" 상한 명시. 실측 결과 정확히 30턴으로 수렴
4. **🟢 TTS 순차 처리로 느림** — `build_voice_briefing()`의 발화별 합성을 `ThreadPoolExecutor(max_workers=6)`로 병렬화(기존 코드베이스의 병렬 API 호출 패턴 재사용). 실측: 30턴 합성 21초(이전 순차 방식 대비 턴당 3.2초→0.7초, 체감 4배+ 개선)

**커밋 완료 (2026-08-26, `00629a9`)**: `feat: AI 음성 브리핑(Phase 4-117) 추가 - Claude API 대본생성 + Google Cloud TTS`. 7개 파일 546줄 추가/38줄 삭제(`requirements.txt`, `app.py`, `data_fetcher.py`, `templates/index.html`, `static/js/brief.js`, `static/css/style.css`, `.gitignore`). `data/pe_eps_cache.json`은 관례대로 제외

**남은 것**
1. 브라우저 실제 클릭(재생버튼 등) 시각 확인은 여전히 미완료(크롬 자동화 도구 미설치 지속) — 사용자가 서버 로그상 직접 접속해 확인 중이었음(GET 요청 다수 확인됨)
2. **CLOVA Voice는 최종 폐기됨 — 재언급 시 이미 Google TTS로 바뀐 것 상기시킬 것**
3. 추가로 다듬을 부분이 나오면 이어서 진행 (현재까지 알려진 이슈는 위 4건 전부 해결됨)

## 2026-09-07 세션: 코드 정리 감사 백로그 5건 처리 (커밋 예정, 아직 미커밋)
"더 작업할 거 확인" → 코드베이스 재감사(수동, 에이전트 미사용) 후 사용자가 "코드 정리부터" 선택. 08-18/08-20 백로그의 "코드정리 4건" + WL/PT 저장소 통합까지 처리:
- **죽은 코드 제거**: `data_fetcher.py` `FMP_KEY` 상수(참조 0)·`fetch_quote_v7()`(호출 0, quoteSummary 401) 완전 삭제
- **함수 개명**: `fetch_pe_eps_fmp` → `fetch_pe_eps_yahoo` (실제 동작은 Yahoo HTML 파싱인데 이름·docstring이 FMP로 오도됐음). `app.py:128` 호출부 + `refresh_pe_eps` docstring 동기 수정
- **API 키 소스 분리**: `_load_api_key(filename)` 헬퍼 신설. `AV_KEY`/`FINNHUB_KEY`를 `api/alphavantage.txt`·`api/finnhub.txt`(기존 빈 파일, `.gitignore`의 `api/` 규칙)에서 읽도록. 파일 없거나 비면 `""` 반환 + 경고 로그(해당 뉴스 소스만 조용히 스킵). **주의: 키는 이미 git 히스토리에 있음 — 완전 차단하려면 AV/Finnhub 콘솔에서 rotate 필요(사용자 결정, 미실행)**
- **하드코딩 색상 정리**: `chart.js` 사이드바 렌더(`_renderSignalCard`/`_loadKrInvestor`/`_loadStockNews` + placeholder) 인라인 `#8b949e`/`#3fb950`/`#f85149`/`#58a6ff` → `var(--muted/green/red/accent)`. **캔버스(Lightweight Charts) 설정 색은 항상 다크 의도라 그대로 둠**. `#ffa64d`(경고 오렌지)는 대응 토큰 없어 유지. 다크 테마 픽셀 변화 없음, 라이트 테마만 개선
- **WL/PT 저장소 중복 통합**: `WLN`≡`PTN`(메모/목표가), `WLG`≡`PTG`(그룹+그룹명목록)가 watchlist.js/portfolio.js에 거의 동일 코드로 중복 → `main.js`에 `makeNotesStore(key)`·`makeGroupStore(key, namesKey)` 팩토리 신설, 4곳 다 팩토리 호출로 교체(각 파일 -60~80줄). `WL`(티커 배열)/`PT`(티커→객체 맵)는 구조가 달라 통합 대상 아님, 그대로 둠. localStorage 키·데이터 포맷 불변이라 기존 사용자 데이터 그대로 호환
- **인라인 스타일→클래스**: `index.html` `#disclosures-refresh-btn` 6속성 인라인 style → `.disc-refresh-btn` 클래스(style.css NEWS 섹션)
- **검증**: `py_compile`/`node --check` 전체 통과, 서버 기동 후 `/api/news`(AV 뉴스 포함 251건, KR80/US171)·`/api/financials/AAPL`(실데이터)·`/api/financials/005930.KS`(200)·`/api/stock-analysis/AAPL`(items 8)·`/api/kr-disclosures`(200) 확인. `fetch_finnhub_news()` 직접 호출 50건(파일 키 정상). 잔여 참조 grep 0건. 브라우저 시각 검증은 크롬 도구 미설치로 이번에도 미완료
- **index.html/CSS/JS 수정됨 → 서버 재시작 필요**(Jinja 템플릿 캐싱)
- 커밋 시 `data/pe_eps_cache.json`은 관례대로 제외

### 같은 세션 후반: 감사 버그 3건도 수정 (코드정리와 함께 미커밋)
"버그 관련 작업계획서" 요청 → 3건 계획 승인 후 전부 수정:
1. **음성브리핑 오디오 선삭제 → 소실 위험** (`data_fetcher.build_voice_briefing`): 대본 생성 후 TTS 합성 **전에** `data/audio/` 전체를 삭제하던 걸 제거. 합성이 다 끝나고 `turns` 비어있지 않을 때만 새 turn 세트(`{t["audio_file"] for t in turns}`)에 없는 잔여 파일 정리. TTS 전체 실패 시 기존 오디오·매니페스트 그대로 유지. (`load_cached_voice_briefing` 조기반환 덕에 정상 재시작 땐 애초에 재빌드 안 함 — 실질 트리거는 "그날 첫 빌드가 TTS 단계에서 전멸")
2. **`/api/financials` 404 미캐시** (`app.py` `financials()`): 재무제표 없는 종목(ETF/ADR/20-F/SPAC, US 5천개 중 상당수)이 차트 열 때마다 SEC EDGAR 재호출(초당 10요청 제한 위험). `result is None`이면 `{"__notfound__": True}` 센티넬을 `ttl=21600`(6h, 성공 12h보다 짧게)로 캐시, 캐시히트가 센티넬이면 다시 404. 실측: `financials_ZZZZ` 캐시 저장→2회차 재fetch 없이 404 확인
3. **경제캘린더 2026-12-23 이후 고갈** (`data_fetcher._ECO_EVENTS`): 2027년 95개 추가(총 95→190개, 2026-01-09~2027-12-22). FOMC 8개는 연준 공표일(웹검색), NFP 12개는 "첫째 금요일" 규칙 계산(1월은 신정 겹쳐 8일로), 나머지 월간 시리즈(CPI/PPI/PCE/Retail/ISM/ConsumerConf/GDP)는 2026 각 항목 +364일(52주, 요일 유지). `fetch_economic_calendar()`에 "마지막 이벤트가 45일 이내면 `log.warning`" 추가 → 다음엔 조용히 안 비고 로그로 알림. 엔드포인트는 `days` 60일 상한이라 위젯엔 늘 60일치만 노출됨(2027분은 목록엔 있고 때가 되면 나옴)
- **검증**: `py_compile` 통과, 서버 재기동 후 `/api/financials/AAPL`(200)·`/ZZZZ`(404 캐시)·`/api/economic-calendar`(200)·`/api/voice-briefing`(200) 확인, `_ECO_EVENTS` 중복 0·정렬 OK. **버그1은 실제 유료 재생성 테스트는 안 함**(과금 회피, 코드 검토로 갈음)
- 미착수 버그 후보 없음(3건이 09-07 감사에서 나온 전부).
- **커밋 완료 (2026-09-07, `0e2340c`)**: `refactor+fix: 코드 정리 5건 + 감사 버그 3건`. 8개 파일 270+/227-. `data/pe_eps_cache.json`은 관례대로 제외(여전히 로컬 미커밋 상태로 남음)

### 같은 세션: 08-18 신규기능 백로그 2건 구현 (미커밋)
"3번 먼저" 요청 → 08-18 세션에서 발굴됐던 "신규기능 2건" 처리:
1. **포트폴리오 CSV에 Group/Memo/Target 컬럼 추가** (`portfolio.js`): 내보내기 헤더 5→8컬럼(`+Group,Memo,Target`), 값은 `PTG.get`/`PTN.get().memo`/`PTN.get().target`. 가져오기는 헤더에 해당 컬럼 있으면 `PTG.set`/`PTN.setMemo`/`PTN.setTarget`로 복원(구버전 CSV 하위호환). 워치리스트 CSV도 대칭성 위해 `Memo/Target` 추가(Group은 원래 있었음)
2. **홈 위젯에 목표가 달성 반영** (`main.js`): `renderHomeWatchlistSummary`/`renderHomePortfolioSummary`에 "🎯 목표가 도달 N건 — 티커..." 줄 + 워치리스트 top5 표에서 도달 행에 `✓`. `price >= WLN/PTN.get().target`(상승 목표), `typeof WLN/PTN` guard. 새 API 없음, 기존 `window._scStocks`/`_krStocks` 가격 재사용
- **공용 CSV 헬퍼 신설** (`main.js`): `_csvCell()`(쉼표/따옴표/개행 시 `"..."` 감싸고 `"`→`""`), `_csvSplitLine()`(따옴표 필드 인식 파서). 기존 `line.split(',')`는 메모 안 쉼표에서 깨졌음 → watchlist/portfolio 가져오기 양쪽을 이 파서로 교체
- **검증**: `node --check` 3파일 통과, CSV 라운드트립 Node 시뮬(메모 안 쉼표/이름 안 따옴표/빈 필드/한글 전부 export→split 일치 확인), 서버가 갱신된 static 파일 서빙 확인. 브라우저 시각 확인은 미완료(크롬 도구 미설치)
- **`index.html` 미변경 → 서버 재시작 불필요**(정적 JS/CSS는 매 요청 새로 읽힘)
- **커밋 완료 (2026-09-07, `fcecb3f`)**: `feat: 포트폴리오/워치리스트 CSV에 그룹·메모·목표가 컬럼 + 홈 위젯 목표가 도달 표시`. 4파일 89+/19-. `data/pe_eps_cache.json` 제외

### 같은 세션: 차트 더미 OHLCV 표시 개선 (오래 보류됐던 백로그, 미커밋)
`/api/chart`가 조회 실패 시 랜덤 워크 가짜 캔들을 아무 표시 없이 반환 → 실시세 오인 + 그 위 SIGNAL 카드까지 믿게 되던 문제. **보류 사유였던 "빈 데이터 미대응"은 빈 배열을 안 보내고 더미를 *태그만* 달아 우회**:
- `app.py` `_generate_ohlcv_dummy()`: 각 봉 dict에 `"_dummy": True` 추가(여분 키라 기존 소비자 전부 무시 — 파급 0). 캐시는 원래부터 안 함
- `chart.js`: `_chartIsDummy` 플래그 + `_isDummyOhlcv()`(첫 봉 `._dummy===true`) + `_setDummyBanner()`(없으면 `#lw-chart` 앞에 동적 삽입). `loadChart`에서 감지→빨간 배너 "⚠️ 예시 데이터입니다 — ... 자동 재시도" 표시. `_applyIndicators` 끝에서 더미면 `_candleSeries.setMarkers([])` + `#signal-card` 숨김(가짜 매수/매도 신호 차단), MA/RSI 등 토글지표·캔들은 렌더 유지. 자동갱신: 실데이터 보다 더미 수신 시 **갱신 건너뜀(화면 보존)**, 더미 보다 실데이터 복구 시 배너 내리고 전체 재렌더
- `style.css` `.chart-dummy-banner` (CHART 섹션, `#lw-chart` 규칙 다음)
- **검증**: 서버 재시작 후 `/api/chart/ZZZZ99`→180봉 전부 `_dummy:true`, `/api/chart/AAPL`→252봉 태그 없음 확인. Node로 `_isDummyOhlcv` 4케이스 + 자동갱신 4분기(SKIP/RECOVER/NORMAL) 판정 확인. `py_compile`/`node --check` 통과. 브라우저 시각 확인은 크롬 도구 미설치로 미완료
- **app.py 변경 → 서버 재시작 필요**(했음). 3파일 수정(app.py/chart.js/style.css)
- **커밋 완료 (2026-09-07, `5136c22`)**: `feat: 차트 조회 실패 시 예시 데이터 경고 배너 + 가짜 SIGNAL 억제`. 3파일 64+/3-. `data/pe_eps_cache.json` 제외

### 같은 세션: RSI 다이버전스 단독 스캐너 (커밋 `469a338`)
"스크리너 CSV 내보내기"는 재확인 결과 **이미 구현돼 있었음**(screener.js `exportScreenerCSV`/`exportKrCSV` + 버튼) → 백로그에서 제거. 남은 "쉬움" 백로그였던 RSI 다이버전스 스캐너만 구현:
- `_sig_rsi_divergence()`(기존, 복합신호 점수에만 쓰이던 것)를 Brief 개요 패널 독립 카드로 노출. 다른 스캐너 4종(거래량/캔들패턴/52주/실적결합)과 동일 위상
- `compute_daily_metrics._one()`: **마지막 봉만 보면 거의 안 잡힘**(스윙 확정에 order=5봉 지연) → `_sig_rsi_divergence(closes)[-10:]`에서 가장 최신 0 아닌 값을 `rsi_div`로. 제외 조건에 `and not rsi_div` 추가(다이버전스만 있어도 포함)
- `build_daily_recommendations._process()`: 반환 튜플 4→5개(`{bullish,bearish}` 시총순 top15 추가), `rsi_divergences: {us,kr}` 결과 병합
- `app.py`: `/api/rsi-divergence`(candle-patterns와 동일 패턴), `_EMPTY_DAILY_SIGNALS`에 키
- `brief.js`: `loadRsiDivergence()`, `_renderPatternList(elId, items, label)`에 label 파라미터 추가(캔들패턴과 공용, 빈 문구 "해당 패턴이"→"해당 항목이")
- `index.html`: 캔들패턴 카드 다음 US/KR RSI 다이버전스 카드 2개(4 div)
- **실서버 검증**: 240초 배치 후 `/api/rsi-divergence` 실데이터 확인 — US bullish 5(CVS/APP/DDOG…)/bearish 15(MSFT/PFE/VRTX…), KR bullish 1(004170.KS)/bearish 15(066570.KS…). `compute_daily_metrics` 결과 US 100/KR 107 (필터 완화로 인한 배치 팽창 없음, 기존 ~91-110 범위). 배치 17초. `_sig_rsi_divergence` 합성데이터로 상승 다이버전스 감지 단위확인. `py_compile`/`node --check` 통과. **index.html 수정 → 서버 재시작 필요**(했음). 브라우저 시각 확인은 미완료(크롬 도구 미설치)
- **커밋 `469a338`**: 4파일 74+/7-. `data/pe_eps_cache.json` 제외

## 2026-09-15 세션: 전체 재감사 + 코드정리 3건 + 버그 4건 수정 (커밋 `47cb80d`)
"작업 리스트 불러와줘" → "전체 확인해서 리스트 더 확인해줘" 요청으로 general-purpose 에이전트가 app.py/data_fetcher.py/cache.py/static/js 전체/index.html/style.css 재감사(기존 처리·확정보류 항목 제외 지시). 버그 4건·코드정리 5건·신규기능후보 4건 발굴 → 사용자가 "코드 정리부터"→"버그도 작업하자" 순으로 진행 지시, CLAUDE.md 작업계획서 규칙대로 순차 처리 후 커밋까지 완료.

**코드 정리 3건 (완료)**
- `NAME_KO` 딕셔너리 "DG"(달러제너럴) 중복 키 삭제
- `fetch_indices()` 독스트링 "지수 10개"→실제 19개로 정정
- 히트맵 `_avgFill`(로컬)/`_avgFillKr`(전역) 완전 동일 로직 함수를 top-level `_avgFill()` 하나로 통합 (`heatmap.js`)

**코드정리 중 보류한 2건(의도적 제외, 사유 있음)**
- KR 스크리너 정렬키 `_52w_pos`→`_52wpos` 통일: 버그(아래 항목2)와 묶어서 처리 — 이름만 바꾸면 정렬 안 되는 버그가 그대로 남아 반쪽짜리라 버그수정 라운드에서 함께 처리
- 비정상종목 판별 정규식 JS/Python 이중 유지: 완전 해결하려면 두 언어 로직을 공용 API화하는 구조적 리팩터링 필요, 다음 논의 대상으로 보류

**버그 4건 (완료, 커밋 `47cb80d`)**
1. **홈 "섹터 퍼포먼스" 위젯 깨짐** — `main.js` `_refreshCurrentView()`가 WS 갱신(5분)·WS끊김 폴백(30초) 시 `renderSectorPerf(stocks)`에 원본 배열을 그대로 넘겨(`_sectorItemsFrom1D()` 가공 누락) `avg` 필드 없어 `undefined%`가 종목 수만큼 출력되던 버그. 다른 정상 호출부와 동일하게 가공 함수 추가해 수정
2. **KR 스크리너 Performance뷰 "52W 위치" 정렬 무동작** — KR 컬럼 키가 `_52w_pos`(US는 `_52wpos`)로 달라서 `_krCmpCol`이 객체에 없는 필드를 읽어 항상 0으로 비교(no-op). 키를 `_52wpos`로 통일 + `_krCmpCol`에 US와 동일한 즉석계산 특례(`_calc52wPosKr`) 추가
3. **차트 탭 주봉 추세 필터가 일봉(기본) 조회 시 항상 무력화** — `_resampleWeekly()`가 `bar.time * 1000`으로 계산했는데, 일봉 응답의 `time`은 `"YYYY-MM-DD"` 문자열이라 NaN이 되어 전체 기간이 한 주로 뭉개짐. `_parseBarTime()` 헬퍼(문자열/숫자 모두 처리) 신규 추가로 해결. 서버 계산(`data_fetcher._sig_resample_weekly`, 문자열 파싱 정상)과 이제 일치 — 이전엔 차트탭 SIGNAL 마커와 Brief 등 서버계산 신호가 이 필터 하나 때문에 미묘하게 어긋났었음
4. **KR PER/EPS 관계 역전** — `_fetch_kr_price_one()`이 PER을 base 고정, EPS를 `가격/고정PER`로 매번 역산(EPS가 가격 따라 5분마다 흔들리고 PER은 스크립트 재실행 전까지 고정되던 구조). 방향을 반대로 바꿔 **EPS를 base 고정 앵커**, **PER=현재가/EPS로 실시간 재계산**하도록 수정. `/api/kr-stocks` 실측으로 PER=가격/EPS 정확히 일치 확인(예: 207940.KS 45.36=1,396,000/30,776)
- **알려진 한계**: PER 계산의 EPS 앵커 자체가 `data/kr_stocks.json` 마지막 생성일(2026-07-02) 기준으로 오래됨 — 완전한 정확도는 `scripts/fetch_kr_stocks.py` 수동 재실행(~10분) 필요, 이번 세션에서는 미실행(사용자에게 제안만 하고 다음으로 미룸)

**검증**: `py_compile`/`node --check` 전체 통과, 서버 재시작 후 `/api/indices`(19개)·`/api/kr-stocks`(200, PER 실측 일치) 확인, Node 시뮬레이션으로 `_parseBarTime`(문자열/숫자 케이스)·`_krCmpCol`(52wpos 정렬 실제 동작) 확인. 브라우저 실클릭 검증은 이번에도 크롬 도구 미설치로 미완료(지속되는 제약)
- **커밋 완료 (2026-09-15, `47cb80d`)**: `fix+refactor: 재감사 버그 4건 수정 + 코드정리 3건`. 5파일 23+/25-. `data/pe_eps_cache.json` 제외
- **미착수로 남은 것**: 신규기능 후보 4건(관심종목 신규신호 브라우저알림/News 관심종목만 필터/Brief 스캐너3종 관심종목필터/KR PER 자동재수집 배치화), 코드정리 보류 2건(위 참고), KR 기준데이터 재수집 여부(사용자 결정 대기)

## 2026-10-31: KR 수급 완전 파손 발견(미수정) + 해외주식 수급 대안 작업리스트 등록
사용자가 "거래량과 수급이 안 나온다" 질문 → 진단만 수행(아직 수정 안 함, [[feedback-workflow]] 작업계획서 규칙 적용 전이라 분석만):

- **KR 수급(`fetch_kr_investor`, Phase 4-74) 완전 파손 확인**: 네이버가 `finance.naver.com/item/frgn.naver`를 폐기 — 접속 시 `stock.naver.com/domestic/stock/<code>/investmentinfo`로 302 리다이렉트, 응답이 Next.js SPA(`<tr>` 0개, 가끔 HTTP 410도 발생)로 바뀜. 기존 정규식 테이블 파싱이 원천적으로 불가능해져 `/api/kr-investor`가 항상 빈 배열 반환 → 프론트 "정보 없음". **PLAN.md에 "높음" 우선순위로 등록**, 대체 데이터 소스 조사 필요(새 Npay증권 내부 API 역추적 등)
- **거래량은 정상**: US(`/api/stocks`)·KR(`/api/kr-stocks`) 둘 다 Yahoo Finance 기반이라 네이버 이슈와 무관, 실데이터로 정상 확인(NVDA 77.5M, 삼성전자 19.6M)
- **해외주식(US) 수급 — 사용자가 Brief 탭에 별도 관리하기로 결정, 보류**: KRX처럼 일별 외국인/기관 순매수 공개 데이터가 미국엔 없음(13F는 분기+45일 지연, Form4는 내부자 개념이 다름, 다크풀은 유료) → KR과 동일 방식 구현 불가 결론. 대안(13F 기관 보유비중 변화 등)은 차트 패널이 아니라 Brief 탭에 별도 섹션으로 — 사용자 요청으로 **작업리스트에만 등록, 착수 안 함**
- PLAN.md "Phase 4-76 이후 예정 항목"에 2건 추가: "KR 수급 데이터 소스 교체"(높음), "해외주식 수급 대안 — 브리핑 탭"(보류)

## 2026-10-18~10-31 커밋 (git log 기준, 10-31 확인)
- `e44b113` (10-18) Render 배포 준비(PORT 환경변수, Procfile, runtime.txt)
- `014dd69`/`e79053a`/`e9b4284` (10-19) KR 가격갱신 수정, KR 뉴스 Google News 폴백 → 네이버 검색 API 1순위, Render secret file 읽기
- `143219f` (10-26) gzip 응답압축, 시작 작업 시차 실행, 네이버 키 파싱 관대화
- `8b9150f`/`3ff25de` (10-31) **KR 수급 데이터 소스 네이버 JSON API로 교체 — 위 "완전 파손" 이슈 해결됨**
- `3dcd0cb` (10-31) 스크리너 미방문 상태에서 히트맵 클릭 시 종목 모달 안 뜨던 버그 수정

## 2026-10-31: KR PER/EPS 1일 1회 자동 재수집 + PLAN.md 정리 (커밋 `ea61268`, 캐시 json 2개는 관례대로 제외)
- `data_fetcher.fetch_kr_per_eps()` (네이버 `m.stock.naver.com/api/stock/{code}/integration`) + `app.py` `refresh_kr_per()`(24h, 시작 300초 후, 캐시 20h 이내 스킵) → `data/kr_per_cache.json`. `_apply_kr_per()`가 EPS 덮어쓰고 PER 재계산
- **`scripts/fetch_kr_stocks.py`는 소스(`sise_market_sum.naver`) 폐기로 동작 불가** — 새 API 교체 작업을 PLAN.md 예정 항목(높음)으로 등록
- PLAN.md에 4-101~4-117, 9~10월 작업 기록 추가 및 예정 표 정리

## 2026-11-01: 홈 화면 수정 2건 (커밋 완료)
- `b5735b5` 홈 Sectors 스트립 자동 갱신 버그(`_homeStocks` 미갱신, 1W/1M 선택이 1D로 덮임) 수정
- `cba2591` 홈 지수판 GBP/USD 제거, 필라델피아 반도체 지수 `^SOX`("PHLX Semi") Major Indices에 추가
- 주의: `data_fetcher.py`는 git index가 CRLF(i/crlf) — 파이썬으로 텍스트 재작성 시 CRLF 유지할 것(LF로 쓰면 전체 diff 발생)

---

# Part 2. 신호 적중률 백테스트 상세 (원본: project_signal_accuracy.md)


## 현재 신호 시스템 (2026-06-30 기준, commit 9688a7c)

**구현된 지표:** MACD + RSI + STO (Stochastic)
**신호 로직:** score -3~+3, ±2 이상 시 차트 마커 표시
**적용된 필터 (중첩):**
1. MACD 제로라인 필터: 데드크로스는 MACD값 음수일 때만 -1
2. MA50 추세 필터: 하락 추세 시 매수 억제, 상승 추세 시 매도 억제
3. 주봉 MA13 추세 필터: 주봉 상승 시 매도 억제, 주봉 하락 시 매수 억제
4. RSI 다이버전스: 강세/약세 다이버전스 감지 시 ±1 추가
5. BB %B 필터: 매수 %B < 0.35, 매도 KR %B > 0.85 / US %B > 0.65
6. **[전략B, KR 전용, 신규]** 매도 신호 시 최근 3봉 내 약세 캔들(슈팅스타/베어리시 인걸핑) 필수

**Why:** 사용자 목표 65% 적중률 달성. 300종목 확대 백테스트로 신뢰도 검증.

## 300종목 백테스트 결과 (2026-06-30, 10일 기준)

| 항목 | 결과 | 목표 | 판정 |
|------|------|------|------|
| US 매수 (278종목) | **75.4%** | 65% | ✅ 초과 달성 |
| KR 매수 (297종목) | **70.0%** | 65% | ✅ 달성 |
| US 매도 | 47.8% | 65% | ❌ 미달 (구조적 한계) |
| KR 매도 [전략B] | **68.0%** | 65% | ✅ 달성 |

## 전략별 비교 (핵심)

### US (278종목)
| 전략 | 전체% | 매수% | 매도% | 매도건 |
|------|-------|-------|-------|--------|
| [현재] MTF+DIV+BB | 61.7% | **75.4%** | 47.8% | 540 |
| [전략A+B] %B>0.75+캔들 | 70.1% | 75.4% | 38.7% | 93 (신호 희소) |
| SPY 시장 필터 | 60.5% | 75.4% | 44.5% | — (효과 없음) |

### KR (297종목)
| 전략 | 전체% | 매수% | 매도% | 매도건 |
|------|-------|-------|-------|--------|
| [현재] MTF+DIV+BB | 68.1% | **70.0%** | 60.6% | 180 |
| **[전략B] 매도+캔들확인** | **69.9%** | 70.0% | **68.0%** | 50 |
| KOSPI 시장 필터 | 67.5% | 70.1% | 56.8% | — (효과 없음) |

## 구현 완료 항목 (2026-06-30)

- `static/js/chart.js` `_calcSignals()`: KR 전용 약세 캔들 매도 필터
- `static/js/chart.js` `_renderSignalCard()`: CANDLE 행에 `⚡ 매도 차단` / `패턴명 ✓` 표시
- `scripts/backtest_300.py`: US/KR 각 300종목 전체 전략 비교 스크립트

## 500종목 확대 재검증 (2026-07-16~17)

기존 300종목 결과가 표본 우연이 아닌지 재확인하기 위해 500종목으로 확대 실행. `scripts/backtest_300.py`를 수정해 US도 KR과 동일하게 **실제 라이브 시총 데이터**(`data_fetcher.fetch_nasdaq_stocks()`) 기반 상위 N개 동적 로드로 변경(기존엔 하드코딩 300개 티커였음), `load_kr_top300()`→`load_kr_topN(n)` 일반화, 종목 수를 3번째 CLI 인자로 받도록 함(`python scripts/backtest_300.py 10 all 500`).

**현재 운영 중인 전략(production 로직) 기준, 300종목 vs 500종목 비교:**

| 구분 | 300종목 (06-30) | 500종목 (07-16) | 목표 | 판정 |
|------|------|------|------|------|
| US 매수 (MTF+DIV+BB) | 75.4% | **76.3%** | 65% | ✅ 유지·소폭 개선 |
| US 매도 (MTF+DIV+BB) | 47.8% | **50.8%** | 65% | ❌ 여전히 미달 |
| KR 매수 (MTF+DIV+BB) | 70.0% | **73.6%** | 65% | ✅ 유지·소폭 개선 |
| KR 매도 (전략B) | 68.0% | **67.3%** | 65% | ✅ 유지 |

표본을 300→500개(US 유효 492개, KR 유효 490개)로 늘려도 결과가 거의 동일 — 300종목 결과가 우연이 아니라 신뢰할 수 있는 수치였음을 재확인. US 매도 개선 포기 결정도 재확인됨.

## score 구간별(순위) 적중률 검증 (2026-07-17)

Brief/Screener/Watchlist 등에 표시되는 매수·매도 순위가 실제로 "score 높을수록 잘 맞는지" 검증(US/KR 500종목, 10일 기준, `backtest_300.py`의 `strategy_current` = production `compute_today_signal()`과 동일 로직 — KR 캔들 베토는 신호를 0으로 지울 뿐 magnitude엔 영향 없어 US와 동일 기준으로 비교 가능).

| \|score\| | US 매수% | US 매도% | KR 매수% | KR 매도% |
|---|---|---|---|---|
| 2 | 75.2% (944건) | 49.8% (616건) | 73.4% (890건) | 63.4% (183건) |
| 3 | **85.7%** (98건) | **70.0%** (30건) | 74.4% (160건) | 90.9%*(11건, 표본 극소) |
| 4+ | 100%*(2건) | — | 100%*(3건) | — |

**결론: 정렬 기준(score 내림차순)이 실제로 유효함** — score 높을수록 US/KR 매수·매도 전부 적중률 상승. 특히 US 매도는 전체 평균(50.8%)으론 목표(65%) 미달이지만, **score=3 이상만 골라내면 70.0%로 목표 달성** — "약한 매도 신호(score=2)는 걸러내고 강한 신호(score>=3)만 신뢰"하라는 실전 가이드 근거가 됨. KR은 score=2도 이미 목표 상회, score=3에서 소폭 추가 개선.

## [중요] compute_today_signal() threshold 게이트 누락 버그 발견 및 수정 (2026-07-17)

score 구간별 검증 도중 사용자가 "Brief 매도 신호 숨기기 UI" 요청 → 실제 `/api/daily-signals` 라이브 데이터를 열어보니 **오늘 표시된 매수·매도 신호의 거의 전부(US 매도 19건 전부, KR 매수·매도 96건 전부)가 `\|score\|=1`인 미검증 약한 신호**였음을 발견.

**원인:** `chart.js`의 `_calcSignals()`는 원점수만 계산하고, 실제 마커를 그릴지는 별도 함수 `_applySignalMarkers()`가 `threshold=2`로 게이트함. `data_fetcher.py`의 `compute_today_signal()`은 `_calcSignals()`는 충실히 포팅했지만 **이 threshold 게이트 적용 단계가 누락**되어 있었음 — 그 결과 지금까지 이 세션에서 한 모든 백테스트(300종목, 500종목, score 구간별 검증)는 전부 `\|score\|>=2`만 신호로 인정하는 로직(`strategy_current`/`backtest_tiered`)을 검증한 것인데, **실제 production이 화면에 보여주는 신호는 이 검증 대상과 다른(더 약한, 미검증) 신호가 대부부이었던 것.**

**수정 (`data_fetcher.py`):** `compute_today_signal()` 마지막에 `\|score\|<2`면 0(신호 없음) 반환하는 게이트 추가. `_SIG_TERM` 라벨 매핑도 `{1:단기,2:중기,3:장기}` → `{2:중기,3:장기}`로 정리(단기 라벨 자체가 이제 나올 일이 없어짐), 기본 라벨을 "단기"→"장기"로 수정(score=4 이상 강신호가 잘못 라벨링되던 것도 같이 고침).

**수정 후 실측(같은 날 재계산):** US 매도 19→0건, KR 매수 19→0건, KR 매도 77→0건, US 매수 70→2건(EXC·VMC, score=2). 신호 개수가 급감했지만 이게 정상 — "진짜 검증된 신호만 남은" 의도된 결과. **이 수정 이후로 비로소 화면에 뜨는 신호와 이 세션에서 백테스트로 검증한 수치(US 매수 76.3%, KR 매수 73.6%, KR 매도 67.3%, score>=3 필터 시 US 매도 70.0% 등)가 실제로 일치하게 됨.**

커밋: `0695b11`(백엔드 수정), `02a5ba3`(Brief 매도 "약한 신호(score=2) 숨기기" 체크박스 UI — 이 수정 전엔 항상 score=1뿐이라 체크박스가 사실상 무의미했는데, 수정 후엔 score=2 항목이 실제로 나타나 의미 있게 동작).

## 다음 작업 제안

- US 매도는 전체 평균으로는 어떤 전략도 65% 달성 못 함 → 개선 포기 확정(300·500종목 둘 다 재확인됨). 다만 **score=3 이상 필터링하면 70.0%로 목표 달성** — Brief 탭 매도 리스트에 "약한 신호(score=2) 숨기기" 체크박스로 구현 완료(2026-07-17)
- KR 전략B 신호 희소(300종목 기준 50건/2년, 500종목 기준 55건) → 고신뢰 신호로 활용 권장
- threshold 게이트 수정으로 신호 개수가 전반적으로 크게 줄었으므로, Brief/스크리너/워치리스트 등에서 "신호가 너무 없다"는 피드백이 나오면 이 변경이 원인임을 먼저 확인할 것

## 관련 파일
- `static/js/chart.js`: `_calcSignals()`, `_calcCandlePatterns()`, `_renderSignalCard()`
- `scripts/backtest_300.py`: US/KR N종목(기본 300, 인자로 변경 가능) 전체 전략 백테스트. US는 `data_fetcher.fetch_nasdaq_stocks()` 라이브 시총 상위 로드, KR은 `data/kr_stocks.json` 시총 상위 로드
  - 실행: `python scripts/backtest_300.py 10` (300종목) / `python scripts/backtest_300.py 10 all 500` (500종목)
  - spy 모드: `python scripts/backtest_300.py 10 spy`

## 종합 진단 신규 항목(4종) 백테스트 (2026-07-18)
`build_stock_analysis()`(종목 종합 진단, Phase 4-108/4-109)에 추가한 52주위치·거래량+방향·캔들패턴·골든/데드크로스를 `scripts/backtest_new_signals.py`(신규)로 US/KR 각 700종목(유효 679/678) 대상 검증. 밸류에이션·뉴스감성/수급은 과거 시계열 데이터가 없어 백테스트 자체가 불가능해서 대상에서 제외.

**결과: 4개 전부 신뢰도 낮음.**
- 매도 방향은 US/KR 전 항목·전 기간(5/10/20일)에서 40.7~50.2% — 랜덤(50%) 이하이거나 비슷한 수준. 실전에서 매도 근거로 쓰기엔 부적합
- 매수 방향은 50.8~63.6% — 약한 우위는 있으나(KR 52주위치 60.3~63.6%가 그나마 최선, US 골든크로스 20일 58.6%), 위에서 검증된 "기술적 신호"(US/KR 매수 73~76%)에 한참 못 미침. 2년치 데이터가 대체로 강세장이었던 영향(시장 상승 편향)일 가능성이 높아 이 지표들이 실제 정보를 담고 있다는 근거로 보기 어려움
- **결론**: 종합 진단 패널 7개 항목 중 "기술적 신호" 하나만 실제 검증됨. 나머지 6개는 참고용으로만 두되, 매수/매도 자동 판단 근거로 과신하면 안 됨 — 다음에 이 주제 나오면 이 결과부터 공유할 것

**Why:** 사용자가 "이 지표로 매수/매도해도 신뢰도가 높은가" 직접 질문 → 감이 아니라 숫자로 검증하기 위해 진행
**How to apply:** 종합 진단 패널 관련 작업(요약 카운트 가중치 조정, 항목 제거/문구 수정 등) 논의 시 이 결과를 근거로 제시

## 수박지표(오리지널/업그레이드)·세력계단 백테스트 (2026-07-18)
사용자가 수강 중인 키움 HTS 트레이딩 강의의 커스텀 수식(사용자 로컬 강의 자료 폴더의 키움 수식 txt)을 `scripts/backtest_watermelon_stairs.py`(신규)로 번역해 US/KR 각 700종목(유효 671/652, 5년치) 검증.

**핵심 발견 — 첫 해석이 틀렸었음:** 수박지표는 "스케일:화면"(가격축이 아닌 독립 오실레이터, RSI처럼)인데 처음엔 "종가가 껍질 라인에 근접"으로 잘못 해석해 신호가 0건 나옴 → 라인설정의 "기준값:0" 근거로 "껍질(min) 라인이 0에서 양수로 전환되는 시점"으로 재해석해 정상 작동. **이 재해석도 원 강의 영상의 정확한 룰과 다를 수 있음(영상 자체는 못 봄).**

**결과:**
| 지표 | US 5/10/20일 | KR 5/10/20일 | 비고 |
|---|---|---|---|
| 수박지표 오리지널 | 57.2/58.5/**61.2%** | 51.0/52.7/50.3% | 신호 US 725건·KR 431건 |
| 수박지표 업그레이드 | 52.5/55.1/55.9% | 48.7/48.3/50.4% | 신호 US 2507건·KR 3119건(오리지널보다 3~7배 많음) |
| 세력계단(근접1/2) | 52.9/54.1/56.2% | 49.7/50.2/51.9% | 신호 수만 건(가장 잦음), KR은 사실상 랜덤 |

**결론**: **수박지표 오리지널이 업그레이드보다 명확히 우수** — 업그레이드에 추가된 다중 이평 정배열+이격 필터가 신호 빈도만 늘리고(3~7배) 적중률은 오히려 낮췄음("필터 추가 = 개선"이 아니라는 반례). US 61.2%(20일 기준)가 이번에 테스트한 강의 지표 중 최고 성적이지만, 그래도 기존 검증된 "기술적 신호"(73~76%)에는 못 미침 — "괜찮은 기준"이라 부르기엔 약함. 세력계단은 KR에서 랜덤 수준이라 채택 비추천.

**Why:** 사용자가 강의에서 배우는 커스텀 지표(수박지표 오리지널/업그레이드, 계단지표) 파일을 제시하며 "이걸로 확인해보는 게 어떤가" 질문 → 동일하게 실측 검증
**How to apply:** 종합 진단에 새 항목 추가 논의 시, 채택한다면 "수박지표(오리지널)"이 후보 1순위지만 정확도가 여전히 기술적 신호보다 낮다는 점 명시 필요. 이 지표들 관련 재질문 시 "제가 해석한 매수룰이 원 강의와 다를 수 있다"는 전제부터 재확인할 것

### 재검증: KR을 코스피2000+코스닥1000으로 확대 (2026-07-18, 유효 2,509종목)
최초 KR 테스트(700종목)는 시총 통합정렬이라 사실상 코스피 대형주 위주였음 — 사용자 요청으로 `load_kr_kospi_kosdaq()` 추가해 코스피/코스닥 비율을 명시적으로 맞춰 재검증(`python scripts/backtest_watermelon_stairs.py kr 2000 1000`).

**결과: 코스닥을 제대로 포함하니 3개 지표 전부 더 나빠짐.**
| 지표 | 700종목(대형주위주) | 3,000종목(코스피2000+코스닥1000) |
|---|---|---|
| 수박 오리지널 | 50~53% | 49.5~51.1% (거의 정확히 랜덤) |
| 수박 업그레이드 | 48~50% | 43~45% (랜덤 이하로 악화) |
| 세력계단 | 50~52% | 45.6% (랜덤보다 확실히 낮음, 신호 21만건) |

**결론**: "세력 매집" 개념이 대형주(수급 안정적)엔 약간 맞았을 수 있으나, 코스닥 중소형주(변동성 크고 개인 수급 위주)엔 안 맞음 — KR에서는 이 세 지표 전부 채택 비추천 확정. **US 수박지표 오리지널(57~61%)만 유일하게 남은 "약한 참고 후보"**, 나머지 전부(세력계단·수박업그레이드·52주위치·골든크로스 등)는 KR 기준 랜덤 이하 확정.

**How to apply:** KR 관련 신규 지표를 앞으로 백테스트할 때는 반드시 코스피/코스닥 비율을 명시적으로 맞출 것 — 시총 통합 top-N은 대형주 편향으로 결과가 실제보다 낙관적으로 나올 수 있음(이번 사례가 증거)

### 재재검증: 최신 데이터로 동일 조건 재실행 (2026-08-24)
사용자 요청으로 KR 코스피2000+코스닥1000(3,000종목, 유효 2,526종목)을 최신 시세로 다시 백테스트. 결과: 수박 오리지널 50.7~52.4%(20일 50.7%), 수박 업그레이드 42.9~44.8%, 세력계단 45.2~45.6% — **07-18 결과(오리지널 49.5~51.1%, 업그레이드 43~45%, 계단 45.6%)와 거의 동일하게 재현됨**. 데이터 시점을 바꿔도 결론이 안정적이라는 뜻 — KR 채택 비추천 결론 재확정. 룰 해석이 바뀌지 않는 한 다시 돌려도 같은 결과가 나올 가능성이 높으므로, 다음에 재검증 요청이 오면 먼저 "룰 해석이 달라졌는지"부터 확인할 것.
