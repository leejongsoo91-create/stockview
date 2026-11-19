#!/usr/bin/env bash
# 집 서버(Proxmox CT stockview) StockView 로그 실시간 보기 — wmux "집서버" 작업 공간용 (11-20)
# SSH 주소(예: root@192.168.x.x)는 공개 저장소에 쓰지 않도록 git 제외 파일 api/home-server-ssh.txt에 한 줄로 둔다 (결정 006).
# 사용 (루트에서): bash scripts/home_logs.sh          # stockview 서비스 로그
#                 bash scripts/home_logs.sh grep 시장  # 특정 글자가 든 줄만
# 끊기면 10초 뒤 다시 붙는다. Ctrl+C로 종료.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
F="$DIR/api/home-server-ssh.txt"
if [ ! -s "$F" ]; then echo "SSH 주소 파일이 없습니다: api/home-server-ssh.txt (예: root@192.168.0.10)"; exec bash; fi
HOST="$(head -n1 "$F" | tr -d '[:space:]')"
FILTER=""
[ "$1" = "grep" ] && [ -n "$2" ] && FILTER="$2"
printf '\033]0;%s\007' "📜 집서버 로그"
trap 'exit 0' INT TERM
while true; do
  echo "── $(date +%H:%M:%S) 집 서버 로그 연결 (journalctl -u stockview -f) ──"
  if [ -n "$FILTER" ]; then
    ssh -o ConnectTimeout=8 -o ServerAliveInterval=30 "$HOST" "journalctl -u stockview -f -n 30 --no-pager | grep --line-buffered -- '$FILTER'"
  else
    ssh -o ConnectTimeout=8 -o ServerAliveInterval=30 "$HOST" "journalctl -u stockview -f -n 30 --no-pager | grep --line-buffered -v -E 'GET /|socket.io|Running job|executed successfully|indices_update'"
  fi
  echo "── 연결 끊김 — 10초 뒤 다시 연결 (Ctrl+C 종료) ──"; sleep 10 & wait $!
done
