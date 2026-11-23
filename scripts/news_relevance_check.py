"""미국 종목 관련 뉴스 선별 기준 검증 (11-24) — 기사 본문을 실제로 열어 기준(rank_company_news)과 맞는지 본다.

종목마다 Finnhub 최근 7일 기사에서 기준이 '고른' 기사(제목·요약에 티커·회사 이름)와 '버린' 기사를 몇 건씩 뽑아
기사 페이지를 받아 본문에서 회사 이름·티커가 몇 번 나오는지 센다.
  - 고른 기사인데 본문 언급 0~1회 → 잘못 고름(시황 기사 등)
  - 버린 기사인데 본문 언급 3회 이상 → 놓침
본문을 못 받는 사이트(유료·차단)는 '본문 없음'으로 따로 센다. 읽기 전용, 저장 없음.

사용 (루트에서): .venv/bin/python scripts/news_relevance_check.py [AAPL NVDA ...] [--n 6] [--show]
"""
import argparse
import html
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import data_fetcher as df  # noqa: E402

NAMES = {"AAPL": "Apple Inc.", "NVDA": "NVIDIA Corporation", "AMD": "Advanced Micro Devices Inc.",
         "META": "Meta Platforms Inc. Class A", "TSLA": "Tesla Inc.", "F": "Ford Motor Company",
         "INTC": "Intel Corporation", "PLTR": "Palantir Technologies Inc. Class A",
         "GOOGL": "Alphabet Inc. Class A", "AMZN": "Amazon.com Inc.", "MSFT": "Microsoft Corporation"}
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"}


def body_text(url: str) -> str | None:
    try:
        r = requests.get(url, headers=UA, timeout=12, allow_redirects=True)
        if r.status_code != 200 or "html" not in r.headers.get("Content-Type", ""):
            return None
        t = r.text
    except Exception:
        return None
    t = re.sub(r"(?is)<(script|style|noscript|svg|nav|header|footer)[^>]*>.*?</\1>", " ", t)
    paras = re.findall(r"(?is)<p[^>]*>(.*?)</p>", t)          # 본문은 대개 <p>
    text = " ".join(re.sub(r"<[^>]+>", " ", p) for p in paras)
    text = html.unescape(re.sub(r"\s+", " ", text)).strip()
    return text if len(text) > 400 else None                   # 너무 짧으면 차단·동의 화면으로 봄


def count_mentions(text: str, ticker: str, name: str) -> int:
    tk_re, words = df._news_keys(ticker, name)
    low = text.lower()
    names = sum(len(re.findall(r"(?<![a-z0-9])" + re.escape(w) + r"(?![a-z0-9])", low)) for w in words if not any(w != o and w in o for o in words))
    return len(tk_re.findall(text)) + names


def check(ticker: str, n: int, show: bool) -> dict:
    name = NAMES.get(ticker, ticker)
    import datetime
    today = datetime.date.today()
    url = (f"https://finnhub.io/api/v1/company-news?symbol={ticker}&from={today - datetime.timedelta(days=7)}"
           f"&to={today}&token={df.FINNHUB_KEY}")
    raw = requests.get(url, timeout=10).json()
    items = [dict(df._finnhub_item_to_dict(i), summary=(i.get("summary") or "")[:300]) for i in raw if i.get("headline")]
    tk_re, words = df._news_keys(ticker, name)
    name_re = re.compile(r"(?<![a-z0-9])(?:" + "|".join(re.escape(w) for w in words) + r")(?![a-z0-9])") if words else None
    hit = lambda s: bool(tk_re.search(s or "")) or bool(name_re and name_re.search((s or "").lower()))
    for it in items:
        it["rel"] = 2 if hit(it["title"]) else 1 if hit(it.get("summary")) else 0
    picked = [i for i in items if i["rel"]][:n]
    dropped = [i for i in items if not i["rel"]][:n]
    with ThreadPoolExecutor(6) as ex:
        bodies = list(ex.map(lambda i: body_text(i["url"]), picked + dropped))
    res = {"ticker": ticker, "total": len(items), "rel": sum(1 for i in items if i["rel"]),
           "picked_ok": 0, "picked_weak": 0, "dropped_missed": 0, "dropped_ok": 0, "nobody": 0, "rows": []}
    for i, body in zip(picked + dropped, bodies):
        m = count_mentions(body, ticker, name) if body else None
        kind = "고름" if i["rel"] else "버림"
        if m is None:
            res["nobody"] += 1; verdict = "본문 없음"
        elif i["rel"]:
            ok = m >= 2
            res["picked_ok" if ok else "picked_weak"] += 1; verdict = "맞음" if ok else "잘못 고름"
        else:
            missed = m >= 3
            res["dropped_missed" if missed else "dropped_ok"] += 1; verdict = "놓침" if missed else "맞음"
        res["rows"].append((kind, i["rel"], m, verdict, i["source"], i["title"][:90]))
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tickers", nargs="*", default=["AAPL", "NVDA", "AMD", "META", "TSLA", "F", "INTC", "PLTR"])
    ap.add_argument("--n", type=int, default=6, help="종목마다 고른·버린 기사 각 몇 건을 열어 볼지")
    ap.add_argument("--show", action="store_true", help="기사별 결과도 출력")
    a = ap.parse_args()
    tot = {"picked_ok": 0, "picked_weak": 0, "dropped_missed": 0, "dropped_ok": 0, "nobody": 0}
    print(f"\n{'종목':<6} {'7일 기사':>7} {'관련':>5} │ 고른 기사: 맞음/잘못  │ 버린 기사: 맞음/놓침 │ 본문 없음")
    for t in a.tickers:
        r = check(t.upper(), a.n, a.show)
        for k in tot:
            tot[k] += r[k]
        print(f"{r['ticker']:<6} {r['total']:>7} {r['rel']:>5} │ {r['picked_ok']:>6} / {r['picked_weak']:<9}│ "
              f"{r['dropped_ok']:>6} / {r['dropped_missed']:<8}│ {r['nobody']}")
        if a.show:
            for kind, rel, m, verdict, src, title in r["rows"]:
                print(f"    [{kind} rel{rel}] 본문 언급 {('-' if m is None else m):>3} → {verdict:<6} {src[:18]:<18} {title}")
    p = tot["picked_ok"] + tot["picked_weak"]
    d = tot["dropped_ok"] + tot["dropped_missed"]
    print(f"\n합계: 고른 기사 {p}건 중 본문으로 맞음 {tot['picked_ok']}건"
          f"({tot['picked_ok'] / p * 100 if p else 0:.0f}%) · 버린 기사 {d}건 중 놓침 {tot['dropped_missed']}건 · 본문 없음 {tot['nobody']}건")


if __name__ == "__main__":
    main()
