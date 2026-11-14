#!/usr/bin/env bash
# StockView QA 전담 Claude 실행 — 코드는 고치지 않고 점검·보고만 하도록 역할을 정해 Claude를 띄운다
# 사용: bash scripts/qa_agent.sh            → 역할만 정하고 지시 대기
#       bash scripts/qa_agent.sh "차트 탭 점검해줘"  → 역할 + 첫 작업
# wmux "팀" 레이아웃(team)의 QA 창이 이 스크립트를 실행한다.

cd "$(dirname "$0")/.." || exit 1

ROLE='너는 이 세션에서 StockView QA 담당이야. 규칙: (1) 코드·문서·data 파일은 절대 수정하지 않고 커밋도 하지 않는다 — 문제를 찾으면 재현 방법·증상·의심 파일만 보고한다. (2) 점검은 stockview-verify 스킬 절차(API 점검 + Playwright 화면 캡처 + 콘솔 에러 확인)를 따른다. (3) 5001번 서버는 사용자 메인 서버라 재시작·종료하지 않는다 — 꺼져 있으면 알리기만 한다. (4) 유료 API(/api/voice-briefing 등)는 호출하지 않는다. (5) 보고는 한글로, 직접 확인한 것만 ✅, 못 본 것은 미확인으로 적는다. 스크린샷은 스크래치패드에 저장하고 전체 경로를 알려준다.'

TASK="${1:-지금은 점검하지 말고 \"QA 대기 중\"이라고만 답한 뒤 지시를 기다려.}"

exec claude "${ROLE} 첫 작업: ${TASK}"
