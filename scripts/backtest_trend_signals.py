"""
backtest_trend_signals.py -- 추세형 신호(슈퍼트렌드·스퀴즈) vs 현재 신호, 적중률 + 손익비 비교 (11-28)

왜: 현재 신호(decisions/003)는 '10일 뒤 올랐나' 적중률만 쟀고 눌림목 매수만 잡는다.
    요즘 많이 쓰는 추세형 기준을 같은 종목·같은 기간으로 재서, 손익비(R)까지 비교한다.

재는 것
  1) 10일 적중률 — 003과 같은 정의 (신호일 종가 vs 10거래일 뒤 종가)
  2) 매매 모의 (매수 신호만) — 다음 날 시가 진입, 손절 = 진입가 − ATR(14)×2
     A. 목표 청산: 목표 = 손익비 2:1(진입가 + ATR×4), 최대 20일 보유 후 종가 청산
     B. 추세 청산: 목표 없음, 손절선을 슈퍼트렌드 선으로 끌어올림(최대 60일)
     같은 날 손절·목표 둘 다 닿으면 손절로 본다(보수적). 시가가 손절 아래로 갭하락하면 시가 청산.
     비용: 왕복 KR 0.25%, US 0.05% 를 빼고 R(손절폭=1) 단위로 환산.
  종목: US 시총 상위 300(backtest_300의 목록) / KR 코스피 150 + 코스닥 150 (시총순, ETF·ETN 제외)
  기간: 야후 일봉 5년

실행: .venv/bin/python scripts/backtest_trend_signals.py [종목수=300]
      (데이터는 logs/bt_cache/ 에 저장해 두고 다시 돌릴 때 재사용)
"""
import json, os, sys, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, 'scripts'))
N = int(sys.argv[1]) if len(sys.argv) > 1 else 300
_argv = sys.argv; sys.argv = [sys.argv[0]]          # backtest_300이 import 때 argv를 읽음
import backtest_300 as bt                            # noqa: E402  지표 함수 재사용
sys.argv = _argv
import requests                                      # noqa: E402

FWD = 10
CACHE = os.path.join(ROOT, 'logs', 'bt_cache'); os.makedirs(CACHE, exist_ok=True)
HEADERS = bt.HEADERS


def fetch(ticker, rng='5y'):
    path = os.path.join(CACHE, f'{ticker.replace("^", "_")}_{rng}.json')
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < 86400 * 3:
        with open(path) as f: return json.load(f)
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}'
    out = []
    try:
        r = requests.get(url, params={'range': rng, 'interval': '1d'}, headers=HEADERS, timeout=20)
        d = r.json()['chart']['result'][0]; q = d['indicators']['quote'][0]
        for i, t in enumerate(d['timestamp']):
            o, h, l, c, v = q['open'][i], q['high'][i], q['low'][i], q['close'][i], q['volume'][i]
            if None in (o, h, l, c) or c <= 0: continue
            out.append({'time': t, 'open': o, 'high': h, 'low': l, 'close': c, 'volume': v or 0})
    except Exception:
        out = []
    if out:
        with open(path, 'w') as f: json.dump(out, f)
    time.sleep(0.25)
    return out


# ── 지표 ──────────────────────────────────────────────────────────────────────
def atr(o, p=14):
    n = len(o); tr = [0.0] * n; a = [None] * n
    for i in range(n):
        h, l = o[i]['high'], o[i]['low']
        tr[i] = h - l if i == 0 else max(h - l, abs(h - o[i-1]['close']), abs(l - o[i-1]['close']))
    if n <= p: return a
    a[p - 1] = sum(tr[:p]) / p
    for i in range(p, n): a[i] = (a[i-1] * (p - 1) + tr[i]) / p   # 와일더 평균 (트레이딩뷰 ATR과 같음)
    return a


