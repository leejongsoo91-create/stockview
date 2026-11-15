"""팀 창 펼치기 — 지금 보고 있는 wmux 작업 공간에 없는 창만 골라 메인 Claude 옆에 만든다.

만드는 창(오른쪽 세로 줄, 위에서부터): 🔍 QA · 🖥 서버 :5001 · 📊 서버감시
- 이미 있으면 건너뛴다: QA = 창 제목에 'QA', 서버 = 5001 포트 사용 중, 서버감시 = server_watch.sh 실행 중
- 보조 Claude는 만들지 않는다(필요할 때만: --with-helper)
- 대상 공간: 이름이 finviz-app이거나 SV-로 시작하는 wmux 작업 공간(하나일 때). 화면에 다른 공간(예: Site)이
  떠 있어도 그 공간을 건드리지 않도록 대상 공간으로 잠깐 전환해 작업한 뒤 원래 보던 공간으로 되돌린다
- 메인 Claude가 없는 공간이면 아무것도 하지 않는다

사용 (루트에서):
  .venv/bin/python scripts/team_up.py --dry-run   # 무엇을 만들지 보기만
  .venv/bin/python scripts/team_up.py             # 실제로 만들기
  .venv/bin/python scripts/team_up.py --with-helper
  .venv/bin/python scripts/team_up.py --workspace <ws-id>   # 후보가 여러 개일 때
"""
import argparse
import json
import socket
import subprocess
import sys
import time

WMUX = r"%LOCALAPPDATA%\wmux\bin\wmux.cmd"
WSL = "wsl -d Ubuntu -u root --cd /root/stockview -- "
PORT = 5001
WS_NAMES = ("finviz-app",)   # + "SV-"로 시작하는 공간


