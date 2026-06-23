# CLAUDE.md — StockView 프로젝트 작업 규칙


이 파일은 Claude Code가 이 프로젝트에서 작업할 때 반드시 따라야 하는 규칙을 정의합니다.

---

## 필수 규칙: 작업 전 계획서 / 작업 후 보고서

### 1. 작업 시작 전 — 작업계획서 작성

**모든 작업(기능 추가, 버그 수정, 리팩토링 포함)을 시작하기 전에** 아래 형식의 작업계획서를 반드시 먼저 작성하고 사용자에게 보여준다. 사용자가 확인 후 진행하는 것을 원칙으로 한다.

```
## 작업계획서

### 작업 개요
- 작업명: (한 줄 요약)
- 목적: (왜 이 작업이 필요한가)
- 예상 소요 시간: (예: 30분 / 1시간)

### 현재 상태 (AS-IS)
- 현재 어떻게 동작하고 있는지 설명
- 문제점 또는 개선이 필요한 부분

### 변경 후 상태 (TO-BE)
- 작업 후 어떻게 달라지는지 설명

### 작업 범위 (변경할 파일 목록)
| 파일 | 변경 유형 | 변경 내용 요약 |
|------|-----------|----------------|
| app.py | 수정 | ... |
| static/js/main.js | 수정 | ... |
| 신규파일.py | 신규 생성 | ... |

### 단계별 작업 순서
1. 1단계: (무엇을, 왜)
2. 2단계: (무엇을, 왜)
3. 3단계: (무엇을, 왜)

### 주의사항 / 리스크
- (예: API 키 필요, 서버 재시작 필요, 기존 데이터 포맷 변경 등)

### 롤백 방법
- 문제 발생 시 되돌리는 방법
```

---

### 2. 작업 완료 후 — 결과 보고서 작성

**모든 작업이 끝난 후** 아래 형식의 결과 보고서를 반드시 작성해 사용자에게 보여준다.

```
## 작업 결과 보고서

### 작업 요약
- 작업명: (한 줄 요약)
- 완료 일시: (예: 2026-06-02)
- 결과: ✅ 성공 / ⚠️ 부분 성공 / ❌ 실패

### 완료된 작업 내용
| 파일 | 변경 유형 | 변경 내용 |
|------|-----------|-----------|
| app.py | 수정 | ... |

### 테스트 결과
- 항목별로 확인한 결과를 체크리스트로 작성
  - [x] API 응답 정상
  - [x] UI 화면 정상 표시
  - [ ] (미완료 항목은 체크 해제)

### 주요 변경사항 설명 (초보자용)
- 전문 용어 없이 쉽게 설명
- 예: "이전에는 미리 만들어둔 가짜 데이터를 보여줬는데, 이제는 Yahoo에서 실시간으로 데이터를 가져옵니다"

### 알려진 이슈 / 다음 작업 제안
- (있으면 작성, 없으면 "없음")
```

---

## 필수 규칙: "불러오기" 명령

사용자가 **"불러오기"** 라고 입력하면, 아래 형식으로 즉시 작업 현황 보고서를 출력한다. 다른 작업을 먼저 하지 말고 이 보고서를 최우선으로 출력한다.

```
## StockView 작업 현황 보고

### 전체 진행률
- 완료된 Phase: (예: Phase 1~3 + 4-1 ~ 4-26, 총 29단계)
- 현재 탭 수 / 연동 종목 수 등 핵심 수치

### 완료된 작업 목록
| Phase | 완료일 | 내용 요약 |
|-------|--------|-----------|
| ...   | ...    | ...       |

### 진행 예정 작업 목록
| 기능 | 우선순위 | 설명 |
|------|---------|------|
| ...  | ...     | ...  |
```

- 완료 목록은 PLAN.md와 메모리(project_finviz.md)를 기준으로 최신 상태를 반영한다.
- 진행 예정 목록은 PLAN.md의 "Phase 4-27 이후 미구현 항목" 및 사용자가 별도로 언급한 계획을 포함한다.

---

