"""
국내주식 종목 목록 수집 스크립트
KOSPI 상위 300개 + KOSDAQ 상위 200개 → data/kr_stocks.json

실행: python scripts/fetch_kr_stocks.py  (루트 디렉토리에서)
"""
import json, time, requests
from html.parser import HTMLParser
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://finance.naver.com",
}

# ── HTML 파서 ──────────────────────────────────────────────────────────────────
class _NaverParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stocks   = []
        self._in_link = False
        self._code    = None
        self._seen    = set()

    def handle_starttag(self, tag, attrs):
        attrs_d = dict(attrs)
        if tag == "a" and "href" in attrs_d:
            href = attrs_d["href"]
            if "item/main.naver?code=" in href:
                code = href.split("code=")[-1].strip()
                if len(code) == 6 and code.isdigit() and code not in self._seen:
                    self._code    = code
                    self._in_link = True

    def handle_data(self, data):
        if self._in_link and self._code and data.strip():
            name = data.strip()
            if name and not name.isdigit():
                self.stocks.append((self._code, name))
                self._seen.add(self._code)
                self._in_link = False
                self._code    = None

    def handle_endtag(self, tag):
        if tag == "a":
            self._in_link = False


def _fetch_page(sosok: int, page: int) -> list[tuple[str, str]]:
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


def _collect(sosok: int, market: str, pages: int) -> list[dict]:
    suffix = ".KS" if sosok == 0 else ".KQ"
    all_stocks: list[tuple[str, str]] = []
    seen = set()
    for page in range(1, pages + 1):
        stocks = _fetch_page(sosok, page)
        for code, name in stocks:
            if code not in seen:
                seen.add(code)
                all_stocks.append((code, name))
        time.sleep(0.15)

    result = []
    for code, name in all_stocks:
        result.append({
            "ticker":  code + suffix,
            "code":    code,
            "name":    name,
            "market":  market,
            "sector":  "",
            "price":   0,
            "change":  0,
            "change_pct": 0,
            "volume":  0,
            "market_cap": 0,
        })
    return result


# ── 가격 배치 수집 ────────────────────────────────────────────────────────────
def _fetch_price(stock: dict) -> dict:
    ticker = stock["ticker"]
    try:
        r = requests.get(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=2d",
            headers={
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/json",
            },
            timeout=8,
        )
        data   = r.json()
        res    = data["chart"]["result"][0]
        meta   = res["meta"]
        price  = meta.get("regularMarketPrice") or meta.get("previousClose", 0)
        prev   = meta.get("chartPreviousClose") or meta.get("previousClose", price)
        chg    = price - prev
        chg_pct = (chg / prev * 100) if prev else 0
        vol    = meta.get("regularMarketVolume", 0)
        cap    = meta.get("marketCap", 0)
        stock.update(price=price, change=round(chg, 2),
                     change_pct=round(chg_pct, 2),
                     volume=vol, market_cap=cap)
    except Exception as e:
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
            if done % 50 == 0:
                print(f"  가격 수집: {done}/{len(stocks)}")
    return result


# ── 메인 ─────────────────────────────────────────────────────────────────────
def main():
    out_path = Path("data/kr_stocks.json")
    out_path.parent.mkdir(exist_ok=True)

    print("KOSPI 종목 수집 중 (상위 300개, 6페이지)…")
    kospi = _collect(sosok=0, market="KOSPI", pages=6)
    print(f"  KOSPI: {len(kospi)}개 수집")

    print("KOSDAQ 종목 수집 중 (상위 200개, 4페이지)…")
    kosdaq = _collect(sosok=1, market="KOSDAQ", pages=4)
    print(f"  KOSDAQ: {len(kosdaq)}개 수집")

    all_stocks = kospi + kosdaq
    print(f"\n총 {len(all_stocks)}개 종목, 가격 수집 중 (Yahoo Finance)…")
    all_stocks = fetch_prices_parallel(all_stocks, workers=25)

    filled = sum(1 for s in all_stocks if s["price"] > 0)
    print(f"가격 수집 완료: {filled}/{len(all_stocks)}개")

    out_path.write_text(json.dumps(all_stocks, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n저장 완료 → {out_path}  ({len(all_stocks)}개 종목)")

    # 샘플 출력
    for s in all_stocks[:3]:
        print(f"  {s['ticker']} {s['name']} ₩{s['price']:,} ({s['change_pct']:+.2f}%)")


if __name__ == "__main__":
    main()
