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


# ── 모의투자용 시세 (11-26) ── 호가·현재가·시간외·휴장일. mkt: J(KRX)·NX(넥스트레이드)·UN(통합)
def book(code: str, mkt: str = "UN") -> dict | None:
    """호가 10단계 스냅숏 {asks:[(가격, 잔량)] 최우선부터, bids, total_ask, total_bid, price, prev_close(기준가), open, high, low}."""
    j = get(_Q + "inquire-asking-price-exp-ccn", "FHKST01010200", {"FID_COND_MRKT_DIV_CODE": mkt, "FID_INPUT_ISCD": code})
    if not j:
        return None
    o, o2 = j.get("output1") or {}, j.get("output2") or {}
    asks = [(_i(o.get(f"askp{i}")), _i(o.get(f"askp_rsqn{i}"))) for i in range(1, 11)]
    bids = [(_i(o.get(f"bidp{i}")), _i(o.get(f"bidp_rsqn{i}"))) for i in range(1, 11)]
    return {"asks": [x for x in asks if x[0]], "bids": [x for x in bids if x[0]],
            "total_ask": _i(o.get("total_askp_rsqn")), "total_bid": _i(o.get("total_bidp_rsqn")),
            "price": _i(o2.get("stck_prpr")), "prev_close": _i(o2.get("stck_sdpr")), "open": _i(o2.get("stck_oprc")),
            "high": _i(o2.get("stck_hgpr")), "low": _i(o2.get("stck_lwpr")), "hour": o.get("aspr_acpt_hour")}


def price(code: str, mkt: str = "UN") -> dict | None:
    """현재가 {price, prev_close, chg, rate, vol, open, high, low, upper, lower, name}."""
    j = get(_Q + "inquire-price", "FHKST01010100", {"FID_COND_MRKT_DIV_CODE": mkt, "FID_INPUT_ISCD": code})
    o = (j or {}).get("output") or {}
    if not _i(o.get("stck_prpr")):      # 넥스트레이드에 없는 종목은 0으로 옴
        return None
    sign = -1 if o.get("prdy_vrss_sign") in ("4", "5") else 1
    return {"price": _i(o.get("stck_prpr")), "prev_close": _i(o.get("stck_sdpr")), "chg": sign * abs(_i(o.get("prdy_vrss"))),
            "rate": _f(o.get("prdy_ctrt")), "vol": _i(o.get("acml_vol")), "open": _i(o.get("stck_oprc")),
            "high": _i(o.get("stck_hgpr")), "low": _i(o.get("stck_lwpr")), "upper": _i(o.get("stck_mxpr")), "lower": _i(o.get("stck_llam"))}


def overtime(code: str) -> dict | None:
    """시간외 단일가 현재 {price, vol, upper, lower} (체결 없으면 price 0)."""
    j = get(_Q + "inquire-overtime-price", "FHPST02300000", {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code})
    o = (j or {}).get("output") or {}
    if not o:
        return None
    return {"price": _i(o.get("ovtm_untp_prpr")), "vol": _i(o.get("ovtm_untp_vol")),
            "upper": _i(o.get("ovtm_untp_mxpr")), "lower": _i(o.get("ovtm_untp_llam"))}


def overtime_book(code: str) -> dict | None:
    j = get(_Q + "inquire-overtime-asking-price", "FHPST02300400", {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code})
    o = (j or {}).get("output") or {}
    if not o:
        return None
    asks = [(_i(o.get(f"ovtm_untp_askp{i}")), _i(o.get(f"ovtm_untp_askp_rsqn{i}"))) for i in range(1, 10)]
    bids = [(_i(o.get(f"ovtm_untp_bidp{i}")), _i(o.get(f"ovtm_untp_bidp_rsqn{i}"))) for i in range(1, 10)]
    return {"asks": [x for x in asks if x[0]], "bids": [x for x in bids if x[0]],
            "total_ask": _i(o.get("ovtm_untp_total_askp_rsqn")), "total_bid": _i(o.get("ovtm_untp_total_bidp_rsqn"))}


