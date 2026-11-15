#!/usr/bin/env bash
# wmux 창 이름 붙여 실행 — 창 제목(탭 이름)을 고정한 뒤 명령을 실행한다
# 사용: bash scripts/pane.sh <창 이름...> -- <명령...>
#   예) bash scripts/pane.sh 🧠 메인 -- claude
#       bash scripts/pane.sh 🖥 서버 :5001 -- env PORT=5001 .venv/bin/python app.py
# (wsl.exe를 거치면 따옴표가 사라지므로, 띄어쓰기 있는 이름도 따옴표 없이 쓰고 -- 로 명령과 구분한다)
# claude를 실행할 때는 Claude Code가 제목을 대화 주제로 바꾸지 않도록 자동 제목을 끈다.

cd "$(dirname "$0")/.." || exit 1
TITLE=""
while [ $# -gt 0 ] && [ "$1" != "--" ]; do TITLE="${TITLE:+$TITLE }$1"; shift; done
[ "$1" = "--" ] && shift
[ -n "$TITLE" ] && [ $# -gt 0 ] || { echo "사용: bash scripts/pane.sh <창 이름> -- <명령>"; exit 1; }

printf '\e]0;%s\a' "$TITLE"
export CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1
export STOCKVIEW_PANE="$TITLE"   # 창 역할 — CLAUDE.md 팀 창 자동 펼치기는 이 값이 메인이 아닐 때 건너뛴다
echo "── ${TITLE} ──"
exec "$@"
