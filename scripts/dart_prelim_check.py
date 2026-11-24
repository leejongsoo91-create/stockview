"""DART 잠정실적 숫자 뽑기 점검 (11-25) — 기간 안 영업(잠정)실적 공시를 받아 매출·영업이익·순이익을 뽑고,
공시에 적힌 증감률(전년 대비 %)과 뽑은 금액으로 다시 계산한 증감률이 맞는지 대조한다. 읽기 전용(저장 없음).

사용 (루트에서): .venv/bin/python scripts/dart_prelim_check.py [시작 YYYYMMDD] [끝 YYYYMMDD] [--n 40] [--show]
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import data_fetcher as df  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bgn", nargs="?", default="20261020")
    ap.add_argument("end", nargs="?", default="20261115")
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--show", action="store_true")
    a = ap.parse_args()
    lst = [x for x in df.fetch_dart_list(a.bgn, a.end, "I", max_pages=20) if df.dart_classify(x["title"])[0] == "prelim" and "정정" not in x["title"]]
    print(f"기간 {a.bgn}~{a.end} 잠정실적 공시 {len(lst)}건 중 {min(a.n, len(lst))}건 점검")
    ok = bad = none = 0
    for x in lst[:a.n]:
        d = df.parse_dart_prelim(x["rcept_no"])
        if not d:
            none += 1
            if a.show:
                print(f"  ✗ 못 뽑음  {x['corp']} {x['title']}")
            continue
        checks = []
        for k in ("sales", "op", "net"):
            v = d.get(k) or {}
            if v.get("cur") and v.get("yoy_base") and v.get("yoy") is not None and v["yoy_base"] > 0 and v["cur"] > 0:
                calc = (v["cur"] / v["yoy_base"] - 1) * 100
                checks.append(abs(calc - v["yoy"]) <= max(1.0, abs(v["yoy"]) * 0.02))
        good = all(checks) if checks else None
        if good is True:
            ok += 1
        elif good is False:
            bad += 1
        else:
            none += 1
        if a.show:
            s = d.get("sales") or {}; o = d.get("op") or {}
            fmt = lambda v: f"{v / 1e8:,.0f}억" if v else "-"
            print(f"  {'✓' if good else '✗' if good is False else '·'} {x['corp']:<12} {d.get('period'):<8} {d.get('unit'):<4} "
                  f"매출 {fmt(s.get('cur'))} (전년 {s.get('yoy')}%) · 영업이익 {fmt(o.get('cur'))} (전년 {o.get('yoy')}%) {o.get('turn') or ''}")
    print(f"\n증감률 대조: 맞음 {ok} · 틀림 {bad} · 대조 불가(값 없음·적자 등) {none}")


if __name__ == "__main__":
    main()