def supertrend(o, p=10, mult=3.0):
    """반환: (선 값, 방향 1=상승/-1=하락) — 트레이딩뷰 기본(10, 3)과 같은 계산"""
    n = len(o); a = atr(o, p); line = [None] * n; dirn = [0] * n
    fu = fl = None
    for i in range(n):
        if a[i] is None: continue
        hl2 = (o[i]['high'] + o[i]['low']) / 2
        bu, bl = hl2 + mult * a[i], hl2 - mult * a[i]
        pc = o[i-1]['close'] if i else o[i]['close']
        fu = bu if fu is None or bu < fu or pc > fu else fu
        fl = bl if fl is None or bl > fl or pc < fl else fl
        prev = dirn[i-1] if i else 0
        if prev == 0: d = 1 if o[i]['close'] > hl2 else -1
        elif prev == -1: d = 1 if o[i]['close'] > fu else -1
        else: d = -1 if o[i]['close'] < fl else 1
        dirn[i] = d; line[i] = fl if d == 1 else fu
    return line, dirn


def squeeze(o, p=20, bbm=2.0, kcm=1.5):
    """TTM 스퀴즈: BB가 켈트너 채널 안이면 압축(on). 모멘텀 = 종가 − (돈치안 중간 + SMA)/2 의 선형회귀값"""
    n = len(o); c = [d['close'] for d in o]; sma = bt._sma(c, p); a = atr(o, p)
    on = [None] * n; mom = [None] * n; raw = [None] * n
    for i in range(p - 1, n):
        if sma[i] is None or a[i] is None: continue
        sl = c[i - p + 1:i + 1]
        sd = (sum((x - sma[i]) ** 2 for x in sl) / p) ** 0.5
        on[i] = (sma[i] + bbm * sd) < (sma[i] + kcm * a[i])
        hh = max(d['high'] for d in o[i - p + 1:i + 1]); ll = min(d['low'] for d in o[i - p + 1:i + 1])
        raw[i] = c[i] - ((hh + ll) / 2 + sma[i]) / 2
    for i in range(2 * p - 2, n):                       # 최근 p개 raw의 선형회귀 끝값
        ys = raw[i - p + 1:i + 1]
        if None in ys: continue
        xm = (p - 1) / 2; ym = sum(ys) / p
        sxy = sum((k - xm) * (y - ym) for k, y in enumerate(ys)); sxx = sum((k - xm) ** 2 for k in range(p))
        mom[i] = ym + sxy / sxx * (p - 1 - xm)
    return on, mom


# ── 신호들 (값: +1 매수 / -1 매도 / 0) ──────────────────────────────────────────
def sig_current(o, is_kr, ma50_filter=False):
    """chart.js _calcSignals()와 같은 순서: 점수 → 주봉 MA13 → BB%B → (KR) 매도 약세캔들
    ma50_filter=True면 11-28 이전 로직(MA50 추세 필터 포함) — 비교용"""
    c = [d['close'] for d in o]; n = len(c)
    base = bt.base_sig(o); div = bt.calc_rsi_divergence(o)
    s = [base[i] + div[i] for i in range(n)]
    ma50 = bt._sma(c, 50); wt = bt.get_weekly_trend_array(o, 13); pb = bt.calc_bb(c)
    pat = bt.calc_candle_patterns(o) if is_kr else None
    thr_sell = 0.85 if is_kr else 0.65
    out = [0] * n; prev = 0
    for i in range(n):
        v = s[i]
        if ma50_filter and ma50[i] is not None and ((c[i] > ma50[i] and v < 0) or (c[i] < ma50[i] and v > 0)): v = 0
        if (wt[i] == 1 and v < 0) or (wt[i] == -1 and v > 0): v = 0
        if pb[i] is not None:
            if v >= 2 and pb[i] >= 0.35: v = 0
            if v <= -2 and pb[i] <= thr_sell: v = 0
        if is_kr and v <= -2 and not any(pat[j] < 0 for j in range(max(0, i - 2), i + 1)): v = 0
        if v != prev and abs(v) >= 2: out[i] = 1 if v > 0 else -1   # 점수가 바뀐 날만 (마커와 같음)
        prev = v
    return out