# ── 조건검색용 (11-26, condsearch.py) ─────────────────────────────────────────
def stock_status(code: str) -> dict | None:
    """종목 상태 {관리·투자위험·투자경고·투자주의·거래정지·정리매매·환기·단기과열: bool} (KRX 현재가 조회의 구분 값)."""
    j = get(_Q + "inquire-price", "FHKST01010100", {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code})
    o = (j or {}).get("output") or {}
    if not o:
        return None
    st, warn = o.get("iscd_stat_cls_code") or "", o.get("mrkt_warn_cls_code") or "00"
    return {"관리": o.get("mang_issu_cls_code") == "Y" or st == "51",
            "투자위험": warn == "03" or st == "52",
            "투자경고": warn == "02" or st == "53",
            "투자주의": warn == "01" or st == "54",
            "거래정지": o.get("temp_stop_yn") == "Y" or st == "58",
            "정리매매": o.get("sltr_yn") == "Y",
            "환기": o.get("invt_caful_yn") == "Y",          # 투자주의환기종목 (투자유의 여부 값으로 판정)
            "단기과열": o.get("short_over_yn") == "Y" or st == "59"}


def strength(code: str, mkt: str = "J") -> float | None:
    """체결강도 % (최근 체결의 당일 체결강도). mkt: J = KRX, NX = 넥스트레이드(프리마켓엔 J가 빈 값)."""
    j = get(_Q + "inquire-ccnl", "FHKST01010300", {"FID_COND_MRKT_DIV_CODE": mkt, "FID_INPUT_ISCD": code})
    rows = (j or {}).get("output") or []
    return _f(rows[0].get("tday_rltv")) if rows else None


def minute_bars(code: str, mkt: str, hour: str) -> list[tuple] | None:
    """오늘 1분봉 — hour(HHMMSS)까지 최근 30개, 최신부터. [(날짜, HHMMSS, 시가, 고가, 저가, 종가, 그 1분 거래량)].
    mkt NX = 넥스트레이드(08:00 프리마켓 포함), J = KRX. 시세가 없는 분은 가격 0으로 온다."""
    j = get(_Q + "inquire-time-itemchartprice", "FHKST03010200",
            {"FID_ETC_CLS_CODE": "", "FID_COND_MRKT_DIV_CODE": mkt, "FID_INPUT_ISCD": code,
             "FID_INPUT_HOUR_1": hour, "FID_PW_DATA_INCU_YN": "Y"})
    if not j:
        return None
    return [(x.get("stck_bsop_date"), x.get("stck_cntg_hour") or "", _i(x.get("stck_oprc")), _i(x.get("stck_hgpr")),
             _i(x.get("stck_lwpr")), _i(x.get("stck_prpr")), _i(x.get("cntg_vol"))) for x in j.get("output2") or []]


def expected_rank(market: str, min_vol: int = 0) -> list[dict]:
    """장 시작 전 예상체결 상승률 상위 30 (market: '0001' 코스피 · '1001' 코스닥).
    [{code, name, price(예상체결가), base(기준가), rate(%), vol(예상체결량)}]"""
    j = get("/uapi/domestic-stock/v1/ranking/exp-trans-updown", "FHPST01820000", {
        "fid_rank_sort_cls_code": "0", "fid_cond_mrkt_div_code": "J", "fid_cond_scr_div_code": "20182",
        "fid_input_iscd": market, "fid_div_cls_code": "0", "fid_aply_rang_prc_1": "", "fid_vol_cnt": str(min_vol or ""),
        "fid_pbmn": "", "fid_blng_cls_code": "0", "fid_mkop_cls_code": "0"})
    out = []
    for x in (j or {}).get("output") or []:
        code, price = x.get("stck_shrn_iscd"), _i(x.get("stck_prpr"))
        if code and price:
            out.append({"code": code, "name": (x.get("hts_kor_isnm") or "").strip(), "price": price,
                        "base": _i(x.get("stck_sdpr")), "rate": _f(x.get("prdy_ctrt")), "vol": _i(x.get("cntg_vol"))})
    return out


