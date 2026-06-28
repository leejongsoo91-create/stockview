"""
backtest_improve.py -- 신호 적중률 개선 전략 비교 백테스트
전략별 US 시총 상위 50종목 테스트 (빠른 비교용)
실행: python scripts/backtest_improve.py
"""
import json, time, sys, os
from datetime import datetime, timedelta
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import requests

HEADERS  = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
FWD = 10  # 10일 고정

US_50 = [
    'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','BRK-B',
    'LLY','AVGO','UNH','JPM','V','WMT','XOM','MA','ORCL',
    'PG','HD','COST','JNJ','NFLX','BAC','CRM','AMD','MRK',
    'ABBV','KO','PEP','TMO','CSCO','ACN','ABT','DHR','MCD',
    'GE','TXN','PM','CAT','IBM','ISRG','INTU','SPGI','AMGN',
    'NOW','BKNG','GS','RTX','QCOM','LOW',
]

def fetch_ohlcv(ticker):
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}'
    try:
        r = requests.get(url, params={'range':'2y','interval':'1d','includePrePost':False},
                         headers=HEADERS, timeout=15)
        d = r.json()['chart']['result'][0]
        ts = d['timestamp']; q = d['indicators']['quote'][0]
        out = []
        for i in range(len(ts)):
            o,h,l,c,v = q['open'][i],q['high'][i],q['low'][i],q['close'][i],q['volume'][i]
            if None in (o,h,l,c): continue
            out.append({'time':ts[i],'open':o,'high':h,'low':l,'close':c,'volume':v or 0})
        return out
    except: return []

# ── 지표 계산 ──────────────────────────────────────────────────────────────────
def _ema(arr, p):
    k=2/(p+1); r=[None]*len(arr)
    s=next((i for i,v in enumerate(arr) if v is not None),None)
    if s is None or s+p-1>=len(arr): return r
    r[s+p-1]=sum(v for v in arr[s:s+p] if v is not None)/p
    for i in range(s+p,len(arr)):
        if arr[i] is None or r[i-1] is None: continue
        r[i]=arr[i]*k+r[i-1]*(1-k)
    return r

def _sma(arr, p):
    r=[None]*len(arr)
    for i in range(p-1,len(arr)):
        sl=arr[i-p+1:i+1]
        if None not in sl: r[i]=sum(sl)/p
    return r

def calc_macd(c):
    e12=_ema(c,12); e26=_ema(c,26)
    m=[a-b if a is not None and b is not None else None for a,b in zip(e12,e26)]
    return m,_ema(m,9)

def calc_rsi(c,p=14):
    n=len(c); r=[None]*n
    if n<p+1: return r
    ag=al=0
    for i in range(1,p+1):
        d=c[i]-c[i-1]
        if d>0: ag+=d
        else: al+=abs(d)
    ag/=p; al/=p
    r[p]=100 if al==0 else 100-100/(1+ag/al)
    for i in range(p+1,n):
        d=c[i]-c[i-1]; g=d if d>0 else 0; l=abs(d) if d<0 else 0
        ag=(ag*(p-1)+g)/p; al=(al*(p-1)+l)/p
        r[i]=100 if al==0 else 100-100/(1+ag/al)
    return r

def calc_sto(ohlcv,p=14,s=3):
    n=len(ohlcv); rk=[None]*n
    for i in range(p-1,n):
        sl=ohlcv[i-p+1:i+1]
        hi=max(d['high'] for d in sl); lo=min(d['low'] for d in sl)
        rk[i]=50 if hi==lo else (ohlcv[i]['close']-lo)/(hi-lo)*100
    return rk,_sma(rk,s)

