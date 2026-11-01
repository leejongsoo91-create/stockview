---
paths:
  - "static/css/**"
---

# CSS 작성 규칙 (style.css)

- `style.css` 단일 파일 유지. 새 스타일은 **해당 탭의 섹션 블록 안**에 넣는다 — 파일 끝에 무작정 추가 금지
- 섹션 순서 (실제 파일 순서, 이 순서를 유지):
  ```
  변수&리셋 → 티커테이프 → 헤더 → 레이아웃 → HOME → FEAR&GREED → 공통 → SCREENER
  → HEATMAP → CHART → NEWS → WATCHLIST → PORTFOLIO → EARNINGS → BRIEF
  ```
  (EARNINGS·BRIEF는 탭 순서상 NEWS 다음이 맞지만 실제로 파일 끝에 있음 — 재배치는 리스크 대비 실익이 낮아 보류)
- 새 섹션 구분자: `/* ── 섹션명 ── */`
- **색상은 테마 변수만** 사용: `var(--green)`, `var(--red)`, `var(--accent)`, `var(--muted)`, `var(--bg-card)`, `var(--text)` 등. 다크 hex(`#3fb950`, `#f85149`, `#58a6ff`) 직접 사용 금지 — 라이트 테마가 깨짐 (08-18·08-20에 36곳 수정한 전례)
- 없는 변수(`--card`, `--fg` 등)를 쓰지 않는다. 새 변수가 필요하면 변수&리셋 섹션의 다크·라이트 양쪽에 정의
- 예외: Lightweight Charts 캔버스 설정 색은 JS 안에서 항상 다크 의도로 하드코딩 (CSS 변수 적용 불가)
- 여러 탭이 같이 쓰는 클래스(예: `.fg-score-big`)를 옮기기 전에 `grep`으로 사용처를 모두 확인
- 모바일: 가로로 늘어나는 줄(flex 헤더·툴바)에는 `flex-wrap`과 media query를 함께 고려