_holi: dict[str, bool] = {}


def is_open_day(day: str) -> bool | None:
    """day 'YYYY-MM-DD'가 국내 개장일인지 (KIS 휴장일 조회, 하루 한 번 몇 주치를 받아 둠). 모르면 None."""
    if day in _holi:
        return _holi[day]
    j = get("/uapi/domestic-stock/v1/quotations/chk-holiday", "CTCA0903R", {"BASS_DT": day.replace("-", ""), "CTX_AREA_NK": "", "CTX_AREA_FK": ""})
    for x in ((j or {}).get("output") or []):
        if x.get("bass_dt"):
            _holi[_day(x["bass_dt"])] = x.get("opnd_yn") == "Y"
    return _holi.get(day)


# ── 실시간 웹소켓 (11-26) ── 호가·체결을 받아 콜백으로 넘김. 키 하나에 연결 하나, 구독은 지금 3개까지(11-26 확인, 신규 계좌 제한으로 보임)
WS_URL = "ws://ops.koreainvestment.com:21000/tryitout/H0STCNT0"
# TR별 필드 위치 (KIS 공식 예제 open-trading-api의 columns 순서)
_F_BOOK = {"code": 0, "hour": 1, "ask": 3, "bid": 13, "ask_q": 23, "bid_q": 33, "total_ask": 43, "total_bid": 44, "acml_vol": 53}
_F_OBOOK = {"code": 0, "hour": 1, "ask": 3, "bid": 12, "ask_q": 21, "bid_q": 30, "total_ask": 39, "total_bid": 40, "n": 9}
_F_TRADE = {"code": 0, "hour": 1, "price": 2, "sign": 3, "chg": 4, "rate": 5, "open": 7, "high": 8, "low": 9, "vol": 12,
            "acml_vol": 13, "side": 21, "strength": 18}
TR_BOOK = {"UN": "H0UNASP0", "J": "H0STASP0", "NX": "H0NXASP0", "OT": "H0STOAA0"}
TR_TRADE = {"UN": "H0UNCNT0", "J": "H0STCNT0", "NX": "H0NXCNT0", "OT": "H0STOUP0"}
_TR_VENUE = {v: k for k, v in {**TR_BOOK}.items()} | {v: k for k, v in TR_TRADE.items()}


def _parse(tr: str, vals: list[str]) -> dict:
    venue = _TR_VENUE.get(tr, "")
    if tr in TR_BOOK.values():
        f = _F_OBOOK if tr == "H0STOAA0" else _F_BOOK
        n = f.get("n", 10)
        g = lambda k, i=0: vals[f[k] + i] if f[k] + i < len(vals) else "0"
        return {"type": "book", "venue": venue, "code": vals[0], "hour": g("hour"),
                "asks": [(_i(g("ask", i)), _i(g("ask_q", i))) for i in range(n) if _i(g("ask", i))],
                "bids": [(_i(g("bid", i)), _i(g("bid_q", i))) for i in range(n) if _i(g("bid", i))],
                "total_ask": _i(g("total_ask")), "total_bid": _i(g("total_bid"))}
    f = _F_TRADE
    g = lambda k: vals[f[k]] if f[k] < len(vals) else "0"
    sign = -1 if g("sign") in ("4", "5") else 1
    return {"type": "trade", "venue": venue, "code": vals[0], "hour": g("hour"), "price": _i(g("price")),
            "chg": sign * abs(_i(g("chg"))), "rate": _f(g("rate")), "open": _i(g("open")), "high": _i(g("high")), "low": _i(g("low")),
            "vol": _i(g("vol")), "acml_vol": _i(g("acml_vol")), "side": g("side"), "strength": _f(g("strength"))}


