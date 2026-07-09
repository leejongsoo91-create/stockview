"""
PE/EPS 수집 스크립트 — Yahoo Finance HTML 파싱
실행: python collect_pe_eps.py
"""
import json, re, requests, shutil, sys, time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CACHE_FILE = Path(__file__).parent.parent / "data" / "pe_eps_cache.json"
COLLECT_LIMIT  = 5000  # 병렬 수집이라 전체를 한 번에 처리 (Yahoo Finance는 일일 한도 없음)
MAX_WORKERS    = 5     # 과도하면 Yahoo가 429로 IP 전체를 차단함 — 보수적으로 유지
REQUEST_DELAY  = 0.3   # 요청별 지연 (초). 워커 5개 기준 초당 최대 ~16건

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

def fetch_nasdaq_tickers(limit=5000):
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
    """반환: (결과 dict, HTTP 상태코드). 상태코드는 호출부의 429 서킷브레이커 판단용."""
    time.sleep(REQUEST_DELAY)
    try:
        r = requests.get(
            f"https://finance.yahoo.com/quote/{ticker}/",
            headers=_HEADERS, timeout=10,
        )
        if r.status_code != 200:
            return {}, r.status_code
        vals = re.findall(r'data-value="([^"]+)"[^>]*data-field="trailingPE"', r.text)
        if not vals:
            return {}, r.status_code
        try: pe = round(float(vals[0]), 1)
        except: pe = None
        eps = None
        if len(vals) >= 2:
            try: eps = round(float(vals[1]), 2)
            except: eps = None
        if pe is not None or eps is not None:
            return {"pe": pe, "eps": eps}, r.status_code
        return {}, r.status_code
    except Exception as e:
        print(f"  오류: {e}")
        return {}, None

def main():
    print("=== PE/EPS 수집 시작 (Yahoo Finance HTML) ===\n")

    if CACHE_FILE.exists():
        shutil.copy(CACHE_FILE, Path(__file__).parent.parent / "data" / "pe_eps_cache.backup.json")
        print("백업 생성: data/pe_eps_cache.backup.json")

    existing = load_cache()
    print(f"기존 캐시: {len(existing)}개\n")

    print("Nasdaq API에서 종목 목록 가져오는 중...")
    tickers = fetch_nasdaq_tickers(limit=5000)
    print(f"{len(tickers)}개 티커 확보\n")

    missing  = [t for t in tickers if t not in existing]
    refresh  = [t for t in tickers if t in existing]
    ordered  = (missing + refresh)[:COLLECT_LIMIT]

    print(f"수집 대상: 미수집 {len(missing)}개 → 최대 {COLLECT_LIMIT}개 처리 (병렬 {MAX_WORKERS}개)\n")
    print("-" * 50)

    success = 0
    done = 0
    consecutive_429 = 0
    blocked = False
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = {ex.submit(fetch_pe_eps, t): t for t in ordered}
        for fut in as_completed(futures):
            ticker = futures[fut]
            result, status = fut.result()
            done += 1

            if status == 429:
                consecutive_429 += 1
            else:
                consecutive_429 = 0

            if result:
                existing[ticker] = result
                success += 1
                print(f"[{done:4d}/{len(ordered)}] ✅ {ticker:8s}  PE={str(result.get('pe','—')):8}  EPS={result.get('eps','—')}")
            else:
                print(f"[{done:4d}/{len(ordered)}] —  {ticker:8s}  (데이터 없음{' - 429' if status == 429 else ''})")

            if done % 100 == 0:
                save_cache(existing)

            if consecutive_429 >= 15:
                print(f"\n⚠️  429 연속 {consecutive_429}회 — Yahoo에 의해 차단된 것으로 판단해 조기 중단합니다. 나머지 요청은 건너뜁니다.")
                blocked = True
                for f in futures:
                    f.cancel()
                break

    save_cache(existing)

    if blocked:
        print("\n잠시 후(수십 분~수 시간 뒤) 다시 실행해 이어서 수집하세요. 이미 수집된 항목은 캐시에 보존됩니다.")

    print("\n" + "=" * 50)
    print(f"수집 완료: {success}개 성공")
    print(f"누적 총계: {len(existing)}개")
    print("=" * 50)

if __name__ == "__main__":
    main()