def calc_bb(c,p=20,mult=2.0):
    mid=_sma(c,p); upper=[None]*len(c); lower=[None]*len(c); pb=[None]*len(c)
    for i in range(p-1,len(c)):
        sl=c[i-p+1:i+1]
        if None in sl or mid[i] is None: continue
        std=(sum((x-mid[i])**2 for x in sl)/p)**0.5
        up=mid[i]+mult*std; lo=mid[i]-mult*std
        upper[i]=up; lower[i]=lo
        bw=up-lo
        pb[i]=(c[i]-lo)/bw if bw>0 else 0.5
    return pb

def calc_volma(ohlcv,p=20):
    vols=[d['volume'] for d in ohlcv]
    return _sma(vols,p)

def calc_rsi_divergence(ohlcv, order=5, min_gap=5, max_gap=60):
    """RSI 다이버전스 탐지: 강세(+1), 약세(-1), 없음(0)"""
    c=[d['close'] for d in ohlcv]; n=len(c)
    rsi=calc_rsi(c); div=[0]*n
    lows=[]; highs=[]
    for i in range(order, n-order):
        if rsi[i] is None: continue
        is_low  = all(c[j]>=c[i] for j in range(i-order, i+order+1) if j!=i)
        is_high = all(c[j]<=c[i] for j in range(i-order, i+order+1) if j!=i)
        if is_low:  lows.append(i)
        if is_high: highs.append(i)
    for k in range(1,len(lows)):
        i1,i2=lows[k-1],lows[k]
        if not (min_gap<=i2-i1<=max_gap): continue
        if rsi[i1] is None or rsi[i2] is None: continue
        if c[i2]<c[i1] and rsi[i2]>rsi[i1]: div[i2]=1
    for k in range(1,len(highs)):
        i1,i2=highs[k-1],highs[k]
        if not (min_gap<=i2-i1<=max_gap): continue
        if rsi[i1] is None or rsi[i2] is None: continue
        if c[i2]>c[i1] and rsi[i2]<rsi[i1]: div[i2]=-1
    return div

def resample_weekly(ohlcv):
    """일봉 -> 주봉 집계 (월요일 기준)"""
    by_week = {}
    for bar in ohlcv:
        d   = datetime.utcfromtimestamp(bar['time'])
        mon = d - timedelta(days=d.weekday())  # weekday(): 0=월
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
    """주봉 MA13 기반 추세를 일봉 배열로 반환 (1=상승, -1=하락, 0=중립)"""
    weekly = resample_weekly(ohlcv)
    wc     = [w['close'] for w in weekly]
    wma    = _sma(wc, ma_period)
    wt_list= [(w['time'], 0 if wma[i] is None else (1 if wc[i]>wma[i] else -1))
              for i,w in enumerate(weekly)]
    result = [0]*len(ohlcv)
    j = 0
    for i, bar in enumerate(ohlcv):
        while j < len(wt_list)-1 and wt_list[j+1][0] <= bar['time']:
            j += 1
        if j < len(wt_list) and wt_list[j][0] <= bar['time']:
            result[i] = wt_list[j][1]
    return result

def calc_candle_patterns(ohlcv):
    """캔들 패턴 탐지: Hammer(+1), Shooting Star(-1), Engulfing(±1)"""
    n=len(ohlcv); pat=[0]*n
    for i in range(1,n):
        o,h,l,c=ohlcv[i]['open'],ohlcv[i]['high'],ohlcv[i]['low'],ohlcv[i]['close']
        po,pc=ohlcv[i-1]['open'],ohlcv[i-1]['close']
        if None in (o,h,l,c,po,pc): continue
        body=abs(c-o); rng=h-l
        if rng==0 or body==0: continue
        upper=h-max(o,c); lower=min(o,c)-l
        if   lower>=2*body and upper<=body*0.3:         pat[i]= 1  # Hammer
        elif upper>=2*body and lower<=body*0.3:         pat[i]=-1  # Shooting Star
        elif pc<po and c>o and o<=pc and c>=po:         pat[i]= 1  # Bullish Engulfing
        elif pc>po and c<o and o>=pc and c<=po:         pat[i]=-1  # Bearish Engulfing
    return pat

