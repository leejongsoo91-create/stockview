# 006. 집 서버(Proxmox CT)에서 24시간 실행 + Tailscale 사설망 접속

- 상태: **확정** (2026-11-18) — [001](001-local-only-access.md)의 "외부 접속 안 함"을 대체 (`127.0.0.1` 바인딩 원칙은 그대로)

## 결정
- 실사용 서버는 **집 서버 PC(Proxmox VE 9.2)의 LXC 컨테이너** `stockview`에서 24시간 돌린다. 내 PC(WSL) 5001은 **개발·테스트용**으로만 켠다
- 접속은 **Tailscale 사설망**으로만: `https://stockview.<tailnet>.ts.net` (`tailscale serve`가 https → `127.0.0.1:5001` 중계). 같은 Tailscale 계정에 로그인한 내 기기만 접속 가능
- 앱 host는 `127.0.0.1` 그대로 — 집 와이파이의 다른 기기도 `서버IP:5001`로는 직접 못 들어온다. 공유기 포트포워딩·공개 배포는 하지 않는다

## 이유
| 고려 | 내용 |
|------|------|
| 로그인 기능 없음 | 08-24에 외부 접속을 되돌린 이유와 같음. 앱 대신 "누가 들어오나"를 Tailscale 계정이 막아 준다 |
| 08-18 방식과 차이 | 그때는 host를 Tailscale IP로 바꾸고 http로 접속 → 모바일 https 자동 승격 문제. 이번엔 `serve`가 정식 https 인증서를 붙이고 host는 안 바꿈 |
| 대안 비교 | 집 와이파이 전용(host 변경 필요, 밖에서 불가) · Cloudflare Tunnel+Access(도메인 필요) · 포트포워딩(인터넷 전체 공개 — 불가) |
| Ubuntu 24.04 | 기본 Python 3.12 = WSL `.venv`(3.12.3)와 같은 버전. 26.04는 Python이 달라 제외(사용자 결정) |
| LXC(CT) | VM보다 가볍고 백업·재생성이 쉬움. Tailscale용 `/dev/net/tun`은 Proxmox "Device Passthrough"로 추가 |

## 서버 구성 (11-18 설치)
| 항목 | 값 |
|------|-----|
| CT | Proxmox CT `stockview` — Ubuntu 24.04, 2 CPU · 2 GB · 20 GB, 부팅 시 자동 시작, 시간대 Asia/Seoul(코드 일부가 컴퓨터 시각을 KST로 가정) |
| 앱 위치·사용자 | `/home/stockview/stockview` (일반 사용자 `stockview`로 실행, root 아님), `.venv` Python 3.12.3 |
| 서비스 | systemd `stockview.service` — `PORT=5001`, `ExecStart=.venv/bin/python app.py`, `Restart=always`(5초 뒤 재시작), `enable`(부팅 시 시작) |
| 키·데이터 | `api/`(권한 600)·`data/signal_history.json`·`us_names_ko.json`·`kr_per_cache.json`·`kr_stocks_backup.json`은 11-18 내 PC에서 1회 복사. 이후 데이터는 서버가 직접 만든다 |
| 접속 | `tailscale serve --bg 5001` (tailnet 전용) |

## 운영 방법
- **코드 반영** (푸시 승인 후): 서버는 코드를 직접 고치지 않으므로 GitHub 기준으로 맞춘다. 서버가 갱신하는 추적 파일 `data/pe_eps_cache.json`이 있어 `pull` 대신 `reset`을 쓴다(캐시는 서버가 다시 만듦)
  ```bash
  ssh root@<서버IP> 'cd /home/stockview/stockview && sudo -u stockview git fetch -q && sudo -u stockview git reset -q --hard origin/main && systemctl restart stockview'
  ```
- 상태·로그: `systemctl status stockview`, `journalctl -u stockview -n 100`
- 끄기: `systemctl disable --now stockview` / 외부 연결만 끄기: `tailscale serve --https=443 off`
- 내 PC와 서버를 동시에 켜면 무료 API 키(Finnhub 등) 한도를 둘이 나눠 쓰게 됨 → 개발할 때만 WSL 5001

## 관리 방침 (11-18 사용자 결정)
- **CT와 Proxmox 본체를 구분해서 관리한다.** Claude는 평소 CT 안(SSH 키, 앱 상태·로그·재시작·코드 반영·업데이트)만 다룬다 — 일상 작업 대부분이 여기서 끝나고, 실수해도 피해가 CT 하나로 끝난다
- CT가 늘어나도 **CT마다 따로** 연결한다 (한 CT의 실수가 다른 CT에 번지지 않게)
- **본체는 지금 연결하지 않는다.** 스냅샷·새 CT·자원 조정이 필요해지면 그때 root SSH 대신 **권한을 좁힌 Proxmox API 토큰**(예: 상태 보기·스냅샷·백업·전원만, 대상 CT 한정)으로 연결한다 — CT 삭제·디스크 변경은 처음부터 불가능하게
- 백업은 본체 연결 없이 Proxmox 웹 화면의 **예약 백업**(Datacenter → Backup, 매일·Snapshot 모드·보관 7개 정도)으로 한다. 같은 디스크(`local`)에 저장하면 실수·잘못된 업데이트는 되돌릴 수 있지만 디스크 고장은 대비 못 함 → 외장 디스크·NAS가 생기면 옮긴다
- 되돌리기 어려운 작업(서비스 중지, 데이터 삭제, OS 업그레이드)은 CT 안이라도 먼저 사용자에게 묻는다

## 주의
- 관심종목·포트폴리오·차트 설정은 **브라우저 localStorage**라 서버로 옮겨지지 않는다(주소가 바뀌면 빈 상태, 휴대폰·PC 따로). 포트폴리오는 CSV 내보내기/가져오기로 이동 가능
- Proxmox 관리 화면(`:8006`)은 인터넷에 열지 않는다