## 프로젝트 개요

| 항목 | 내용 |
|------|------|
| 프로젝트명 | StockView |
| 목표 | Finviz 스타일 미국·국내 주식 시장 분석 웹앱 |
| 실행 | `python app.py` → http://127.0.0.1:5001 |
| 스택 | Flask + Vanilla JS + D3.js + Lightweight Charts |
| 환경 | Python 3.15 알파 (pandas/numpy 설치 불가) |

## 현재 구현 상태

- **Phase 1** ✅ — Flask SPA, 5탭 구조 (Home/Screener/Heatmap/Chart/News)
- **Phase 2** ✅ — fetch_stocks.py (S&P500 수집), screener_api.py (FastAPI 별도 서비스)
- **Phase 3** ✅ — 실시간 데이터 연동 (cache.py, data_fetcher.py, 자동 새로고침)
- **Phase 4-65** ✅ — 국내주식(KR) 업종 분류, 스크리너 업종 필터

## 핵심 파일 역할

> **US = 미국주식 전용 / KR = 국내주식 포함 / 공통 = US+KR 공용**

| 파일 | 구분 | 역할 |
|------|------|------|
| `app.py` | 공통 | Flask 서버, API 엔드포인트, APScheduler |
| `cache.py` | 공통 | Thread-Safe TTL 캐시 (stale-while-revalidate) |
| `data_fetcher.py` | 공통 | Yahoo Finance(US·KR) 가격, Nasdaq API, RSS 뉴스, VADER 감성 분석 |
| `templates/index.html` | 공통 | SPA 단일 HTML 파일 (US·KR 탭 공용) |
| `static/js/main.js` | 공통 | 홈, 뷰 전환, 자동 새로고침, WebSocket |
| `static/js/screener.js` | **공통(US+KR)** | US 스크리너(상단) + KR 스크리너(하단 `// ══ 국내주식 ══` 구분선 이하) |
| `static/js/heatmap.js` | US | D3.js 히트맵 (현재 US 전용) |
| `static/js/chart.js` | **공통(US+KR)** | Lightweight Charts 캔들스틱 (`isKr` 분기로 KR 처리) |
| `static/js/brief.js` | US | Market Brief 탭 |
| `static/js/watchlist.js` | 공통 | 관심종목 (US·KR 모두 저장 가능) |
| `static/js/portfolio.js` | 공통 | 포트폴리오 손익 계산 |
| `static/js/earnings.js` | US | Earnings Calendar 탭 |
| `static/css/style.css` | 공통 | 다크 테마 전체 스타일 |
| `scripts/fetch_stocks.py` | US | S&P500 전체 데이터 수집 (수동 실행) |
| `scripts/fetch_kr_stocks.py` | **KR** | KOSPI·KOSDAQ 488개 수집, 업종·52W·PER 포함 (수동 실행) |
| `scripts/collect_pe_eps.py` | US | PE/EPS 캐시 수집 (수동 실행) |
| `scripts/screener_api.py` | US | FastAPI 고급 스크리너 (별도 서비스, pandas 필요) |
| `data/pe_eps_cache.json` | US | PE/EPS 캐시 (app.py 읽기 전용) |
| `data/kr_stocks.json` | **KR** | 국내주식 기본 데이터 (fetch_kr_stocks.py가 생성, app.py 읽기 전용) |

### KR 기능 수정 시 주요 파일

| 작업 | 수정 파일 |
|------|-----------|
| 국내주식 데이터 재수집 | `scripts/fetch_kr_stocks.py` 실행 |
| KR 가격 갱신 로직 | `data_fetcher.py` → `_fetch_kr_price_one()`, `fetch_kr_prices()` |
| KR 스크리너 필터/렌더 | `static/js/screener.js` 하단 (`// ══ 국내주식 ══` 이하) |
| KR 차트 정보 표시 | `static/js/chart.js` → `renderStockInfo()` 내 `isKr` 분기 |
| KR API 엔드포인트 | `app.py` → `/api/kr-stocks`, `refresh_kr_stocks()` |

