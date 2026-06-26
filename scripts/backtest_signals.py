"""
backtest_signals.py — MACD+RSI+STO 복합 시그널 백테스트 (개선판)
미국/한국 시가총액 상위 100종목 기준, 신호 발생 후 N일 가격 방향 적중률 측정
실행: python scripts/backtest_signals.py
"""
import json, time, sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import requests

HEADERS  = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
FWD_DAYS = [5, 10, 20]

# ── 미국 시가총액 상위 100 ────────────────────────────────────────────────────
US_TOP100 = [
    'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','BRK-B',
    'LLY','AVGO','UNH','JPM','V','WMT','XOM','MA','ORCL',
    'PG','HD','COST','JNJ','NFLX','BAC','CRM','AMD','MRK',
    'ABBV','KO','PEP','TMO','CSCO','ACN','ABT','DHR','MCD',
    'GE','TXN','PM','CAT','IBM','ISRG','INTU','SPGI','AMGN',
    'NOW','BKNG','GS','RTX','QCOM','LOW','VRTX','SYK','T',
    'UBER','AXP','ETN','PLD','NEE','HON','BLK','SCHW','MMC',
    'LMT','DE','ELV','PANW','MDT','CB','BMY','ADI','TJX',
    'BSX','GILD','C','MO','SO','CVS','SLB','PGR','ADP',
    'CI','DUK','ZTS','USB','ICE','CME','NOC','EMR','AON',
    'MCO','ITW','HCA','APD','GD','PH','REGN','TGT','MMM','FDX',
]

# ── KR 시가총액 상위 100 로드 ─────────────────────────────────────────────────
def load_kr_top100():
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'kr_stocks.json')
    with open(path, encoding='utf-8') as f:
        stocks = json.load(f)
    valid = [s for s in stocks if s.get('market_cap') and s['market_cap'] > 0]
    valid.sort(key=lambda s: s['market_cap'], reverse=True)
    return [(s['ticker'], s['name']) for s in valid[:100]]

# ── Yahoo Finance OHLCV ───────────────────────────────────────────────────────
def fetch_ohlcv(ticker, period='2y'):
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}'
    try:
        r = requests.get(url, params={'range': period, 'interval': '1d', 'includePrePost': False},
                         headers=HEADERS, timeout=15)
        d = r.json()['chart']['result'][0]
        ts = d['timestamp']
        q  = d['indicators']['quote'][0]
        ohlcv = []
        for i in range(len(ts)):
            o,h,l,c,v = q['open'][i],q['high'][i],q['low'][i],q['close'][i],q['volume'][i]
            if None in (o,h,l,c): continue
            ohlcv.append({'time':ts[i],'open':o,'high':h,'low':l,'close':c,'volume':v or 0})
        return ohlcv
    except:
        return []

# ── 지표 계산 ─────────────────────────────────────────────────────────────────
def _ema(arr, period):
    k = 2 / (period + 1)
    result = [None] * len(arr)
    start  = next((i for i,v in enumerate(arr) if v is not None), None)
    if start is None or start + period - 1 >= len(arr): return result
    result[start + period - 1] = sum(v for v in arr[start:start+period] if v is not None) / period
    for i in range(start + period, len(arr)):
        if arr[i] is None or result[i-1] is None: continue
        result[i] = arr[i] * k + result[i-1] * (1-k)
    return result

def _sma(arr, period):
    result = [None] * len(arr)
    for i in range(period-1, len(arr)):
        slc = arr[i-period+1:i+1]
        if None not in slc: result[i] = sum(slc)/period
    return result

def calc_macd(closes):
    ema12 = _ema(closes, 12); ema26 = _ema(closes, 26)
    macd  = [a-b if a is not None and b is not None else None for a,b in zip(ema12,ema26)]
    return macd, _ema(macd, 9)

