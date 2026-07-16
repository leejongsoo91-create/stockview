"""
backtest_300.py -- 300종목 확대 백테스트 (전략A+B 신뢰도 검증)
US/KR 각 300종목 / 핵심 4전략 비교
실행: python scripts/backtest_300.py
"""
import json, time, sys, os, bisect
from datetime import datetime, timedelta
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import requests
import data_fetcher

HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
FWD = int(sys.argv[1]) if len(sys.argv) > 1 else 10  # 인자 없으면 10일 기준
N_STOCKS = int(sys.argv[3]) if len(sys.argv) > 3 else 300  # 인자 없으면 300종목

# S&P500 시총 상위 300종목 (중복 제거용 dict.fromkeys 사용)
_US_RAW = [
    # 1-50 (기존 US_50)
    'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','BRK-B',
    'LLY','AVGO','UNH','JPM','V','WMT','XOM','MA','ORCL',
    'PG','HD','COST','JNJ','NFLX','BAC','CRM','AMD','MRK',
    'ABBV','KO','PEP','TMO','CSCO','ACN','ABT','DHR','MCD',
    'GE','TXN','PM','CAT','IBM','ISRG','INTU','SPGI','AMGN',
    'NOW','BKNG','GS','RTX','QCOM','LOW',
    # 51-100
    'CVX','T','VZ','WFC','C','MS','AXP','BLK','DE','REGN',
    'SYK','MDT','VRTX','ADI','PLD','PANW','TJX','ETN','GILD','KLAC',
    'MU','AMAT','NEE','MMC','ADP','LRCX','BSX','BMY','FI','USB',
    'ECL','SO','ICE','NKE','DUK','EMR','MSI','EOG','COP','PH',
    'ZTS','PNC','CTAS','AON','SNPS','HCA','CARR','MCO','CME','NSC',
    # 101-150
    'PSA','TT','COF','APH','WELL','ELV','EW','MMM','CDNS','TGT',
    'FICO','APD','SPG','OKE','GD','ROP','HLT','ITW','HUM','IDXX',
    'O','VRSK','SRE','FCX','PRU','URI','PAYX','AFL','AJG','YUM',
    'DG','NUE','FAST','BK','STT','SHW','PWR','OTIS','WM','TEL',
    'TDG','RMD','ROST','GWW','LIN','WDAY','RCL','SCHW','LMT','NOC',
    # 151-200
    'GEHC','AXON','DOV','WAB','IR','CBRE','FITB','MTB','AME','CPRT',
    'ACGL','SBAC','FTV','RF','HBAN','CFG','DRI','FANG','BLDR','GRMN',
    'EXPD','CINF','IRM','ROK','IFF','WST','EFX','XYL','HIG','RJF',
    'HAL','MTD','AWK','NDAQ','ODFL','TSCO','EIX','TRV','ALL','AEE',
    'WEC','AEP','PPL','EXC','ETR','FE','CNP','ATO','LH','TRMB',
    # 201-250
    'BRO','WTW','MPWR','DECK','POOL','ANSS','PODD','STE','MOH','CRL',
    'HOLX','DXCM','DVN','HES','MPC','VLO','PSX','SLB','ALB','PKG',
    'ZBRA','CDW','HPQ','HPE','NTAP','WDC','STX','AKAM','CTSH','EPAM',
    'UNP','CSX','FDX','UPS','PCAR','CMI','ROL','LDOS','KEYS','GLW',
    'MAS','BALL','IP','CF','MLM','VMC','NVR','PHM','DHI','LEN',
    # 251-300
    'TOL','MAR','H','ABNB','F','GM','BDX','ZBH','ALGN','A',
    'BAX','IQV','CBOE','WRB','PGR','CB','SCHW','PGR','BEN','IVZ',
    'UDR','EQR','AVB','AMT','CCI','DLR','EQIX','WELL','VTR','CPT',
    'MKL','RE','AFL','L','AFG','CINF','HIG','TRV','ALL','AIG',
    'ROK','AME','XYL','ROP','IDEX','ITW','PNR','FAST','GWW','MSC',
]
US_300 = list(dict.fromkeys(_US_RAW))[:300]