def wm(*args: str) -> str:
    """공백·따옴표 없는 인자만 쓰는 wmux 명령 (cmd.exe 경유, UTF-8 출력 그대로)."""
    r = subprocess.run(["cmd.exe", "/c", " ".join([WMUX, *args])], cwd="/mnt/c",
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout.replace("\r", "")


def wm_send(text: str, pty: str) -> None:
    """한글·공백이 있는 명령 보내기 (PowerShell 경유 — cmd.exe는 따옴표를 그대로 넘겨 버림)."""
    t = text.replace("'", "''")
    ps = f"& \"$env:LOCALAPPDATA\\wmux\\bin\\wmux.cmd\" send '{t}' --submit --to {pty}"
    subprocess.run(["powershell.exe", "-NoProfile", "-Command", ps], cwd="/mnt/c",
                   capture_output=True)


def wm_json(*args: str):
    out = wm(*args, "--json")
    start = min(i for i in (out.find("{"), out.find("[")) if i >= 0)   # 앞쪽 경고 문구 건너뛰기
    return json.loads(out[start:])


def port_busy(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) == 0


def proc_running(pattern: str) -> bool:
    return subprocess.run(["pgrep", "-f", pattern], capture_output=True).returncode == 0


def snapshot():
    panes = wm_json("list-panes")["panes"]
    titles = {s.get("ptyId"): s.get("title") or "" for s in wm_json("list-surfaces")}
    for p in panes:
        pty = (p.get("surfacePtyIds") or [None])[0]
        p["_pty"], p["_title"] = pty, titles.get(pty, "")
    return panes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--with-helper", action="store_true", help="🛠 보조 Claude도 만든다")
    ap.add_argument("--workspace", help="대상 작업 공간 ID (생략하면 finviz-app / SV-* 중 하나)")
    a = ap.parse_args()

    spaces = wm_json("list-workspaces")
    if a.workspace:
        cands = [w for w in spaces if w["id"] == a.workspace]
    else:
        cands = [w for w in spaces if w["name"] in WS_NAMES or w["name"].startswith("SV-")]
    if len(cands) != 1:
        names = ", ".join(f"{w['name']}({w['id']})" for w in cands) or "없음"
        print(f"대상 작업 공간을 하나로 정할 수 없습니다 — 후보: {names}. --workspace로 지정하세요")
        return 1
    ws = cands[0]
    prev = wm_json("current-workspace").get("id")
    wm("focus-workspace", ws["id"])
    try:
        return run(a, ws)
    finally:
        if prev and prev != ws["id"]:
            wm("focus-workspace", prev)


def run(a, ws) -> int:
    panes = snapshot()
    claude = [p for p in panes if p.get("foregroundProgram") == "Claude Code"]
    is_qa = lambda p: "QA" in p["_title"]
    is_helper = lambda p: "보조" in p["_title"]
    mains = [p for p in claude if not is_qa(p) and not is_helper(p)]
    print(f"작업 공간: {ws.get('name')} ({ws.get('id')}) · 창 {len(panes)}개")
    if not mains:
        print("메인 Claude 창이 없는 공간입니다 — StockView 작업 공간을 띄운 뒤 다시 실행하세요. 아무것도 만들지 않음")
        return 1

    plan = []   # (이름, 명령, 이미 있음 사유)
    plan.append(("🔍 QA", f"{WSL}bash scripts/qa_agent.sh",
                 "QA 창 있음" if any(is_qa(p) for p in panes) or proc_running("StockView QA 담당") else ""))
    plan.append(("🖥 서버 :5001", f"{WSL}bash scripts/pane.sh 🖥 서버 :5001 -- env PORT=5001 .venv/bin/python app.py",
                 f"{PORT} 포트 사용 중" if port_busy(PORT) else ""))
    plan.append(("📊 서버감시", f"{WSL}bash scripts/server_watch.sh {PORT} 30",
                 "server_watch.sh 실행 중" if proc_running(r"server_watch[.]sh") else ""))
    if a.with_helper:
        plan.append(("🛠 보조", f"{WSL}bash scripts/pane.sh 🛠 보조 -- claude",
                     "보조 창 있음" if any(is_helper(p) for p in panes) else ""))

    for name, _, skip in plan:
        print(f"  {name:<12} {'건너뜀 — ' + skip if skip else '만들 예정'}")
    todo = [(n, c) for n, c, skip in plan if not skip]
    if not todo:
        print("모든 팀 창이 이미 있습니다")
        return 0
    if a.dry_run:
        return 0

    # 오른쪽 줄 기준 창: 이미 있는 팀 창(QA·서버·감시)이 있으면 그 아래로, 없으면 메인 오른쪽에 새 줄
    team_ptys = set()
    if port_busy(PORT) or proc_running(r"server_watch[.]sh"):
        team_ptys = {p["_pty"] for p in panes if p.get("foregroundProgram") is None}
    anchor = next((p for p in panes if is_qa(p) or p["_pty"] in team_ptys), None)
    for name, cmd in todo:
        before = {p["id"] for p in snapshot()}
        if anchor:
            wm("focus-pane", anchor["id"]); wm("split", "--direction", "down")
        else:
            wm("focus-pane", mains[0]["id"]); wm("split", "--direction", "right")
        new = []
        for _ in range(15):   # 새 창의 터미널 ID(ptyId)는 1~수 초 뒤에 생긴다
            time.sleep(1)
            new = [p for p in snapshot() if p["id"] not in before and p["_pty"]]
            if new:
                break
        if not new:
            print(f"  {name}: 창 만들기 실패 — 중단")
            return 1
        anchor = new[0]
        wm_send(cmd, anchor["_pty"])
        print(f"  {name}: 만듦 ({anchor['_pty']})")
        if name.startswith("🖥"):
            for _ in range(45):
                if port_busy(PORT):
                    print("    서버 응답 확인"); break
                time.sleep(2)
            else:
                print("    ⚠️ 90초 안에 서버가 뜨지 않음 — 서버 창을 확인하세요")
    wm("focus-pane", mains[0]["id"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
