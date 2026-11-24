"""증권사 텔레그램 리서치 뽑기 점검 (11-24) — 채널마다 최근 글을 읽어 종목·투자의견·목표주가가 맞게 뽑히는지 표로 본다.
읽기 전용(저장 없음). 종목 목록은 실행 중인 서버(기본 5001)에서 받는다.

사용 (루트에서): .venv/bin/python scripts/tg_extract_check.py [채널 ...] [--show] [--base http://127.0.0.1:5001]
"""
import argparse
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import data_fetcher as df  # noqa: E402

OP = {"buy": "매수", "hold": "중립", "sell": "매도", None: "-"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("channels", nargs="*")
    ap.add_argument("--show", action="store_true", help="글마다 뽑은 결과와 본문 첫 줄 출력")
    ap.add_argument("--base", default="http://127.0.0.1:5001")
    a = ap.parse_args()
    kr = requests.get(f"{a.base}/api/kr-stocks", timeout=30).json()
    us = requests.get(f"{a.base}/api/stocks", timeout=30).json()
    kr_codes = {s["code"]: s["ticker"] for s in kr if s.get("code")}
    kr_name = {s["ticker"]: s["name"] for s in kr}
    us_t = {s["ticker"] for s in us}
    kr_names = {s["name"]: s["ticker"] for s in kr if s.get("name") and (s.get("kind") or "stock") == "stock"}
    us_names = {s["name_ko"]: s["ticker"] for s in us if s.get("name_ko") and not s.get("non_common")}
    chans = [(c, n) for c, n in df.TELEGRAM_RESEARCH if not a.channels or c in a.channels]
    print(f"\n{'채널':<18} {'글':>3} {'종목':>4} {'의견':>4} {'목표가':>5} │ 최신 글")
    tot = [0, 0, 0, 0]
    for ch, name in chans:
        posts = df.fetch_tg_channel(ch)
        ex = [(p, df.tg_extract(p["text"], kr_codes, us_t, kr_names, us_names)) for p in posts]
        n_code = sum(1 for _, e in ex if e["codes"] or e["us"])
        n_op = sum(1 for _, e in ex if e["opinion"])
        n_tg = sum(1 for _, e in ex if e["target"])
        for i, v in enumerate((len(ex), n_code, n_op, n_tg)):
            tot[i] += v
        last = ex[-1][1]["title"][:50] if ex else ""
        print(f"{name:<16} {len(ex):>3} {n_code:>4} {n_op:>4} {n_tg:>5} │ {last}")
        if a.show:
            for p, e in ex[-8:]:
                stocks = [f"{kr_name.get(t, t)}" for t in e["codes"]] + e["us"]
                tg = f"{e['target']:,.0f}{'$' if e['cur'] == 'USD' else '원'}" if e["target"] else "-"
                print(f"    #{p['msg']} [{', '.join(stocks) or '종목 없음'}]{'' if e['single'] else ' (여러 종목)' if stocks else ''} 의견 {OP[e['opinion']]} · 목표 {tg} · {e['analyst'][:24]} | {e['title'][:60]}")
    print(f"\n합계: 글 {tot[0]} · 종목 뽑힘 {tot[1]} · 의견 {tot[2]} · 목표가 {tot[3]}")


if __name__ == "__main__":
    main()
