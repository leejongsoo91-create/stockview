# 004. AI 음성 브리핑 기술 선정 — Claude API 대본 + Google Cloud TTS

- 상태: **확정** (2026-08-25~26)
- 관련 커밋: 00629a9 (Phase 4-117), 0e2340c (오디오 선삭제 버그)

## 결정
| 구성 | 선택 | 대안과 탈락 이유 |
|------|------|------------------|
| 대본 생성 | **Claude API** 단발 `messages.create` (tool use 불필요) | 템플릿 치환 → "되묻기·추가 해석" 같은 대화 깊이가 안 나옴 |
| 음성 합성 | **Google Cloud TTS** `ko-KR-Chirp3-HD` (호스트 Kore=수아 / 애널리스트 Charon=재윤) | CLOVA Voice: 사용량과 무관한 **월 고정 기본료** → **폐기**. Polly: 무료 12개월 한정. Azure·ElevenLabs: 비교 후 탈락 |
| 호출 방식 | `google-auth` + `requests`로 REST 직접 호출 | `google-cloud-texttospeech`는 grpc 의존성 → Python 3.15 alpha 설치 불가 |

**CLOVA Voice 이야기가 다시 나오면 이미 Google TTS로 바뀐 것을 상기시킬 것.**

## 대본 포맷
오프닝 → 시장개요 → 해외뉴스 3 → 국내뉴스 3 → 클로징, 2인 대화체. 헤드라인당 3~5턴, **전체 30턴 이내**. 헤드라인 고유명사·숫자 반드시 반영, 없는 정보는 지어내지 않고 "명시 안 됨"으로 처리. RSS summary를 함께 넣어 구체성 확보.

## 비용 보호 장치 (중요)
- `data/voice_briefing.json` 매니페스트: **오늘 생성분이 있으면 재사용** → 서버를 재시작해도 재과금 없음
- 오디오는 합성이 모두 성공한 뒤에만 이전 파일 정리 (TTS 실패 시 기존 오디오 유지)
- 키 파일: `api/anthropic-key.txt`, `api/google-tts-key.json` (`api/`는 gitignore — **절대 커밋 금지**)

## 운영 참고
- 24시간 배치, 서버 시작 270초 후 실행
- 30턴 합성 약 21초 (ThreadPoolExecutor 6 병렬)
- `max_tokens`는 thinking 포함이라 넉넉히(16000) 잡아야 JSON이 잘리지 않음
