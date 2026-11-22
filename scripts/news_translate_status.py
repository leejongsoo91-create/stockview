"""뉴스 제목 번역 상태를 터미널에서 본다 (11-22).

사용 (프로젝트 루트에서):
  .venv/bin/python scripts/news_translate_status.py            # 작업 PC 서버(5001)
  .venv/bin/python scripts/news_translate_status.py home       # 집 서버 (api/home-server-url.txt 주소)
  .venv/bin/python scripts/news_translate_status.py 5002       # 다른 포트
  .venv/bin/python scripts/news_translate_status.py --guide    # Azure 번역 키 받는 방법 보기

서버의 /api/news/translation을 읽어 서비스별 이번 달 사용량·상태·최근 기록을 보여 준다.
서버가 꺼져 있으면 data/news_translations.json 파일을 직접 읽는다(상태 칸은 알 수 없음).
"""
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GUIDE = os.path.join(ROOT, "docs", "guides", "azure-translator-key.md")


def _server_url(arg: str) -> str:
    if arg == "home":
        with open(os.path.join(ROOT, "api", "home-server-url.txt"), encoding="utf-8") as f:
            return f.read().strip().rstrip("/")
    if arg.startswith("http"):
        return arg.rstrip("/")
    return f"http://127.0.0.1:{arg}"


def _bar(used: int, limit: int, width: int = 24) -> str:
    r = min(1.0, used / limit) if limit else 0
    return "█" * round(r * width) + "░" * (width - round(r * width)) + f" {r * 100:5.1f}%"


def main() -> None:
    args = sys.argv[1:]
    if "--guide" in args:
        with open(GUIDE, encoding="utf-8") as f:
            print(f.read())
        return
    target = args[0] if args else "5001"
    url = _server_url(target)
    st, where = None, url
    try:
        with urllib.request.urlopen(url + "/api/news/translation", timeout=8) as r:
            st = json.load(r)
    except Exception as e:
        print(f"⚠ 서버 응답 없음 ({url}): {e}")
        path = os.path.join(ROOT, "data", "news_translations.json")
        try:
            with open(path, encoding="utf-8") as f:
                raw = json.load(f)
        except OSError:
            print("  번역 기록 파일도 없습니다 — 아직 한 번도 번역하지 않았어요.")
            return
        month = time.strftime("%Y-%m", time.gmtime())
        u = raw.get("usage", {}).get(month, {})
        st = {"month": month, "cached_titles": len(raw.get("titles", {})), "last": raw.get("log", [])[-5:],
              "providers": [{"id": "ms", "name": "Microsoft", "used": u.get("ms", 0), "limit": 1_900_000, "ok": None, "reason": ""},
                            {"id": "google", "name": "Google Cloud", "used": u.get("google", 0), "limit": 450_000, "ok": None, "reason": ""}]}
        where = path + " (파일 직접)"

    print(f"\n📰 뉴스 제목 번역 상태 — {where}")
    print(f"   {st['month']} (UTC 기준 달) · 저장된 번역 {st['cached_titles']:,}건\n")
    for i, p in enumerate(st["providers"], 1):
        state = "알 수 없음" if p["ok"] is None else ("✅ 사용 가능" if p["ok"] else f"⏸ 쉬는 중 — {p['reason'].splitlines()[0][:70]}")
        role = "주 번역" if p["id"] == "ms" else "예비 (①이 안 될 때만)"
        print(f" {'①②'[i - 1]} {p['name']:<13} {role}")
        print(f"    이번 달 {p['used']:>9,} / {p['limit']:,}자  {_bar(p['used'], p['limit'])}")
        print(f"    상태: {state}\n")
    if st.get("last"):
        print(" 최근 기록")
        for ts, p, ok, msg in st["last"]:
            t = time.strftime("%m-%d %H:%M", time.localtime(ts))
            print(f"   {t}  {'Microsoft' if p == 'ms' else 'Google':<9} {'성공' if ok == 'ok' else '실패'}  {msg.splitlines()[0][:70]}")
    if any("키 없음" in (p.get("reason") or "") for p in st["providers"]):
        print("\n 💡 키 받는 방법: .venv/bin/python scripts/news_translate_status.py --guide")
    print()


if __name__ == "__main__":
    main()
