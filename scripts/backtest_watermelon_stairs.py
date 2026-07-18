"""
backtest_watermelon_stairs.py -- 수박지표(오리지널/업그레이드)·세력계단(계단지표) 백테스트
사용자가 보유한 키움 HTS 커스텀 수식(강의자료 .txt)을 파이썬으로 번역해 US/KR 700종목 백테스트.

핵심 공통 로직: EMA(종가,26)+2.5*STDEV(전형가격,26)를 25봉 전 시점 값으로 지연시켜
"세력 매집 추정선"처럼 사용 -- 과거 변동성 밴드 위치가 현재까지 지지 역할을 한다는 논리.

- 세력계단(계단지표)의 "근접1"/"근접2"는 수식에 명시된 매수후보 조건을 그대로 구현(해석 여지 적음)
- 수박지표(오리지널/업그레이드)는 "스케일:화면"(가격축이 아닌 독립 오실레이터 패널)이라
  선 값을 가격과 직접 비교할 수 없음. 라인설정에 "기준값:0"이 명시돼 있고 수식도 트렌드
  조건 불만족 시 값을 0으로 꺼버리는 구조라, "껍질(최소값) 라인이 0에서 양수로 전환되는
  시점"을 매수 신호로 해석해 테스트함 -- 원 강의 영상에만 있는 정확한 진입 규칙과 다를 수 있음

EMA448 같은 장기 이평 워밍업을 위해 2년이 아닌 5년치 데이터로 조회.

실행: python scripts/backtest_watermelon_stairs.py [N종목]
"""
import json, sys, os
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import requests
import data_fetcher

HEADERS      = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
FWD_DAYS     = [5, 10, 20]
MAX_WORKERS  = 5
N_STOCKS     = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] != 'kr' else 700


# ── 종목 유니버스 로드 ────────────────────────────────────────────────────────
def load_us_topN(n):
    print(f"  US 시총 상위 {n}종목 로드 중 (Nasdaq API)...", flush=True)
    stocks = data_fetcher.fetch_nasdaq_stocks(min_market_cap_b=0.0)
    if not stocks:
        raise RuntimeError("Nasdaq API 실패")
    tickers = [s['ticker'] for s in stocks[:n]]
    print(f"  US {len(tickers)}종목 로드 완료")
    return tickers


def load_kr_topN(n):
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'kr_stocks.json')
    with open(path, encoding='utf-8') as f:
        stocks = json.load(f)
    valid = [s for s in stocks if s.get('market_cap') and s['market_cap'] > 0]
    valid.sort(key=lambda s: s['market_cap'], reverse=True)
    tickers = [s['ticker'] for s in valid[:n]]
    print(f"  KR {len(tickers)}종목 로드 완료")
    return tickers


def load_kr_kospi_kosdaq(n_kospi, n_kosdaq):
    """코스피(.KS)·코스닥(.KQ)을 시총 상위 개수로 각각 나눠서 로드 -- 시총 통합정렬(top-N)이면
    코스피 대형주 위주로 쏠려서 코스닥이 거의 안 뽑히는 문제를 피하기 위함."""
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'kr_stocks.json')
    with open(path, encoding='utf-8') as f:
        stocks = json.load(f)
    valid = [s for s in stocks if s.get('market_cap') and s['market_cap'] > 0]
    kospi  = sorted((s for s in valid if s['ticker'].endswith('.KS')), key=lambda s: s['market_cap'], reverse=True)
    kosdaq = sorted((s for s in valid if s['ticker'].endswith('.KQ')), key=lambda s: s['market_cap'], reverse=True)
    tickers = [s['ticker'] for s in kospi[:n_kospi]] + [s['ticker'] for s in kosdaq[:n_kosdaq]]
    print(f"  KR 코스피 {min(n_kospi, len(kospi))}종목 + 코스닥 {min(n_kosdaq, len(kosdaq))}종목 = {len(tickers)}종목 로드 완료")
    return tickers


# ── OHLCV 수집 (5년치, 스레드풀 + 429 서킷브레이커) ───────────────────────────
def fetch_ohlcv(ticker):
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}'
    try:
        r = requests.get(url, params={'range': '5y', 'interval': '1d', 'includePrePost': False},
                          headers=HEADERS, timeout=15)
        if r.status_code == 429:
            return [], 429
        d = r.json()['chart']['result'][0]
        ts = d['timestamp']
        q  = d['indicators']['quote'][0]
        out = []
        for i in range(len(ts)):
            o, h, l, c, v = q['open'][i], q['high'][i], q['low'][i], q['close'][i], q['volume'][i]
            if None in (o, h, l, c):
                continue
            out.append({'time': ts[i], 'open': o, 'high': h, 'low': l, 'close': c, 'volume': v or 0})
        return out, r.status_code
    except Exception:
        return [], 0


