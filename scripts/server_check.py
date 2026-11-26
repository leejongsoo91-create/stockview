"""StockView 집 서버 자동 점검 (11-21) — 시간외·장 마감 데이터가 제대로 들어왔는지 정해진 시각에 확인한다.

감시 CT `monitor`의 systemd 타이머가 실행한다(작업 PC·Claude가 꺼져 있어도 동작). 읽기만 하고 서버는 건드리지 않는다.
결과는 JSON 한 줄씩 기록 파일에 쌓고, 문제(❌)일 때만 텔레그램으로 보낸다. 작업 PC에서 "불러오기" 때
`--report`로 지난번 이후 결과를 표로 본다.

점검 종류 (첫 인자):
  kr-pre    평일 08:25 KST   국내 넥스트레이드 프리 — 프리 표시가 시간외 체결 종목에만, 등락 = 전일 KRX 종가 대비
  kr-close  평일 16:40 KST   국내 장 마감 — 애프터 표시, KRX 전용 종목은 KRX 종가, 오늘 거래대금·투자자 순매수, 하락 종목 존재
  us-pre    평일 04:40 뉴욕  미국 프리 — 프리 표시, 등락 = 전일 종가 대비
  us-after  평일 16:40 뉴욕  미국 장 마감 — 애프터 표시, 등락 = 전일 종가 대비, 오늘 시장 거래 저장, 하락 종목 존재
휴장일(그날 체결이 없으면)은 ❌ 대신 "휴장"으로 기록한다.

사용:
  python3 scripts/server_check.py kr-close                 # 결과 출력 + 기록 (작업 PC에서 시험할 때)
  python3 scripts/server_check.py us-after --telegram      # 문제면 텔레그램 (monitor CT 타이머)
  python3 scripts/server_check.py --report                 # 작업 PC: 지난 --report 이후 결과 (monitor CT에서 SSH로 읽음)
  python3 scripts/server_check.py --report --all           # 최근 20개 전부

환경 변수 (monitor CT: /etc/sv-check/env, 권한 600 — 저장소에 쓰지 않는다):
  SV_BASE            StockView 주소 (없으면 api/home-server-url.txt)
  SV_CHECK_LOG       기록 파일 (기본 /var/lib/sv-check/results.jsonl, 쓸 수 없으면 logs/server_check.jsonl)
  TELEGRAM_BOT_TOKEN · TELEGRAM_CHAT_ID   --telegram일 때
작업 PC --report: SSH 주소는 git 제외 파일 api/monitor-ssh.txt (예: root@192.168.0.20)
"""
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
NAVER_RT = "https://polling.finance.naver.com/api/realtime"
KST, NY = ZoneInfo("Asia/Seoul"), ZoneInfo("America/New_York")
PCT_TOL = 0.06      # 등락률 비교 허용 오차(%p) — 반올림
PRICE_TOL = 0.02    # 서버 가격 vs 네이버 원본 허용 차이(2%) — 시간외는 서버가 2분마다 받아 몇 분 늦을 수 있음
MODES = {"kr-pre": "🇰🇷 국내 프리", "kr-close": "🇰🇷 국내 장 마감", "us-pre": "🇺🇸 미국 프리", "us-after": "🇺🇸 미국 장 마감"}