def load_us_topN(n):
    """data_fetcher의 실제 라이브 Nasdaq 데이터(시총 내림차순)에서 상위 n개 티커 로드.
    n<=300이면 하드코딩 리스트(US_300) 사용, 초과분은 라이브 데이터로 보충."""
    if n <= len(US_300):
        return US_300[:n]
    print(f"  (US 시총 상위 {n}종목 로드 위해 Nasdaq API 조회 중...)", flush=True)
    stocks = data_fetcher.fetch_nasdaq_stocks(min_market_cap_b=0.0)
    if not stocks:
        print("  Nasdaq API 실패, 하드코딩 300종목만 사용")
        return US_300
    tickers = [s['ticker'] for s in stocks[:n]]
    print(f"  (US 시총 상위 {len(tickers)}종목 로드 완료)")
    return tickers


def fetch_ohlcv(ticker):
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}'
    try:
        r = requests.get(url, params={'range': '2y', 'interval': '1d', 'includePrePost': False},
                         headers=HEADERS, timeout=15)
        d = r.json()['chart']['result'][0]
        ts = d['timestamp']; q = d['indicators']['quote'][0]
        out = []
        for i in range(len(ts)):
            o, h, l, c, v = q['open'][i], q['high'][i], q['low'][i], q['close'][i], q['volume'][i]
            if None in (o, h, l, c): continue
            out.append({'time': ts[i], 'open': o, 'high': h, 'low': l, 'close': c, 'volume': v or 0})
        return out
    except:
        return []


# ── 지표 계산 ──────────────────────────────────────────────────────────────────
def _ema(arr, p):
    k = 2 / (p + 1); r = [None] * len(arr)
    s = next((i for i, v in enumerate(arr) if v is not None), None)
    if s is None or s + p - 1 >= len(arr): return r
    r[s + p - 1] = sum(v for v in arr[s:s + p] if v is not None) / p
    for i in range(s + p, len(arr)):
        if arr[i] is None or r[i - 1] is None: continue
        r[i] = arr[i] * k + r[i - 1] * (1 - k)
    return r

def _sma(arr, p):
    r = [None] * len(arr)
    for i in range(p - 1, len(arr)):
        sl = arr[i - p + 1:i + 1]
        if None not in sl: r[i] = sum(sl) / p
    return r

def calc_macd(c):
    e12 = _ema(c, 12); e26 = _ema(c, 26)
    m = [a - b if a is not None and b is not None else None for a, b in zip(e12, e26)]
    return m, _ema(m, 9)

def calc_rsi(c, p=14):
    n = len(c); r = [None] * n
    if n < p + 1: return r
    ag = al = 0
    for i in range(1, p + 1):
        d = c[i] - c[i - 1]
        if d > 0: ag += d
        else: al += abs(d)
    ag /= p; al /= p
    r[p] = 100 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(p + 1, n):
        d = c[i] - c[i - 1]; g = d if d > 0 else 0; l = abs(d) if d < 0 else 0
        ag = (ag * (p - 1) + g) / p; al = (al * (p - 1) + l) / p
        r[i] = 100 if al == 0 else 100 - 100 / (1 + ag / al)
    return r

def calc_sto(ohlcv, p=14, s=3):
    n = len(ohlcv); rk = [None] * n
    for i in range(p - 1, n):
        sl = ohlcv[i - p + 1:i + 1]
        hi = max(d['high'] for d in sl); lo = min(d['low'] for d in sl)
        rk[i] = 50 if hi == lo else (ohlcv[i]['close'] - lo) / (hi - lo) * 100
    return rk, _sma(rk, s)

def calc_bb(c, p=20, mult=2.0):
    mid = _sma(c, p); pb = [None] * len(c)
    for i in range(p - 1, len(c)):
        sl = c[i - p + 1:i + 1]
        if None in sl or mid[i] is None: continue
        std = (sum((x - mid[i]) ** 2 for x in sl) / p) ** 0.5
        up = mid[i] + mult * std; lo = mid[i] - mult * std
        bw = up - lo
        pb[i] = (c[i] - lo) / bw if bw > 0 else 0.5
    return pb

def calc_volma(ohlcv, p=20):
    vols = [d['volume'] for d in ohlcv]
    return _sma(vols, p)

# ── 시장 추세 (SPY / KOSPI) ────────────────────────────────────────────────────
_MKT_SORTED_KEYS = []
_MKT_SORTED_VALS = []

