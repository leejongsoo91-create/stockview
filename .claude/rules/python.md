---
paths:
  - "**/*.py"
  - "data/**"
  - "requirements.txt"
---

# Python · 데이터 파일 규칙

## 파일별
| 파일 | 규칙 |
|------|------|
| `data_fetcher.py` | 섹션 헤더 `# ── 이름 ──` 형식 유지, **모듈 분리 금지**. 줄바꿈이 **CRLF** — 스크립트로 다시 쓸 때 CRLF 유지 (LF로 쓰면 파일 전체 diff) |
| `app.py` | 라우트는 관련 라우트 그룹 근처에 삽입 (파일 끝 금지). 스케줄러 작업은 `_scheduler.add_job` 블록에. `socketio.run`의 host는 `127.0.0.1` 유지 — `0.0.0.0`은 `RENDER` 환경변수일 때만 |
| `scripts/*.py` | 독립 실행 전용, **`app.py`에서 import 금지**. 항상 **루트에서** 실행: `python scripts/collect_pe_eps.py` (scripts 폴더 안에서 실행 금지) |

## 실행 환경 (WSL Ubuntu `.venv`, Python 3.12.3)
- 서버·스크립트는 `/root/stockview/.venv/bin/python`으로 실행. 패키지 설치도 `.venv/bin/python -m pip install ...` (Windows `pip`·`py -3.15`에 설치해도 서버에 반영 안 됨)
- numpy·pandas·yfinance는 미설치 → 예전 3.15 알파 시절 구조 그대로 `requests`로 Yahoo 직접 호출. 새 의존성 추가는 먼저 사용자에게 묻는다
- `.venv`에 requirements.txt 전부 설치·import 확인됨(`anthropic` 2.4.0 포함, 2026-11-04)
- `scripts/screener_api.py`(pandas 필요)는 `.venv`에 pandas가 없어 현재 실행 불가

## 신호 로직 이중 구현
`data_fetcher.py` `compute_today_signal()` ↔ `static/js/chart.js` `_calcSignals()`/`_applySignalMarkers()`는 같은 로직이다. **한쪽을 고치면 다른 쪽도 고친다** (07-17 `|score|>=2` 게이트 누락 사고 → docs/decisions/003).

## 외부 요청
- Yahoo: 병렬 과다 시 429 → 동시성 보수적으로(5 workers + 지연), 실패율 50%↑ 결과는 짧게 캐시
- 네이버: 페이지마다 인코딩 다름 → `Content-Type` 확인 후 디코딩. 옛 HTML 페이지 대신 `m.stock.naver.com/api/...` JSON 우선
- SEC EDGAR: User-Agent에 이메일 형식 필수
- API 키는 `_load_api_key("파일명")`으로 `api/`에서 읽는다. 코드·문서에 키 평문 금지 (저장소 공개 상태)

## data/ 폴더
- 직접 편집 금지 — 스크립트 또는 서버가 생성
- `pe_eps_cache.json`(추적됨)은 **기능 커밋에 섞지 않는다**. 필요할 때만 별도 `chore: PE/EPS 캐시 갱신` 커밋
- `kr_per_cache.json`, `signal_history.json`, `voice_briefing.json`, `audio/`는 런타임 상태 → gitignore
- 음성 브리핑 재생성은 **유료**(Claude API + TTS). 테스트 시 `data/voice_briefing.json` 재사용 로직을 우회하지 않는다