def sig_st(o, vol_filter=False, rs=None):
    _, d = supertrend(o); n = len(o); out = [0] * n
    vma = bt._sma([x['volume'] for x in o], 20)
    for i in range(1, n):
        if d[i] == 1 and d[i-1] == -1: out[i] = 1
        elif d[i] == -1 and d[i-1] == 1: out[i] = -1
        if out[i] == 1 and vol_filter and not (vma[i] and o[i]['volume'] >= 1.5 * vma[i]): out[i] = 0
        if out[i] == 1 and rs is not None and not rs[i]: out[i] = 0
    return out


def sig_sqz(o, trend=False):
    on, mom = squeeze(o); n = len(o); out = [0] * n
    ma50 = bt._sma([d['close'] for d in o], 50) if trend else None
    for i in range(6, n):
        # 5봉 이상 압축돼 있다가 오늘 풀림
        if on[i] is False and on[i-1] and all(on[j] for j in range(i - 5, i)) and mom[i] is not None and mom[i-1] is not None:
            if mom[i] > 0 and mom[i] > mom[i-1]: out[i] = 1
            elif mom[i] < 0 and mom[i] < mom[i-1]: out[i] = -1
            if trend and out[i] == 1 and not (ma50[i] and o[i]['close'] > ma50[i]): out[i] = 0
    return out


