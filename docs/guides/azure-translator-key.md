# 뉴스 제목 번역 키 준비하기 (11-22)

터미널에서 다시 보기: `.venv/bin/python scripts/news_translate_status.py --guide`

번역은 ① **Microsoft Translator 무료판(F0)**이 주로 하고, ② **Google Cloud Translation**은 ①이 안 될 때만 씁니다.
둘 다 준비하지 않아도 앱은 그대로 동작하고, 영어 제목이 원문으로 보일 뿐입니다.

---

## 1. Microsoft Translator 무료판 키 받기 (약 15분)

### 1-1. Azure 계정 만들기 (이미 있으면 건너뛰기)
1. 브라우저에서 **https://azure.microsoft.com/ko-kr/free/** 를 엽니다.
2. **[무료로 시작]** 을 누르고 Microsoft 계정(Outlook·Hotmail 등)으로 로그인합니다.
3. 이름·전화번호 인증 → **카드 정보 입력**을 합니다. 본인 확인용이며, 이 단계에서 요금은 나가지 않습니다.
   - 무료 체험(첫 30일 크레딧)이 끝난 뒤 "종량제로 업그레이드"를 하라는 안내가 오면 업그레이드해도 됩니다.
     **F0(무료) 등급은 업그레이드 뒤에도 0원**이고, 한도를 넘으면 요금 대신 번역이 거절됩니다.
     업그레이드하지 않으면 체험이 끝날 때 리소스가 멈출 수 있습니다(그때는 앱이 원문을 보여 줍니다).

### 1-2. Translator 리소스 만들기
1. **https://portal.azure.com** 에 로그인합니다.
2. 맨 위 검색창에 **`Translator`** 를 입력 → "서비스" 아래 **Translators(번역기)** 를 누릅니다.
3. **[+ 만들기]** 를 누르고 아래처럼 채웁니다.

   | 칸 | 넣을 값 |
   |---|---|
   | 구독 | 방금 만든 구독 (예: "Azure subscription 1") |
   | 리소스 그룹 | **[새로 만들기]** → `stockview` |
   | 지역(Region) | **Korea Central** |
   | 이름 | 아무 이름 (전 세계에서 겹치면 안 됨, 예: `stockview-tr-0922`) |
   | **가격 책정 계층** | ⚠️ **Free F0** (월 200만 자 무료) — S1 등 다른 것을 고르지 않습니다 |

4. **[검토 + 만들기]** → **[만들기]**. 1분쯤 뒤 "배포가 완료되었습니다" → **[리소스로 이동]**.

### 1-3. 키와 지역 복사하기
1. 리소스 화면 왼쪽 메뉴 **리소스 관리 → 키 및 엔드포인트(Keys and Endpoint)** 를 엽니다.
2. 두 가지를 복사합니다.
   - **KEY 1** (32자 정도의 영문·숫자)
   - **위치/지역(Location/Region)** — 예: `koreacentral`

### 1-4. 키 파일 저장하기 (WSL 터미널)
```bash
cd /root/stockview
nano api/azure-translator.txt
```
아래처럼 **두 줄**을 붙여 넣고 `Ctrl+O` → `Enter` → `Ctrl+X` 로 저장합니다.
```
여기에_KEY_1_붙여넣기
koreacentral
```
```bash
chmod 600 api/azure-translator.txt
```
- `api/` 폴더는 git에 올라가지 않습니다. 키를 채팅·문서·코드에 붙여 넣지 마세요.
- **서버를 다시 켤 필요는 없습니다.** 다음 뉴스 갱신(10분 안)에 번역을 시작합니다.

### 1-5. 확인
```bash
.venv/bin/python scripts/news_translate_status.py
```
① Microsoft 상태가 `✅ 사용 가능`이고 이번 달 사용량이 늘어나면 성공입니다.
`HTTP 401`이면 키 복사가 잘못된 것, `HTTP 403`·지역 관련 오류면 둘째 줄 지역을 확인하세요.

---

## 2. Google Cloud Translation 켜기 (예비, 약 5분)

음성 브리핑에 쓰던 Google Cloud 프로젝트(키 파일 `api/google-tts-key.json`)에서 번역 기능만 켭니다.

1. **https://console.cloud.google.com** → 위쪽 프로젝트 선택에서 음성 브리핑에 쓰던 프로젝트를 고릅니다.
2. 검색창에 **`Cloud Translation API`** → **[사용(Enable)]**.
3. **하루 한도 걸기 (요금 방지 1겹):** API 및 서비스 → Cloud Translation API → **할당량(Quotas)** →
   `Characters per day` (또는 "v2 and v3 general model characters per day") 항목 → **수정** → **15000** 입력 → 저장.
4. **예산 알림 걸기 (요금 방지 2겹):** 결제(Billing) → **예산 및 알림** → **[예산 만들기]** → 금액 **1,000원**,
   알림 50%·90%·100% → 저장. 요금이 생기면 메일이 옵니다.
5. 확인: 위 1-5와 같은 명령에서 ② Google Cloud 상태를 봅니다. (①이 잘 되고 있으면 ②는 쓰이지 않는 게 정상)

서버도 서비스별로 이번 달 글자 수를 세서 **Microsoft 190만 자 · Google 45만 자**에 닿으면 다음 달까지 그 서비스를 쓰지 않습니다.

---

## 3. 집 서버에도 넣기 (코드 반영 뒤)
작업 PC에서:
```bash
scp api/azure-translator.txt $(cat api/home-server-ssh.txt):/home/stockview/stockview/api/
ssh $(cat api/home-server-ssh.txt) 'cd /home/stockview/stockview/api && chown stockview:stockview azure-translator.txt && chmod 600 azure-translator.txt'
.venv/bin/python scripts/news_translate_status.py home
```
(앱 위치 `/home/stockview/stockview`, 실행 사용자 `stockview` — `docs/decisions/006-home-server-tailscale.md`. 서버 재시작은 필요 없음)
