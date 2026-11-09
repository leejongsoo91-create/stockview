"""
국내주식 전종목 수집 스크립트
KOSPI 전종목 + KOSDAQ 전종목 → data/kr_stocks.json

실행: .venv/bin/python scripts/fetch_kr_stocks.py            (루트 디렉토리에서, 약 5~10분)
      .venv/bin/python scripts/fetch_kr_stocks.py --dry-run  (저장 없이 수집 결과·기존 파일과 차이만 출력)

소스 (2026-11-09 교체 — 옛 finance.naver.com/sise/sise_market_sum·sise_group HTML은 접속 불가):
  - 종목 목록·현재가·등락·거래량·시가총액·종류: m.stock.naver.com/api/stocks/marketValue/{KOSPI|KOSDAQ}
  - 업종: m.stock.naver.com/api/stocks/industry (79개) → /industry/{no} 업종별 종목
  - PER/EPS: data_fetcher.fetch_kr_per_eps() (서버 1일 1회 갱신과 같은 integration API)
  - 52주 최고/최저: Yahoo Finance v8 chart (range=1y)
"""
import json, os, sys, time, shutil
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import requests
import data_fetcher

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
NAVER = "https://m.stock.naver.com/api/stocks"
_num = data_fetcher._naver_num   # "1,234" / "N/A" → float | None


def _get_json(session: requests.Session, url: str, params: dict) -> dict:
    """네이버 JSON 요청 (실패 시 2번 재시도)."""
    for attempt in range(3):
        try:
            r = session.get(url, params=params, timeout=15)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            if attempt == 2:
                raise
            print(f"  재시도 {attempt + 1}: {url} {params} ({e})")
            time.sleep(1.0)
    return {}


# ── 종목 목록 (시가총액순) ──────────────────────────────────────────────────────
def collect_market(session: requests.Session, market: str) -> list[dict]:
    """네이버 국내 시총 목록을 100개씩 끝까지 순회.
    종목코드는 6자리 숫자 또는 영문 섞인 신규 코드(2024~ 상장, 삼성에피스홀딩스 0126Z0 등 — 11-09 기준 424개)."""
    suffix = ".KS" if market == "KOSPI" else ".KQ"
    result, seen, page = [], set(), 1
    while page <= 60:   # 안전장치 (KOSPI 약 25페이지)
        d = _get_json(session, f"{NAVER}/marketValue/{market}", {"page": page, "pageSize": 100})
        stocks = d.get("stocks") or []
        for s in stocks:
            code = s.get("itemCode") or ""
            if data_fetcher.kr_code(code) != code or len(code) != 6 or code in seen:
                continue
            seen.add(code)
            mv = _num(s.get("marketValue"))   # 억원 단위
            result.append({
                "ticker":      code + suffix,
                "code":        code,
                "name":        (s.get("stockName") or "").strip(),
                "market":      market,
                "sector":      "",
                "price":       _num(s.get("closePrice")) or 0,
                "change":      _num(s.get("compareToPreviousClosePrice")) or 0,
                "change_pct":  _num(s.get("fluctuationsRatio")) or 0,
                "volume":      int(_num(s.get("accumulatedTradingVolume")) or 0),
                "market_cap":  int(mv * 1e8) if mv else 0,
                "pe":          0,
                "eps":         0,
                "week52_high": 0,
                "week52_low":  0,
                "_kind":       s.get("stockEndType") or "stock",   # 저장 전 제거 (서버가 실시간 목록에서 따로 부여)
            })
        total = d.get("totalCount") or 0
        if page % 10 == 0:
            print(f"    {market} {page}페이지 ({len(result)}/{total})")
        if not stocks or page * 100 >= total:
            break
        page += 1
        time.sleep(0.2)
    return result


# ── 업종 분류 ──────────────────────────────────────────────────────────────────
def build_sector_map(session: requests.Session) -> dict[str, str]:
    """{종목코드: 업종명}. 업종 목록은 79개라 pageSize 100 한 번이면 충분."""
    d = _get_json(session, f"{NAVER}/industry", {"page": 1, "pageSize": 100})
    groups = d.get("groups") or []
    print(f"  업종 {len(groups)}개 발견 (네이버 totalCount {d.get('totalCount')})")

    def _one(g: dict) -> tuple[str, list[str]]:
        codes, page = [], 1
        while page <= 20:
            dd = _get_json(session, f"{NAVER}/industry/{g['no']}", {"page": page, "pageSize": 100})
            st = dd.get("stocks") or []
            codes += [s.get("itemCode") for s in st if s.get("itemCode")]
            if not st or page * 100 >= (dd.get("totalCount") or 0):
                break
            page += 1
        return g["name"].strip(), codes

    code_to_sector: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for fut in as_completed([ex.submit(_one, g) for g in groups]):
            try:
                name, codes = fut.result()
            except Exception as e:
                print(f"  업종 조회 실패: {e}")
                continue
            for c in codes:
                code_to_sector.setdefault(c, name)
    return code_to_sector


