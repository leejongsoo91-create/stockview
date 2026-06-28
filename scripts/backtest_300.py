"""
backtest_300.py -- 300종목 확대 백테스트 (전략A+B 신뢰도 검증)
US/KR 각 300종목 / 핵심 4전략 비교
실행: python scripts/backtest_300.py
"""
import json, time, sys, os
from datetime import datetime, timedelta
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import requests

HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
FWD = 10  # 10일 기준

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


def load_kr_top300():
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        'data', 'kr_stocks.json')
    with open(path, encoding='utf-8') as f:
        stocks = json.load(f)
    valid = [s for s in stocks if s.get('market_cap') and s['market_cap'] > 0]
    valid.sort(key=lambda s: s['market_cap'], reverse=True)
    tickers = [s['ticker'] for s in valid[:300]]
    print(f"  (KR 시총 상위 {len(tickers)}종목 로드)")
    return tickers


def run_group(label, tickers):
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
    for name, fn in STRATEGIES:
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
    print(f"\n  == [{label}] 결과 (10일 기준) ==")
    print(f"  {'전략':<26} {'전체':>6} {'전체%':>7}  {'매수건':>5} {'매수%':>7}  {'매도건':>5} {'매도%':>7}")
    print("  " + "-" * 74)
    for name, a in results.items():
        total_pct = p(a['buy_ok'] + a['sell_ok'], a['total'])
        print(f"  {name:<26} {a['total']:>6}  {total_pct}  "
              f"{a['buy']:>5}  {p(a['buy_ok'], a['buy'])}  "
              f"{a['sell']:>5}  {p(a['sell_ok'], a['sell'])}")
    return results


if __name__ == '__main__':
    print(f"\n  신호 적중률 개선 전략 비교 -- US/KR 300종목 확대 백테스트 / 10일 기준")
    print("  " + "=" * 74)
    print(f"  US 대상: {len(US_300)}종목 (S&P500 시총 상위)")

    us_results = run_group("US 미국 시총 300", US_300)

    try:
        kr300 = load_kr_top300()
        kr_results = run_group("KR 국내 시총 300", kr300)
    except Exception as e:
        print(f"\n  KR 로드 오류: {e}")

    print("\n  완료.")
