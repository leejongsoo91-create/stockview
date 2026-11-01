---
name: parallel-work
description: StockView에서 여러 작업을 wmux 창 여러 개로 동시에 진행하는 절차 — 작업마다 git worktree(별도 폴더+브랜치)와 별도 서버 포트를 배정하고, 끝나면 main에 합치고 정리. 사용자가 "동시에", "병렬로", "창 여러 개로", "따로 진행" 등을 요청할 때 사용.
---

# 병렬 작업 (wmux + git worktree)

같은 폴더에서 Claude 여러 개가 파일을 동시에 고치면 서로 덮어쓴다. 작업마다 **폴더·브랜치·포트를 따로** 준다.

## 0. 시작 전

- 각 작업도 CLAUDE.md 규칙대로 **작업계획서 → 사용자 확인**을 먼저 거친다. 병렬로 할 작업 목록과 배정표(아래)를 계획서에 넣는다.
- 서로 **같은 파일의 같은 부분**을 고치는 작업은 병렬로 돌리지 않는다(나중에 합칠 때 충돌). 특히 `main.js`·`style.css`·`app.py`는 겹치기 쉬우니 배정 전에 변경 예정 범위를 비교한다.
- `main` 작업 트리가 깨끗한지 `git status`로 확인(캐시 json 변경은 무관).

## 1. 작업별 배정표

| 작업 | 브랜치 | 폴더 | 서버 포트 |
|------|--------|------|----------|
| 작업 A | `wt/<짧은이름>` | `../finviz-app-wt/<짧은이름>` | 5002 |
| 작업 B | `wt/<짧은이름>` | `../finviz-app-wt/<짧은이름>` | 5003 |

- 5001은 사용자가 평소 쓰는 메인 서버용으로 비워둔다.
- 폴더는 프로젝트 **바깥**(형제 폴더)에 만든다 — 프로젝트 안에 두면 grep/검색에 중복으로 걸린다.

## 2. worktree 만들기 (루트에서)

```bash
git worktree add ../finviz-app-wt/<이름> -b wt/<이름>
# git에 없는 파일은 복사해야 동작함
cp -r api ../finviz-app-wt/<이름>/              # API 키 (커밋 금지 폴더)
cp data/kr_per_cache.json ../finviz-app-wt/<이름>/data/ 2>/dev/null   # 없으면 서버가 자동 재수집
```

## 3. wmux에서 창 띄우기

- **기본 방법: `wmux-layout` 스킬의 "병렬" 프리셋** — worktree를 만든 뒤 한 줄로 worktree마다 Claude 창 + 서버 창(포트 5002부터 자동 배정)이 뜬다:
  `powershell -NoProfile -ExecutionPolicy Bypass -File .claude\skills\wmux-layout\apply-layout.ps1 -Preset parallel -Worktrees <이름1>,<이름2>`
  작업이 끝나면 5단계 정리 전에 `-Preset parallel -Close`로 창을 닫는다(진행 중인 Claude가 있으면 사용자에게 먼저 확인)
- 수동으로 할 때 — wmux 단축키: `Ctrl+D` 오른쪽 분할 / `Ctrl+Shift+D` 아래 분할 / `Ctrl+N` 새 워크스페이스 / `Ctrl+I` 알림
- 각 창에서 해당 worktree 폴더로 이동해 `claude` 실행 → 작업 지시
- 서버 확인이 필요하면 그 창에서 포트를 바꿔 실행:
  PowerShell `$env:PORT=5002; python app.py` / bash `PORT=5002 python app.py`
- 검증은 `stockview-verify` 스킬을 쓰되 URL의 포트를 배정 포트로 바꾼다
- wmux MCP(`wmux`)가 연결돼 있으면 창 분할·다른 창 터미널 확인·창 간 메시지를 도구로 할 수 있다. wmux 자체 "Multi Task" 기능(프롬프트 하나를 최대 8개 worktree로 쪼갬)도 있으나, 이 프로젝트는 작업계획서 승인 절차 때문에 위 수동 절차를 기본으로 한다.

## 4. 합치기 (사용자가 커밋·병합을 요청한 뒤)

```bash
# worktree 안에서: 작업 커밋 (CLAUDE.md 결과보고서 작성 후)
git -C ../finviz-app-wt/<이름> add <파일들> && git -C ../finviz-app-wt/<이름> commit
# 루트(main)에서: 하나씩 병합, 충돌 나면 멈추고 사용자에게 보고
git merge --no-ff wt/<이름>
```

- `data_fetcher.py`는 git index가 CRLF — 스크립트로 파일을 다시 쓸 때 줄바꿈을 CRLF로 유지한다(LF로 쓰면 전체 diff가 생김).
- 병합 후 main에서 `stockview-verify`로 한 번 더 확인.

## 5. 정리

```bash
git worktree remove ../finviz-app-wt/<이름>   # 커밋 안 된 변경이 있으면 거부됨 → 사용자에게 확인
git branch -d wt/<이름>
git worktree list                              # 남은 것 확인
```

해당 포트로 띄운 서버도 종료한다.
