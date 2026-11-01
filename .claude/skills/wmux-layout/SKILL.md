---
name: wmux-layout
description: StockView wmux 창 배치 프리셋 적용·전환·수정 — "기본/화면확인/집중/병렬" 같은 이름으로 창 구성(Claude·서버·git·내장 브라우저)을 한 번에 띄우거나 바꾼다. 사용자가 "레이아웃", "창 배치", "창 바꿔줘", "화면확인 모드", "창 추가/빼줘", "프리셋 저장" 등을 말할 때 사용.
---

# wmux 레이아웃 프리셋

- 프리셋 정의: `.claude/wmux-layouts.json` (사용자가 직접 고쳐도 됨)
- 적용 스크립트: `.claude/skills/wmux-layout/apply-layout.ps1` (wmux CLI `%LOCALAPPDATA%\wmux\bin\wmux.cmd` 사용 — wmux 밖에서 실행해도 동작)
- **프리셋 1개 = wmux 작업 공간(상단 탭) 1개**, 이름 `SV-<프리셋키>`. 처음엔 만들고, 이후엔 **전환만** 한다(실행 중인 Claude·서버 유지).
- 사용자 원래 작업 공간(`finviz-app` 등 `SV-`로 시작하지 않는 것)은 건드리지 않는다.

## 명령 (프로젝트 루트에서, PowerShell 도구)

```powershell
$f = ".claude\skills\wmux-layout\apply-layout.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File $f -List                      # 프리셋 목록 + 열림 여부
powershell -NoProfile -ExecutionPolicy Bypass -File $f -Preset verify -DryRun     # 무엇을 만들지 미리보기
powershell -NoProfile -ExecutionPolicy Bypass -File $f -Preset verify             # 만들기 또는 전환
powershell -NoProfile -ExecutionPolicy Bypass -File $f -Preset verify -Rebuild    # 닫고 다시 만들기 ⚠️
powershell -NoProfile -ExecutionPolicy Bypass -File $f -Preset verify -Close      # 닫기 ⚠️
powershell -NoProfile -ExecutionPolicy Bypass -File $f -Preset parallel -Worktrees chart-fix,news-filter
```

- `-Preset`은 키(basic/verify/focus/parallel) 또는 한글 title(기본/화면확인/집중/병렬) 둘 다 받는다.
- ⚠️ `-Rebuild`·`-Close`는 그 공간의 창을 **강제 종료**한다(그 안의 Claude 대화·서버도 끝남). 실행 전 `wmux.cmd list-panes --json`(해당 공간 focus 후) 또는 wmux MCP `pane_list`로 `agentStatus`가 working인 Claude나 서버가 있는지 보고, 있으면 **사용자에게 먼저 묻는다.**
- 서버 창은 `port`가 이미 사용 중이면 실행을 건너뛴다(중복 실행 방지) — 결과 표 `note`에 "port busy" 표시. 서버가 다른 공간에 떠 있으면 정상.
- `cwd` 폴더가 없으면(예: worktree 미생성) 그 창은 아무것도 실행하지 않고 안내 문구만 띄운다.

## 사용자 말 → 행동

| 사용자 말 | 행동 |
|-----------|------|
| "화면확인 모드로", "기본 레이아웃" | `-Preset <이름>` (있으면 전환만) |
| "레이아웃 뭐 있어?" | `-List` 결과를 표로 |
| "보조 Claude 창 빼줘" (프리셋 자체 변경) | `wmux-layouts.json` 수정 → 바뀐 내용 보여주고 "다시 만들까요?" 확인 후 `-Rebuild` |
| "지금 화면에 로그 창 하나 추가" (즉석) | 아래 "즉석 변경" |
| "이 구성 프리셋으로 저장" | 현재 공간 `list-panes --json`의 창 수·cwd·실행 프로그램을 보고 JSON에 새 프리셋 추가(키는 영문, title은 한글) |
| "창 잠깐 숨겨줘 / 다시 보여줘" | wmux MCP `pane_stash` (`restore:true`로 복원) — 프로세스는 계속 실행됨 |

## 즉석 변경 (프리셋 파일 안 바꿈)

```powershell
$W = "$env:LOCALAPPDATA\wmux\bin\wmux.cmd"
& $W focus-workspace <ws-id>; & $W focus-pane <pane-id>; & $W split --direction right   # 또는 down
& $W list-panes --json        # active:true 인 게 새 창, surfacePtyIds[0] = ptyId
& $W send "Set-Location -LiteralPath '<프로젝트>'; <명령>" --submit --to <ptyId>
& $W read-screen --tail 20 --to <ptyId>
```
- 창 닫기: wmux MCP `pane_close`(paneId). 브라우저 창은 `wmux.cmd close-surface <surfaceId>` 후 남은 빈 창을 `pane_close`.

## JSON 항목 형식

- `columns`: 왼쪽부터 세로 줄 배열, 줄 안은 위에서부터 창
- 창: `name`(창 이름, 터미널 제목으로 설정) · `cmd`(시작 명령) · `cwd`(프로젝트 기준 상대경로) · `port`(서버 포트, PORT 환경변수로도 전달) · `browser`(옆에 내장 브라우저로 열 주소, 127.0.0.1이면 서버 뜰 때까지 최대 90초 대기)
- `perWorktree` + `portBase`: `columns` 대신. `-Worktrees`의 이름마다 줄 하나, `{wt}`·`{port}` 치환

## 알려진 제약 (2026-11-01 wmux 4.13.0 확인)

- **창 크기 비율 지정 불가** — 균등 분할. 3줄 이상이면 `split right` 반복이라 50/25/25가 된다 → 사용자에게 마우스로 경계 드래그 안내
- **wmux 탭/창 이름표(라벨)는 wmux 밖에서 설정 불가** (MCP `pane_metadata set`은 wmux 안 Claude만 가능). 그래서 창 구분은 터미널 제목 + 결과 표의 ptyId로 한다. wmux 안에서 실행 중인 Claude라면 `pane_metadata set label`로 라벨을 추가로 붙여도 된다
- 내장 브라우저는 wmux 창 **안에서** 실행한 `wmux open`만 허용 → 스크립트는 대상 창에 백그라운드 Job으로 `wmux open`을 보내는 방식으로 우회
- wmux 밖의 MCP 호출자는 `#w2-1` 같은 창 이름 지정이 막혀 있음 → CLI에 ptyId(`daemon-xxxx`)로 지정
- PowerShell 5.1에서 `ConvertFrom-Json` 배열은 한 덩어리로 반환됨 → 스크립트의 `WmJson`이 풀어서 씀. **스크립트 수정 시 이 처리 유지**(예전에 이걸 빠뜨려 엉뚱한 작업 공간이 닫힌 적 있음)
- 스크립트 파일은 **UTF-8 BOM**으로 저장해야 PowerShell 5.1에서 특수문자가 안 깨진다