# ── 52주 최고/최저 (Yahoo) ─────────────────────────────────────────────────────
def _fetch_52w(stock: dict) -> dict:
    try:
        r = requests.get(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{stock['ticker']}?interval=1d&range=1y",
            headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"}, timeout=8)
        meta = r.json()["chart"]["result"][0]["meta"]
        stock["week52_high"] = meta.get("fiftyTwoWeekHigh", 0) or 0
        stock["week52_low"]  = meta.get("fiftyTwoWeekLow", 0) or 0
    except Exception:
        pass
    return stock


def fetch_52w_parallel(stocks: list[dict], workers: int = 10) -> None:
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for _ in as_completed([ex.submit(_fetch_52w, s) for s in stocks]):
            done += 1
            if done % 500 == 0:
                print(f"  52주 수집: {done}/{len(stocks)}")


# ── 메인 ─────────────────────────────────────────────────────────────────────
def main():
    dry_run = "--dry-run" in sys.argv
    out_path = Path("data/kr_stocks.json")
    old = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else []
    session = requests.Session()
    session.headers.update(HEADERS)
    t0 = time.time()

    print("KOSPI·KOSDAQ 종목 목록 수집 중 (네이버)…")
    all_stocks = collect_market(session, "KOSPI") + collect_market(session, "KOSDAQ")
    kospi = sum(1 for s in all_stocks if s["market"] == "KOSPI")
    print(f"  전체 {len(all_stocks)}개 (KOSPI {kospi} · KOSDAQ {len(all_stocks) - kospi})")
    if len(all_stocks) < 3000:   # 비정상적으로 적으면 저장하지 않는다 (기존 3,936개)
        print("  ⚠️ 종목 수가 너무 적어 중단합니다 (네이버 응답 확인 필요)")
        sys.exit(1)

    print("\n업종 분류 수집 중…")
    sector_map = build_sector_map(session)
    for s in all_stocks:
        # 업종 목록에 없는 종목(ETF·ETN·스팩 등)은 기존처럼 '기타' — 화면 쪽 ETF/ETN 판별 규칙과 호환
        s["sector"] = sector_map.get(s["code"]) or "기타"
    print(f"  업종 매핑: {sum(1 for s in all_stocks if s['sector'] != '기타')}/{len(all_stocks)}개 (나머지 '기타')")

    print("\nPER/EPS 수집 중 (네이버 integration, 종목당 1회)…")
    stock_codes = [s["code"] for s in all_stocks if s["_kind"] == "stock"]   # ETF·ETN은 PER 없음
    per_map = data_fetcher.fetch_kr_per_eps(stock_codes)
    for s in all_stocks:
        v = per_map.get(s["code"])
        if v:
            s["pe"], s["eps"] = v["pe"], v["eps"]
    print(f"  PER/EPS: {len(per_map)}/{len(stock_codes)}개")

    print("\n52주 최고/최저 수집 중 (Yahoo, 병렬 10)…")
    fetch_52w_parallel(all_stocks)

    kinds = {}
    for s in all_stocks:
        k = s.pop("_kind")
        kinds[k] = kinds.get(k, 0) + 1

    # ── 요약 · 기존 파일과 비교 ──
    old_codes = {s["code"]: s for s in old}
    new_codes = {s["code"] for s in all_stocks}
    added   = [s for s in all_stocks if s["code"] not in old_codes]
    removed = [s for c, s in old_codes.items() if c not in new_codes]
    print(f"\n종류: {kinds}")
    print(f"가격 {sum(1 for s in all_stocks if s['price'] > 0)} · 시총 {sum(1 for s in all_stocks if s['market_cap'] > 0)}"
          f" · PER {sum(1 for s in all_stocks if s['pe'])} · EPS {sum(1 for s in all_stocks if s['eps'])}"
          f" · 52주 {sum(1 for s in all_stocks if s['week52_high'] > 0)} / {len(all_stocks)}")
    print(f"기존 {len(old)}개 → 새 {len(all_stocks)}개 (신규 {len(added)} · 빠짐 {len(removed)})")
    print("  신규 예:", ", ".join(f"{s['name']}({s['code']})" for s in added[:10]))
    print("  빠짐 예:", ", ".join(f"{s['name']}({s['code']})" for s in removed[:10]))
    print("\n시총 상위 5개:")
    for s in sorted(all_stocks, key=lambda x: -x["market_cap"])[:5]:
        print(f"  [{s['market']}] {s['name']} ({s['code']}) {s['price']:,.0f}원  "
              f"PER={s['pe']}  시총={s['market_cap'] / 1e12:.1f}조원  업종={s['sector']}")
    print(f"\n소요 {time.time() - t0:.0f}초")

    if dry_run:
        print("\n--dry-run: 저장하지 않음")
        return
    if out_path.exists():
        backup = out_path.with_name("kr_stocks_backup.json")
        shutil.copy(out_path, backup)
        print(f"기존 파일 백업 → {backup}")
    all_stocks.sort(key=lambda x: -x["market_cap"])
    out_path.write_text(json.dumps(all_stocks, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"저장 완료 → {out_path}  ({len(all_stocks)}개 종목)")


if __name__ == "__main__":
    main()