def fetch_all(tickers):
    result = {}
    consecutive_429 = 0
    done = 0
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = {ex.submit(fetch_ohlcv, t): t for t in tickers}
        for fut in as_completed(futs):
            ohlcv, status = fut.result()
            done += 1
            consecutive_429 = consecutive_429 + 1 if status == 429 else 0
            if len(ohlcv) >= 460:  # EMA448 워밍업 최소치
                result[futs[fut]] = ohlcv
            if done % 50 == 0 or done == len(tickers):
                print(f"  [{done:>4}/{len(tickers)}] 수집 진행 (유효 {len(result)}개)", flush=True)
            if consecutive_429 >= 15:
                print(f"  429 연속 {consecutive_429}회 -- Yahoo 차단으로 판단해 조기 중단합니다.")
                break
    return result


# ── 공용 지표 함수 (키움 수식언어 -> 파이썬 번역) ─────────────────────────────
def _ema(arr, period):
    k = 2 / (period + 1)
    r = [None] * len(arr)
    start = next((i for i, v in enumerate(arr) if v is not None), None)
    if start is None or start + period - 1 >= len(arr):
        return r
    r[start + period - 1] = sum(v for v in arr[start:start + period] if v is not None) / period
    for i in range(start + period, len(arr)):
        if arr[i] is None or r[i - 1] is None:
            continue
        r[i] = arr[i] * k + r[i - 1] * (1 - k)
    return r


def _stdev(arr, period):
    r = [None] * len(arr)
    for i in range(period - 1, len(arr)):
        sl = arr[i - period + 1:i + 1]
        if None in sl:
            continue
        mean = sum(sl) / period
        r[i] = (sum((x - mean) ** 2 for x in sl) / period) ** 0.5
    return r


def _shift(arr, n):
    """키움 X(n) 구문: n봉 전 값."""
    r = [None] * len(arr)
    for i in range(n, len(arr)):
        r[i] = arr[i - n]
    return r


def _highest(arr, period):
    r = [None] * len(arr)
    for i in range(period - 1, len(arr)):
        sl = [v for v in arr[i - period + 1:i + 1] if v is not None]
        if sl:
            r[i] = max(sl)
    return r


def _lowest(arr, period):
    r = [None] * len(arr)
    for i in range(period - 1, len(arr)):
        sl = [v for v in arr[i - period + 1:i + 1] if v is not None]
        if sl:
            r[i] = min(sl)
    return r


def _valuewhen(cond, x):
    """키움 valuewhen(1,cond,x): cond가 True인 가장 최근 시점의 x값을 그 이후 계속 유지."""
    r = [None] * len(cond)
    last = None
    for i in range(len(cond)):
        if cond[i]:
            last = x[i]
        r[i] = last
    return r


# ── 핵심 공통 밴드 (수박지표/계단지표 공용) ───────────────────────────────────
def calc_band_lagged25(ohlcv, period=26, d1=2.5):
    """a1(수박) / a2·a3(계단) 공통: EMA(c,26)+2.5*STDEV(전형가,26)를 25봉 지연."""
    closes  = [d['close'] for d in ohlcv]
    typical = [(d['close'] + d['high'] + d['low']) / 3 for d in ohlcv]
    ema = _ema(closes, period)
    std = _stdev(typical, period)
    raw = [ema[i] + d1 * std[i] if ema[i] is not None and std[i] is not None else None
           for i in range(len(closes))]
    return _shift(raw, 25)


# ── 수박지표 오리지널 ─────────────────────────────────────────────────────────
def watermelon_original_events(ohlcv):
    closes = [d['close'] for d in ohlcv]
    highs  = [d['high']  for d in ohlcv]
    n = len(ohlcv)
    ema112, ema224, ema448 = _ema(closes, 112), _ema(closes, 224), _ema(closes, 448)
    a2 = calc_band_lagged25(ohlcv)
    size1, size2 = 7.5, 4.5
    subak = [v / size1 if v is not None else None for v in a2]

    x = [None] * n
    y = [None] * n
    for i in range(n):
        if subak[i] is None or ema112[i] is None or ema224[i] is None or ema448[i] is None:
            continue
        x1 = 0.0 if ema224[i] > ema448[i] else subak[i]
        x[i] = x1 if ema112[i] > ema224[i] else subak[i]

        b1, b2 = highs[i] / size1, highs[i] / size2
        y1 = b2 if subak[i] < b1 else b1
        y2 = 0.0 if ema224[i] > ema448[i] else y1
        y[i] = y2 if ema112[i] > ema224[i] else y1

    return _shell_zero_cross_events(x, y)


