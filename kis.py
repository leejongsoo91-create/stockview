"""kis.py — 한국투자증권 KIS Open API (11-26)

조회 전용. 주문 함수는 두지 않는다 — 모의투자는 사이트 자체 가상계좌(실전 키로 시세만 받음), 실전 주문은 로드맵 F 전까지 만들지 않음.

키 파일 api/kis.txt (git 제외, 권한 600): 1 실전 앱키 · 2 실전 앱시크릿 · 3 실전 계좌 · 4 모의 앱키 · 5 모의 앱시크릿 · 6 모의 계좌
토큰은 하루짜리라 api/kis_token_real.json에 저장해 재사용 (재발급은 1분에 1번만 허용됨).
호출 한도가 초당 약 3번(11-26 측정)이라 모든 요청을 한 줄로 세워 0.35초 간격을 둔다.
"""
import json
import logging
import os
import threading
import time
from datetime import date, timedelta

import requests

log = logging.getLogger(__name__)

_API_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "api")
REAL_BASE = "https://openapi.koreainvestment.com:9443"
_Q = "/uapi/domestic-stock/v1/quotations/"
_GAP = 0.35

_lock = threading.Lock()          # 호출 간격·토큰 발급을 한 줄로
_last_call = 0.0
_token: dict = {}
_token_fail_at = 0.0


def _keys() -> tuple[str, str] | None:
    try:
        with open(os.path.join(_API_DIR, "kis.txt"), encoding="utf-8-sig") as f:
            lines = [l.strip() for l in f.read().splitlines()]
        return (lines[0], lines[1]) if len(lines) >= 2 and lines[0] and lines[1] else None
    except OSError:
        return None


def enabled() -> bool:
    return _keys() is not None


def _get_token() -> str | None:
    """실전 접속 토큰 (파일 캐시, 만료 10분 전 재발급). _lock 안에서 부른다."""
    global _token, _token_fail_at
    now = time.time()
    if _token.get("exp", 0) > now + 600:
        return _token["tok"]
    path = os.path.join(_API_DIR, "kis_token_real.json")
    try:
        with open(path, encoding="utf-8") as f:
            t = json.load(f)
        if t.get("exp", 0) > now + 600:
            _token = t
            return t["tok"]
    except (OSError, ValueError):
        pass
    if now - _token_fail_at < 65:      # 재발급 1분 제한
        return None
    k = _keys()
    if not k:
        return None
    try:
        j = requests.post(REAL_BASE + "/oauth2/tokenP", json={"grant_type": "client_credentials", "appkey": k[0], "appsecret": k[1]},
                          timeout=15).json()
    except Exception as e:
        _token_fail_at = now
        log.warning(f"KIS 토큰 실패: {e}")
        return None
    if "access_token" not in j:
        _token_fail_at = now
        log.warning(f"KIS 토큰 실패: {j.get('error_code')} {j.get('error_description')}")
        return None
    _token = {"tok": j["access_token"], "exp": now + int(j.get("expires_in", 86400))}
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(_token, f)
    except OSError as e:
        log.warning(f"KIS 토큰 저장 실패: {e}")
    return _token["tok"]


def get(path: str, tr_id: str, params: dict, retry: int = 2) -> dict | None:
    """실전 조회 GET. 초당 한도 초과(EGW00201)면 잠깐 쉬고 다시."""
    global _last_call
    k = _keys()
    if not k:
        return None
    for attempt in range(retry + 1):
        with _lock:
            tok = _get_token()
            if not tok:
                return None
            wait = _GAP - (time.time() - _last_call)
            if wait > 0:
                time.sleep(wait)
            _last_call = time.time()
        try:
            r = requests.get(REAL_BASE + path, params=params, timeout=12,
                             headers={"authorization": "Bearer " + tok, "appkey": k[0], "appsecret": k[1], "tr_id": tr_id, "custtype": "P"})
            j = r.json()
        except Exception as e:
            log.warning(f"KIS {tr_id}: {e}")
            return None
        if j.get("rt_cd") == "0":
            return j
        if j.get("msg_cd") == "EGW00201" and attempt < retry:
            time.sleep(1.0)
            continue
        log.info(f"KIS {tr_id} {j.get('msg_cd')} {str(j.get('msg1', '')).strip()}")
        return None
    return None


def _i(v) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def _f(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _day(s: str) -> str:
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}" if s and len(s) == 8 else s


def short_daily(code: str, days: int = 60) -> list[dict]:
    """공매도 일별 [{day, short(주), vol(거래량), ratio(%)}] 오래된 것부터."""
    j = get(_Q + "daily-short-sale", "FHPST04830000", {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code,
            "FID_INPUT_DATE_1": (date.today() - timedelta(days=days)).strftime("%Y%m%d"), "FID_INPUT_DATE_2": date.today().strftime("%Y%m%d")})
    out = [{"day": _day(x.get("stck_bsop_date")), "short": _i(x.get("ssts_cntg_qty")), "vol": _i(x.get("acml_vol")),
            "ratio": _f(x.get("ssts_vol_rlim"))} for x in ((j or {}).get("output2") or []) if x.get("stck_bsop_date")]
    return sorted(out, key=lambda x: x["day"])


def credit_daily(code: str) -> list[dict]:
    """신용 융자 잔고 일별 [{day, remain(주), rate(상장주식 대비 %), new, repay}] 오래된 것부터 (약 30일, 결제일 기준 2일 늦음)."""
    j = get(_Q + "daily-credit-balance", "FHPST04760000", {"fid_cond_mrkt_div_code": "J", "fid_cond_scr_div_code": "20476",
            "fid_input_iscd": code, "fid_input_date_1": date.today().strftime("%Y%m%d")})
    out = [{"day": _day(x.get("deal_date")), "remain": _i(x.get("whol_loan_rmnd_stcn")), "rate": _f(x.get("whol_loan_rmnd_rate")),
            "new": _i(x.get("whol_loan_new_stcn")), "repay": _i(x.get("whol_loan_rdmp_stcn"))}
           for x in ((j or {}).get("output") or []) if x.get("deal_date")]
    return sorted(out, key=lambda x: x["day"])


def investor_daily(code: str) -> list[dict]:
    """투자자별 순매수(주) 일별 [{day, ind, frg, inst}] 오래된 것부터 (약 30일). 오늘 장중엔 오늘 줄이 비어 있을 수 있음."""
    j = get(_Q + "inquire-investor", "FHKST01010900", {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code})
    out = [{"day": _day(x.get("stck_bsop_date")), "ind": _i(x.get("prsn_ntby_qty")), "frg": _i(x.get("frgn_ntby_qty")),
            "inst": _i(x.get("orgn_ntby_qty"))}
           for x in ((j or {}).get("output") or []) if x.get("stck_bsop_date") and (x.get("prsn_ntby_qty") or x.get("frgn_ntby_qty"))]
    return sorted(out, key=lambda x: x["day"])
