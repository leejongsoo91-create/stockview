"""
국내주식 전종목 수집 스크립트
KOSPI 전종목 + KOSDAQ 전종목 → data/kr_stocks.json

실행: python scripts/fetch_kr_stocks.py  (루트 디렉토리에서)
"""
import json, time, re, shutil, requests
from html.parser import HTMLParser
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://finance.naver.com",
}

# ── HTML 파서 (종목명 + 시가총액 + PER 동시 파싱) ────────────────────────────────
class _NaverParser(HTMLParser):
    """
    Naver Finance sise_market_sum 페이지에서 종목코드·이름·시가총액·PER 추출.
    컬럼 순서: 종목명 | 현재가(1) | 전일비(2) | 등락률(3) | 액면가(4) |
               시가총액(5, 억원) | 상장주식수(6) | 외국인비율(7) | 거래량(8) |
               PER(9) | ROE(10)
    """
    def __init__(self):
        super().__init__()
        self.stocks    = []
        self._code     = None
        self._name     = None
        self._in_name  = False
        self._td_count = -1
        self._buf      = ''
        self._td_bufs  = []
        self._seen     = set()

    def handle_starttag(self, tag, attrs):
        attrs_d = dict(attrs)
        if tag == 'a' and 'href' in attrs_d:
            href = attrs_d['href']
            if 'item/main.naver?code=' in href:
                code = href.split('code=')[-1].strip()
                if len(code) == 6 and code.isdigit() and code not in self._seen:
                    self._code     = code
                    self._name     = None
                    self._in_name  = True
                    self._td_count = 0
                    self._td_bufs  = []
        if tag == 'td' and self._td_count >= 0:
            self._td_count += 1
            self._buf = ''

    def handle_data(self, data):
        stripped = data.strip()
        if self._in_name and self._code and stripped and not stripped.isdigit():
            self._name    = stripped
            self._in_name = False
        if self._code and self._td_count > 0:
            self._buf += stripped

    def handle_endtag(self, tag):
        if tag == 'a':
            self._in_name = False
        elif tag == 'td' and self._td_count > 0:
            self._td_bufs.append(self._buf)
            self._buf = ''
            if len(self._td_bufs) == 9 and self._code and self._name:
                raw_cap = self._td_bufs[4].replace(',', '').replace(' ', '')
                cap_raw = int(raw_cap) * int(1e8) if raw_cap.isdigit() else 0
                raw_per = self._td_bufs[8].replace(',', '').replace(' ', '')
                try:
                    per = float(raw_per) if raw_per and raw_per not in ('N/A', '-', '') else 0.0
                except ValueError:
                    per = 0.0
                self.stocks.append((self._code, self._name, cap_raw, per))
                self._seen.add(self._code)
                self._code     = None
                self._name     = None
                self._td_count = -1
                self._td_bufs  = []


def _get_last_page(sosok: int) -> int:
    """Naver sise 페이지에서 전체 페이지 수 자동 감지"""
    url = f"https://finance.naver.com/sise/sise_market_sum.naver?sosok={sosok}&page=1"
    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        content = r.content.decode("euc-kr", errors="replace")
        # 마지막 페이지 링크: page=XX  >맨뒤
        m = re.search(r'page=(\d+)[^>]*>\s*맨뒤', content)
        return int(m.group(1)) if m else 1
    except Exception:
        return 1


def _fetch_page(sosok: int, page: int) -> list[tuple]:
    url = f"https://finance.naver.com/sise/sise_market_sum.naver?sosok={sosok}&page={page}"
    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        content = r.content.decode("euc-kr", errors="replace")
        p = _NaverParser()
        p.feed(content)
        return p.stocks
    except Exception as e:
        print(f"  페이지 오류 sosok={sosok} page={page}: {e}")
        return []


def _collect(sosok: int, market: str) -> list[dict]:
    """전체 페이지를 순회하며 모든 종목 수집"""
    suffix = ".KS" if sosok == 0 else ".KQ"
    last_page = _get_last_page(sosok)
    print(f"  {market}: 총 {last_page}페이지 감지")

    all_tuples: list[tuple] = []
    seen = set()
    for page in range(1, last_page + 1):
        stocks = _fetch_page(sosok, page)
        for code, name, cap_raw, per in stocks:
            if code not in seen:
                seen.add(code)
                all_tuples.append((code, name, cap_raw, per))
        if page % 10 == 0:
            print(f"    {page}/{last_page}페이지 완료 ({len(seen)}종목)")
        time.sleep(0.1)

    result = []
    for code, name, cap_raw, per in all_tuples:
        result.append({
            "ticker":      code + suffix,
            "code":        code,
            "name":        name,
            "market":      market,
            "sector":      "",
            "price":       0,
            "change":      0,
            "change_pct":  0,
            "volume":      0,
            "market_cap":  cap_raw,
            "pe":          per,
            "eps":         0,
            "week52_high": 0,
            "week52_low":  0,
        })
    return result