def calc_rsi(closes, period=14):
    n = len(closes); rsi = [None]*n
    if n < period+1: return rsi
    ag = al = 0
    for i in range(1, period+1):
        d = closes[i]-closes[i-1]
        if d>0: ag+=d
        else:   al+=abs(d)
    ag/=period; al/=period
    rsi[period] = 100 if al==0 else 100-100/(1+ag/al)
    for i in range(period+1, n):
        d=closes[i]-closes[i-1]; g=d if d>0 else 0; l=abs(d) if d<0 else 0
        ag=(ag*(period-1)+g)/period; al=(al*(period-1)+l)/period
        rsi[i] = 100 if al==0 else 100-100/(1+ag/al)
    return rsi

def calc_stochastic(ohlcv, period=14, smooth=3):
    n = len(ohlcv); rawK=[None]*n
    for i in range(period-1, n):
        slc=ohlcv[i-period+1:i+1]
        hi=max(d['high'] for d in slc); lo=min(d['low'] for d in slc)
        rawK[i]=50 if hi==lo else (ohlcv[i]['close']-lo)/(hi-lo)*100
    return rawK, _sma(rawK, smooth)

# ── 지표 계산 (BB %B) ────────────────────────────────────────────────────────
def _calc_bb_pb(closes, period=20, mult=2.0):
    pb = [None] * len(closes)
    mid = _sma(closes, period)
    for i in range(period - 1, len(closes)):
        if mid[i] is None: continue
        slc = closes[i - period + 1:i + 1]
        std = (sum((x - mid[i]) ** 2 for x in slc) / period) ** 0.5
        upper = mid[i] + mult * std
        lower = mid[i] - mult * std
        bw = upper - lower
        pb[i] = (closes[i] - lower) / bw if bw > 0 else 0.5
    return pb

# ── 시그널 생성 (v3: MA50 + BB %B 이중 필터) ─────────────────────────────────
def generate_signals(ohlcv, ma50_filter=True, bb_filter=True):
    closes = [d['close'] for d in ohlcv]
    n = len(closes)
    sig = [0]*n

    # MACD (제로라인 필터: 데드크로스는 MACD값이 음수일 때만 -1)
    macd, msig = calc_macd(closes)
    state = 0
    for i in range(1,n):
        if None in (macd[i],msig[i],macd[i-1],msig[i-1]): pass
        elif macd[i-1] <= msig[i-1] and macd[i] > msig[i]:
            state = 1
        elif macd[i-1] >= msig[i-1] and macd[i] < msig[i]:
            state = -1 if macd[i] < 0 else 0
        sig[i] += state

    # RSI (70 하향돌파 = 매도, 70 상향돌파 = 강한 모멘텀)
    rsi = calc_rsi(closes); state = 0
    for i in range(1,n):
        if None in (rsi[i],rsi[i-1]): pass
        elif rsi[i-1] < 30  and rsi[i] >= 30: state = 1
        elif rsi[i-1] >= 30 and rsi[i] < 30:  state = -1
        elif rsi[i-1] > 70  and rsi[i] <= 70: state = -1
        elif rsi[i-1] <= 70 and rsi[i] > 70:  state = 1
        sig[i] += state

    # STO (이전봉 기준 30/70 존 크로스)
    k, d = calc_stochastic(ohlcv); state = 0
    for i in range(1,n):
        if None in (k[i],d[i],k[i-1],d[i-1]): pass
        elif k[i-1] <= d[i-1] and k[i] > d[i] and k[i-1] <= 30: state = 1
        elif k[i-1] >= d[i-1] and k[i] < d[i] and k[i-1] >= 70: state = -1
        sig[i] += state

    # ── MA50 추세 필터 ────────────────────────────────────────────────────────
    if ma50_filter:
        ma50 = _sma(closes, 50)
        for i in range(n):
            if ma50[i] is None: continue
            if closes[i] > ma50[i] and sig[i] < 0: sig[i] = 0
            if closes[i] < ma50[i] and sig[i] > 0: sig[i] = 0

    # ── BB %B 필터 ────────────────────────────────────────────────────────────
    # 매수(sig>=2): %B < 0.35 (BB 하단 근처)만 유효
    # 매도(sig<=-2): %B > 0.65 (BB 상단 근처)만 유효
    if bb_filter:
        pb = _calc_bb_pb(closes)
        for i in range(n):
            if pb[i] is None: continue
            if sig[i] >= 2  and pb[i] >= 0.35: sig[i] = 0
            if sig[i] <= -2 and pb[i] <= 0.65: sig[i] = 0

    return sig

