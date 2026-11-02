# 005. Aside AI 브라우저 — 무료 플랜 보조 도구로 연결

- 상태: **확정** (2026-11-03)
- 이전 판단 정정: 11-01 작업환경 구축 때 "유료 크레딧"이라 제외했으나, 실제로는 Free 플랜($0, 월 500 크레딧)이 있음

## 결정
| 항목 | 선택 |
|------|------|
| 플랜 | **Free** — 결제 카드 미등록 (처리방침에 크레딧 자동 충전 기능이 있어 카드 등록 시 과금 경로가 생김) |
| AI 모델 | Aside 기본 무료 모델만. **API 키·Claude/ChatGPT 구독 연결 안 함** (API 키 = 별도 과금, 구독 = Claude Code 한도 공유) |
| 개인정보 | Analytics·동기화 끔. 작업 중 스크린샷·페이지 내용이 모델 제공자로 전송되므로 **포트폴리오·워치리스트 화면은 Aside로 보지 않음** |
| 역할 분담 | **화면 검증(`stockview-verify`)은 Playwright MCP가 기본.** Aside는 사용자가 요청할 때만 (외부 사이트 조사·로그인 필요한 사이트 등) |
| 연결 방식 | 앱의 "코딩 도구 자동 설정" 기능은 쓰지 않고 `claude mcp add -s user aside -- <경로>\aside.exe mcp`로 직접 등록 |

## Windows CLI 설치 (문서에 없음)
- 공식 `install.sh`는 macOS·Linux 전용. Windows용은 `https://releases.aside.com/cli/AsideCLI-win-x64-latest.zip` (aside.exe 1개, AT YOUR SIDE INC 서명 확인)
- 설치 위치: `%USERPROFILE%\.aside\cli\aside.exe`. 업데이트는 `aside update`
- CLI는 브라우저 앱의 로그인 계정을 그대로 사용 (별도 `aside login` 불필요했음)

## MCP 도구
| 도구 | 내용 | 크레딧 |
|------|------|--------|
| `exec` | AI 에이전트가 브라우저 조작 | 사용 |
| `repl` | Playwright 스타일 JS 직접 실행 (120초 제한) | 모델 미사용 |
| `browser_profiles` | 프로필 목록 | — |

## 시험 결과 (11-03)
- `repl`: example.com 제목 읽기 성공 (0.6초)
- `exec` 1회: 모델 `gpt-6.1-sol`(provider `aside`), 4회 호출 약 5만 토큰, 세션 기록상 비용 $0. 실제 크레딧 차감량은 앱 Settings > Plan & Usage에서 확인
