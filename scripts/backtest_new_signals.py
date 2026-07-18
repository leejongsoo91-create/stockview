"""
backtest_new_signals.py -- 종합 진단(build_stock_analysis) 신규 항목 백테스트
52주 위치 / 거래량+방향 / 캔들패턴 / 골든·데드크로스 4개 항목만 대상
(밸류에이션·뉴스감성/수급은 과거 시계열 데이터가 없어 백테스트 불가 — 이번 대상에서 제외)

각 항목의 판정 규칙은 data_fetcher.py의 build_stock_analysis()와 동일하게 구현.
US/KR 각 N종목(기본 700) 기준, 신호 발생 후 5/10/20일 뒤 방향 적중률 측정.

실행: python scripts/backtest_new_signals.py [N종목]
"""
import json, sys, os
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import requests
import data_fetcher

HEADERS      = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
FWD_DAYS     = [5, 10, 20]
MAX_WORKERS  = 5   # Yahoo 429 방지 — collect_pe_eps.py와 동일하게 보수적으로 유지
N_STOCKS     = int(sys.argv[1]) if len(sys.argv) > 1 else 700


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


# ── OHLCV 수집 (스레드풀 + 429 서킷브레이커) ──────────────────────────────────
def fetch_ohlcv(ticker):
    """반환: (ohlcv list, http_status)"""
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}'
    try:
        r = requests.get(url, params={'range': '2y', 'interval': '1d', 'includePrePost': False},
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
    """스레드풀로 전 종목 OHLCV 수집. 52주+MA200 계산에 필요한 최소 260거래일 미만은 제외."""
    result = {}
    consecutive_429 = 0
    done = 0
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = {ex.submit(fetch_ohlcv, t): t for t in tickers}
        for fut in as_completed(futs):
            ohlcv, status = fut.result()
            done += 1
            consecutive_429 = consecutive_429 + 1 if status == 429 else 0
            if len(ohlcv) >= 260:
                result[futs[fut]] = ohlcv
            if done % 50 == 0 or done == len(tickers):
                print(f"  [{done:>4}/{len(tickers)}] 수집 진행 (유효 {len(result)}개)", flush=True)
            if consecutive_429 >= 15:
                print(f"  429 연속 {consecutive_429}회 -- Yahoo 차단으로 판단해 조기 중단합니다.")
                break
    return result


# ── 지표 계산 (build_stock_analysis()와 동일 판정 로직) ──────────────────────
def _sma(arr, p):
    r = [None] * len(arr)
    for i in range(p - 1, len(arr)):
        sl = arr[i - p + 1:i + 1]
        if None not in sl:
            r[i] = sum(sl) / p
    return r


def calc_52w_pos(ohlcv):
    """각 시점 t에서 직전 252거래일(자기 포함) 기준 52주 range 내 위치(%)."""
    n = len(ohlcv)
    pos = [None] * n
    for i in range(n):
        window = ohlcv[max(0, i - 251):i + 1]
        hi = max(d['high'] for d in window)
        lo = min(d['low']  for d in window)
        if hi <= lo:
            continue
        p = (ohlcv[i]['close'] - lo) / (hi - lo) * 100
        if 0 <= p <= 100:
            pos[i] = p
    return pos


def calc_vol_ratio(ohlcv, lookback=20):
    n = len(ohlcv)
    r = [None] * n
    for i in range(lookback, n):
        vols = [ohlcv[j]['volume'] for j in range(i - lookback, i)]
        avg = sum(vols) / len(vols) if vols else 0
        if avg and ohlcv[i]['volume']:
            r[i] = ohlcv[i]['volume'] / avg
    return r


def calc_candle_patterns(ohlcv):
    n = len(ohlcv)
    pat = [0] * n
    for i in range(1, n):
        o, h, l, c = ohlcv[i]['open'], ohlcv[i]['high'], ohlcv[i]['low'], ohlcv[i]['close']
        po, pc = ohlcv[i - 1]['open'], ohlcv[i - 1]['close']
        body, rng = abs(c - o), h - l
        if rng == 0 or body == 0:
            continue
        upper, lower = h - max(o, c), min(o, c) - l
        if   lower >= 2 * body and upper <= body * 0.3: pat[i] = 1
        elif upper >= 2 * body and lower <= body * 0.3: pat[i] = -1
        elif pc < po and c > o and o <= pc and c >= po: pat[i] = 1
        elif pc > po and c < o and o >= pc and c <= po: pat[i] = -1
    return pat


def detect_ma_cross_events(ohlcv):
    """골든크로스(+1)/데드크로스(-1)가 발생한 그날만 표시 (build_stock_analysis의 이벤트 정의와 동일)."""
    closes = [d['close'] for d in ohlcv]
    ma50, ma200 = _sma(closes, 50), _sma(closes, 200)
    n = len(closes)
    events = [0] * n
    for i in range(1, n):
        if None in (ma50[i - 1], ma200[i - 1], ma50[i], ma200[i]):
            continue
        if ma50[i - 1] <= ma200[i - 1] and ma50[i] > ma200[i]:
            events[i] = 1
        elif ma50[i - 1] >= ma200[i - 1] and ma50[i] < ma200[i]:
            events[i] = -1
    return events


# ── 이벤트 생성 (build_stock_analysis 판정 규칙과 동일 임계값) ────────────────
def gen_events(ohlcv):
    closes = [d['close'] for d in ohlcv]
    n = len(ohlcv)
    events = {'position_52w': [], 'volume': [], 'candle_pattern': [], 'ma_cross': []}

    pos = calc_52w_pos(ohlcv)
    for i in range(n):
        if pos[i] is None:
            continue
        if pos[i] >= 90:
            events['position_52w'].append((i, 'buy'))
        elif pos[i] <= 10:
            events['position_52w'].append((i, 'sell'))

    volr = calc_vol_ratio(ohlcv)
    for i in range(1, n):
        if volr[i] is None or volr[i] < 2.0 or not closes[i - 1]:
            continue
        chg = (closes[i] - closes[i - 1]) / closes[i - 1] * 100
        if chg > 0:
            events['volume'].append((i, 'buy'))
        elif chg < 0:
            events['volume'].append((i, 'sell'))

    pat = calc_candle_patterns(ohlcv)
    for i in range(n):
        if pat[i] == 1:
            events['candle_pattern'].append((i, 'buy'))
        elif pat[i] == -1:
            events['candle_pattern'].append((i, 'sell'))

    cross = detect_ma_cross_events(ohlcv)
    for i in range(n):
        if cross[i] == 1:
            events['ma_cross'].append((i, 'buy'))
        elif cross[i] == -1:
            events['ma_cross'].append((i, 'sell'))

    return events


def backtest_factor(closes, events, fwd):
    n = len(closes)
    total = buy = buy_ok = sell = sell_ok = 0
    for i, kind in events:
        if i + fwd >= n:
            continue
        future  = closes[i + fwd]
        correct = (future > closes[i]) if kind == 'buy' else (future < closes[i])
        total += 1
        if kind == 'buy':
            buy += 1
            buy_ok += correct
        else:
            sell += 1
            sell_ok += correct
    return total, buy, buy_ok, sell, sell_ok


FACTORS = ['position_52w', 'volume', 'candle_pattern', 'ma_cross']
FACTOR_LABELS = {
    'position_52w':   '52주 위치 (>=90% 매수 / <=10% 매도)',
    'volume':         '거래량 (2배 이상 급증 + 등락방향)',
    'candle_pattern':  '캔들 패턴 (망치형/장악형)',
    'ma_cross':       '골든/데드크로스 (MA50 x MA200)',
}


def run(label, tickers):
    print(f"\n{'=' * 70}\n  [{label}] {len(tickers)}종목 백테스트\n{'=' * 70}")
    all_ohlcv = fetch_all(tickers)
    print(f"  유효 데이터 {len(all_ohlcv)}/{len(tickers)}종목 (260거래일 이상)")

    agg = {f: {fwd: {'total': 0, 'buy': 0, 'buy_ok': 0, 'sell': 0, 'sell_ok': 0} for fwd in FWD_DAYS}
           for f in FACTORS}

    for ticker, ohlcv in all_ohlcv.items():
        try:
            closes = [d['close'] for d in ohlcv]
            events = gen_events(ohlcv)
            for factor, evs in events.items():
                for fwd in FWD_DAYS:
                    tot, buy, bok, sell, sok = backtest_factor(closes, evs, fwd)
                    a = agg[factor][fwd]
                    a['total'] += tot; a['buy'] += buy; a['buy_ok'] += bok
                    a['sell'] += sell; a['sell_ok'] += sok
        except Exception:
            continue

    def p(ok, tot):
        return f"{ok / tot * 100:5.1f}%" if tot else "  N/A"

    print(f"\n  == [{label}] 항목별 적중률 ==")
    for factor in FACTORS:
        print(f"\n  [{factor}] {FACTOR_LABELS[factor]}")
        print(f"  {'기준일':>6} {'전체':>6} {'전체%':>7}  {'매수':>5} {'매수%':>7}  {'매도':>5} {'매도%':>7}")
        print("  " + "-" * 52)
        for fwd in FWD_DAYS:
            a = agg[factor][fwd]
            print(f"  {fwd:>4}일 {a['total']:>6} {p(a['buy_ok'] + a['sell_ok'], a['total'])}  "
                  f"{a['buy']:>5} {p(a['buy_ok'], a['buy'])}  {a['sell']:>5} {p(a['sell_ok'], a['sell'])}")
    return agg


if __name__ == '__main__':
    print(f"\n  종합 진단 신규 항목 백테스트 -- US/KR {N_STOCKS}종목 / 5·10·20일 후 방향 적중률")
    print("  대상: 52주 위치 / 거래량+방향 / 캔들패턴 / 골든·데드크로스")
    print("  (밸류에이션·뉴스감성/수급은 과거 시계열 데이터 없어 이번 대상에서 제외)\n")

    us_tickers = load_us_topN(N_STOCKS)
    us_agg = run(f"US 시총상위 {N_STOCKS}", us_tickers)

    kr_tickers = load_kr_topN(N_STOCKS)
    kr_agg = run(f"KR 시총상위 {N_STOCKS}", kr_tickers)

    print("\n  백테스트 완료.")