# ── 수박지표 업그레이드 ───────────────────────────────────────────────────────
def watermelon_upgrade_events(ohlcv):
    closes = [d['close'] for d in ohlcv]
    highs  = [d['high']  for d in ohlcv]
    n = len(ohlcv)
    ema5, ema112, ema224, ema448 = _ema(closes, 5), _ema(closes, 112), _ema(closes, 224), _ema(closes, 448)
    a2 = calc_band_lagged25(ohlcv)
    size1, size2 = 7.5, 4.5
    gap_ma, gap_long = 1, 15
    subak = [v / size1 if v is not None else None for v in a2]

    x = [None] * n
    y = [None] * n
    for i in range(n):
        if None in (subak[i], ema5[i], ema112[i], ema224[i], ema448[i]):
            continue
        cond = (ema112[i] * (100 + gap_ma) / 100 < ema224[i]
                and ema224[i] * (100 + gap_ma) / 100 < ema448[i]
                and closes[i] <= ema224[i] * (100 + gap_long) / 100
                and ema5[i] > ema112[i])
        x1 = subak[i] if cond else 0.0
        x[i] = 0.0 if closes[i] < ema112[i] else x1

        b1, b2 = highs[i] / size1, highs[i] / size2
        y1 = b2 if subak[i] < b1 else b1
        y2 = y1 if cond else 0.0
        y[i] = 0.0 if closes[i] < ema112[i] else y2

    return _shell_zero_cross_events(x, y)


def _shell_zero_cross_events(x, y):
    """껍질(min(x,y))이 0(또는 음수)에서 양수로 전환되는 시점 = 매수 신호.
    (라인설정 '기준값:0' 근거 -- 스케일:화면인 오실레이터라 가격과 직접 비교 불가)"""
    events = []
    prev_shell = None
    for i in range(len(x)):
        if x[i] is None or y[i] is None:
            prev_shell = None
            continue
        shell = x[i] if x[i] < y[i] else y[i]
        if prev_shell is not None and prev_shell <= 0 and shell > 0:
            events.append((i, 'buy'))
        prev_shell = shell
    return events


# ── 세력계단 (계단지표) ───────────────────────────────────────────────────────
def stairs_events(ohlcv):
    closes = [d['close'] for d in ohlcv]
    highs  = [d['high']  for d in ohlcv]
    lows   = [d['low']   for d in ohlcv]
    n = len(ohlcv)
    ema112, ema224, ema448 = _ema(closes, 112), _ema(closes, 224), _ema(closes, 448)

    a3 = calc_band_lagged25(ohlcv)  # a2/a3 = 25봉 지연 밴드 (수박지표의 a2와 동일 개념)

    step_len = 7
    b1 = _highest(a3, step_len)
    b1_shift1 = _shift(b1, 1)
    cond_b2 = [a3[i] is not None and b1_shift1[i] is not None and a3[i] > b1_shift1[i] for i in range(n)]
    b2 = _valuewhen(cond_b2, a3)
    a3_shift1 = _shift(a3, 1)
    cond_b3 = [a3[i] is not None and a3_shift1[i] is not None and a3[i] < a3_shift1[i] for i in range(n)]
    b3 = _valuewhen(cond_b3, b2)

    hi52, lo52 = _highest(highs, 52), _lowest(lows, 52)
    p1_full = [None] * n
    for i in range(n):
        if hi52[i] is not None and lo52[i] is not None:
            p1_full[i] = (hi52[i] + lo52[i]) / 2
    p2 = _shift(p1_full, 25)

    step_exit, support, cloud_gap, gap224, ready, start = 8, 112, 8, 8, 8, 5
    ema_support = ema112  # 지원군=112 -> EMA(c,112)

    events = []
    for i in range(n):
        if None in (a3[i], ema112[i], ema224[i], ema448[i], p2[i], ema_support[i]):
            continue
        y1 = ema112[i] < ema448[i]
        y3 = closes[i] < p2[i] * (100 + cloud_gap) / 100
        y4 = closes[i] >= ema224[i] * (100 - gap224) / 100
        y5 = closes[i] <= ema224[i] * (100 + gap224) / 100
        y6 = a3[i] <= closes[i] * (100 + ready) / 100
        y7 = closes[i] <= a3[i] * (100 + support) / 100  # 단기이격도 8 (재사용)
        y2 = closes[i] < ema_support[i]
        if y1 and y2 and y3 and y4 and y5 and y6 and y7:
            events.append((i, 'buy'))
            continue
        z1 = closes[i] > ema_support[i]
        z2 = a3[i] <= closes[i] * (100 + start) / 100
        if y1 and y3 and y4 and y5 and y7 and z1 and z2:
            events.append((i, 'buy'))
    return events


