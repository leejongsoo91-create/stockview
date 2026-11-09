---
name: stockview-verify
description: StockView 작업 후 실제 동작 검증 — 서버 기동 확인, 핵심 API 점검, Playwright로 탭별 화면 캡처·콘솔 에러 확인. 기능 추가·버그 수정을 끝내고 결과보고서를 쓰기 전, 또는 사용자가 "확인해봐", "화면 봐줘", "검증해줘"라고 할 때 사용.
---

# StockView 검증 절차

결과보고서의 "테스트 결과"는 이 절차로 직접 확인한 것만 체크한다. 못 한 항목은 체크 해제로 남긴다.

## 1. 서버 상태

- `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5001/` → 200이면 실행 중
- 실행 중이 아니면 WSL `.venv`로 백그라운드 실행, 200 응답까지 2초 간격 대기:
  `wsl -d Ubuntu -u root -- bash -lc 'cd /root/stockview && .venv/bin/python app.py'`
  (Windows의 `python app.py`는 Windows Python 3.14로 떠서 실제 환경과 다르다 — 쓰지 않는다)
- **재시작 필요 여부**: `app.py`·`data_fetcher.py`·`cache.py`·`templates/index.html`(Jinja 캐시) 변경 → 재시작 필요.
  `static/js`·`static/css`만 변경 → 재시작 불필요, 브라우저 새로고침만
- 재시작: Windows 쪽에서 5001을 잡고 있는 건 `wslrelay.exe`(WSL 중계)라 그걸 끄면 안 된다. WSL 안에서 확인·종료 후 위 명령으로 재실행:
  확인 `wsl -d Ubuntu -u root -- ss -ltnp "sport = :5001"` / 종료 `wsl -d Ubuntu -u root -- fuser -k 5001/tcp`
  (5001은 사용자 메인 서버 — 종료 전 사용자에게 확인)

## 2. API 점검 (변경과 관련된 것 위주)

| 영역 | 엔드포인트 | 확인 포인트 |
|------|-----------|------------|
| 공통 | `/api/cache/status` | 캐시 키별 상태 |
| 홈 | `/api/indices`, `/api/stocks`, `/api/fear-greed` | 지수 19개, 종목 5,000개 내외 |
| KR | `/api/kr-stocks`, `/api/kr-investor/005930` | 4,318개(11-09 기준), PER/EPS 값, 수급 5일치 |
| 차트 | `/api/chart/AAPL`, `/api/stock-analysis/AAPL` | 첫 봉에 `_dummy` 없음(있으면 가짜 데이터) |
| 뉴스 | `/api/news` | `market` 필드 US/KR 분리 |
| Brief | `/api/daily-signals`, `/api/heatmap-perf?period=1w` | 서버 시작 후 240초 지나야 채워짐 |

- `/api/voice-briefing`은 Claude API·Google TTS **유료 호출**과 연결되므로 사용자가 요청할 때만 확인한다.
- 한글이 섞인 JSON을 Python으로 출력할 땐 `PYTHONIOENCODING=utf-8` 지정 (Windows 콘솔 cp949 깨짐 방지)

## 3. 화면 확인 (Playwright MCP)

`playwright` MCP 도구가 있으면:
1. `browser_navigate` → `http://127.0.0.1:5001`
2. 탭 전환: 상단 `button.nav-btn[data-view="<탭>"]` 클릭
   (home / screener / heatmap / chart / news / brief / earnings / watchlist / portfolio)
3. 데이터 로딩을 위해 3~6초 대기 후 `browser_take_screenshot`
4. `browser_console_messages`로 JS 에러 확인 — 에러가 있으면 보고서에 그대로 적는다
5. 변경한 UI 요소를 직접 클릭해 동작 확인 (예: 기간 버튼, 필터, 모달)

MCP 도구가 없으면 CLI 대체(스크린샷만 가능):
```bash
npx -y playwright@1.65.0-alpha-2026-10-30 screenshot --browser chromium \
  --viewport-size "1400,900" --wait-for-timeout 6000 http://127.0.0.1:5001 <스크래치패드>/home.png
```
찍은 PNG는 Read 도구로 열어 눈으로 확인한다.

## 4. 보고

- 결과보고서 "테스트 결과"에 API 실측값과 화면 확인 결과를 분리해서 적는다
- 장 마감·주말이면 1D 수치가 안 바뀌는 게 정상임을 명시
- 스크린샷은 스크래치패드에 두고, 경로는 전체 절대경로로 안내