def load_market_trend(ticker):
    global _MKT_SORTED_KEYS, _MKT_SORTED_VALS
    print(f"  [{ticker}] 시장 추세 로드...", end='  ', flush=True)
    ohlcv = fetch_ohlcv(ticker)
    if not ohlcv:
        print("실패")
        _MKT_SORTED_KEYS = []; _MKT_SORTED_VALS = []
        return
    weekly = resample_weekly(ohlcv)
    wc = [w['close'] for w in weekly]
    wma = _sma(wc, 13)
    trend_map = {}
    for i, w in enumerate(weekly):
        d = datetime.utcfromtimestamp(w['time'])
        mon = (d - timedelta(days=d.weekday())).strftime('%Y%m%d')
        trend_map[mon] = 0 if wma[i] is None else (1 if wc[i] > wma[i] else -1)
    keys = sorted(trend_map.keys())
    _MKT_SORTED_KEYS = keys
    _MKT_SORTED_VALS = [trend_map[k] for k in keys]
    # 시장 추세 분포 출력
    up   = sum(1 for v in _MKT_SORTED_VALS if v ==  1)
    down = sum(1 for v in _MKT_SORTED_VALS if v == -1)
    print(f"OK ({len(keys)}주: 상승 {up}주 / 하락 {down}주)")

def get_mkt_trend(ts):
    if not _MKT_SORTED_KEYS:
        return 0
    d = datetime.utcfromtimestamp(ts)
    mon = (d - timedelta(days=d.weekday())).strftime('%Y%m%d')
    idx = bisect.bisect_right(_MKT_SORTED_KEYS, mon) - 1
    return _MKT_SORTED_VALS[idx] if idx >= 0 else 0

def calc_rsi_divergence(ohlcv, order=5, min_gap=5, max_gap=60):
    c = [d['close'] for d in ohlcv]; n = len(c)
    rsi = calc_rsi(c); div = [0] * n
    lows = []; highs = []
    for i in range(order, n - order):
        if rsi[i] is None: continue
        is_low  = all(c[j] >= c[i] for j in range(i - order, i + order + 1) if j != i)
        is_high = all(c[j] <= c[i] for j in range(i - order, i + order + 1) if j != i)
        if is_low:  lows.append(i)
        if is_high: highs.append(i)
    for k in range(1, len(lows)):
        i1, i2 = lows[k - 1], lows[k]
        if not (min_gap <= i2 - i1 <= max_gap): continue
        if rsi[i1] is None or rsi[i2] is None: continue
        if c[i2] < c[i1] and rsi[i2] > rsi[i1]: div[i2] = 1
    for k in range(1, len(highs)):
        i1, i2 = highs[k - 1], highs[k]
        if not (min_gap <= i2 - i1 <= max_gap): continue
        if rsi[i1] is None or rsi[i2] is None: continue
        if c[i2] > c[i1] and rsi[i2] < rsi[i1]: div[i2] = -1
    return div

def resample_weekly(ohlcv):
    by_week = {}
    for bar in ohlcv:
        d = datetime.utcfromtimestamp(bar['time'])
        mon = d - timedelta(days=d.weekday())
        key = mon.strftime('%Y%m%d')
        if key not in by_week:
            by_week[key] = {'time': bar['time'], 'open': bar['open'],
                            'high': bar['high'], 'low': bar['low'], 'close': bar['close']}
        else:
            by_week[key]['high']  = max(by_week[key]['high'], bar['high'])
            by_week[key]['low']   = min(by_week[key]['low'],  bar['low'])
            by_week[key]['close'] = bar['close']
    return sorted(by_week.values(), key=lambda x: x['time'])

def get_weekly_trend_array(ohlcv, ma_period=13):
    weekly = resample_weekly(ohlcv)
    wc = [w['close'] for w in weekly]
    wma = _sma(wc, ma_period)
    wt_list = [(w['time'], 0 if wma[i] is None else (1 if wc[i] > wma[i] else -1))
               for i, w in enumerate(weekly)]
    result = [0] * len(ohlcv)
    j = 0
    for i, bar in enumerate(ohlcv):
        while j < len(wt_list) - 1 and wt_list[j + 1][0] <= bar['time']:
            j += 1
        if j < len(wt_list) and wt_list[j][0] <= bar['time']:
            result[i] = wt_list[j][1]
    return result

def calc_candle_patterns(ohlcv):
    n = len(ohlcv); pat = [0] * n
    for i in range(1, n):
        o, h, l, c = ohlcv[i]['open'], ohlcv[i]['high'], ohlcv[i]['low'], ohlcv[i]['close']
        po, pc = ohlcv[i - 1]['open'], ohlcv[i - 1]['close']
        if None in (o, h, l, c, po, pc): continue
        body = abs(c - o); rng = h - l
        if rng == 0 or body == 0: continue
        upper = h - max(o, c); lower = min(o, c) - l
        if   lower >= 2 * body and upper <= body * 0.3: pat[i] =  1
        elif upper >= 2 * body and lower <= body * 0.3: pat[i] = -1
        elif pc < po and c > o and o <= pc and c >= po:  pat[i] =  1
        elif pc > po and c < o and o >= pc and c <= po:  pat[i] = -1
    return pat