def rs_array(o, idx):
    """60일 수익률이 지수보다 높으면 True (날짜로 맞춤)"""
    im = {d['time'] // 86400: d['close'] for d in idx}
    days = sorted(im); out = [False] * len(o)
    import bisect
    def ic(t):
        k = bisect.bisect_right(days, t // 86400) - 1
        return im[days[k]] if k >= 0 else None
    for i in range(60, len(o)):
        a, b = ic(o[i]['time']), ic(o[i-60]['time'])
        if a and b: out[i] = (o[i]['close'] / o[i-60]['close']) > (a / b)
    return out


# ── 평가 ──────────────────────────────────────────────────────────────────────
def hit10(o, sig):
    r = {'b': 0, 'bo': 0, 's': 0, 'so': 0}
    for i in range(len(o) - FWD):
        if sig[i] == 1: r['b'] += 1; r['bo'] += o[i + FWD]['close'] > o[i]['close']
        elif sig[i] == -1: r['s'] += 1; r['so'] += o[i + FWD]['close'] < o[i]['close']
    return r


def trades(o, sig, mode, cost):
    """매수 신호만. mode 'A'=2:1 목표·20일, 'B'=슈퍼트렌드 추적 손절·60일. R 목록 반환"""
    a = atr(o, 14); st, _ = supertrend(o) if mode == 'B' else (None, None)
    res = []; i = 0; n = len(o)
    while i < n - 2:
        if sig[i] != 1 or a[i] is None: i += 1; continue
        e_i = i + 1; entry = o[e_i]['open']; risk = 2 * a[i]
        if risk <= 0: i += 1; continue
        stop = entry - risk; tgt = entry + 2 * risk if mode == 'A' else None
        hold = 20 if mode == 'A' else 60; exit_px = None; j = e_i
        while j < min(n, e_i + hold):
            b = o[j]
            if j > e_i and b['open'] <= stop: exit_px = b['open']; break   # 갭하락
            if b['low'] <= stop: exit_px = stop; break
            if tgt and b['high'] >= tgt: exit_px = tgt if b['open'] < tgt else b['open']; break
            if mode == 'B' and st[j] is not None: stop = max(stop, st[j])  # 다음 날부터 적용
            j += 1
        if exit_px is None:
            j = min(n - 1, e_i + hold - 1); exit_px = o[j]['close']
            if j >= n - 1 and j - e_i < 3: break                            # 끝에 걸려 판단 못함
        res.append((exit_px - entry - cost * entry) / risk)
        i = j + 1                                                           # 보유 중엔 새 신호 무시
    return res


def summarize(rs):
    if not rs: return None
    w = [r for r in rs if r > 0]; l = [r for r in rs if r <= 0]
    pf = sum(w) / -sum(l) if l and sum(l) < 0 else float('inf')
    return {'n': len(rs), 'win': len(w) / len(rs) * 100, 'avg': sum(rs) / len(rs),
            'aw': sum(w) / len(w) if w else 0, 'al': sum(l) / len(l) if l else 0, 'pf': pf}


STRATS = [
    ('현재 신호 (11-28, MA50 뺌)', lambda o, kr, rs: sig_current(o, kr)),
    ('옛 신호 (MA50 필터 포함)',  lambda o, kr, rs: sig_current(o, kr, ma50_filter=True)),
    ('슈퍼트렌드 전환',          lambda o, kr, rs: sig_st(o)),
    ('슈퍼트렌드 + 거래량1.5배', lambda o, kr, rs: sig_st(o, vol_filter=True)),
    ('슈퍼트렌드 + 시장대비 강세', lambda o, kr, rs: sig_st(o, rs=rs)),
    ('스퀴즈 풀림',              lambda o, kr, rs: sig_sqz(o)),
    ('스퀴즈 풀림 + MA50 위',    lambda o, kr, rs: sig_sqz(o, trend=True)),
]


def universe_kr(n):
    with open(os.path.join(ROOT, 'data', 'kr_stocks.json'), encoding='utf-8') as f:
        d = json.load(f)
    d = [s for s in d if s.get('market_cap') and s.get('sector') not in (None, '', '기타')]   # ETF·ETN 제외
    d.sort(key=lambda s: -s['market_cap'])
    ks = [s['ticker'] for s in d if s['market'] == 'KOSPI'][:n // 2]
    kq = [s['ticker'] for s in d if s['market'] == 'KOSDAQ'][:n - n // 2]
    return ks + kq


def run(label, tickers, is_kr, index_of, cost):
    data = {}
    for k, t in enumerate(tickers, 1):
        o = fetch(t)
        if len(o) >= 300: data[t] = o
        if k % 50 == 0: print(f'  {label} 데이터 {k}/{len(tickers)}', flush=True)
    idx = {x: fetch(x) for x in set(index_of(t) for t in data)}
    print(f'\n== {label}: 유효 {len(data)}종목, 5년 일봉 ==')
    print(f'{"신호":<24}{"매수건":>7}{"10일적중":>9}{"매도건":>7}{"10일적중":>9} | '
          f'{"A 2:1목표":^34} | {"B 추세청산":^34}')
    print(f'{"":<24}{"":>7}{"":>9}{"":>7}{"":>9} | {"건수":>5}{"승률":>7}{"평균R":>7}{"평균익":>7}{"PF":>6}   | '
          f'{"건수":>5}{"승률":>7}{"평균R":>7}{"평균익":>7}{"PF":>6}')
    rows = {}
    for name, fn in STRATS:
        h = {'b': 0, 'bo': 0, 's': 0, 'so': 0}; ra = []; rb = []
        for t, o in data.items():
            rs = rs_array(o, idx[index_of(t)])
            s = fn(o, is_kr, rs)
            for k2, v in hit10(o, s).items(): h[k2] += v
            ra += trades(o, s, 'A', cost); rb += trades(o, s, 'B', cost)
        A, B = summarize(ra), summarize(rb)
        pct = lambda ok, tot: f'{ok / tot * 100:7.1f}%' if tot else '     -  '
        fm = lambda x: (f'{x["n"]:>5}{x["win"]:>6.1f}%{x["avg"]:>+7.2f}{x["aw"]:>+7.2f}{x["pf"]:>6.2f}' if x else ' ' * 31)
        print(f'{name:<24}{h["b"]:>7}{pct(h["bo"], h["b"])}{h["s"]:>7}{pct(h["so"], h["s"])} |  {fm(A)}   |  {fm(B)}', flush=True)
        rows[name] = {'hit': h, 'A': A, 'B': B}
    return rows


if __name__ == '__main__':
    t0 = time.time()
    us = bt.US_300[:N]
    kr = universe_kr(N)
    out = {
        'US': run('미국', us, False, lambda t: '^GSPC', 0.0005),
        'KR': run('국내', kr, True, lambda t: '^KS11' if t.endswith('.KS') else '^KQ11', 0.0025),
    }
    with open(os.path.join(ROOT, 'logs', 'backtest_trend_signals.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1, default=str)
    print(f'\n걸린 시간 {time.time() - t0:.0f}초 · 결과 logs/backtest_trend_signals.json')