# ── 백테스트 ──────────────────────────────────────────────────────────────────
def backtest_one(ohlcv, signals, fwd):
    closes = [d['close'] for d in ohlcv]
    n = len(closes); events = []; prev = 0
    for i in range(1, n-fwd):
        s = signals[i]
        if s != prev and (s >= 2 or s <= -2):
            kind    = 'BUY' if s >= 2 else 'SELL'
            future  = closes[i+fwd]
            correct = (future > closes[i]) if kind=='BUY' else (future < closes[i])
            pct     = (future-closes[i])/closes[i]*100
            events.append({'kind':kind,'score':s,'correct':correct,'pct':pct})
        prev = s
    return events

def analyze(tickers_with_names, label, ma50_filter=True, bb_filter=True):
    print(f"\n{'='*70}")
    tags = []
    if ma50_filter: tags.append("MA50")
    if bb_filter:   tags.append("BB%B")
    filter_tag = "+".join(tags) + " Filter" if tags else "No Filter"
    print(f"  [{label}] Top 100 by market cap backtest ({filter_tag})")
    print(f"{'='*70}")

    agg = {fwd:{'total':0,'correct':0,'buy':0,'buy_ok':0,'sell':0,'sell_ok':0} for fwd in FWD_DAYS}
    rows = []

    for idx, (ticker, name) in enumerate(tickers_with_names, 1):
        print(f"  [{idx:>3}/100] {ticker:<15} {name[:10]:<10}", end=' ', flush=True)
        ohlcv = fetch_ohlcv(ticker)
        time.sleep(0.3)
        if len(ohlcv) < 80:
            print("데이터 부족")
            continue

        signals  = generate_signals(ohlcv, ma50_filter=ma50_filter, bb_filter=bb_filter)
        row = {'ticker':ticker,'name':name,'data':{}}

        for fwd in FWD_DAYS:
            events = backtest_one(ohlcv, signals, fwd)
            if not events: row['data'][fwd] = None; continue
            total  = len(events); ok = sum(1 for e in events if e['correct'])
            buy_e  = [e for e in events if e['kind']=='BUY']
            sell_e = [e for e in events if e['kind']=='SELL']
            row['data'][fwd] = {
                'total':total, 'acc':ok/total*100,
                'buy':len(buy_e), 'buy_ok':sum(1 for e in buy_e if e['correct']),
                'sell':len(sell_e),'sell_ok':sum(1 for e in sell_e if e['correct']),
            }
            agg[fwd]['total']   += total
            agg[fwd]['correct'] += ok
            agg[fwd]['buy']     += len(buy_e)
            agg[fwd]['buy_ok']  += sum(1 for e in buy_e  if e['correct'])
            agg[fwd]['sell']    += len(sell_e)
            agg[fwd]['sell_ok'] += sum(1 for e in sell_e if e['correct'])

        d10 = row['data'].get(10)
        if d10:
            b_acc = d10['buy_ok']/max(d10['buy'],1)*100
            s_acc = d10['sell_ok']/max(d10['sell'],1)*100
            print(f"전체 {d10['total']:>3}건 | 매수 {d10['buy']:>2}건 {b_acc:>5.1f}% | 매도 {d10['sell']:>2}건 {s_acc:>5.1f}%")
        else:
            print("시그널 없음")
        rows.append(row)

    # 전체 요약
    print(f"\n  {'─'*65}")
    print(f"  [전체 집계]")
    for fwd in FWD_DAYS:
        a = agg[fwd]
        if a['total'] == 0: continue
        acc      = a['correct']/a['total']*100
        buy_acc  = a['buy_ok']/a['buy']*100  if a['buy']  else 0
        sell_acc = a['sell_ok']/a['sell']*100 if a['sell'] else 0
        print(f"  {fwd:>2}일 후 | 전체 {a['total']:>4}건 {acc:>5.1f}% | "
              f"매수 {a['buy']:>3}건 {buy_acc:>5.1f}% | 매도 {a['sell']:>3}건 {sell_acc:>5.1f}%")

    # 매도 상위 종목
    sell_rows = [(r, r['data'].get(10)) for r in rows if r['data'].get(10) and r['data'][10]['sell']>0]
    sell_rows.sort(key=lambda x: x[1]['sell_ok']/max(x[1]['sell'],1), reverse=True)
    print(f"\n  [매도 신호 적중률 상위 10]")
    print(f"  {'종목':<15} {'이름':<12} {'매도건':>6} {'10일적중':>9}")
    print(f"  {'─'*45}")
    for r, d in sell_rows[:10]:
        s_acc = d['sell_ok']/max(d['sell'],1)*100
        print(f"  {r['ticker']:<15} {r['name'][:12]:<12} {d['sell']:>6} {s_acc:>8.1f}%")

    return agg

