---
paths:
  - "scripts/fetch_kr_stocks.py"
  - "data/kr_*.json"
  - "static/js/screener.js"
  - "static/js/heatmap.js"
  - "static/js/chart.js"
---

# 국내주식(KR) 작업 규칙

## KR 기능별 수정 위치
| 작업 | 위치 |
|------|------|
| KR 가격 갱신 | `data_fetcher.py` `_fetch_kr_price_one()`, `fetch_kr_prices()` / `app.py` `refresh_kr_stocks()` (emit `kr_stocks_update`) |
| KR PER/EPS | `data_fetcher.py` `fetch_kr_per_eps()` / `app.py` `refresh_kr_per()`, `_apply_kr_per()` — **EPS가 앵커, PER = 현재가 ÷ EPS** (반대로 하지 말 것) |
| KR 수급 | `data_fetcher.py` `fetch_kr_investor()` (네이버 integration JSON API) |
| KR 스크리너 | `static/js/screener.js` 하단 `// ══ 국내주식 ══` 이하 (`_getKrFiltered`, `renderKrScreener`) |
| KR 히트맵 | `static/js/heatmap.js` `renderKrHeatmap()` (업종→종목 2단계) |
| KR 차트 정보 | `static/js/chart.js` `renderStockInfo()` 안 `isKr` 분기 |
| KR API | `app.py` `/api/kr-stocks`, `/api/kr-news/<code>`, `/api/kr-investor/<code>`, `/api/kr-disclosures` |

## 주의
- 티커 형식: `005930.KS`(코스피) / `.KQ`(코스닥). 백엔드는 숫자만 추출해서 처리
- US 소켓·타이머가 KR 화면을 덮어쓰지 않게 `_scMarket` 등 시장 분기를 확인 (08-18 버그)
- 비정상 종목: 이름에 "스팩" 포함, 또는 "우"/"우B"로 끝나는 우선주. ETF/ETN은 `sector=='기타'`
- `scripts/fetch_kr_stocks.py`는 **현재 동작 안 함** — 소스(`sise_market_sum.naver`) 폐기. 수정 전까지 실행해도 소용없음 (docs/ROADMAP.md "다음")
- KR 지표 백테스트는 **코스피/코스닥 비율을 명시적으로 맞춘다** (시총 통합 top-N은 대형주 편향)