# ── 가격 + 52W 배치 수집 ──────────────────────────────────────────────────────
def _fetch_price(stock: dict) -> dict:
    ticker = stock["ticker"]
    try:
        r = requests.get(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=1y",
            headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
            timeout=8,
        )
        data  = r.json()
        res   = data["chart"]["result"][0]
        meta  = res["meta"]
        price = meta.get("regularMarketPrice") or meta.get("previousClose", 0)
        prev  = meta.get("chartPreviousClose") or meta.get("previousClose", price)
        chg   = price - prev
        chg_pct = round((chg / prev * 100), 2) if prev else 0
        # KRX 상하한가 ±30% 초과는 stale chartPreviousClose(거래정지 종목 등) 오류로 판단해 무시
        if abs(chg_pct) > 30:
            chg, chg_pct = 0, 0
        vol   = meta.get("regularMarketVolume", 0)
        cap   = meta.get("marketCap", 0) or stock.get("market_cap", 0) or 0
        w52h  = meta.get("fiftyTwoWeekHigh", 0) or 0
        w52l  = meta.get("fiftyTwoWeekLow",  0) or 0
        per   = stock.get("pe", 0) or 0
        eps   = round(price / per, 0) if per > 0 and price > 0 else 0
        stock.update(
            price=price, change=round(chg, 2), change_pct=chg_pct,
            volume=vol, market_cap=cap,
            week52_high=w52h, week52_low=w52l,
            pe=per, eps=eps,
        )
    except Exception:
        pass
    return stock


def fetch_prices_parallel(stocks: list[dict], workers: int = 20) -> list[dict]:
    result = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(_fetch_price, s): s for s in stocks}
        done = 0
        for fut in as_completed(futs):
            result.append(fut.result())
            done += 1
            if done % 100 == 0:
                print(f"  가격 수집: {done}/{len(stocks)}")
    return result


# ── 업종 분류 수집 ─────────────────────────────────────────────────────────────
def _fetch_sector_detail(no: str, name: str) -> tuple[str, list[str]]:
    url = f"https://finance.naver.com/sise/sise_group_detail.naver?type=upjong&no={no}&page=1"
    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        c = r.content.decode("euc-kr", errors="replace")
        codes = list(set(re.findall(r'code=(\d{6})', c)))
        return name, codes
    except Exception:
        return name, []


def build_sector_map() -> dict[str, str]:
    r = requests.get(
        "https://finance.naver.com/sise/sise_group.naver?type=upjong",
        headers=HEADERS, timeout=10,
    )
    content = r.content.decode("euc-kr", errors="replace")
    matches = re.findall(r'upjong&no=(\d+)[^"]*"[^>]*>([^<]{1,40})', content)

    industry_map: dict[str, str] = {}
    seen_no: set[str] = set()
    for no, name in matches:
        if no not in seen_no:
            industry_map[no] = name.strip()
            seen_no.add(no)

    print(f"  업종 {len(industry_map)}개 발견")
    code_to_sector: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(_fetch_sector_detail, no, name): no for no, name in industry_map.items()}
        for fut in as_completed(futs):
            sector_name, codes = fut.result()
            for code in codes:
                if code not in code_to_sector:
                    code_to_sector[code] = sector_name
    return code_to_sector


# ── 메인 ─────────────────────────────────────────────────────────────────────
def main():
    out_path = Path("data/kr_stocks.json")
    out_path.parent.mkdir(exist_ok=True)

    # 기존 파일 백업
    if out_path.exists():
        backup = out_path.with_name("kr_stocks_backup.json")
        shutil.copy(out_path, backup)
        print(f"기존 파일 백업 → {backup}")

    print("\nKOSPI 전종목 수집 중…")
    kospi = _collect(sosok=0, market="KOSPI")
    print(f"  KOSPI: {len(kospi)}개 수집 완료")

    print("\nKOSDAQ 전종목 수집 중…")
    kosdaq = _collect(sosok=1, market="KOSDAQ")
    print(f"  KOSDAQ: {len(kosdaq)}개 수집 완료")

    all_stocks = kospi + kosdaq
    print(f"\n전체 {len(all_stocks)}개 종목 수집")

    print("\n업종 분류 수집 중…")
    sector_map = build_sector_map()
    for s in all_stocks:
        s["sector"] = sector_map.get(s["code"], "")
    has_sector = sum(1 for s in all_stocks if s["sector"])
    print(f"  업종 매핑: {has_sector}/{len(all_stocks)}개")

    print(f"\n가격·52W 수집 중 (Yahoo Finance, 병렬 20)… 약 5~10분 소요")
    all_stocks = fetch_prices_parallel(all_stocks, workers=20)

    filled  = sum(1 for s in all_stocks if s["price"] > 0)
    has_cap = sum(1 for s in all_stocks if s["market_cap"] > 0)
    has_per = sum(1 for s in all_stocks if s["pe"] > 0)
    has_w52 = sum(1 for s in all_stocks if s["week52_high"] > 0)
    print(f"가격: {filled}/{len(all_stocks)}, 시총: {has_cap}, PER: {has_per}, 52W: {has_w52}")

    out_path.write_text(json.dumps(all_stocks, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n저장 완료 → {out_path}  ({len(all_stocks)}개 종목)")

    print("\n시총 상위 5개:")
    for s in sorted(all_stocks, key=lambda x: -x["market_cap"])[:5]:
        cap_str = f"{s['market_cap']/1e12:.1f}조원" if s['market_cap'] >= 1e12 else "N/A"
        print(f"  [{s['market']}] {s['name']} ({s['code']}) "
              f"{s['price']:,.0f}원  PER={s['pe']}  시총={cap_str}")


if __name__ == "__main__":
    main()