# ── 기본 sig 계산 (공통) ──────────────────────────────────────────────────────
def base_sig(ohlcv):
    c=[d['close'] for d in ohlcv]; n=len(c); sig=[0]*n

    macd,msig=calc_macd(c); state=0
    for i in range(1,n):
        if None in (macd[i],msig[i],macd[i-1],msig[i-1]): pass
        elif macd[i-1]<=msig[i-1] and macd[i]>msig[i]: state=1
        elif macd[i-1]>=msig[i-1] and macd[i]<msig[i]:
            state=-1 if macd[i]<0 else 0
        sig[i]+=state

    rsi=calc_rsi(c); state=0
    for i in range(1,n):
        if None in (rsi[i],rsi[i-1]): pass
        elif rsi[i-1]<30 and rsi[i]>=30: state=1
        elif rsi[i-1]>=30 and rsi[i]<30: state=-1
        elif rsi[i-1]>70 and rsi[i]<=70: state=-1
        elif rsi[i-1]<=70 and rsi[i]>70: state=1
        sig[i]+=state

    k,d=calc_sto(ohlcv); state=0
    for i in range(1,n):
        if None in (k[i],d[i],k[i-1],d[i-1]): pass
        elif k[i-1]<=d[i-1] and k[i]>d[i] and k[i-1]<=30: state=1
        elif k[i-1]>=d[i-1] and k[i]<d[i] and k[i-1]>=70: state=-1
        sig[i]+=state

    return sig

# ── 전략별 신호 생성 ──────────────────────────────────────────────────────────

def strategy_baseline(ohlcv):
    """기준선: score >= 2"""
    return base_sig(ohlcv), 2

def strategy_strict(ohlcv):
    """전략1: 임계값 강화 score = 3 (3개 모두 동의)"""
    return base_sig(ohlcv), 3

def strategy_bb(ohlcv):
    """전략2: 볼린저밴드 %B 추가 (4번째 지표)
    매수: sig>=2 AND %B<0.35 (하단 근처)
    매도: sig<=-2 AND %B>0.65 (상단 근처)
    """
    c=[d['close'] for d in ohlcv]; n=len(c)
    sig=base_sig(ohlcv)
    pb=calc_bb(c)
    filtered=[0]*n
    for i in range(n):
        if sig[i]>=2 and pb[i] is not None and pb[i]<0.35:
            filtered[i]=sig[i]
        elif sig[i]<=-2 and pb[i] is not None and pb[i]>0.65:
            filtered[i]=sig[i]
    return filtered, 2

def strategy_volume(ohlcv):
    """전략3: 거래량 확인 (20일 평균 1.2배 이상)"""
    n=len(ohlcv); sig=base_sig(ohlcv)
    volma=calc_volma(ohlcv)
    filtered=[0]*n
    for i in range(n):
        if sig[i]==0: continue
        if volma[i] is None: continue
        if ohlcv[i]['volume']>=volma[i]*1.2:
            filtered[i]=sig[i]
    return filtered, 2

def strategy_bb_volume(ohlcv):
    """전략4: 볼린저밴드 + 거래량 복합"""
    c=[d['close'] for d in ohlcv]; n=len(c)
    sig=base_sig(ohlcv)
    pb=calc_bb(c); volma=calc_volma(ohlcv)
    filtered=[0]*n
    for i in range(n):
        if sig[i]==0: continue
        if pb[i] is None or volma[i] is None: continue
        vol_ok = ohlcv[i]['volume']>=volma[i]*1.2
        if sig[i]>=2 and pb[i]<0.40 and vol_ok:
            filtered[i]=sig[i]
        elif sig[i]<=-2 and pb[i]>0.60 and vol_ok:
            filtered[i]=sig[i]
    return filtered, 2

