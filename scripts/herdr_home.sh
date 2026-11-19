#!/usr/bin/env bash
# herdr에 "홈서버" 공간 만들기 (11-20) — 📊 집서버감시(60초 API 점검) | 📜 집서버 로그(SSH journalctl)
# 이미 "홈서버" 공간이 있으면 그 공간으로 전환만 한다. WSL 재시작 등으로 사라졌을 때 다시 실행.
# 사용 (herdr 창 안, 루트에서): bash scripts/herdr_home.sh
set -e
cd "$(dirname "$0")/.."
command -v herdr >/dev/null || { echo "herdr가 없습니다"; exit 1; }
LABEL="홈서버"
ws_id() { herdr workspace list | python3 -c "import json,sys;print(next((w['workspace_id'] for w in json.load(sys.stdin)['result']['workspaces'] if w['label']==sys.argv[1]),''))" "$LABEL"; }
WS="$(ws_id)"
if [ -n "$WS" ]; then herdr workspace focus "$WS" >/dev/null; echo "이미 있음 → $LABEL($WS)로 전환"; exit 0; fi
P1="$(herdr workspace create --cwd "$PWD" --label "$LABEL" --no-focus | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['root_pane']['pane_id'])")"
P2="$(herdr pane split --pane "$P1" --direction right --cwd "$PWD" --no-focus | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['pane']['pane_id'])")"
herdr pane run "$P1" "bash scripts/server_watch.sh home 60" >/dev/null
herdr pane run "$P2" "bash scripts/home_logs.sh" >/dev/null
herdr pane rename "$P1" "📊 집서버감시" >/dev/null 2>&1 || true
herdr pane rename "$P2" "📜 집서버 로그" >/dev/null 2>&1 || true
echo "만듦: $LABEL — $P1 집서버감시 · $P2 집서버 로그"