# ── 기본 신호 계산 ────────────────────────────────────────────────────────────
def base_sig(ohlcv):
    c = [d['close'] for d in ohlcv]; n = len(c); sig = [0] * n

    macd, msig = calc_macd(c); state = 0
    for i in range(1, n):
        if None in (macd[i], msig[i], macd[i - 1], msig[i - 1]): pass
        elif macd[i - 1] <= msig[i - 1] and macd[i] > msig[i]: state = 1
        elif macd[i - 1] >= msig[i - 1] and macd[i] < msig[i]:
            state = -1 if macd[i] < 0 else 0
        sig[i] += state

    rsi = calc_rsi(c); state = 0
    for i in range(1, n):
        if None in (rsi[i], rsi[i - 1]): pass
        elif rsi[i - 1] < 30 and rsi[i] >= 30:  state = 1
        elif rsi[i - 1] >= 30 and rsi[i] < 30:  state = -1
        elif rsi[i - 1] > 70 and rsi[i] <= 70:  state = -1
        elif rsi[i - 1] <= 70 and rsi[i] > 70:  state = 1
        sig[i] += state

    k, d = calc_sto(ohlcv); state = 0
    for i in range(1, n):
        if None in (k[i], d[i], k[i - 1], d[i - 1]): pass
        elif k[i - 1] <= d[i - 1] and k[i] > d[i] and k[i - 1] <= 30: state = 1
        elif k[i - 1] >= d[i - 1] and k[i] < d[i] and k[i - 1] >= 70: state = -1
        sig[i] += state

    return sig


# ── 전략 함수 ────────────────────────────────────────────────────────────────

def strategy_baseline(ohlcv):
    """기준선: score >= 2, 필터 없음"""
    return base_sig(ohlcv), 2

def strategy_strict(ohlcv):
    """score = 3 (3개 지표 모두 동의)"""
    return base_sig(ohlcv), 3

def strategy_bb_only(ohlcv):
    """BB %B 필터만 (MTF/DIV 없음)"""
    c = [d['close'] for d in ohlcv]; n = len(c)
    sig = base_sig(ohlcv); pb = calc_bb(c)
    filtered = [0] * n
    for i in range(n):
        if sig[i] >= 2 and pb[i] is not None and pb[i] < 0.35:
            filtered[i] = sig[i]
        elif sig[i] <= -2 and pb[i] is not None and pb[i] > 0.65:
            filtered[i] = sig[i]
    return filtered, 2

def strategy_volume(ohlcv):
    """거래량 필터 (20일 평균 1.2배 이상)"""
    n = len(ohlcv); sig = base_sig(ohlcv); volma = calc_volma(ohlcv)
    filtered = [0] * n
    for i in range(n):
        if sig[i] == 0 or volma[i] is None: continue
        if ohlcv[i]['volume'] >= volma[i] * 1.2:
            filtered[i] = sig[i]
    return filtered, 2

def strategy_bb_volume(ohlcv):
    """BB %B + 거래량 복합"""
    c = [d['close'] for d in ohlcv]; n = len(c)
    sig = base_sig(ohlcv); pb = calc_bb(c); volma = calc_volma(ohlcv)
    filtered = [0] * n
    for i in range(n):
        if sig[i] == 0 or pb[i] is None or volma[i] is None: continue
        vol_ok = ohlcv[i]['volume'] >= volma[i] * 1.2
        if sig[i] >= 2 and pb[i] < 0.40 and vol_ok:
            filtered[i] = sig[i]
        elif sig[i] <= -2 and pb[i] > 0.60 and vol_ok:
            filtered[i] = sig[i]
    return filtered, 2

def strategy_strict_volume(ohlcv):
    """score=3 + 거래량 확인"""
    n = len(ohlcv); sig = base_sig(ohlcv); volma = calc_volma(ohlcv)
    filtered = [0] * n
    for i in range(n):
        if sig[i] == 0 or volma[i] is None: continue
        if ohlcv[i]['volume'] >= volma[i] * 1.2:
            filtered[i] = sig[i]
    return filtered, 3