def get_json(url: str, timeout: int = 30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def num(v):
    try:
        return float(str(v).replace(",", "").replace("+", ""))
    except (TypeError, ValueError):
        return None


def base_url() -> str:
    u = os.environ.get("SV_BASE", "").strip()
    if not u:
        f = ROOT / "api" / "home-server-url.txt"
        u = f.read_text(encoding="utf-8").strip() if f.is_file() else ""
    if not u:
        sys.exit("StockView 주소가 없습니다: 환경 변수 SV_BASE 또는 api/home-server-url.txt")
    return u.rstrip("/")


def naver(path: str, codes: list[str]) -> dict:
    d = get_json(f"{NAVER_RT}/{path}/" + ",".join(codes))
    return {x.get("itemCode") or x.get("symbolCode"): x for x in d.get("datas") or []}


class Check:
    def __init__(self):
        self.items = []   # (이름, ok: True/False, 설명)

    def add(self, name, ok, detail):
        self.items.append({"name": name, "ok": bool(ok), "detail": detail})


def pct_ok(server_row, expected_base, ch: Check, label: str, nv_price=None):
    """서버 등락률이 '서버 가격 ÷ 기준가(전일 종가)'와 같은지 + 서버 가격이 네이버 원본과 크게 다르지 않은지."""
    p, sp = server_row.get("price"), server_row.get("change_pct")
    if not p or sp is None or not expected_base:
        ch.add(label, False, f"값 없음 (서버 {p}·{sp}%, 기준가 {expected_base})")
        return
    exp = (p / expected_base - 1) * 100
    good = abs(sp - exp) <= PCT_TOL
    msg = f"{p:,g} {sp:+.2f}% (전일 종가 {expected_base:,g} 대비 계산 {exp:+.2f}%)"
    if nv_price:
        far = abs(p / nv_price - 1) > PRICE_TOL
        msg += f" · 원본 {nv_price:,g}" + (" ⚠ 차이 큼" if far else "")
        good = good and not far
    ch.add(label, good, msg)


# ── 국내 ──────────────────────────────────────────────────────────────────────
def check_kr(mode: str, base: str) -> tuple[str, Check]:
    ch = Check()
    nv = naver("domestic/stock", ["005930", "000660", "069500"])
    sam = nv.get("005930") or {}
    today = datetime.now(KST).strftime("%Y-%m-%d")
    if mode == "kr-pre":
        if sam.get("marketStatus") != "PREOPEN":   # 거래일 아침엔 PREOPEN, 휴장일엔 CLOSE
            return "holiday", ch
    elif str(sam.get("localTradedAt") or "")[:10] != today:
        return "holiday", ch
    rows = {s.get("code"): s for s in get_json(f"{base}/api/kr-stocks")}
    ch.add("국내 종목 수", len(rows) >= 4000, f"{len(rows):,}개")
    sess = {}
    for s in rows.values():
        k = (s.get("session") or "", bool(s.get("session_open")))
        sess[k] = sess.get(k, 0) + 1
    want = "pre" if mode == "kr-pre" else "after"
    live = sess.get((want, True), 0)
    lo, hi = (100, 3500) if mode == "kr-pre" else (500, 3500)
    ch.add(f"{'프리' if want == 'pre' else '애프터'} 진행 중 표시", lo <= live <= hi,
           f"{live:,}종목 (정상 범위 {lo:,}~{hi:,}) · 표시 없음 {sess.get(('', False), 0):,}")
    etf = rows.get("069500") or {}
    ch.add("KRX 전용(KODEX 200) 표시 없음", not etf.get("session"), f"session='{etf.get('session') or ''}'")
    for code, name in (("005930", "삼성전자"), ("000660", "SK하이닉스")):
        x, r = nv.get(code) or {}, rows.get(code) or {}
        o = x.get("overMarketPriceInfo") or {}
        c, cc = num(x.get("closePrice")), num(x.get("compareToPreviousClosePrice"))
        if mode == "kr-pre":
            if o.get("tradingSessionType") != "PRE_MARKET" or not num(o.get("overPrice")):
                ch.add(f"{name} 프리", True, "프리 체결 없음 — 건너뜀")
                continue
            ch.add(f"{name} 프리 표시", r.get("session") == "pre", f"session='{r.get('session')}'")
            pct_ok(r, c, ch, f"{name} 등락 기준", num(o.get("overPrice")))   # 장 시작 전 정규 closePrice = 전일 종가
        else:
            if c is None or cc is None:
                ch.add(name, False, "네이버 원본 없음")
                continue
            ext = o.get("tradingSessionType") == "AFTER_MARKET" and num(o.get("overPrice"))
            pct_ok(r, c - cc, ch, f"{name} 등락 기준", num(o.get("overPrice")) if ext else c)
    if mode == "kr-close":
        x = nv.get("069500") or {}
        ok = etf.get("price") == num(x.get("closePrice"))
        ch.add("KODEX 200 = KRX 종가", ok, f"서버 {etf.get('price')} · 원본 {x.get('closePrice')}")
        neg = sum(1 for s in rows.values() if (s.get("change_pct") or 0) < 0)
        pos = sum(1 for s in rows.values() if (s.get("change_pct") or 0) > 0)
        ch.add("상승·하락 종목 모두 있음", neg >= 50 and pos >= 50, f"상승 {pos:,} · 하락 {neg:,}")
        # 11-24: 증권사 텔레그램 리서치 수집 — 평일 장 마감 무렵이면 오늘 글이 몇 건은 있어야 함(텔레그램 미리보기 구조 변경 감지)
        try:
            br = get_json(f"{base}/api/broker-research?days=1")
        except Exception:
            br = []
        n_br = len(br) if isinstance(br, list) else 0
        ch.add("증권사 리포트 오늘 수집", n_br >= 3, f"{n_br}건 (9개 채널)")
        try:
            feed = get_json(f"{base}/api/reports-feed?days=1")
        except Exception:
            feed = []
        n_nv = sum(1 for x in feed if x.get("src") == "naver") if isinstance(feed, list) else 0
        n_hk = sum(1 for x in feed if x.get("src") == "hk") if isinstance(feed, list) else 0
        ch.add("네이버 리서치·한경 오늘 수집", n_nv >= 10 and n_hk >= 5, f"네이버 {n_nv}건 · 한경 {n_hk}건")
        try:
            dl = get_json(f"{base}/api/dart-feed?days=1")
        except Exception:
            dl = []
        n_dart = len(dl) if isinstance(dl, list) else 0
        ch.add("DART 공시 오늘 수집", n_dart >= 5, f"분류된 공시 {n_dart}건")
        # 11-26: 🎯 조건검색 (집 서버만 검색) — 아침 준비 08:00 전, 장중 5분 검색 70회↑(09:01~15:26 = 78회), 오류 0
        try:
            cs = get_json(f"{base}/api/cond-search")
        except Exception:
            cs = {}
        ld, sc = cs.get("load") or {}, cs.get("scan") or {}
        fin = datetime.fromtimestamp(ld["finished"], KST) if ld.get("finished") else None
        ch.add("조건검색 아침 준비 08:00 전", bool(fin) and fin.strftime("%Y-%m-%d") == today and fin.hour < 8,
               f"{ld.get('state')} · 끝난 시각 {fin:%m-%d %H:%M}" if fin else f"{ld.get('state') or '응답 없음'}")
        ok_day = sc.get("day") == today
        ch.add("조건검색 장중 검색 70회 이상", ok_day and (sc.get("n") or 0) >= 70,
               f"장중 {sc.get('n') if ok_day else 0}회 · 시초가 {sc.get('n_gap') if ok_day else 0}회 · 예상체결 {sc.get('n_pre') if ok_day else 0}회 · 마지막 {sc.get('secs')}초")
        ch.add("조건검색 오류 없음", ok_day and not sc.get("errors"),
               f"오류 {sc.get('errors') if ok_day else '-'}건" + (f" · {sc.get('last_error')}" if sc.get("last_error") else ""))
        for m in ("KOSPI", "KOSDAQ"):
            f = get_json(f"{base}/api/market-flow?market={m}&days=5")
            last = (f.get("rows") or [{}])[-1]
            ch.add(f"{m} 오늘 거래대금", last.get("date") == today and (last.get("amount") or 0) > 1e11,
                   f"{last.get('date')} {(last.get('amount') or 0) / 1e12:.2f}조원 (출처 {f.get('source')})")
            iv = get_json(f"{base}/api/market-investors?market={m}&days=5")
            n = iv.get("now") or {}
            lr = (iv.get("rows") or [{}])[-1]
            ch.add(f"{m} 오늘 투자자 순매수", lr.get("date") == today,
                   f"{lr.get('date')} 개인 {lr.get('individual', 0) / 1e8:+,.0f} · 외국인 {lr.get('foreign', 0) / 1e8:+,.0f} · "
                   f"기관 {lr.get('institution', 0) / 1e8:+,.0f}억 (장중 값 {n.get('time') or '-'})")
    return "ok", ch


# ── 미국 ──────────────────────────────────────────────────────────────────────
def check_us(mode: str, base: str) -> tuple[str, Check]:
    ch = Check()
    tick = {"AAPL.O": "AAPL", "NVDA.O": "NVDA", "TSLA.O": "TSLA"}
    nv = {}
    for x in get_json(f"{NAVER_RT}/worldstock/stock/" + ",".join(tick)).get("datas") or []:
        nv[tick.get(x.get("reutersCode"))] = x
    today = datetime.now(NY).strftime("%Y-%m-%d")
    a = nv.get("AAPL") or {}
    o = a.get("overMarketPriceInfo") or {}
    if mode == "us-pre":
        if o.get("tradingSessionType") != "PRE_MARKET" or str(o.get("localTradedAt") or "")[:10] != today:
            return "holiday", ch
    elif str(a.get("localTradedAt") or "")[:10] != today:
        return "holiday", ch
    rows = {s.get("ticker"): s for s in get_json(f"{base}/api/stocks")}
    ch.add("미국 종목 수", len(rows) >= 4000, f"{len(rows):,}개")
    if mode == "us-pre":   # 어제(직전 거래일) 애프터 기록(20:05)이 남았는지
        fr = [r for r in get_json(f"{base}/api/market-flow?market=US&days=5").get("rows") or [] if r.get("date", "") < today]
        y = fr[-1] if fr else {}
        ok = y.get("after_amount") is not None or y.get("mixed")
        ch.add("직전 거래일 애프터 기록(20:05)", ok,
               f"{y.get('date')} " + ("구분 전 기록" if y.get("mixed") else
                                      f"애프터 ${(y.get('after_amount') or 0) / 1e9:,.2f}B" if ok else "기록 없음"))
    want = "pre" if mode == "us-pre" else "after"
    live = sum(1 for s in rows.values() if s.get("session") == want and s.get("session_open"))
    ch.add(f"{'프리' if want == 'pre' else '애프터'} 진행 중 표시", live >= 300, f"{live:,}종목 (300 이상이면 정상)")
    for t in ("AAPL", "NVDA", "TSLA"):
        x, r = nv.get(t) or {}, rows.get(t) or {}
        oo = x.get("overMarketPriceInfo") or {}
        c, cc = num(x.get("closePrice")), num(x.get("compareToPreviousClosePrice"))
        if oo.get("tradingSessionType") != ("PRE_MARKET" if want == "pre" else "AFTER_MARKET") or not num(oo.get("overPrice")):
            ch.add(t, True, "시간외 체결 없음 — 건너뜀")
            continue
        ch.add(f"{t} {want} 표시", r.get("session") == want, f"session='{r.get('session')}'")
        base_px = c if want == "pre" else (c - cc if c is not None and cc is not None else None)
        pct_ok(r, base_px, ch, f"{t} 등락 기준", num(oo.get("overPrice")))
    if mode == "us-after":
        neg = sum(1 for s in rows.values() if (s.get("change_pct") or 0) < 0)
        pos = sum(1 for s in rows.values() if (s.get("change_pct") or 0) > 0)
        ch.add("상승·하락 종목 모두 있음", neg >= 100 and pos >= 100, f"상승 {pos:,} · 하락 {neg:,}")
        f = get_json(f"{base}/api/market-flow?market=US&days=5")
        last = (f.get("rows") or [{}])[-1]
        try:   # 11-25: FINRA 일별 공매도 쌓기 — 최근 4일 안 기록이 있어야
            fs = (get_json(f"{base}/api/flow-stock/AAPL") or {}).get("short_daily") or {}
        except Exception:
            fs = {}
        ch.add("FINRA 일별 공매도 기록", bool(fs.get("day")) and fs["day"] >= (datetime.now() - timedelta(days=5)).strftime("%Y-%m-%d"),
               f"최근 {fs.get('day')} · 쌓인 {fs.get('n')}일")
        ch.add("오늘 미국 정규장 거래 기록(16:01)", last.get("date") == today and (last.get("amount") or 0) > 1e10,
               f"{last.get('date')} 정규장 ${(last.get('amount') or 0) / 1e9:,.1f}B · {(last.get('volume') or 0) / 1e9:.2f}B주")
        # 11-23: 네이버 누적값엔 프리마켓이 없어 09:29 기록을 없앰 → 대신 정규장 값이 말이 되는지(음수·0 아님) 확인
        if last.get("date") == today:
            ch.add("미국 정규장 거래 값 정상(0보다 큼)", (last.get("volume") or 0) > 0 and (last.get("amount") or 0) > 0,
                   f"거래량 {(last.get('volume') or 0) / 1e9:.2f}B주")
    return "ok", ch


# ── 기록·알림·보고 ─────────────────────────────────────────────────────────────
def log_path() -> Path:
    p = Path(os.environ.get("SV_CHECK_LOG") or "/var/lib/sv-check/results.jsonl")
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a", encoding="utf-8"):
            pass
        return p
    except OSError:
        q = ROOT / "logs" / "server_check.jsonl"
        q.parent.mkdir(exist_ok=True)
        return q


def telegram(text: str) -> bool:
    tok, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not tok or not chat:
        print("텔레그램 설정 없음 — 전송 생략", file=sys.stderr)
        return False
    data = urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()
    try:
        with urllib.request.urlopen(f"https://api.telegram.org/bot{tok}/sendMessage", data, timeout=15) as r:
            return json.loads(r.read()).get("ok", False)
    except Exception as e:
        print(f"텔레그램 전송 실패: {e}", file=sys.stderr)
        return False


def run(mode: str, send: bool) -> int:
    now = datetime.now(KST)
    try:
        status, ch = (check_kr if mode.startswith("kr") else check_us)(mode, base_url())
        if status == "ok" and not all(i["ok"] for i in ch.items):
            status = "fail"
    except Exception as e:   # 서버 응답 없음·네이버 실패 등
        status, ch = "error", Check()
        ch.add("점검 실행", False, f"{type(e).__name__}: {e}"[:300])
    bad = [i for i in ch.items if not i["ok"]]
    summary = {"ok": "모두 정상", "holiday": "휴장 (그날 체결 없음)"}.get(
        status, " / ".join(f"{i['name']}: {i['detail']}" for i in bad)[:400])
    rec = {"ts": now.isoformat(timespec="seconds"), "mode": mode, "status": status, "summary": summary, "items": ch.items}
    with open(log_path(), "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    icon = {"ok": "✅", "holiday": "💤", "fail": "❌", "error": "❌"}[status]
    lines = [f"{icon} [StockView 점검] {now:%m-%d %H:%M} {MODES[mode]}"] + \
            [f"{'✅' if i['ok'] else '❌'} {i['name']}: {i['detail']}" for i in ch.items]
    if status == "holiday":
        lines.append("휴장 — 점검 건너뜀")
    text = "\n".join(lines)
    print(text)
    if send and status in ("fail", "error"):
        telegram(text + "\n\n→ 작업 PC에서 '불러오기' 하면 자세히 볼 수 있어요")
    return 0 if status in ("ok", "holiday") else 1


def report(show_all: bool) -> int:
    """작업 PC: monitor CT 기록을 SSH로 읽어 지난번 이후 결과를 마크다운 표로 (불러오기용)."""
    f = ROOT / "api" / "monitor-ssh.txt"
    if not f.is_file():
        print("monitor SSH 주소 파일이 없습니다: api/monitor-ssh.txt")
        return 1
    host = f.read_text(encoding="utf-8").strip()
    r = subprocess.run(["ssh", "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", host,
                        "tail -n 200 /var/lib/sv-check/results.jsonl 2>/dev/null"],
                       capture_output=True, text=True, timeout=30)
    if r.returncode not in (0, 1) or (r.returncode and not r.stdout):
        print(f"monitor CT에 연결하지 못했습니다 ({r.stderr.strip()[:120]})")
        return 1
    recs = [json.loads(l) for l in r.stdout.splitlines() if l.strip().startswith("{")]
    seen_f = ROOT / "logs" / "server_check_seen.txt"
    seen = seen_f.read_text().strip() if seen_f.is_file() and not show_all else ""
    new = [x for x in recs if x["ts"] > seen] if seen else recs[-20:]
    since = f"{seen[5:16].replace('T', ' ')} 이후" if seen else "최근"
    if not new:
        print(f"### 자동 점검 결과 ({since})\n새 점검 결과 없음" + (" — 휴장·주말이거나 아직 점검 시각 전" if seen else ""))
    else:
        icon = {"ok": "✅", "holiday": "💤 휴장", "fail": "❌", "error": "❌ 실행 오류"}
        print(f"### 자동 점검 결과 ({since}, {len(new)}건)\n| 시각 | 점검 | 결과 | 내용 |\n|---|---|---|---|")
        for x in new:
            print(f"| {x['ts'][5:16].replace('T', ' ')} | {MODES.get(x['mode'], x['mode'])} | {icon.get(x['status'], x['status'])} "
                  f"| {x['summary'].replace('|', '/')} |")
        bad = [x for x in new if x["status"] in ("fail", "error")]
        if bad:
            print(f"\n❌ {len(bad)}건 — 항목별 내용:")
            for x in bad:
                for i in x["items"]:
                    if not i["ok"]:
                        print(f"- {x['ts'][5:16].replace('T', ' ')} {MODES.get(x['mode'])} · {i['name']}: {i['detail']}")
    if recs and not show_all:
        seen_f.parent.mkdir(exist_ok=True)
        seen_f.write_text(recs[-1]["ts"])
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--report" in args:
        sys.exit(report("--all" in args))
    if not args or args[0] not in MODES:
        sys.exit(__doc__)
    sys.exit(run(args[0], "--telegram" in args))
