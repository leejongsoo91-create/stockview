# CLAUDE.md — StockView 프로젝트 작업 규칙

<!-- 관리 메모 (Claude에게는 전달되지 않음):
     - 2026-11-02 구조 개편: 상세 규칙은 .claude/rules/(경로별 자동 로드), 양식·절차는 .claude/skills/, 기록은 docs/ 로 분리.
     - 이 파일은 150줄 이하 유지. 특정 파일에만 해당하는 규칙은 rules/에, 가끔 쓰는 절차는 skills/에 넣는다.
     - 개편 전 원본: git show fac219f:CLAUDE.md -->

## ⚡ 스킬 발동 트리거 (최우선 규칙)

아래 상황이 되면 **해당 스킬을 먼저 실행**한 뒤 진행한다.

| 이런 상황이면 | 이 스킬을 먼저 쓴다 | 하는 일 |
|---|---|---|
| 사용자가 **"불러오기"** 입력 (또는 현황·작업 리스트 요청) | `load-status` | CHANGELOG 앞 30줄 + ROADMAP으로 현황 보고서 출력. 다른 작업보다 우선 |
| 기능 추가·버그 수정·리팩토링 **착수** | `work-report` (A. 계획서) | 작업계획서 작성 → 사용자 확인 후 진행 |
| 작업 **완료**, 커밋 직전 | `work-report` (B. 보고서) | 검증 → CHANGELOG·ROADMAP 기록 → 결과보고서 → 커밋 → 푸시 확인 |
| 화면이 바뀌는 작업을 마침 / "확인해봐" | `stockview-verify` | 서버·API 점검 + Playwright 화면 캡처 |
| "동시에", "병렬로", "창 여러 개로" | `parallel-work` | worktree·브랜치·포트 분리 |
| "레이아웃", "창 배치", "화면확인 모드" | `wmux-layout` | wmux 프리셋 적용·전환 |

작업을 시작할 때는 `docs/ROADMAP.md`의 **"진행 중"** 칸만 확인한다 (전체 이력은 읽지 않는다).

---

## 필수 규칙

1. **작업 전 계획서, 작업 후 보고서** — 모든 작업(기능·버그·리팩토링)은 `work-report` 양식으로 계획서를 보여주고 사용자 확인 후 진행, 끝나면 결과보고서를 쓴다.
2. **직접 확인한 것만 보고** — 테스트 결과는 실제로 확인한 항목만 체크한다. 화면 변경은 `stockview-verify`로 캡처까지 한 뒤 보고한다.
3. **진행 과정은 한글로** 보여준다. 결과보고서에는 초보자용 설명을 넣는다.
4. **GitHub 푸시는 확인 후에만** — 결과보고서 끝에 푸시 대기 커밋을 보여주고 승인받는다. 자동 푸시 금지 (공개 저장소, Render 배포 연결 가능성).
5. **무료 도구만** — 검증·병렬 도구는 무료(wmux, Playwright MCP)만 쓴다. 유료 서비스·유료 API 호출(음성 브리핑 재생성 등)은 먼저 묻는다.
6. **기록은 docs/에** — 완료는 `docs/CHANGELOG.md` 맨 위 한 줄, 할 일은 `docs/ROADMAP.md`. 메모리에는 짧은 사실·선호만 남긴다.
7. **wmux 프리셋 공간**을 닫거나 다시 만들기 전에는 진행 중인 Claude·서버가 있는지 확인하고 사용자에게 묻는다.

---

## 프로젝트 개요

| 항목 | 내용 |
|------|------|
| 프로젝트 | StockView — Finviz 스타일 미국·국내 주식 분석 웹앱 (개인용, 로컬 전용) |
| 실행 | `python app.py` → http://127.0.0.1:5001 (터미널 창을 띄워두는 방식) |
| 스택 | Flask + flask-socketio + APScheduler / Vanilla JS + D3.js + Lightweight Charts |
| 환경 | **Python 3.15.0a7 알파** — numpy·pandas·yfinance 사용 불가, `requests`로 직접 호출 |
| 규모 | 9탭 (Home·Screener·Heatmap·Chart·News·Brief·Watchlist·Portfolio·Earnings), US 5,000 · KR 약 3,940종목 |
| 저장소 | GitHub **공개(public)** — 키·개인정보를 코드·문서에 쓰지 않는다 |

## 문서 지도 — 필요할 때만 읽는다

| 알고 싶은 것 | 문서 |
|-------------|------|
| 앞으로 할 일 | `docs/ROADMAP.md` |
| 완료 이력 (최신순) | `docs/CHANGELOG.md` |
| 구조·데이터 흐름·API·스케줄러·개발 함정 | `docs/architecture.md` |
| 과거 결정과 이유 (외부접속, 해외수급, 신호 백테스트, 음성 브리핑) | `docs/decisions/` |
| 옛 PLAN.md 원본 / 06~11월 상세 경위 | `docs/specs/plan-legacy.md`, `docs/specs/work-history-detail.md` |

## 파일 위치 규칙

| 위치 | 용도 | 기준 |
|------|------|------|
| 루트 | 서버 런타임 핵심 | `app.py`가 import하는 파일만 (`app.py`, `cache.py`, `data_fetcher.py`, `requirements.txt`) |
| `templates/` | HTML | `index.html` 단일 파일 (SPA). **수정하면 서버 재시작 필요** (Jinja 캐시) |
| `static/js/` | 프론트엔드 | 탭 하나당 파일 하나. 여러 탭 공용 유틸은 `main.js` |
| `static/css/` | 스타일 | `style.css` 단일 파일 |
| `scripts/` | 수동 실행 도구 | `app.py`에서 import 금지, 루트에서 실행 |
| `data/` | 캐시·데이터 | 직접 편집 금지 (스크립트·서버가 생성) |
| `docs/` | 문서 | 계획·이력·구조·결정 |
| `logs/`, `api/` | 로그 / API 키 | gitignore. **`api/`는 절대 커밋 금지** |

새 파일이 위 기준에 안 맞으면 만들기 전에 사용자에게 묻는다.

## 공통 코딩 규칙

- 파일별 세부 규칙은 해당 파일을 열 때 자동 로드된다: CSS → `.claude/rules/css.md`, Python·data → `python.md`, 국내주식 → `kr.md`
- 새 기능은 **기존 데이터·API·패턴 재사용**을 먼저 검토한다 (새 외부 API는 최후 수단)
- 신호 로직은 JS(`chart.js`)와 Python(`data_fetcher.py`) **이중 구현** — 한쪽만 고치지 않는다
- localStorage 키·포맷(`WL`, `PT`, `WLG`, `WLN`, `NB` 등)은 기존 사용자 데이터 호환을 유지한다
- 서버 host는 `127.0.0.1` 유지 — `0.0.0.0`은 `RENDER` 환경변수일 때만 (`docs/decisions/001-local-only-access.md`)
- 병렬 작업 서버는 5002번부터. 5001은 사용자 메인 서버용