def strategy_rsi_div_bb(ohlcv):
    """RSI 다이버전스 + BB (MTF 없음)"""
    c = [d['close'] for d in ohlcv]; n = len(c)
    sig = base_sig(ohlcv); div = calc_rsi_divergence(ohlcv); pb = calc_bb(c)
    combined = [sig[i] + div[i] for i in range(n)]
    filtered = [0] * n
    for i in range(n):
        if combined[i] >= 2 and pb[i] is not None and pb[i] < 0.35:
            filtered[i] = combined[i]
        elif combined[i] <= -2 and pb[i] is not None and pb[i] > 0.65:
            filtered[i] = combined[i]
    return filtered, 2

def strategy_current(ohlcv):
    """[현재] MTF + RSI 다이버전스 + BB (기준선)"""
    c = [d['close'] for d in ohlcv]; n = len(c)
    sig = base_sig(ohlcv); div = calc_rsi_divergence(ohlcv)
    wtrend = get_weekly_trend_array(ohlcv); pb = calc_bb(c)
    combined = [sig[i] + div[i] for i in range(n)]
    for i in range(n):
        if wtrend[i] ==  1 and combined[i] < 0: combined[i] = 0
        if wtrend[i] == -1 and combined[i] > 0: combined[i] = 0
    filtered = [0] * n
    for i in range(n):
        if combined[i] >= 2 and pb[i] is not None and pb[i] < 0.35:
            filtered[i] = combined[i]
        elif combined[i] <= -2 and pb[i] is not None and pb[i] > 0.65:
            filtered[i] = combined[i]
    return filtered, 2

def strategy_A(ohlcv):
    """[전략A] 매도 %B > 0.75"""
    c = [d['close'] for d in ohlcv]; n = len(c)
    sig = base_sig(ohlcv); div = calc_rsi_divergence(ohlcv)
    wtrend = get_weekly_trend_array(ohlcv); pb = calc_bb(c)
    combined = [sig[i] + div[i] for i in range(n)]
    for i in range(n):
        if wtrend[i] ==  1 and combined[i] < 0: combined[i] = 0
        if wtrend[i] == -1 and combined[i] > 0: combined[i] = 0
    filtered = [0] * n
    for i in range(n):
        if combined[i] >= 2 and pb[i] is not None and pb[i] < 0.35:
            filtered[i] = combined[i]
        elif combined[i] <= -2 and pb[i] is not None and pb[i] > 0.75:
            filtered[i] = combined[i]
    return filtered, 2

def strategy_B(ohlcv):
    """[전략B] 매도 + 약세 캔들 확인"""
    c = [d['close'] for d in ohlcv]; n = len(c)
    sig = base_sig(ohlcv); div = calc_rsi_divergence(ohlcv)
    wtrend = get_weekly_trend_array(ohlcv); pb = calc_bb(c)
    pat = calc_candle_patterns(ohlcv)
    combined = [sig[i] + div[i] for i in range(n)]
    for i in range(n):
        if wtrend[i] ==  1 and combined[i] < 0: combined[i] = 0
        if wtrend[i] == -1 and combined[i] > 0: combined[i] = 0
    filtered = [0] * n
    for i in range(n):
        if combined[i] >= 2 and pb[i] is not None and pb[i] < 0.35:
            filtered[i] = combined[i]
        elif combined[i] <= -2 and pb[i] is not None and pb[i] > 0.65:
            has_bearish = any(pat[j] < 0 for j in range(max(0, i - 2), i + 1))
            if has_bearish:
                filtered[i] = combined[i]
    return filtered, 2

def strategy_AB(ohlcv):
    """[전략A+B] 매도 %B > 0.75 + 약세 캔들 확인"""
    c = [d['close'] for d in ohlcv]; n = len(c)
    sig = base_sig(ohlcv); div = calc_rsi_divergence(ohlcv)
    wtrend = get_weekly_trend_array(ohlcv); pb = calc_bb(c)
    pat = calc_candle_patterns(ohlcv)
    combined = [sig[i] + div[i] for i in range(n)]
    for i in range(n):
        if wtrend[i] ==  1 and combined[i] < 0: combined[i] = 0
        if wtrend[i] == -1 and combined[i] > 0: combined[i] = 0
    filtered = [0] * n
    for i in range(n):
        if combined[i] >= 2 and pb[i] is not None and pb[i] < 0.35:
            filtered[i] = combined[i]
        elif combined[i] <= -2 and pb[i] is not None and pb[i] > 0.75:
            has_bearish = any(pat[j] < 0 for j in range(max(0, i - 2), i + 1))
            if has_bearish:
                filtered[i] = combined[i]
    return filtered, 2