def strategy_strict_volume(ohlcv):
    """전략5: score=3 + 거래량 확인"""
    n=len(ohlcv); sig=base_sig(ohlcv)
    volma=calc_volma(ohlcv)
    filtered=[0]*n
    for i in range(n):
        if sig[i]==0: continue
        if volma[i] is None: continue
        if ohlcv[i]['volume']>=volma[i]*1.2:
            filtered[i]=sig[i]
    return filtered, 3

def strategy_score3_bb(ohlcv):
    """전략6: score=3 + BB %B 필터 -- 3개 지표 모두 동의 + BB 위치 확인"""
    c=[d['close'] for d in ohlcv]; n=len(c)
    sig=base_sig(ohlcv); pb=calc_bb(c)
    filtered=[0]*n
    for i in range(n):
        if sig[i]>=3 and pb[i] is not None and pb[i]<0.35:
            filtered[i]=sig[i]
        elif sig[i]<=-3 and pb[i] is not None and pb[i]>0.65:
            filtered[i]=sig[i]
    return filtered, 3

def strategy_rsi_div_bb(ohlcv):
    """[이전] RSI 다이버전스 + BB %B"""
    c=[d['close'] for d in ohlcv]; n=len(c)
    sig=base_sig(ohlcv); div=calc_rsi_divergence(ohlcv); pb=calc_bb(c)
    combined=[sig[i]+div[i] for i in range(n)]
    filtered=[0]*n
    for i in range(n):
        if combined[i]>=2 and pb[i] is not None and pb[i]<0.35:
            filtered[i]=combined[i]
        elif combined[i]<=-2 and pb[i] is not None and pb[i]>0.65:
            filtered[i]=combined[i]
    return filtered, 2

def strategy_mtf_div_bb(ohlcv):
    """[신규] 주봉 MA13 추세 + RSI 다이버전스 + BB %B"""
    c=[d['close'] for d in ohlcv]; n=len(c)
    sig=base_sig(ohlcv); div=calc_rsi_divergence(ohlcv)
    wtrend=get_weekly_trend_array(ohlcv); pb=calc_bb(c)
    combined=[sig[i]+div[i] for i in range(n)]
    # 주봉 추세 필터
    for i in range(n):
        if wtrend[i]== 1 and combined[i]<0: combined[i]=0
        if wtrend[i]==-1 and combined[i]>0: combined[i]=0
    filtered=[0]*n
    for i in range(n):
        if combined[i]>=2 and pb[i] is not None and pb[i]<0.35:
            filtered[i]=combined[i]
        elif combined[i]<=-2 and pb[i] is not None and pb[i]>0.65:
            filtered[i]=combined[i]
    return filtered, 2

def strategy_mtf_div_bb_sellA(ohlcv):
    """[전략A] MTF+DIV+BB, 매도 기준 강화: %B > 0.75 (현재 0.65)"""
    c=[d['close'] for d in ohlcv]; n=len(c)
    sig=base_sig(ohlcv); div=calc_rsi_divergence(ohlcv)
    wtrend=get_weekly_trend_array(ohlcv); pb=calc_bb(c)
    combined=[sig[i]+div[i] for i in range(n)]
    for i in range(n):
        if wtrend[i]== 1 and combined[i]<0: combined[i]=0
        if wtrend[i]==-1 and combined[i]>0: combined[i]=0
    filtered=[0]*n
    for i in range(n):
        if combined[i]>=2 and pb[i] is not None and pb[i]<0.35:
            filtered[i]=combined[i]
        elif combined[i]<=-2 and pb[i] is not None and pb[i]>0.75:  # 0.65 -> 0.75
            filtered[i]=combined[i]
    return filtered, 2