class Realtime:
    """KIS 실시간 연결 하나 — want(set of (tr, code))를 맞춰 구독/해지, 받은 값은 on_data(dict)로."""

    def __init__(self, on_data):
        self.on_data = on_data
        self.want: set[tuple[str, str]] = set()
        self.have: set[tuple[str, str]] = set()
        self.status = "꺼짐"
        self._stop = False
        self._ws = None
        self._key = None
        self._key_at = 0.0
        self._lk = threading.Lock()

    def set_want(self, pairs: set) -> None:
        with self._lk:
            self.want = set(pairs)

    def _approval(self) -> str | None:
        if self._key and time.time() - self._key_at < 12 * 3600:
            return self._key
        k = _keys()
        if not k:
            return None
        try:
            j = requests.post(REAL_BASE + "/oauth2/Approval", json={"grant_type": "client_credentials", "appkey": k[0], "secretkey": k[1]},
                              timeout=15).json()
        except Exception as e:
            log.warning(f"KIS 실시간 승인키 실패: {e}")
            return None
        self._key, self._key_at = j.get("approval_key"), time.time()
        return self._key

    def _send(self, tr: str, code: str, on: bool) -> None:
        self._ws.send(json.dumps({"header": {"approval_key": self._key, "custtype": "P", "tr_type": "1" if on else "2",
                                             "content-type": "utf-8"}, "body": {"input": {"tr_id": tr, "tr_key": code}}}))

    def run(self) -> None:
        import simple_websocket
        back = 2
        while not self._stop:
            if not self.want:
                self.status = "대기 (보는 종목 없음)"
                time.sleep(1)
                continue
            if not self._approval():
                self.status = "승인키 실패"
                time.sleep(60)
                continue
            try:
                self._ws = simple_websocket.Client.connect(WS_URL)
                self.have = set()
                self.status = "연결됨"
                back = 2
                while not self._stop:
                    with self._lk:
                        want = set(self.want)
                    for tr, code in sorted(self.have - want):
                        self._send(tr, code, False)
                        self.have.discard((tr, code))
                    for tr, code in sorted(want - self.have):
                        self._send(tr, code, True)
                        self.have.add((tr, code))
                    if not want:
                        break
                    msg = self._ws.receive(timeout=1)
                    if msg is None:
                        continue
                    if isinstance(msg, bytes):
                        msg = msg.decode("utf-8", "replace")
                    if msg[:1] in ("0", "1"):          # 0|TR|건수|값^값...  (1이면 암호화 — 체결통보용, 여기선 안 씀)
                        parts = msg.split("|", 3)
                        if len(parts) == 4 and parts[0] == "0":
                            tr, cnt, body = parts[1], int(parts[2] or 1), parts[3].split("^")
                            per = len(body) // max(cnt, 1)
                            for i in range(cnt):
                                try:
                                    self.on_data(_parse(tr, body[i * per:(i + 1) * per]))
                                except Exception as e:
                                    log.warning(f"KIS 실시간 처리 오류 {tr}: {e}")
                        continue
                    try:
                        j = json.loads(msg)
                    except ValueError:
                        continue
                    h = j.get("header") or {}
                    if h.get("tr_id") == "PINGPONG":
                        self._ws.send(msg)
                        continue
                    b = j.get("body") or {}
                    if b.get("rt_cd") == "1":
                        log.info(f"KIS 실시간 {h.get('tr_id')} {h.get('tr_key')}: {b.get('msg1')}")
                        if "MAX SUBSCRIBE" in str(b.get("msg1")):
                            self.have.discard((h.get("tr_id"), h.get("tr_key")))
                            with self._lk:
                                self.want.discard((h.get("tr_id"), h.get("tr_key")))
                            self.status = "구독 한도 초과"
            except Exception as e:
                self.status = f"끊김 — {str(e)[:60]}"
                log.info(f"KIS 실시간 끊김: {e}")
            finally:
                try:
                    if self._ws:
                        self._ws.close()
                except Exception:
                    pass
                self._ws = None
                self.have = set()
            if not self._stop and self.want:
                time.sleep(back)
                back = min(back * 2, 60)

    def stop(self) -> None:
        self._stop = True