def strategy_A2(ohlcv):
    """[전략A2] 매도 %B > 0.85 (더 강한 임계값)"""
    c = [d['close'] for d in ohlcv]; n = len(c)
    sig = base_sig(ohlcv); div = calc_rsi_divergence(ohlcv)
    wtrend = get_weekly_trend_array(ohlcv); pb = calc_bb(c)
    combined = [sig[i] + div[i] for i in range(n)]
    for i in range(n):
        if wtrend[i] ==  1 and combined[i] < 0: combined[i] = 0
        if wtrend[i] == -1 and combined[i] > 0: combined[i] = 0
    filtered = [0] * n
    for i in range(n):
        if combined[i] >= 2 and pb[i] is not None and pb[i] < 0.35:
            filtered[i] = combined[i]
        elif combined[i] <= -2 and pb[i] is not None and pb[i] > 0.85:
            filtered[i] = combined[i]
    return filtered, 2

def strategy_full_bb(ohlcv):
    """RSI 다이버전스 + 캔들 패턴 + BB (전체 결합, MTF 없음)"""
    c = [d['close'] for d in ohlcv]; n = len(c)
    sig = base_sig(ohlcv); div = calc_rsi_divergence(ohlcv)
    pat = calc_candle_patterns(ohlcv); pb = calc_bb(c)
    combined = [sig[i] + div[i] + pat[i] for i in range(n)]
    filtered = [0] * n
    for i in range(n):
        if combined[i] >= 2 and pb[i] is not None and pb[i] < 0.35:
            filtered[i] = combined[i]
        elif combined[i] <= -2 and pb[i] is not None and pb[i] > 0.65:
            filtered[i] = combined[i]
    return filtered, 2


def strategy_mkt_sell(ohlcv):
    """[시장 매도 필터] 현재 전략 + 시장 주봉 하락/중립 시에만 매도 허용"""
    c = [d['close'] for d in ohlcv]; n = len(c)
    sig = base_sig(ohlcv); div = calc_rsi_divergence(ohlcv)
    wtrend = get_weekly_trend_array(ohlcv); pb = calc_bb(c)
    mkt = [get_mkt_trend(ohlcv[i]['time']) for i in range(n)]
    combined = [sig[i] + div[i] for i in range(n)]
    for i in range(n):
        if wtrend[i] ==  1 and combined[i] < 0: combined[i] = 0
        if wtrend[i] == -1 and combined[i] > 0: combined[i] = 0
    filtered = [0] * n
    for i in range(n):
        if combined[i] >= 2 and pb[i] is not None and pb[i] < 0.35:
            filtered[i] = combined[i]
        elif combined[i] <= -2 and pb[i] is not None and pb[i] > 0.65:
            if mkt[i] != 1:  # 시장 상승 추세일 때 매도 차단
                filtered[i] = combined[i]
    return filtered, 2

def strategy_mkt_both(ohlcv):
    """[시장 양방향 필터] 시장 상승/중립 시 매수, 시장 하락/중립 시 매도만"""
    c = [d['close'] for d in ohlcv]; n = len(c)
    sig = base_sig(ohlcv); div = calc_rsi_divergence(ohlcv)
    wtrend = get_weekly_trend_array(ohlcv); pb = calc_bb(c)
    mkt = [get_mkt_trend(ohlcv[i]['time']) for i in range(n)]
    combined = [sig[i] + div[i] for i in range(n)]
    for i in range(n):
        if wtrend[i] ==  1 and combined[i] < 0: combined[i] = 0
        if wtrend[i] == -1 and combined[i] > 0: combined[i] = 0
    filtered = [0] * n
    for i in range(n):
        if combined[i] >= 2 and pb[i] is not None and pb[i] < 0.35:
            if mkt[i] >= 0:  # 시장 상승/중립 시 매수
                filtered[i] = combined[i]
        elif combined[i] <= -2 and pb[i] is not None and pb[i] > 0.65:
            if mkt[i] <= 0:  # 시장 하락/중립 시 매도
                filtered[i] = combined[i]
    return filtered, 2


SPY_STRATEGIES = [
    ('[현재] MTF+DIV+BB (기준)',             strategy_current),
    ('[시장매도필터] 시장 하락시만 매도',      strategy_mkt_sell),
    ('[시장양방향] 시장 방향 일치만',          strategy_mkt_both),
]