def strategy_mtf_div_bb_sellA2(ohlcv):
    """[전략A2] MTF+DIV+BB, 매도 기준 더 강화: %B > 0.85"""
    c=[d['close'] for d in ohlcv]; n=len(c)
    sig=base_sig(ohlcv); div=calc_rsi_divergence(ohlcv)
    wtrend=get_weekly_trend_array(ohlcv); pb=calc_bb(c)
    combined=[sig[i]+div[i] for i in range(n)]
    for i in range(n):
        if wtrend[i]== 1 and combined[i]<0: combined[i]=0
        if wtrend[i]==-1 and combined[i]>0: combined[i]=0
    filtered=[0]*n
    for i in range(n):
        if combined[i]>=2 and pb[i] is not None and pb[i]<0.35:
            filtered[i]=combined[i]
        elif combined[i]<=-2 and pb[i] is not None and pb[i]>0.85:  # 0.65 -> 0.85
            filtered[i]=combined[i]
    return filtered, 2

def strategy_mtf_div_bb_sellB(ohlcv):
    """[전략B] MTF+DIV+BB + 매도 시 약세 캔들 확인 (Shooting Star / Bearish Engulfing)"""
    c=[d['close'] for d in ohlcv]; n=len(c)
    sig=base_sig(ohlcv); div=calc_rsi_divergence(ohlcv)
    wtrend=get_weekly_trend_array(ohlcv); pb=calc_bb(c)
    pat=calc_candle_patterns(ohlcv)
    combined=[sig[i]+div[i] for i in range(n)]
    for i in range(n):
        if wtrend[i]== 1 and combined[i]<0: combined[i]=0
        if wtrend[i]==-1 and combined[i]>0: combined[i]=0
    filtered=[0]*n
    for i in range(n):
        if combined[i]>=2 and pb[i] is not None and pb[i]<0.35:
            filtered[i]=combined[i]
        elif combined[i]<=-2 and pb[i] is not None and pb[i]>0.65:
            # 최근 3봉 내 약세 캔들 패턴 있을 때만 매도 통과
            has_bearish = any(pat[j]<0 for j in range(max(0,i-2), i+1))
            if has_bearish:
                filtered[i]=combined[i]
    return filtered, 2

def strategy_mtf_div_bb_sellAB(ohlcv):
    """[전략A+B] MTF+DIV+BB + 매도 %B>0.75 + 약세 캔들 확인"""
    c=[d['close'] for d in ohlcv]; n=len(c)
    sig=base_sig(ohlcv); div=calc_rsi_divergence(ohlcv)
    wtrend=get_weekly_trend_array(ohlcv); pb=calc_bb(c)
    pat=calc_candle_patterns(ohlcv)
    combined=[sig[i]+div[i] for i in range(n)]
    for i in range(n):
        if wtrend[i]== 1 and combined[i]<0: combined[i]=0
        if wtrend[i]==-1 and combined[i]>0: combined[i]=0
    filtered=[0]*n
    for i in range(n):
        if combined[i]>=2 and pb[i] is not None and pb[i]<0.35:
            filtered[i]=combined[i]
        elif combined[i]<=-2 and pb[i] is not None and pb[i]>0.75:  # A: 0.75
            has_bearish = any(pat[j]<0 for j in range(max(0,i-2), i+1))
            if has_bearish:  # B: 약세 캔들 확인
                filtered[i]=combined[i]
    return filtered, 2

def strategy_full_bb(ohlcv):
    """[신규] RSI 다이버전스 + 캔들 패턴 + BB %B (전체 결합)"""
    c=[d['close'] for d in ohlcv]; n=len(c)
    sig=base_sig(ohlcv); div=calc_rsi_divergence(ohlcv)
    pat=calc_candle_patterns(ohlcv); pb=calc_bb(c)
    combined=[sig[i]+div[i]+pat[i] for i in range(n)]
    filtered=[0]*n
    for i in range(n):
        if combined[i]>=2 and pb[i] is not None and pb[i]<0.35:
            filtered[i]=combined[i]
        elif combined[i]<=-2 and pb[i] is not None and pb[i]>0.65:
            filtered[i]=combined[i]
    return filtered, 2

