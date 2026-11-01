# ROADMAP — StockView 앞으로 할 일

> 갱신: 2026-11-02 · 작업을 시작하면 "진행 중"으로, 끝나면 이 표에서 지우고 [CHANGELOG.md](CHANGELOG.md) 맨 위에 한 줄 추가한다.
> worktree 병렬 작업 중에는 이 파일을 고치지 않는다 — main에 합칠 때만 수정(충돌 방지).

## 🔨 진행 중
| 항목 | 시작일 | 메모 |
|------|--------|------|
| (없음) | | |

## ⏭️ 다음 (우선순위 높음)
| 항목 | 설명 |
|------|------|
| `scripts/fetch_kr_stocks.py` 새 네이버 API로 교체 | 종목목록·PER 소스(`sise_market_sum.naver`) 폐기로 스크립트가 동작 안 함. 신규 상장·업종 재분류 불가. `m.stock.naver.com/api/stocks/marketValue/{KOSPI\|KOSDAQ}` 등으로 교체 (업종 페이지 `sise_group`도 확인) |
| ⚠️ 옛 API 키 교체(rotate) — **사용자 작업** | AlphaVantage·Finnhub 키가 과거 커밋 이력에 평문으로 남아 있고 **저장소가 공개(public)** 상태. 09-07에 코드에서는 `api/` 파일로 분리했지만 이력은 그대로 → 각 콘솔에서 새 키 발급 후 `api/alphavantage.txt`, `api/finnhub.txt` 교체 |
| 과거 미검증 화면 일괄 확인 | 08-18~09-15 작업 다수가 "브라우저 시각 확인 미완료"(당시 도구 없음). 이제 Playwright MCP가 있으니 `stockview-verify`로 Brief 음성 재생, 재무제표, 차트 더미 배너 등 일괄 확인 |

## 💡 후보 (미착수, 언제든 시작 가능)
| 항목 | 출처 | 설명 |
|------|------|------|
| 관심종목 신규 신호 브라우저 알림 | 09-15 감사 | — |
| News 탭 "관심종목만" 필터 | 09-15 감사 | — |
| Brief 스캐너 3종 관심종목 필터 | 09-15 감사 | — |
| KR 종합진단에 실적 임박 항목 | 07-23 아이디어 7번 | KR 실적 캘린더 데이터 소스 필요 |
| 07-18 감사 "보통/어려움" 21건 | 07-18 감사 | 목록 원문 미보존 — 필요 시 재감사 |

## ⏸️ 보류 (조건 충족 시 재개)
| 항목 | 재개 조건 | 설명 |
|------|-----------|------|
| 국내주식 이전 분기 실적 조회 (공시 탭) | **DART Open API 키** 발급 | 이 주제가 나오면 "DART API 키 있으신가요?"부터 확인 |
| FinBERT 감성 분석 | **Hugging Face 토큰** 발급 | 로컬 torch 불가 → HF 호스팅 Inference API로 연결하기로 결정(08-25) |
| 해외주식(US) 수급 대안 | 사용자 요청 | Brief 탭 별도 섹션으로 관리하기로 결정 → [decisions/002](decisions/002-us-investor-flow.md) |
| 비정상종목 판별 정규식 JS/Python 이중 유지 | 공용 API화 리팩터링 결정 | 09-15 보류 |
| KR 함수 네이밍 불일치 (`_calc52wPosKr` vs `_getKrFiltered`) | — | 일괄 리네임 대신 신규 함수부터 통일 |
| `_renderSignalCard` (chart.js, 200줄+) 비대 함수 분리 | 그 부분을 고칠 때 | 관찰만 |

## ✅ 결정 완료 — 재작업 불필요
| 항목 | 결정 |
|------|------|
| Reddit RSS 429 근본 해결 | 5초 지연 현행 유지 |
| Russell 2000 정확한 구성종목 | iShares SPA 개편으로 스크래핑 불가 → 시총 근사 유지 |
| US 매도 신호 개선 | 구조적 한계로 포기. score≥3만 쓰면 70% → [decisions/003](decisions/003-signal-backtest.md) |
| 외부(핸드폰) 접속 · 클라우드 배포 | 로컬 전용 유지 → [decisions/001](decisions/001-local-only-access.md) |
| TTS 엔진 | CLOVA Voice 폐기, Google Cloud TTS 확정 → [decisions/004](decisions/004-voice-briefing-stack.md) |