STRATEGIES = [
    # ── 현재 및 개선 전략 ──
    ('[현재] MTF+DIV+BB',        strategy_current),
    ('[전략A]  매도 %B>0.75',    strategy_A),
    ('[전략A2] 매도 %B>0.85',    strategy_A2),
    ('[전략B]  매도+캔들확인',   strategy_B),
    ('[전략A+B] %B>0.75+캔들',  strategy_AB),
    # ── 이전 단계 비교 ──
    ('DIV+BB (MTF 없음)',         strategy_rsi_div_bb),
    ('DIV+캔들+BB (MTF 없음)',    strategy_full_bb),
    ('BB만 (Phase 1)',            strategy_bb_only),
    # ── 초기 비교군 ──
    ('기준선 (score>=2)',         strategy_baseline),
    ('score=3',                   strategy_strict),
    ('거래량 필터',               strategy_volume),
    ('BB+거래량',                 strategy_bb_volume),
    ('score=3+거래량',            strategy_strict_volume),
]


# ── 집계 ──────────────────────────────────────────────────────────────────────
def backtest(ohlcv, signals, threshold):
    c = [d['close'] for d in ohlcv]; n = len(c)
    total = buy = buy_ok = sell = sell_ok = 0; prev = 0
    for i in range(1, n - FWD):
        s = signals[i]
        if s != prev and (s >= threshold or s <= -threshold):
            kind = 'BUY' if s >= threshold else 'SELL'
            fut = c[i + FWD]; ok = (fut > c[i]) if kind == 'BUY' else (fut < c[i])
            total += 1
            if kind == 'BUY': buy += 1; buy_ok += (1 if ok else 0)
            else: sell += 1; sell_ok += (1 if ok else 0)
        prev = s
    return total, buy, buy_ok, sell, sell_ok


def backtest_tiered(ohlcv, signals):
    """[현재] 전략 신호를 |score| 구간별(2/3/4+)로 버킷팅해 매수·매도 적중률을 따로 집계.
    순위 정렬 기준(score 내림차순)이 실제 적중률과 상관관계가 있는지 검증하기 위함."""
    c = [d['close'] for d in ohlcv]; n = len(c)
    buckets = {}  # tier -> {'buy': [total, ok], 'sell': [total, ok]}
    prev = 0
    for i in range(1, n - FWD):
        s = signals[i]
        if s != prev and abs(s) >= 2:
            tier = min(abs(s), 4)  # 4 이상은 '4+' 구간으로 합침
            kind = 'buy' if s > 0 else 'sell'
            fut = c[i + FWD]
            ok = (fut > c[i]) if kind == 'buy' else (fut < c[i])
            b = buckets.setdefault(tier, {'buy': [0, 0], 'sell': [0, 0]})
            b[kind][0] += 1
            b[kind][1] += (1 if ok else 0)
        prev = s
    return buckets


def run_tiered(label, tickers):
    print(f"\n  {label} ({len(tickers)}종목) -- 데이터 수집 중...", flush=True)
    all_ohlcv = {}
    for i, ticker in enumerate(tickers, 1):
        print(f"  [{i:>3}/{len(tickers)}] {ticker}", end='  ', flush=True)
        ohlcv = fetch_ohlcv(ticker)
        if len(ohlcv) >= 80:
            all_ohlcv[ticker] = ohlcv
            print("OK")
        else:
            print("skip")
        time.sleep(0.25)

    print(f"\n  [{label}] score 구간별 집계 중... (유효 {len(all_ohlcv)}종목)", flush=True)
    agg = {}  # tier -> {'buy': [total, ok], 'sell': [total, ok]}
    for ticker, ohlcv in all_ohlcv.items():
        try:
            sig, _ = strategy_current(ohlcv)
            buckets = backtest_tiered(ohlcv, sig)
            for tier, b in buckets.items():
                a = agg.setdefault(tier, {'buy': [0, 0], 'sell': [0, 0]})
                a['buy'][0]  += b['buy'][0];  a['buy'][1]  += b['buy'][1]
                a['sell'][0] += b['sell'][0]; a['sell'][1] += b['sell'][1]
        except Exception:
            pass

    def p(ok, tot): return f"{ok / tot * 100:6.1f}%" if tot else "    N/A"
    print(f"\n  == [{label}] score 구간별 적중률 ({FWD}일 기준, [현재]전략) ==")
    print(f"  {'|score|':>8} {'매수건':>6} {'매수%':>7}  {'매도건':>6} {'매도%':>7}")
    print("  " + "-" * 44)
    for tier in sorted(agg.keys()):
        label_tier = f"{tier}" if tier < 4 else "4+"
        a = agg[tier]
        print(f"  {label_tier:>8} {a['buy'][0]:>6}  {p(a['buy'][1], a['buy'][0])}  "
              f"{a['sell'][0]:>6}  {p(a['sell'][1], a['sell'][0])}")
    return agg


