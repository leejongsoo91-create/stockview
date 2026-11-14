#!/usr/bin/env bash
# StockView 서버 감시 — 일정 간격으로 주요 API를 점검해 한 줄씩 출력 (읽기 전용, 로컬 무료 API만 호출)
# 사용: bash scripts/server_watch.sh [포트=5001] [간격초=30]
#   예) bash scripts/server_watch.sh          → 5001번을 30초마다
#       bash scripts/server_watch.sh 5002 10  → 병렬 작업 서버 5002번을 10초마다
# 끝내기: Ctrl+C

PORT="${1:-5001}"
INTERVAL="${2:-30}"
BASE="http://127.0.0.1:${PORT}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PY="${DIR}/.venv/bin/python"
[ -x "$PY" ] || PY="python3"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; echo; echo "감시 종료"; exit 0' INT TERM

RED=$'\e[31m'; GRN=$'\e[32m'; YEL=$'\e[33m'; DIM=$'\e[2m'; RST=$'\e[0m'

# 엔드포인트 | 표시 이름 | 개수 확인 방식(len=배열 길이, -=확인 안 함)
CHECKS=(
  "/|홈|-"
  "/api/indices|지수|len"
  "/api/stocks|미국|len"
  "/api/kr-stocks|국내|len"
  "/api/news|뉴스|len"
  "/api/cache/status|캐시|stale"
)

count_json() {  # $1=파일 $2=방식 → 숫자 또는 "stale:키,키"
  "$PY" - "$1" "$2" <<'PYEOF' 2>/dev/null || echo "?"
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
if sys.argv[2] == "len":
    print(len(d) if isinstance(d, (list, dict)) else "?")
else:  # stale: fresh가 false인 캐시 키
    bad = [k for k, v in d.items() if isinstance(v, dict) and v.get("fresh") is False]
    print("만료:" + ",".join(bad) if bad else "OK")
PYEOF
}

echo "StockView 서버 감시 — ${BASE} · ${INTERVAL}초 간격 · Ctrl+C로 종료"
echo "${DIM}✅ 정상  ⚠️ 응답은 있으나 비어 있음/캐시 만료  ❌ 실패${RST}"
fails=0
while true; do
  now="$(date +%H:%M:%S)"
  line=""; status="ok"
  for c in "${CHECKS[@]}"; do
    IFS='|' read -r path name mode <<<"$c"
    out="$TMP/r.json"
    res="$(curl -s -m 15 -o "$out" -w '%{http_code} %{time_total}' "${BASE}${path}")"
    code="${res%% *}"; t="${res##* }"
    if [ "$code" = "000" ]; then
      status="down"; break
    elif [ "$code" != "200" ]; then
      status="fail"; line+=" ${RED}${name} ${code}${RST} ·"
      continue
    fi
    case "$mode" in
      -)     line+=" ${name} $(printf '%.2f' "$t")s ·" ;;
      len)   n="$(count_json "$out" len)"
             if [ "$n" = "0" ] || [ "$n" = "?" ]; then
               [ "$status" = ok ] && status="warn"; line+=" ${YEL}${name} ${n}${RST} ·"
             else
               line+=" ${name} $(printf "%'d" "$n" 2>/dev/null || echo "$n") ·"
             fi ;;
      stale) s="$(count_json "$out" stale)"
             if [ "$s" = "OK" ]; then line+=" ${name} OK ·"
             else [ "$status" = ok ] && status="warn"; line+=" ${YEL}${name} ${s}${RST} ·"; fi ;;
    esac
  done
  case "$status" in
    down) fails=$((fails+1)); echo "${now} ${RED}❌ 서버 꺼짐 (응답 없음, 연속 ${fails}회)${RST}" ;;
    fail) fails=$((fails+1)); echo "${now} ${RED}❌${RST}${line% ·}" ;;
    warn) fails=0; echo "${now} ${YEL}⚠️${RST}${line% ·}" ;;
    *)    fails=0; echo "${now} ${GRN}✅${RST}${line% ·}" ;;
  esac
  sleep "$INTERVAL"
done