# ── 백테스트 집계 ──────────────────────────────────────────────────────────────
def backtest_events(closes, events, fwd):
    n = len(closes)
    total = ok = 0
    for i, kind in events:
        if i + fwd >= n:
            continue
        future = closes[i + fwd]
        correct = (future > closes[i]) if kind == 'buy' else (future < closes[i])
        total += 1
        ok += 1 if correct else 0
    return total, ok


INDICATORS = {
    'watermelon_original': ('수박지표 (오리지널, 껍질 제로크로스 해석)', watermelon_original_events),
    'watermelon_upgrade':  ('수박지표 (업그레이드, 껍질 제로크로스 해석)', watermelon_upgrade_events),
    'stairs':              ('세력계단 (근접1/근접2 명시조건)', stairs_events),
}


def run(label, tickers):
    print(f"\n{'=' * 70}\n  [{label}] {len(tickers)}종목 백테스트 (5년치 데이터)\n{'=' * 70}")
    all_ohlcv = fetch_all(tickers)
    print(f"  유효 데이터 {len(all_ohlcv)}/{len(tickers)}종목 (460거래일 이상)")

    agg = {k: {fwd: {'total': 0, 'ok': 0} for fwd in FWD_DAYS} for k in INDICATORS}

    for ticker, ohlcv in all_ohlcv.items():
        closes = [d['close'] for d in ohlcv]
        for key, (_, fn) in INDICATORS.items():
            try:
                events = fn(ohlcv)
            except Exception:
                continue
            for fwd in FWD_DAYS:
                tot, ok = backtest_events(closes, events, fwd)
                agg[key][fwd]['total'] += tot
                agg[key][fwd]['ok']    += ok

    def p(ok, tot):
        return f"{ok / tot * 100:5.1f}%" if tot else "  N/A"

    print(f"\n  == [{label}] 지표별 매수 적중률 (전부 매수전용 신호) ==")
    for key, (label_kr, _) in INDICATORS.items():
        print(f"\n  [{key}] {label_kr}")
        print(f"  {'기준일':>6} {'신호건수':>8} {'적중률':>8}")
        print("  " + "-" * 26)
        for fwd in FWD_DAYS:
            a = agg[key][fwd]
            print(f"  {fwd:>4}일 {a['total']:>8} {p(a['ok'], a['total'])}")
    return agg


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'kr':
        # KR만, 코스피/코스닥 개수를 따로 지정: python ... kr <코스피개수> <코스닥개수>
        n_kospi  = int(sys.argv[2]) if len(sys.argv) > 2 else 2000
        n_kosdaq = int(sys.argv[3]) if len(sys.argv) > 3 else 1000
        print(f"\n  수박지표(오리지널/업그레이드)·세력계단 백테스트 -- KR 코스피{n_kospi}+코스닥{n_kosdaq}종목")
        print("  (전부 매수전용 신호 -- 매도 신호는 정의되지 않음)\n")
        kr_tickers = load_kr_kospi_kosdaq(n_kospi, n_kosdaq)
        kr_agg = run(f"KR 코스피{n_kospi}+코스닥{n_kosdaq}", kr_tickers)
    else:
        print(f"\n  수박지표(오리지널/업그레이드)·세력계단 백테스트 -- US/KR {N_STOCKS}종목 / 5·10·20일 매수 적중률")
        print("  (전부 매수전용 신호 -- 매도 신호는 정의되지 않음)\n")

        us_tickers = load_us_topN(N_STOCKS)
        us_agg = run(f"US 시총상위 {N_STOCKS}", us_tickers)

        kr_tickers = load_kr_topN(N_STOCKS)
        kr_agg = run(f"KR 시총상위 {N_STOCKS}", kr_tickers)

    print("\n  백테스트 완료.")