## 파일 위치 규칙

새 파일을 만들거나 기존 파일을 수정할 때 반드시 아래 기준을 따른다.

### 폴더별 용도

| 위치 | 용도 | 기준 |
|------|------|------|
| `루트/` | 서버 런타임 핵심 | `app.py`가 `import`하는 파일만 (app.py, cache.py, data_fetcher.py, requirements.txt) |
| `templates/` | HTML 템플릿 | SPA 구조이므로 `index.html` 단일 파일 유지 |
| `static/js/` | 프론트엔드 JS | 탭 하나당 파일 하나 원칙 (main.js, screener.js, heatmap.js, chart.js, portfolio.js) |
| `static/css/` | 스타일 | `style.css` 단일 파일 유지 |
| `scripts/` | 독립 실행 도구 | 서버와 무관하게 수동으로 실행하는 스크립트. `app.py`에서 import 금지 |
| `data/` | 캐시/데이터 파일 | 서버가 읽는 JSON 등 정적 데이터. 직접 편집 금지, 스크립트로 생성 |
| `logs/` | 로그 | 자동 생성, gitignore 처리. 직접 수정 금지 |
| `api/` | API 키 | gitignore 처리. 절대 커밋 금지 |

### scripts/ 실행 방법

항상 **루트 디렉토리에서** 실행한다 (스크립트 내부 경로가 루트 기준으로 설정됨):

```bash
# ✅ 올바른 실행
cd finviz-app
python scripts/collect_pe_eps.py
python scripts/fetch_stocks.py

# ❌ 잘못된 실행
cd finviz-app/scripts
python collect_pe_eps.py
```

---

## CSS / JS 작성 규칙

### CSS 삽입 위치

새 탭이나 기능의 스타일을 추가할 때 반드시 **해당 탭의 CSS 블록 안**에 삽입한다. 파일 끝에 무작정 추가하지 않는다.

```
❌ 나쁜 예: style.css 맨 끝에 추가
✅ 좋은 예: 해당 탭의 CSS 블록 안에 삽입
```

`style.css` 섹션 순서 (이 순서를 유지한다):
```
변수&리셋 → 티커테이프 → 헤더 → 레이아웃
→ HOME → FEAR&GREED → 공통 → SCREENER
→ HEATMAP → CHART → NEWS → WATCHLIST → PORTFOLIO
```

새 섹션 구분자 형식: `/* ── 섹션명 ── */`

### JS 파일 선택 기준

기능이 특정 탭에 종속되면 그 탭의 JS 파일에 추가한다. 여러 탭에서 공유하는 유틸리티는 `main.js`에 추가한다.

---

## Python 파일 규칙

| 파일 | 수정 시 주의사항 |
|------|-----------------|
| `data_fetcher.py` | 섹션 헤더 `# ── 이름 ──` 형식 유지. 모듈 분리 금지 (Python 3.15 alpha 제약) |
| `app.py` | 라우트 추가 시 관련 라우트 그룹 근처에 삽입. 파일 끝에 무작정 추가 금지 |
| `scripts/*.py` | `app.py`에서 `import` 금지. 독립 실행 전용 |

---

## 환경 제약사항

- **Python 3.15.0a7** 알파 버전: `numpy`, `pandas` 바이너리 휠 미지원
- `yfinance` 사용 불가 → `requests`로 Yahoo Finance API 직접 호출
- `screener_api.py`는 pandas 의존성으로 현재 환경에서 실행 불가

## 의존성 패키지 (설치 가능)

```
flask
feedparser>=6.0.11
vaderSentiment>=3.3.2
APScheduler>=3.10.4
requests
```

## API 갱신 주기

| 데이터 | TTL | 갱신 방식 |
|--------|-----|-----------|
| 주가 (stocks) | 5분 | APScheduler 백그라운드 |
| 지수 (indices) | 5분 | APScheduler 백그라운드 |
| 뉴스 (news) | 10분 | APScheduler 백그라운드 |
| 차트 (chart) | 1시간 | 요청 시 lazy 갱신 |