# ── 백테스트 집계 ─────────────────────────────────────────────────────────────
def backtest(ohlcv, signals, threshold):
    c=[d['close'] for d in ohlcv]; n=len(c)
    total=buy=buy_ok=sell=sell_ok=0; prev=0
    for i in range(1,n-FWD):
        s=signals[i]
        if s!=prev and (s>=threshold or s<=-threshold):
            kind='BUY' if s>=threshold else 'SELL'
            fut=c[i+FWD]; ok=(fut>c[i]) if kind=='BUY' else (fut<c[i])
            total+=1
            if kind=='BUY': buy+=1; buy_ok+=(1 if ok else 0)
            else: sell+=1; sell_ok+=(1 if ok else 0)
        prev=s
    return total,buy,buy_ok,sell,sell_ok

STRATEGIES = [
    ('[현재] MTF+DIV+BB (기준)',           strategy_mtf_div_bb),
    ('[전략A]  매도 %B>0.75',              strategy_mtf_div_bb_sellA),
    ('[전략B]  매도+캔들확인',             strategy_mtf_div_bb_sellB),
    ('[전략A+B] %B>0.75+캔들확인',        strategy_mtf_div_bb_sellAB),
    ('--- 이전 단계 ---',                   None),
    ('DIV+BB (MTF 없음)',                   strategy_rsi_div_bb),
    ('BB만 (Phase 1)',                      strategy_bb),
]

def load_kr_top50():
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'kr_stocks.json')
    with open(path, encoding='utf-8') as f:
        stocks = json.load(f)
    valid = [s for s in stocks if s.get('market_cap') and s['market_cap'] > 0]
    valid.sort(key=lambda s: s['market_cap'], reverse=True)
    return [s['ticker'] for s in valid[:50]]

def run_group(label, tickers):
    print(f"\n  {label} -- 데이터 수집 중...", flush=True)
    all_ohlcv = {}
    for i, ticker in enumerate(tickers, 1):
        print(f"  [{i:>2}/{len(tickers)}] {ticker}", end='  ', flush=True)
        ohlcv = fetch_ohlcv(ticker)
        if len(ohlcv) >= 80:
            all_ohlcv[ticker] = ohlcv
            print("OK")
        else:
            print("skip")
        time.sleep(0.25)

    results = {}
    for name, fn in STRATEGIES:
        if fn is None:  # 구분선
            results[name] = None
            continue
        agg = {'total':0,'buy':0,'buy_ok':0,'sell':0,'sell_ok':0}
        for ticker, ohlcv in all_ohlcv.items():
            try:
                sig, thr = fn(ohlcv)
                tot,buy,bok,sell,sok = backtest(ohlcv, sig, thr)
                agg['total']+=tot; agg['buy']+=buy; agg['buy_ok']+=bok
                agg['sell']+=sell; agg['sell_ok']+=sok
            except: pass
        results[name] = agg

    def p(ok, tot): return f"{ok/tot*100:6.1f}%" if tot else "    N/A"
    print(f"\n  [{label}] 결과 (10일 기준)")
    print(f"  {'전략':<24} {'전체':>6} {'전체%':>7}  {'매수건':>5} {'매수%':>7}  {'매도건':>5} {'매도%':>7}")
    print("  " + "-"*72)
    for name, a in results.items():
        if a is None:
            print(f"  {name}")
            continue
        total_pct = p(a['buy_ok']+a['sell_ok'], a['total'])
        print(f"  {name:<24} {a['total']:>6}  {total_pct}  "
              f"{a['buy']:>5}  {p(a['buy_ok'],a['buy'])}  "
              f"{a['sell']:>5}  {p(a['sell_ok'],a['sell'])}")
    return results

if __name__ == '__main__':
    print("\n  신호 적중률 개선 전략 비교 -- US/KR 시총 상위 50종목 / 10일 기준")
    print("  " + "="*70)

    us_results = run_group("US 미국 시총 50", US_50)

    try:
        kr50 = load_kr_top50()
        kr_results = run_group("KR 국내 시총 50", kr50)
    except Exception as e:
        print(f"\n  KR 로드 오류: {e}")

    print("\n  완료.")