def summarize(label, no_filter, with_filter, fwd=10):
    """필터 전후 비교 요약 출력"""
    print(f"\n  {'─'*65}")
    print(f"  [{label}] MA50 추세 필터 전후 비교 (10일 기준)")
    print(f"  {'─'*65}")
    a, b = no_filter[fwd], with_filter[fwd]
    def pct(ok, tot): return f"{ok/tot*100:5.1f}%" if tot else "   N/A"
    print(f"  {'':12} {'전체':>8}  {'매수':>8}  {'매도':>8}  {'신호수':>6}")
    print(f"  {'필터 없음':14} {pct(a['correct'],a['total']):>8}  "
          f"{pct(a['buy_ok'],a['buy']):>8}  {pct(a['sell_ok'],a['sell']):>8}  {a['total']:>6}건")
    print(f"  {'MA50+BB%B':14} {pct(b['correct'],b['total']):>8}  "
          f"{pct(b['buy_ok'],b['buy']):>8}  {pct(b['sell_ok'],b['sell']):>8}  {b['total']:>6}건")
    buy_diff  = (b['buy_ok']/b['buy']*100 if b['buy'] else 0) - (a['buy_ok']/a['buy']*100 if a['buy'] else 0)
    sell_diff = (b['sell_ok']/b['sell']*100 if b['sell'] else 0) - (a['sell_ok']/a['sell']*100 if a['sell'] else 0)
    print(f"  {'개선폭':12} {'':>8}  {buy_diff:>+7.1f}%  {sell_diff:>+7.1f}%")

if __name__ == '__main__':
    print("\n  MACD + RSI + STO -- MA50 + BB %B 이중 필터 백테스트")
    print("  신호 발생 후 10일 뒤 방향 적중률 | 과거 2년 일봉 | score +-2 이상\n")

    us_tickers = [(t, t) for t in US_TOP100]
    try:
        kr_tickers = load_kr_top100()
    except Exception as e:
        print(f"  KR 종목 로드 오류: {e}"); kr_tickers = []

    print("  ▶ [US] 필터 없음")
    us_base = analyze(us_tickers, 'US', ma50_filter=False, bb_filter=False)
    print("  ▶ [US] MA50 + BB %B 이중 필터")
    us_full = analyze(us_tickers, 'US', ma50_filter=True, bb_filter=True)
    summarize('US 비교', us_base, us_full)

    if kr_tickers:
        print("\n  ▶ [KR] 필터 없음")
        kr_base = analyze(kr_tickers, 'KR', ma50_filter=False, bb_filter=False)
        print("\n  ▶ [KR] MA50 + BB %B 이중 필터")
        kr_full = analyze(kr_tickers, 'KR', ma50_filter=True, bb_filter=True)
        summarize('KR 비교', kr_base, kr_full)

    print("\n  백테스트 완료.")