def load_kr_topN(n):
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        'data', 'kr_stocks.json')
    with open(path, encoding='utf-8') as f:
        stocks = json.load(f)
    valid = [s for s in stocks if s.get('market_cap') and s['market_cap'] > 0]
    valid.sort(key=lambda s: s['market_cap'], reverse=True)
    tickers = [s['ticker'] for s in valid[:n]]
    print(f"  (KR 시총 상위 {len(tickers)}종목 로드)")
    return tickers


def run_group(label, tickers, strategies=None, market_ticker=None):
    if strategies is None:
        strategies = STRATEGIES
    if market_ticker:
        load_market_trend(market_ticker)
    print(f"\n  {label} ({len(tickers)}종목) -- 데이터 수집 중...", flush=True)
    all_ohlcv = {}
    for i, ticker in enumerate(tickers, 1):
        print(f"  [{i:>3}/{len(tickers)}] {ticker}", end='  ', flush=True)
        ohlcv = fetch_ohlcv(ticker)
        if len(ohlcv) >= 80:
            all_ohlcv[ticker] = ohlcv
            print("OK")
        else:
            print("skip")
        time.sleep(0.25)

    print(f"\n  [{label}] 집계 중... (유효 {len(all_ohlcv)}종목)", flush=True)
    results = {}
    for name, fn in strategies:
        agg = {'total': 0, 'buy': 0, 'buy_ok': 0, 'sell': 0, 'sell_ok': 0}
        for ticker, ohlcv in all_ohlcv.items():
            try:
                sig, thr = fn(ohlcv)
                tot, buy, bok, sell, sok = backtest(ohlcv, sig, thr)
                agg['total'] += tot; agg['buy'] += buy; agg['buy_ok'] += bok
                agg['sell'] += sell; agg['sell_ok'] += sok
            except:
                pass
        results[name] = agg

    def p(ok, tot): return f"{ok / tot * 100:6.1f}%" if tot else "    N/A"
    print(f"\n  == [{label}] 결과 ({FWD}일 기준) ==")
    print(f"  {'전략':<26} {'전체':>6} {'전체%':>7}  {'매수건':>5} {'매수%':>7}  {'매도건':>5} {'매도%':>7}")
    print("  " + "-" * 74)
    for name, a in results.items():
        total_pct = p(a['buy_ok'] + a['sell_ok'], a['total'])
        print(f"  {name:<26} {a['total']:>6}  {total_pct}  "
              f"{a['buy']:>5}  {p(a['buy_ok'], a['buy'])}  "
              f"{a['sell']:>5}  {p(a['sell_ok'], a['sell'])}")
    return results


if __name__ == '__main__':
    print(f"\n  신호 적중률 개선 전략 비교 -- US/KR {N_STOCKS}종목 확대 백테스트 / {FWD}일 기준")
    print("  " + "=" * 74)

    us_tickers = load_us_topN(N_STOCKS)
    print(f"  US 대상: {len(us_tickers)}종목 (시총 상위) / FWD={FWD}일")

    mode = sys.argv[2] if len(sys.argv) > 2 else 'all'
    us_label = f"US 미국 시총 {N_STOCKS}"
    kr_label = f"KR 국내 시총 {N_STOCKS}"

    if mode == 'tier':
        # score 구간별(|score|=2/3/4+) 적중률 분리 집계 — [현재] 전략만 대상
        us_results = run_tiered(us_label, us_tickers)
        try:
            kr_tickers = load_kr_topN(N_STOCKS)
            kr_results = run_tiered(kr_label, kr_tickers)
        except Exception as e:
            print(f"\n  KR 로드 오류: {e}")
    elif mode == 'spy':
        # SPY/KOSPI 시장 추세 필터 테스트
        us_results = run_group(us_label, us_tickers,
                               strategies=SPY_STRATEGIES, market_ticker='SPY')
        try:
            kr_tickers = load_kr_topN(N_STOCKS)
            kr_results = run_group(kr_label, kr_tickers,
                                   strategies=SPY_STRATEGIES, market_ticker='^KS11')
        except Exception as e:
            print(f"\n  KR 로드 오류: {e}")
    else:
        us_results = run_group(us_label, us_tickers)
        try:
            kr_tickers = load_kr_topN(N_STOCKS)
            kr_results = run_group(kr_label, kr_tickers)
        except Exception as e:
            print(f"\n  KR 로드 오류: {e}")

    print("\n  완료.")
