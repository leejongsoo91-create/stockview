"""
PE/EPS 수집 스크립트 — Yahoo Finance HTML 파싱
실행: python collect_pe_eps.py
"""
import json, time, re, requests, shutil
from pathlib import Path

CACHE_FILE = Path("pe_eps_cache.json")
COLLECT_LIMIT = 500   # Yahoo Finance는 일일 한도 없음

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}

def load_cache():
    if CACHE_FILE.exists():
        return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    return {}

def save_cache(data):
    CACHE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

def fetch_nasdaq_tickers(limit=600):
    url = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=5000&offset=0&download=true"
    headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    try:
        r = requests.get(url, headers=headers, timeout=15)
        rows = r.json()["data"]["rows"]
        def parse_cap(s):
            try:
                s = s.replace("$","").replace(",","").strip()
                if s.endswith("T"): return float(s[:-1]) * 1e12
                if s.endswith("B"): return float(s[:-1]) * 1e9
                if s.endswith("M"): return float(s[:-1]) * 1e6
                return float(s) if s else 0
            except: return 0
        rows.sort(key=lambda x: parse_cap(x.get("marketCap","")), reverse=True)
        return [r["symbol"].strip() for r in rows if r.get("symbol","").strip()][:limit]
    except Exception as e:
        print(f"Nasdaq API 실패: {e}")
        return []

def fetch_pe_eps(ticker):
    try:
        r = requests.get(
            f"https://finance.yahoo.com/quote/{ticker}/",
            headers=_HEADERS, timeout=10,
        )
        if r.status_code != 200:
            return {}
        vals = re.findall(r'data-value="([^"]+)"[^>]*data-field="trailingPE"', r.text)
        if not vals:
            return {}
        try: pe = round(float(vals[0]), 1)
        except: pe = None
        eps = None
        if len(vals) >= 2:
            try: eps = round(float(vals[1]), 2)
            except: eps = None
        if pe is not None or eps is not None:
            return {"pe": pe, "eps": eps}
        return {}
    except Exception as e:
        print(f"  오류: {e}")
        return {}

def main():
    print("=== PE/EPS 수집 시작 (Yahoo Finance HTML) ===\n")

    if CACHE_FILE.exists():
        shutil.copy(CACHE_FILE, "pe_eps_cache.backup.json")
        print("백업 생성: pe_eps_cache.backup.json")

    existing = load_cache()
    print(f"기존 캐시: {len(existing)}개\n")

    print("Nasdaq API에서 시총 상위 종목 목록 가져오는 중...")
    tickers = fetch_nasdaq_tickers(limit=600)
    print(f"상위 {len(tickers)}개 티커 확보\n")

    missing  = [t for t in tickers if t not in existing]
    refresh  = [t for t in tickers if t in existing]
    ordered  = (missing + refresh)[:COLLECT_LIMIT]

    print(f"수집 대상: 미수집 {len(missing)}개 → 최대 {COLLECT_LIMIT}개 처리\n")
    print("-" * 50)

    success = 0
    for i, ticker in enumerate(ordered, 1):
        result = fetch_pe_eps(ticker)
        if result:
            existing[ticker] = result
            success += 1
            print(f"[{i:3d}/{len(ordered)}] ✅ {ticker:8s}  PE={str(result.get('pe','—')):8}  EPS={result.get('eps','—')}")
        else:
            print(f"[{i:3d}/{len(ordered)}] —  {ticker:8s}  (데이터 없음)")

        if i % 10 == 0:
            save_cache(existing)

        time.sleep(0.4)

    save_cache(existing)

    print("\n" + "=" * 50)
    print(f"수집 완료: {success}개 성공")
    print(f"누적 총계: {len(existing)}개")
    print("=" * 50)

if __name__ == "__main__":
    main()
