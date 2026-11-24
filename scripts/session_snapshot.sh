#!/usr/bin/env bash
# 세션 상태 스냅숏 (11-24) — Claude 대화가 리셋(자동 요약·/clear)돼도 진행 상황을 놓치지 않게.
#   PreCompact 훅:   bash scripts/session_snapshot.sh --save    → logs/session-snapshot.md 에만 저장
#   SessionStart 훅: bash scripts/session_snapshot.sh --inject  → 저장 + 같은 내용을 출력(새 대화에 자동으로 들어감)
# 내용: 푸시 안 한 커밋·커밋 안 한 변경·작업 PC 5001·집 서버 코드 버전·ROADMAP 진행 중 + 인수인계 노트(logs/session-handoff.md,
# wrap-up 스킬이 씀). 읽기만 하고 아무것도 바꾸지 않는다. 결과는 git 제외 폴더 logs/ (서버 주소 등이 들어갈 수 있음).
cd "$(dirname "$0")/.." || exit 0
mkdir -p logs
OUT=logs/session-snapshot.md
HANDOFF=logs/session-handoff.md
MODE="${1:---save}"

{
  echo "## 🔁 리셋 직후 자동 상태 ($(TZ=Asia/Seoul date '+%m-%d %H:%M') KST · scripts/session_snapshot.sh)"
  git fetch -q origin 2>/dev/null
  ahead="$(git log origin/main..HEAD --oneline 2>/dev/null)"
  if [ -n "$ahead" ]; then
    echo "- ⚠️ **푸시 안 한 커밋 $(echo "$ahead" | wc -l)개** — 사용자가 이미 푸시를 승인했는지 대화 요약·인수인계 노트에서 확인하고, 아니면 결과보고서 끝에서 다시 묻는다:"
    echo "$ahead" | sed 's/^/  - /'
  else
    echo "- 푸시 안 한 커밋: 없음"
  fi
  dirty="$(git status --short 2>/dev/null | grep -v -E '^\?\? (\.agents/|AGENTS\.md)$' | grep -v ' data/pe_eps_cache.json$')"
  if [ -n "$dirty" ]; then
    echo "- ⚠️ 커밋 안 한 변경 (pe_eps_cache·AGENTS 제외):"; echo "$dirty" | head -20 | sed 's/^/  - /'
  else
    echo "- 커밋 안 한 변경: 없음 (data/pe_eps_cache.json 은 따로 관리)"
  fi
  code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:5001/)"
  echo "- 작업 PC 5001: $([ "$code" = 200 ] && echo '켜짐' || echo "꺼짐 (응답 $code) — herdr 자동 실행 또는 scripts/herdr_autostart.sh --force")"
  # 집 서버 코드 버전 — 내부망 주소가 안 되면 Tailscale 이름으로 (주소는 git 제외 api/ 파일에서만 읽음)
  main="$(git rev-parse --short origin/main 2>/dev/null)"
  home=""
  for tgt in "$(head -n1 api/home-server-ssh.txt 2>/dev/null)" \
             "root@$(head -n1 api/home-server-url.txt 2>/dev/null | sed -E 's#https?://##; s#/.*##')"; do
    [ -z "$tgt" ] || [ "$tgt" = "root@" ] && continue
    home="$(ssh -o BatchMode=yes -o ConnectTimeout=4 "$tgt" \
            'sudo -u stockview git -C /home/stockview/stockview rev-parse --short HEAD' 2>/dev/null)" && [ -n "$home" ] && break
  done
  if [ -z "$home" ]; then echo "- 집 서버 코드: 확인 못 함 (SSH 연결 안 됨)"
  elif [ "$home" = "$main" ]; then echo "- 집 서버 코드: $home = GitHub main (반영됨)"
  else echo "- ⚠️ 집 서버 코드: $home ≠ GitHub main $main — 반영 안 됨 (docs/decisions/006 반영 명령)"; fi
  prog="$(awk '/^## 🔨 진행 중/{f=1;next} /^## /{f=0} f && /^\| / && !/^\| 항목/ && !/^\|---/' docs/ROADMAP.md 2>/dev/null)"
  echo "- ROADMAP 진행 중: $([ -n "$prog" ] && echo && echo "$prog" | sed 's/^/  /' || echo '없음')"
  echo "- 최근 커밋:"; git log --oneline -5 | sed 's/^/  - /'
  if [ -f "$HANDOFF" ]; then
    age=$(( ($(date +%s) - $(stat -c %Y "$HANDOFF")) / 3600 ))
    echo; echo "### 📝 인수인계 노트 (logs/session-handoff.md · ${age}시간 전 작성)"
    head -n 80 "$HANDOFF"
  else
    echo "- 인수인계 노트 없음 (사용자가 \"정리하고 리셋\"이라고 하면 wrap-up 스킬이 작성)"
  fi
} > "$OUT" 2>/dev/null

[ "$MODE" = "--inject" ] && cat "$OUT"
exit 0
