#!/usr/bin/env bash
# herdr 실행 시 자동 시작 (11-22) — WSL이 다시 켜진 뒤 herdr 창의 셸이 처음 열릴 때 부팅당 한 번만:
#   ① 5001이 꺼져 있으면 stockview 공간의 "🖥 서버 :5001" 창에서 서버 실행 (창이 없으면 새로 나눔)
#   ② 홈서버 공간의 📊 집서버감시·📜 집서버 로그 창이 멈춰 있으면 다시 실행 (공간이 없으면 만듦)
# ~/.bashrc에서 herdr 안일 때만 백그라운드로 부른다:
#   [ -n "$HERDR_PANE_ID" ] && (bash /root/stockview/scripts/herdr_autostart.sh >/dev/null 2>&1 &)
# 같은 부팅에서 다시 하려면: bash scripts/herdr_autostart.sh --force   기록: logs/herdr_autostart.log
cd "$(dirname "$0")/.." || exit 1
DIR="$PWD"
mkdir -p logs
LOG="$DIR/logs/herdr_autostart.log"
STAMP="/tmp/sv-autostart.$(cut -c1-8 /proc/sys/kernel/random/boot_id)"
exec 9>"/tmp/sv-autostart.lock"
flock -n 9 || exit 0                        # 여러 창이 동시에 열려도 한 번만
[ "$1" = "--force" ] && rm -f "$STAMP"
[ -e "$STAMP" ] && exit 0
command -v herdr >/dev/null || exit 0
log() { echo "$(date '+%m-%d %H:%M:%S') $*" >>"$LOG"; }
sleep 3                                     # herdr 서버가 창을 다 복원할 시간

ws_json() { herdr workspace list 2>/dev/null; }
ws_id() {  # $1=공간 이름 → workspace_id
  ws_json | python3 -c "import json,sys;print(next((w['workspace_id'] for w in json.load(sys.stdin)['result']['workspaces'] if w.get('label')==sys.argv[1]),''))" "$1" 2>/dev/null
}
pane_by_label() {  # $1=공간 id $2=창 이름 → "pane_id<TAB>terminal_title"
  herdr pane list --workspace "$1" 2>/dev/null | python3 -c "
import json,sys
for p in json.load(sys.stdin)['result']['panes']:
    if p.get('label')==sys.argv[1]: print(p['pane_id']+'\t'+p.get('terminal_title','')); break" "$2" 2>/dev/null
}
idle() { case "$1" in *@*:*|'') return 0 ;; *) return 1 ;; esac; }   # 제목이 "root@PC: ~/…"면 셸만 떠 있는 상태

SERVER_CMD="bash scripts/pane.sh 🖥 서버 :5001 -- env PORT=5001 .venv/bin/python app.py"

# ① 5001 서버
if curl -s -m 3 -o /dev/null http://127.0.0.1:5001/; then
  log "5001 이미 실행 중 — 건너뜀"
else
  WS="$(ws_id stockview)"
  P=""; T=""
  if [ -n "$WS" ]; then
    IFS=$'\t' read -r P T <<<"$(pane_by_label "$WS" "🖥 서버 :5001")"
    if [ -z "$P" ]; then   # 창이 없으면 공간 마지막 창을 아래로 나눠 만든다
      LAST="$(herdr pane list --workspace "$WS" | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['panes'][-1]['pane_id'])" 2>/dev/null)"
      [ -n "$LAST" ] && P="$(herdr pane split --pane "$LAST" --direction down --cwd "$DIR" --no-focus | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['pane']['pane_id'])" 2>/dev/null)"
      [ -n "$P" ] && herdr pane rename "$P" "🖥 서버 :5001" >/dev/null 2>&1
    fi
  fi
  if [ -n "$P" ]; then
    herdr pane run "$P" "$SERVER_CMD" >/dev/null && log "5001 서버 실행 → 창 $P"
  else   # stockview 공간이 없으면 창 없이 백그라운드로
    PORT=5001 nohup .venv/bin/python app.py >>logs/server-5001.log 2>&1 &
    log "5001 서버 실행 → 백그라운드(stockview 공간 없음, 로그 logs/server-5001.log)"
  fi
fi

# ② 홈서버 공간 (집서버감시·로그)
WS="$(ws_id 홈서버)"
if [ -z "$WS" ]; then
  bash scripts/herdr_home.sh >/dev/null 2>&1 && log "홈서버 공간 새로 만듦"
else
  for spec in "📊 집서버감시|bash scripts/server_watch.sh home 60" "📜 집서버 로그|bash scripts/home_logs.sh"; do
    name="${spec%%|*}"; cmd="${spec#*|}"
    IFS=$'\t' read -r P T <<<"$(pane_by_label "$WS" "$name")"
    if [ -n "$P" ] && idle "$T"; then herdr pane run "$P" "$cmd" >/dev/null && log "$name 다시 실행 → 창 $P"
    elif [ -n "$P" ]; then log "$name 이미 실행 중"; fi
  done
fi
touch "$STAMP"
