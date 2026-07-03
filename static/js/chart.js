/* ═══════════════════════════════════════════════════════════════
   chart.js — Lightweight Charts 캔들스틱 차트 (실시간 갱신)
   ═══════════════════════════════════════════════════════════════ */

let _lwChart        = null;
let _candleSeries   = null;
let _volSeries      = null;
let _currentTicker  = null;
let _currentPeriod  = '1y';
let _currentInterval = '1d';
let _priceTimer     = null;
let _candleTimer    = null;
let _lastOhlcv      = [];

// ── 기술 지표 상태 ────────────────────────────────────────────────────────────
const _activeInds = new Set(['ma5','ma20','ma60','bb','rsi','macd','sto','volma']);
const _indSeries  = { ma5: null, ma20: null, ma60: null, bbFill: null, bbMask: null, bbU: null, bbM: null, bbL: null, volma: null };
let   _rsiChart   = null;
let   _rsiSeries  = null;
let   _rsiOb      = null;   // 과매수 기준선
let   _rsiOs      = null;   // 과매도 기준선
let   _macdChart  = null;
let   _macdLine   = null;
let   _macdSignal = null;
let   _macdHist   = null;
let   _stoChart   = null;
let   _stoK       = null;   // %K 빠른선
let   _stoD       = null;   // %D 시그널선
let   _stoOb      = null;   // 과매수 80
let   _stoOs      = null;   // 과매도 20

// ── 가격 알림 상태 ────────────────────────────────────────────────────────────
const _ALERT_KEY = 'stockview_price_alerts';
let   _alertFired = new Set();  // 이번 세션에서 이미 발화된 알림 ID

// ── 비교 모드 상태 ────────────────────────────────────────────────────────────
let _compareMode   = false;
let _compareTicker = null;
let _cmpMainSeries = null;   // 메인 종목 정규화 라인
let _cmpSeries     = null;   // 비교 종목 정규화 라인

const _CANDLE_REFRESH = {
  '1m': 30_000, '5m': 60_000, '15m': 120_000,
  '30m': 300_000, '60m': 600_000, '1d': 60_000,
};

// 지수 심볼 → 표시 이름 매핑
const _INDEX_NAMES = {
  '^GSPC': 'S&P 500 Index',
  '^IXIC': 'NASDAQ Composite',
  '^DJI':  'Dow Jones Industrial',
  '^RUT':  'Russell 2000 Index',
  '^VIX':  'CBOE Volatility Index',
  'CL=F':  'WTI Crude Oil Futures',
  'GC=F':  'Gold Futures',
};

function _isIndex(ticker) {
  return ticker.startsWith('^') || ticker.endsWith('=F');
}

function _isKrStock(ticker) {
  return ticker.endsWith('.KS') || ticker.endsWith('.KQ');
}

function _fmtKrPrice(v) {
  if (!v) return '—';
  return '₩' + Math.round(v).toLocaleString('ko-KR');
}

function initChart() {
  _createLWChart();
  _bindSearchEvents();
  _bindPeriodEvents();
  _bindIndicatorEvents();
  _bindCompareEvents();
  _bindAlertEvents();
  _bindResizeObserver();
}

// 차트 탭 이탈 시 타이머 정지 (main.js에서 호출)
function stopChartTimers() {
  if (_priceTimer)  { clearInterval(_priceTimer);  _priceTimer  = null; }
  if (_candleTimer) { clearInterval(_candleTimer); _candleTimer = null; }
  const badge = document.getElementById('chart-live-badge');
  if (badge) badge.style.display = 'none';
}

// ── LW 차트 생성 ─────────────────────────────────────────────────────────────
function _createLWChart() {
  const container = document.getElementById('lw-chart');
  const W = container.clientWidth || 900;
  const H = Math.max(window.innerHeight - (container.getBoundingClientRect().top || 280) - 24, 300);

  _lwChart = LightweightCharts.createChart(container, {
    width:  W,
    height: H,
    layout: {
      background: { type: 'solid', color: '#161b22' },
      textColor:  '#8b949e',
      fontSize:   12,
    },
    grid: {
      vertLines: { color: '#1e2530' },
      horzLines: { color: '#1e2530' },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: '#484f58', width: 1, style: 0 },
      horzLine: { color: '#484f58', width: 1, style: 0 },
    },
    rightPriceScale: {
      borderColor: '#30363d',
      scaleMargins: { top: 0.08, bottom: 0.22 },
    },
    timeScale: {
      borderColor: '#30363d',
      timeVisible: true,
      fixLeftEdge: true,
      fixRightEdge: true,
    },
  });

  _candleSeries = _lwChart.addCandlestickSeries({
    upColor:         '#3fb950',
    downColor:       '#f85149',
    borderUpColor:   '#3fb950',
    borderDownColor: '#f85149',
    wickUpColor:     '#3fb950',
    wickDownColor:   '#f85149',
  });

  // BB 밴드 fill/mask — volSeries 보다 먼저 생성해야 볼륨 바가 마스크 위에 렌더됨
  _indSeries.bbFill = _lwChart.addAreaSeries({
    topColor: 'rgba(188,140,255,0.22)', bottomColor: 'rgba(188,140,255,0.22)',
    lineColor: 'rgba(0,0,0,0)', lineWidth: 0,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });
  _indSeries.bbMask = _lwChart.addAreaSeries({
    topColor: '#161b22', bottomColor: '#161b22',
    lineColor: 'rgba(0,0,0,0)', lineWidth: 0,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });

  _volSeries = _lwChart.addHistogramSeries({
    priceFormat:  { type: 'volume' },
    priceScaleId: 'vol',
  });
  _lwChart.priceScale('vol').applyOptions({
    scaleMargins: { top: 0.78, bottom: 0 },
    borderVisible: false,
  });

  // 서브 패널(RSI·MACD) 시간축 동기화
  _lwChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (!range) return;
    if (_rsiChart)  _rsiChart.timeScale().setVisibleLogicalRange(range);
    if (_macdChart) _macdChart.timeScale().setVisibleLogicalRange(range);
  });

  // 서브 패널 크로스헤어 동기화
  _lwChart.subscribeCrosshairMove(param => {
    if (!param.point) {
      if (_rsiChart)  _rsiChart.clearCrosshairPosition();
      if (_macdChart) _macdChart.clearCrosshairPosition();
      return;
    }
    const x = param.point.x;
    if (_rsiChart  && _rsiSeries)  _rsiChart.setCrosshairPosition(x, 50, _rsiSeries);
    if (_macdChart && _macdLine)   _macdChart.setCrosshairPosition(x, 0,  _macdLine);
  });
}

// ── 이벤트 바인딩 ─────────────────────────────────────────────────────────────
function _bindSearchEvents() {
  const input = document.getElementById('chart-input');
  document.getElementById('chart-go-btn').addEventListener('click', () => {
    const t = input.value.trim().toUpperCase();
    if (t) loadChart(t);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const t = input.value.trim().toUpperCase();
      if (t) loadChart(t);
    }
  });
  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => loadChart(btn.dataset.ticker));
  });
}

function _bindPeriodEvents() {
  // 기간 버튼 (1D interval일 때만 활성)
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.period === _currentPeriod) return;
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _currentPeriod = btn.dataset.period;
      if (_currentTicker) loadChart(_currentTicker);
    });
  });

  // interval 버튼 (1m/5m/15m/30m/1H/1D)
  document.querySelectorAll('.interval-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const iv = btn.dataset.interval;
      if (iv === _currentInterval) return;
      document.querySelectorAll('.interval-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _currentInterval = iv;
      // 인트라데이 선택: 기간 버튼 숨김 / 1D: 표시
      const pg = document.getElementById('period-group');
      const sep = document.querySelector('.chart-sep');
      const isIntraday = iv !== '1d';
      if (pg)  pg.style.display  = isIntraday ? 'none' : '';
      if (sep) sep.style.display = isIntraday ? 'none' : '';
      if (_currentTicker) loadChart(_currentTicker);
    });
  });
}

function _bindResizeObserver() {
  const resizeObs = new ResizeObserver(entries => {
    for (const entry of entries) {
      const w = entry.contentRect.width;
      if (_rsiChart)  _rsiChart.resize(w, 105);
      if (_macdChart) _macdChart.resize(w, 105);
      if (_stoChart)  _stoChart.resize(w, 105);
      // 메인 차트 높이는 _resizeChartPanels()가 관리
      _resizeChartPanels();
    }
  });
  resizeObs.observe(document.getElementById('lw-chart'));
}

// ── 차트 데이터 로드 ─────────────────────────────────────────────────────────
async function loadChart(ticker) {
  ticker = ticker.toUpperCase();
  if (_compareMode) _exitCompare();   // 새 종목 로드 시 비교 모드 종료
  _currentTicker = ticker;
  document.getElementById('chart-input').value = ticker;

  // 헤더 초기화
  document.getElementById('chart-ticker-label').textContent  = ticker;
  document.getElementById('chart-company-label').textContent = '…';
  document.getElementById('chart-price-badge').innerHTML     = '';
  document.getElementById('stock-info-panel').innerHTML      = '<div class="info-placeholder">Loading…</div>';
  _setUpdatedAt('');

  // 기존 타이머 정지
  stopChartTimers();

  try {
    const encodedTicker = encodeURIComponent(ticker);
    const chartUrl = _currentInterval === '1d'
      ? `/api/chart/${encodedTicker}?interval=1d&period=${_currentPeriod}`
      : `/api/chart/${encodedTicker}?interval=${_currentInterval}`;

    let ohlcv, stockData;

    if (_isIndex(ticker)) {
      // 지수: OHLCV만 가져오고, 현재가는 /api/indices에서 추출
      ohlcv = await api(chartUrl);
      const indices = await api('/api/indices');
      const idx = indices.find(i => {
        const map = { '^GSPC':'S&P 500','^IXIC':'NASDAQ','^DJI':'Dow Jones',
                      '^RUT':'Russell 2000','^VIX':'VIX','CL=F':'WTI Crude','GC=F':'Gold' };
        return map[ticker] === i.name;
      });
      stockData = idx
        ? { ticker, name: _INDEX_NAMES[ticker] || ticker, name_ko: '',
            sector: 'Index', price: idx.value, change: idx.change,
            change_pct: idx.change_pct, volume: null,
            market_cap: null, pe: null, eps: null,
            week52_high: null, week52_low: null }
        : { ticker, name: _INDEX_NAMES[ticker] || ticker, name_ko: '',
            sector: 'Index', price: ohlcv.length ? ohlcv[ohlcv.length-1].close : null,
            change: 0, change_pct: 0, volume: null,
            market_cap: null, pe: null, eps: null,
            week52_high: null, week52_low: null };
    } else {
      [ohlcv, stockData] = await Promise.all([
        api(chartUrl),
        api(`/api/stock/${encodedTicker}`),
      ]);
    }

    if (!ohlcv.length) throw new Error('No data');

    _lastOhlcv = ohlcv;
    _renderCandles(ohlcv);
    _renderHeader(stockData);
    renderStockInfo(stockData);
    _setUpdatedAt(new Date().toLocaleTimeString('ko-KR'));
    _updateAlertBadge();
    document.getElementById('chart-alert-panel').style.display = 'none';

    if (!_isIndex(ticker)) _loadStockNews(ticker);

    _startAutoRefresh();

  } catch {
    document.getElementById('stock-info-panel').innerHTML =
      `<div class="info-placeholder" style="color:#f85149">Ticker "${ticker}" not found</div>`;
    document.getElementById('chart-ticker-label').textContent  = ticker;
    document.getElementById('chart-company-label').textContent = '';
  }
}

function _renderCandles(ohlcv) {
  _candleSeries.setData(ohlcv.map(d => ({
    time: d.time, open: d.open, high: d.high, low: d.low, close: d.close,
  })));
  _volSeries.setData(ohlcv.map(d => ({
    time:  d.time,
    value: d.volume,
    color: d.close >= d.open ? 'rgba(63,185,80,.5)' : 'rgba(248,81,73,.5)',
  })));
  _lwChart.timeScale().fitContent();
  _applyIndicators();
}

// ── 기술 지표 계산 ────────────────────────────────────────────────────────────
function _calcMA(closes, period) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    return closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

function _calcBB(closes, period = 20, mult = 2) {
  const upper = [], mid = [], lower = [];
  closes.forEach((_, i) => {
    if (i < period - 1) { upper.push(null); mid.push(null); lower.push(null); return; }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean  = slice.reduce((a, b) => a + b, 0) / period;
    const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    mid.push(mean);
    upper.push(mean + mult * std);
    lower.push(mean - mult * std);
  });
  return { upper, mid, lower };
}

// ── RSI 다이버전스 탐지 ────────────────────────────────────────────────────────
// 강세 다이버전스: 가격 저점↓ + RSI 저점↑ → 하락 모멘텀 약화 → +1
// 약세 다이버전스: 가격 고점↑ + RSI 고점↓ → 상승 모멘텀 약화 → -1
function _calcRSIDivergence(closes, order = 5) {
  const rsi    = _calcRSI(closes);
  const n      = closes.length;
  const divSig = new Array(n).fill(0);
  const pivotLows = [], pivotHighs = [];

  for (let i = order; i < n - order; i++) {
    if (rsi[i] == null) continue;
    let isLow = true, isHigh = true;
    for (let j = i - order; j <= i + order; j++) {
      if (j === i) continue;
      if (closes[j] <= closes[i]) isLow  = false;
      if (closes[j] >= closes[i]) isHigh = false;
    }
    if (isLow)  pivotLows.push(i);
    if (isHigh) pivotHighs.push(i);
  }

  for (let k = 1; k < pivotLows.length; k++) {
    const [i1, i2] = [pivotLows[k-1], pivotLows[k]];
    const gap = i2 - i1;
    if (gap < 5 || gap > 60) continue;
    if (closes[i2] < closes[i1] && rsi[i2] > rsi[i1]) divSig[i2] = 1;
  }

  for (let k = 1; k < pivotHighs.length; k++) {
    const [i1, i2] = [pivotHighs[k-1], pivotHighs[k]];
    const gap = i2 - i1;
    if (gap < 5 || gap > 60) continue;
    if (closes[i2] > closes[i1] && rsi[i2] < rsi[i1]) divSig[i2] = -1;
  }

  return divSig;
}

// ── 멀티 타임프레임: 일봉 → 주봉 집계 ────────────────────────────────────────
function _resampleWeekly(ohlcv) {
  const byWeek = new Map();
  for (const bar of ohlcv) {
    const d   = new Date(bar.time * 1000);
    const dow = d.getUTCDay();                            // 0=일, 1=월...
    const mon = new Date(d);
    mon.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
    mon.setUTCHours(0, 0, 0, 0);
    const key = mon.getTime();
    if (!byWeek.has(key)) {
      byWeek.set(key, { time: Math.floor(mon.getTime() / 1000),
                        open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    } else {
      const w = byWeek.get(key);
      w.high  = Math.max(w.high, bar.high);
      w.low   = Math.min(w.low,  bar.low);
      w.close = bar.close;
    }
  }
  return [...byWeek.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

// 주봉 MA13(3개월) 기반 추세를 일봉 배열로 반환 (1=상승, -1=하락, 0=중립)
function _getWeeklyTrendArray(ohlcv, maPeriod = 13) {
  const weekly = _resampleWeekly(ohlcv);
  const wc     = weekly.map(w => w.close);
  const wma    = _calcMA(wc, maPeriod);
  const wtList = weekly.map((w, i) => ({
    time:  w.time,
    trend: wma[i] == null ? 0 : wc[i] > wma[i] ? 1 : -1,
  }));
  const n      = ohlcv.length;
  const result = new Array(n).fill(0);
  let j = 0;
  for (let i = 0; i < n; i++) {
    while (j < wtList.length - 1 && wtList[j + 1].time <= ohlcv[i].time) j++;
    if (j < wtList.length && wtList[j].time <= ohlcv[i].time) result[i] = wtList[j].trend;
  }
  return result;
}

// ── 캔들 패턴 탐지 ────────────────────────────────────────────────────────────
// Hammer(+1), Shooting Star(-1), Bullish/Bearish Engulfing(±1)
function _calcCandlePatterns(ohlcv) {
  const n   = ohlcv.length;
  const pat = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const { open: o, high: h, low: l, close: c } = ohlcv[i];
    const { open: po, close: pc } = ohlcv[i - 1];
    const body  = Math.abs(c - o);
    const range = h - l;
    if (range === 0 || body === 0) continue;
    const upper = h - Math.max(o, c);  // 위 꼬리
    const lower = Math.min(o, c) - l;  // 아래 꼬리

    if      (lower >= 2 * body && upper <= body * 0.3)               pat[i] =  1; // Hammer
    else if (upper >= 2 * body && lower <= body * 0.3)               pat[i] = -1; // Shooting Star
    else if (pc < po && c > o && o <= pc && c >= po)                 pat[i] =  1; // Bullish Engulfing
    else if (pc > po && c < o && o >= pc && c <= po)                 pat[i] = -1; // Bearish Engulfing
  }

  return pat;
}

function _calcEMA(closes, period) {
  const k = 2 / (period + 1);
  const ema = [];
  let prev = null;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { ema.push(null); continue; }
    if (i === period - 1) {
      prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
      ema.push(prev);
    } else {
      prev = closes[i] * k + prev * (1 - k);
      ema.push(prev);
    }
  }
  return ema;
}

function _calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const ema12 = _calcEMA(closes, fast);
  const ema26 = _calcEMA(closes, slow);
  const macdVals = ema12.map((v, i) => v != null && ema26[i] != null ? v - ema26[i] : null);

  // Signal = EMA(signal) of MACD line
  const firstIdx = macdVals.findIndex(v => v != null);
  const signalVals = new Array(macdVals.length).fill(null);
  if (firstIdx === -1 || firstIdx + signal - 1 >= macdVals.length) {
    return { macd: macdVals, signal: signalVals, hist: signalVals };
  }
  const sigK = 2 / (signal + 1);
  let prevSig = macdVals.slice(firstIdx, firstIdx + signal).reduce((a, b) => a + b, 0) / signal;
  signalVals[firstIdx + signal - 1] = prevSig;
  for (let i = firstIdx + signal; i < macdVals.length; i++) {
    if (macdVals[i] == null) { signalVals[i] = null; continue; }
    prevSig = macdVals[i] * sigK + prevSig * (1 - sigK);
    signalVals[i] = prevSig;
  }

  const hist = macdVals.map((v, i) =>
    v != null && signalVals[i] != null ? v - signalVals[i] : null
  );
  return { macd: macdVals, signal: signalVals, hist };
}

function _calcStochastic(ohlcv, period = 14, smoothD = 3) {
  const len = ohlcv.length;
  const rawK = new Array(len).fill(null);
  for (let i = period - 1; i < len; i++) {
    const slice  = ohlcv.slice(i - period + 1, i + 1);
    const highest = Math.max(...slice.map(d => d.high));
    const lowest  = Math.min(...slice.map(d => d.low));
    rawK[i] = highest === lowest ? 50 : ((ohlcv[i].close - lowest) / (highest - lowest)) * 100;
  }
  const dVals = _calcMA(rawK, smoothD);   // %D = SMA(%K, 3)
  return { k: rawK, d: dVals };
}

// line1이 line2를 돌파하는 시점 감지 → LW markers 배열 반환
function _findCrossovers(line1, line2, times) {
  const markers = [];
  for (let i = 1; i < line1.length; i++) {
    if (line1[i] == null || line2[i] == null || line1[i-1] == null || line2[i-1] == null) continue;
    const crossUp   = line1[i-1] <= line2[i-1] && line1[i] > line2[i];
    const crossDown = line1[i-1] >= line2[i-1] && line1[i] < line2[i];
    if (crossUp)   markers.push({ time: times[i], position: 'belowBar', color: '#3fb950', shape: 'arrowUp',   size: 1 });
    if (crossDown) markers.push({ time: times[i], position: 'aboveBar', color: '#f85149', shape: 'arrowDown', size: 1 });
  }
  return markers;
}

function _calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return [];
  const rsi = new Array(period).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period; avgLoss /= period;
  rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d    = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? Math.abs(d) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

// ── 지표 적용 ─────────────────────────────────────────────────────────────────
function _applyIndicators() {
  if (!_lastOhlcv.length) return;
  const times  = _lastOhlcv.map(d => d.time);
  const closes = _lastOhlcv.map(d => d.close);

  const _setLine = (key, color, width = 1.5) => {
    if (!_indSeries[key]) {
      _indSeries[key] = _lwChart.addLineSeries({
        color, lineWidth: width,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
    }
  };
  const _rmLine = key => {
    if (_indSeries[key]) { _lwChart.removeSeries(_indSeries[key]); _indSeries[key] = null; }
  };
  const _toData = (vals) => vals.map((v, i) => v != null ? { time: times[i], value: +v.toFixed(4) } : null).filter(Boolean);

  // MA5
  if (_activeInds.has('ma5')) {
    _setLine('ma5', '#f0c040');
    _indSeries.ma5.setData(_toData(_calcMA(closes, 5)));
  } else { _rmLine('ma5'); }

  // MA20
  if (_activeInds.has('ma20')) {
    _setLine('ma20', '#58a6ff');
    _indSeries.ma20.setData(_toData(_calcMA(closes, 20)));
  } else { _rmLine('ma20'); }

  // MA60
  if (_activeInds.has('ma60') && closes.length >= 60) {
    _setLine('ma60', '#ff7b72');
    _indSeries.ma60.setData(_toData(_calcMA(closes, 60)));
  } else { _rmLine('ma60'); }

  // Bollinger Bands
  if (_activeInds.has('bb')) {
    const bb = _calcBB(closes);
    // fill·mask는 _createLWChart()에서 이미 생성됨 — 데이터만 세팅
    _indSeries.bbFill.setData(_toData(bb.upper));
    _indSeries.bbMask.setData(_toData(bb.lower));
    _setLine('bbU', 'rgba(188,140,255,0.85)', 1);
    _setLine('bbM', 'rgba(188,140,255,0.45)', 1);
    _setLine('bbL', 'rgba(188,140,255,0.85)', 1);
    _indSeries.bbU.setData(_toData(bb.upper));
    _indSeries.bbM.setData(_toData(bb.mid));
    _indSeries.bbL.setData(_toData(bb.lower));
  } else {
    _indSeries.bbFill.setData([]);
    _indSeries.bbMask.setData([]);
    _rmLine('bbU'); _rmLine('bbM'); _rmLine('bbL');
  }

  // Volume MA (20일, vol 스케일에 오버레이)
  if (_activeInds.has('volma')) {
    const volumes = _lastOhlcv.map(d => d.volume);
    const volMaVals = _calcMA(volumes, 20);
    if (!_indSeries.volma) {
      _indSeries.volma = _lwChart.addLineSeries({
        color: 'rgba(255,166,77,0.85)', lineWidth: 1.5,
        priceScaleId: 'vol',
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
    }
    _indSeries.volma.setData(_toData(volMaVals));
  } else { _rmLine('volma'); }

  // RSI
  const rsiPanel = document.getElementById('rsi-panel');
  if (_activeInds.has('rsi')) {
    rsiPanel.style.display = '';
    if (!_rsiChart) _createRSIChart();
    const rsiVals = _calcRSI(closes);
    const rsiData = rsiVals.map((v, i) => v != null ? { time: times[i], value: +v.toFixed(2) } : null).filter(Boolean);
    _rsiSeries.setData(rsiData);
    const t0 = times[0], t1 = times[times.length - 1];
    _rsiOb.setData([{ time: t0, value: 70 }, { time: t1, value: 70 }]);
    _rsiOs.setData([{ time: t0, value: 30 }, { time: t1, value: 30 }]);
  } else {
    rsiPanel.style.display = 'none';
  }

  // MACD
  const macdPanel = document.getElementById('macd-panel');
  if (_activeInds.has('macd')) {
    macdPanel.style.display = '';
    if (!_macdChart) _createMACDChart();
    const { macd, signal: sig, hist } = _calcMACD(closes);
    const toD = (vals) => vals.map((v, i) => v != null ? { time: times[i], value: +v.toFixed(4) } : null).filter(Boolean);
    _macdLine.setData(toD(macd));
    _macdSignal.setData(toD(sig));
    _macdHist.setData(hist.map((v, i) => v != null ? {
      time: times[i], value: +v.toFixed(4),
      color: v >= 0 ? 'rgba(63,185,80,0.7)' : 'rgba(248,81,73,0.7)',
    } : null).filter(Boolean));
    // MACD × Signal 크로스오버 마커
    _macdLine.setMarkers(_findCrossovers(macd, sig, times));
  } else {
    macdPanel.style.display = 'none';
  }

  // Stochastic
  const stoPanel = document.getElementById('sto-panel');
  if (_activeInds.has('sto')) {
    stoPanel.style.display = '';
    if (!_stoChart) _createSTOChart();
    const { k, d } = _calcStochastic(_lastOhlcv);
    const fixedScale = () => ({ priceRange: { minValue: 0, maxValue: 100 } });
    const toS = (vals) => vals.map((v, i) => v != null ? { time: times[i], value: +v.toFixed(2) } : null).filter(Boolean);
    _stoK.setData(toS(k));
    _stoD.setData(toS(d));
    const t0 = times[0], t1 = times[times.length - 1];
    _stoOb.setData([{ time: t0, value: 80 }, { time: t1, value: 80 }]);
    _stoOs.setData([{ time: t0, value: 20 }, { time: t1, value: 20 }]);
    // %K × %D 크로스오버 마커
    _stoK.setMarkers(_findCrossovers(k, d, times));
  } else {
    stoPanel.style.display = 'none';
  }

  _applySignalMarkers();
  _renderSignalCard();
  _resizeChartPanels();
}

// ── 복합 매수/매도 시그널 ────────────────────────────────────────────────────
function _calcSignals() {
  if (!_lastOhlcv.length) return null;
  const closes = _lastOhlcv.map(d => d.close);
  const times  = _lastOhlcv.map(d => d.time);
  const n      = closes.length;
  const sig    = new Array(n).fill(0);  // 각 시점 합산 점수

  // MACD: 골든크로스→+1, 데드크로스는 MACD값이 음수일 때만 -1 (제로라인 필터)
  if (_activeInds.has('macd')) {
    const { macd, signal: msig } = _calcMACD(closes);
    let state = 0;
    for (let i = 1; i < n; i++) {
      if (macd[i] == null || msig[i] == null) continue;
      if (macd[i-1] != null && msig[i-1] != null) {
        if (macd[i-1] <= msig[i-1] && macd[i] > msig[i]) state = 1;
        else if (macd[i-1] >= msig[i-1] && macd[i] < msig[i])
          state = macd[i] < 0 ? -1 : 0;  // 데드크로스 + MACD 음수만 매도
      }
      sig[i] += state;
    }
  }

  // RSI: 과매도 탈출(30 상향) → +1 매수, 과매수 탈출(70 하향) → -1 매도
  if (_activeInds.has('rsi')) {
    const rsi = _calcRSI(closes);
    let state = 0;
    for (let i = 1; i < rsi.length; i++) {
      if (rsi[i] == null || rsi[i-1] == null) continue;
      if (rsi[i-1] < 30 && rsi[i] >= 30) state = 1;       // 과매도 탈출 → 매수
      else if (rsi[i-1] >= 30 && rsi[i] < 30) state = -1; // 과매도 진입 → 하락 추세
      else if (rsi[i-1] > 70 && rsi[i] <= 70) state = -1; // 과매수 탈출 → 매도 (핵심 수정)
      else if (rsi[i-1] <= 70 && rsi[i] > 70) state = 1;  // 과매수 진입 → 강한 상승 모멘텀
      sig[i] += state;
    }
  }

  // STO: 과매도 존(이전봉 ≤30)에서 골든크로스 → +1, 과매수 존(이전봉 ≥70)에서 데드크로스 → -1
  if (_activeInds.has('sto')) {
    const { k, d } = _calcStochastic(_lastOhlcv);
    let state = 0;
    for (let i = 1; i < n; i++) {
      if (k[i] == null || d[i] == null || k[i-1] == null || d[i-1] == null) continue;
      const crossUp   = k[i-1] <= d[i-1] && k[i] > d[i];
      const crossDown = k[i-1] >= d[i-1] && k[i] < d[i];
      if (crossUp   && k[i-1] <= 30) state = 1;   // 과매도 존 골든크로스 → 매수
      if (crossDown && k[i-1] >= 70) state = -1;  // 과매수 존 데드크로스 → 매도
      sig[i] += state;
    }
  }

  // RSI 다이버전스 보너스 (RSI 활성 시 각 다이버전스 포인트에 ±1 추가)
  if (_activeInds.has('rsi')) {
    const divSig = _calcRSIDivergence(closes);
    for (let i = 0; i < n; i++) sig[i] += divSig[i];
  }

  // 캔들 패턴: 백테스트에서 정확도 저하 확인 → 스코어 미반영, UI 표시만

  // ── MA50 추세 필터 ──────────────────────────────────────────────────────────
  // 상승 추세(가격 > MA50): 매도 신호 무효화 / 하락 추세(가격 < MA50): 매수 신호 무효화
  const ma50 = _calcMA(closes, 50);
  for (let i = 0; i < n; i++) {
    if (ma50[i] == null) continue;
    if (closes[i] > ma50[i] && sig[i] < 0) sig[i] = 0;
    if (closes[i] < ma50[i] && sig[i] > 0) sig[i] = 0;
  }

  // ── 주봉 추세 필터 ──────────────────────────────────────────────────────────
  // 주봉 MA13(3개월): 주봉 상승 시 매도 억제, 주봉 하락 시 매수 억제
  const wTrend = _getWeeklyTrendArray(_lastOhlcv, 13);
  for (let i = 0; i < n; i++) {
    if (wTrend[i] ===  1 && sig[i] < 0) sig[i] = 0;
    if (wTrend[i] === -1 && sig[i] > 0) sig[i] = 0;
  }

  // ── BB %B 필터 ──────────────────────────────────────────────────────────────
  // 매수(sig≥2): 가격이 BB 하단 35% 이하일 때만 유효 (과매도 구간 확인)
  // 매도(sig≤-2): 가격이 BB 상단 65% 이상일 때만 유효 (과매수 구간 확인)
  const { upper: _bbU, lower: _bbL } = _calcBB(closes, 20, 2);
  for (let i = 0; i < n; i++) {
    const bw = _bbU[i] != null ? _bbU[i] - _bbL[i] : null;
    if (bw == null || bw === 0) continue;
    const pb = (closes[i] - _bbL[i]) / bw;
    const sellPbThr = _isKrStock(_currentTicker) ? 0.85 : 0.65;  // KR: 0.85 (백테스트 매도 +4%p), US: 0.65
    if (sig[i] >= 2  && pb >= 0.35)        sig[i] = 0;  // 매수인데 하단 근처 아님 → 차단
    if (sig[i] <= -2 && pb <= sellPbThr)   sig[i] = 0;  // 매도인데 상단 근처 아님 → 차단
  }

  // ── [전략B] KR 전용: 매도 신호 약세 캔들 확인 ────────────────────────────────
  // 백테스트 KR 매도 60.6% → 68.0% (+7.4%p) — 슈팅스타/베어리시 인걸핑 없으면 차단
  if (_isKrStock(_currentTicker)) {
    const krPat = _calcCandlePatterns(_lastOhlcv);
    for (let i = 0; i < n; i++) {
      if (sig[i] <= -2) {
        const hasBearish = krPat[i] < 0
          || (i >= 1 && krPat[i-1] < 0)
          || (i >= 2 && krPat[i-2] < 0);
        if (!hasBearish) sig[i] = 0;
      }
    }
  }

  const activeCount = (_activeInds.has('macd') ? 1 : 0) +
                      (_activeInds.has('rsi')  ? 1 : 0) +
                      (_activeInds.has('sto')  ? 1 : 0);
  const lastMa50  = ma50[n - 1];
  const lastClose = closes[n - 1];
  const trend = lastMa50 == null ? 'neutral'
              : lastClose > lastMa50 ? 'up' : 'down';

  return { sig, times, activeCount, trend };
}

function _applySignalMarkers() {
  if (!_candleSeries || !_lastOhlcv.length) return;
  const result = _calcSignals();
  if (!result || result.activeCount === 0) { _candleSeries.setMarkers([]); return; }

  const { sig, times, activeCount } = result;
  const isKr = _isKrStock(_currentTicker);
  const fmtPrice = v => isKr ? _fmtKrPrice(v) : fmt$(v);
  // score>=2 + BB%B 통과 시 마커 표시 (score=3 시도 후 되돌림: 매도 신호 소멸 문제)
  const threshold = activeCount >= 3 ? 2 : 1;
  const markers   = [];
  let   prevScore = 0;

  for (let i = 1; i < sig.length; i++) {
    const s = sig[i];
    if (s === prevScore) continue;
    prevScore = s;
    const price = fmtPrice(_lastOhlcv[i].close);
    if (s >= threshold) {
      markers.push({
        time: times[i], position: 'belowBar',
        color: s >= 3 ? '#3fb950' : '#58a6ff',
        shape: 'arrowUp', size: s >= 3 ? 3 : 1.5,
        text: (s >= 3 ? 'BUY ' : 'buy ') + price,
      });
    } else if (s <= -threshold) {
      markers.push({
        time: times[i], position: 'aboveBar',
        color: s <= -3 ? '#f85149' : '#ffa64d',
        shape: 'arrowDown', size: s <= -3 ? 3 : 1.5,
        text: (s <= -3 ? 'SELL ' : 'sell ') + price,
      });
    }
  }
  _candleSeries.setMarkers(markers);
}

function _renderSignalCard() {
  const card = document.getElementById('signal-card');
  if (!card) return;

  const activeCount = (_activeInds.has('macd') ? 1 : 0) +
                      (_activeInds.has('rsi')  ? 1 : 0) +
                      (_activeInds.has('sto')  ? 1 : 0);
  if (activeCount === 0 || !_lastOhlcv.length) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  const closes = _lastOhlcv.map(d => d.close);
  const n      = closes.length;
  const rows   = [];
  let   total  = 0;

  // MACD 최신 상태 (제로라인 필터)
  if (_activeInds.has('macd')) {
    const { macd, signal: msig } = _calcMACD(closes);
    let s = 0;
    for (let i = 1; i < n; i++) {
      if (macd[i] == null || msig[i] == null || macd[i-1] == null || msig[i-1] == null) continue;
      if (macd[i-1] <= msig[i-1] && macd[i] > msig[i]) s = 1;
      else if (macd[i-1] >= msig[i-1] && macd[i] < msig[i])
        s = macd[i] < 0 ? -1 : 0;
    }
    total += s;
    const val = macd[n-1] != null ? macd[n-1].toFixed(3) : '—';
    rows.push({ label: 'MACD', score: s, detail: val });
  }

  // RSI 최신 상태
  if (_activeInds.has('rsi')) {
    const rsi = _calcRSI(closes);
    let s = 0;
    for (let i = 1; i < rsi.length; i++) {
      if (rsi[i] == null || rsi[i-1] == null) continue;
      if (rsi[i-1] < 30 && rsi[i] >= 30) s = 1;
      else if (rsi[i-1] >= 30 && rsi[i] < 30) s = -1;
      else if (rsi[i-1] > 70 && rsi[i] <= 70) s = -1;
      else if (rsi[i-1] <= 70 && rsi[i] > 70) s = 1;
    }
    total += s;
    const last = rsi[rsi.length - 1];
    const val  = last != null ? last.toFixed(1) : '—';
    rows.push({ label: 'RSI', score: s, detail: val });
  }

  // STO 최신 상태
  if (_activeInds.has('sto')) {
    const { k, d } = _calcStochastic(_lastOhlcv);
    let s = 0;
    for (let i = 1; i < n; i++) {
      if (k[i] == null || d[i] == null || k[i-1] == null || d[i-1] == null) continue;
      if (k[i-1] <= d[i-1] && k[i] > d[i] && k[i-1] <= 30) s = 1;
      if (k[i-1] >= d[i-1] && k[i] < d[i] && k[i-1] >= 70) s = -1;
    }
    total += s;
    const last = k[k.length - 1];
    const val  = last != null ? last.toFixed(1) : '—';
    rows.push({ label: 'STO', score: s, detail: val });
  }

  // RSI 다이버전스 최신 상태 (RSI 활성 시, 최근 20봉 내 마지막 감지값)
  let divScore = 0;
  if (_activeInds.has('rsi')) {
    const divArr = _calcRSIDivergence(closes);
    for (let i = n - 1; i >= Math.max(0, n - 20); i--) {
      if (divArr[i] !== 0) { divScore = divArr[i]; break; }
    }
    total += divScore;
    rows.push({
      label: 'DIV',
      score: divScore,
      detail: divScore > 0 ? '강세' : divScore < 0 ? '약세' : '—',
    });
  }

  // 캔들 패턴 (정보 표시용, 스코어 미반영)
  const patArr   = _calcCandlePatterns(_lastOhlcv);
  const patScore = patArr[n - 1] !== 0 ? patArr[n - 1]
                 : patArr[n - 2] !== 0 ? patArr[n - 2]
                 : patArr[n - 3] !== 0 ? patArr[n - 3] : 0;
  const patName  = patScore > 0
    ? (patArr[n-1] !== 0 ? 'Hammer' : 'Bullish Eng.')
    : patScore < 0
    ? (patArr[n-1] !== 0 ? 'Shooting Star' : 'Bearish Eng.')
    : '—';
  rows.push({ label: 'CANDLE', score: 0, detail: patName, infoOnly: true });

  // MA50 추세 방향 계산
  const ma50arr   = _calcMA(closes, 50);
  const lastMa50  = ma50arr[n - 1];
  const lastClose = closes[n - 1];
  const trendUp   = lastMa50 != null && lastClose > lastMa50;
  const trendDown = lastMa50 != null && lastClose < lastMa50;

  // MA50 필터: 추세 반대 신호 무효화
  const filteredByMA50 = lastMa50 == null ? total
    : (trendUp && total < 0) ? 0
    : (trendDown && total > 0) ? 0
    : total;

  // BB %B 계산 및 필터
  const { upper: _bbU2, lower: _bbL2 } = _calcBB(closes, 20, 2);
  const lastBbU = _bbU2[n - 1]; const lastBbL = _bbL2[n - 1];
  const lastBw  = (lastBbU != null) ? lastBbU - lastBbL : null;
  const lastPb  = (lastBw != null && lastBw > 0) ? (lastClose - lastBbL) / lastBw : null;
  const _sellThr = _isKrStock(_currentTicker) ? 0.85 : 0.65;
  const filteredTotal = (lastPb == null) ? filteredByMA50
    : (filteredByMA50 >= 2  && lastPb >= 0.35)      ? 0
    : (filteredByMA50 <= -2 && lastPb <= _sellThr)  ? 0
    : filteredByMA50;

  // [전략B] KR 전용: 매도 신호 약세 캔들 확인 (슈팅스타/베어리시 인걸핑 없으면 차단)
  const isKrMode = _isKrStock(_currentTicker);
  let candleBlocked = false;
  if (isKrMode && filteredTotal <= -2) {
    const hasBearish = patArr[n-1] < 0
      || (n >= 2 && patArr[n-2] < 0)
      || (n >= 3 && patArr[n-3] < 0);
    if (!hasBearish) candleBlocked = true;
  }
  const finalTotal = candleBlocked ? 0 : filteredTotal;
  if (isKrMode) {
    const cr = rows.find(r => r.label === 'CANDLE');
    if (cr) cr.detail = candleBlocked          ? '⚡ 매도 차단'
                      : (filteredTotal <= -2 && patScore < 0) ? patName + ' ✓'
                      : patName;
  }

  const scoreColor = finalTotal > 0 ? '#3fb950' : finalTotal < 0 ? '#f85149' : '#8b949e';
  const scoreLabel = finalTotal >= 3 ? 'STRONG BUY'  : finalTotal === 2  ? 'BUY'
                   : finalTotal <= -3 ? 'STRONG SELL' : finalTotal === -2 ? 'SELL'
                   : finalTotal === 1 ? 'Weak Buy'    : finalTotal === -1 ? 'Weak Sell' : 'Neutral';

  const trendColor = trendUp ? '#3fb950' : trendDown ? '#f85149' : '#8b949e';
  const trendLabel = trendUp ? '▲ 상승 추세' : trendDown ? '▼ 하락 추세' : '— 중립';
  const ma50Val    = lastMa50 != null ? lastMa50.toFixed(2) : '—';
  const trendRow   = `<div class="sc-row sc-trend-row">
    <span class="sc-label">MA50</span>
    <span class="sc-val">${ma50Val}</span>
    <span class="sc-sig" style="color:${trendColor}">${trendLabel}</span>
  </div>`;

  // 주봉 MA13 추세 행
  const wTrendArr  = _getWeeklyTrendArray(_lastOhlcv, 13);
  const wTrendNow  = wTrendArr[n - 1];
  const wTrendColor = wTrendNow ===  1 ? '#3fb950' : wTrendNow === -1 ? '#f85149' : '#8b949e';
  const wTrendLabel = wTrendNow ===  1 ? '▲ 주봉 상승' : wTrendNow === -1 ? '▼ 주봉 하락' : '— 중립';
  const weeklyRow  = `<div class="sc-row sc-trend-row">
    <span class="sc-label">W.MA13</span>
    <span class="sc-val">주봉</span>
    <span class="sc-sig" style="color:${wTrendColor}">${wTrendLabel}</span>
  </div>`;

  // BB %B 행
  const pbPct = lastPb != null ? `${(lastPb * 100).toFixed(0)}%` : '—';
  const bbBlocked = lastPb != null && (
    (filteredByMA50 >= 2  && lastPb >= 0.35) ||
    (filteredByMA50 <= -2 && lastPb <= _sellThr)
  );
  const pbColor = bbBlocked ? '#ffa64d'
    : lastPb == null   ? '#8b949e'
    : lastPb < 0.20    ? '#3fb950'
    : lastPb < 0.35    ? '#58a6ff'
    : lastPb > 0.80    ? '#f85149'
    : lastPb > 0.65    ? '#ffa64d'
    : '#8b949e';
  const pbLabel = bbBlocked       ? '⚡ 신호 차단'
    : lastPb == null   ? '—'
    : lastPb < 0.20    ? '하단권 (강한 반등)'
    : lastPb < 0.35    ? '하단 근처'
    : lastPb > 0.80    ? '상단권 (강한 조정)'
    : lastPb > 0.65    ? '상단 근처'
    : '중립 구간';
  const bbRow = `<div class="sc-row">
    <span class="sc-label">%B</span>
    <span class="sc-val">${pbPct}</span>
    <span class="sc-sig" style="color:${pbColor}">${pbLabel}</span>
  </div>`;

  const rowsHtml = rows.map(r => {
    if (r.infoOnly) {
      const ic = r.detail === '—' ? '#8b949e' : r.detail.startsWith('B') ? '#58a6ff' : '#ffa64d';
      return `<div class="sc-row">
        <span class="sc-label">${r.label}</span>
        <span class="sc-val" style="color:${ic}">${r.detail}</span>
        <span class="sc-sig" style="color:#555e6b">참고</span>
      </div>`;
    }
    // 추세 반대 신호는 회색으로 표시 (필터됨)
    const filtered = (trendUp && r.score < 0) || (trendDown && r.score > 0);
    const ic = filtered ? '#444c56'
             : r.score > 0 ? '#3fb950' : r.score < 0 ? '#f85149' : '#8b949e';
    const il = filtered
             ? (r.score > 0 ? '▲ 매수 (필터)' : '▼ 매도 (필터)')
             : r.score > 0 ? '▲ 매수' : r.score < 0 ? '▼ 매도' : '— 중립';
    return `<div class="sc-row">
      <span class="sc-label">${r.label}</span>
      <span class="sc-val">${r.detail}</span>
      <span class="sc-sig" style="color:${ic}">${il}</span>
    </div>`;
  }).join('');

  const totalSlots = activeCount + (_activeInds.has('rsi') ? 1 : 0); // DIV는 RSI 활성 시 포함
  const scoreBg = finalTotal > 0 ? 'rgba(63,185,80,0.14)'
                : finalTotal < 0 ? 'rgba(248,81,73,0.14)'
                : 'rgba(139,148,158,0.08)';
  card.innerHTML = `
    <div class="sc-banner" style="background:${scoreBg};border-left-color:${scoreColor}">
      <div class="sc-title">SIGNAL</div>
      <div class="sc-score" style="color:${scoreColor}">${scoreLabel}</div>
      <div class="sc-score-num" style="color:${scoreColor}">${finalTotal > 0 ? '+' : ''}${finalTotal} / ${totalSlots}</div>
    </div>
    <div class="sc-divider"></div>
    ${trendRow}
    ${weeklyRow}
    ${bbRow}
    <div class="sc-divider"></div>
    ${rowsHtml}`;
}

// 서브 패널 수에 따라 메인 차트 높이 동적 조절 (뷰포트 기반)
function _resizeChartPanels() {
  const PANEL_H   = 105;
  const PANEL_GAP = 2;
  const count   = (_activeInds.has('rsi') ? 1 : 0) + (_activeInds.has('macd') ? 1 : 0) + (_activeInds.has('sto') ? 1 : 0);
  const el      = document.getElementById('lw-chart');
  const topY    = el.getBoundingClientRect().top || 280;
  const TOTAL_H = Math.max(window.innerHeight - topY - 24, 300);
  const mainH   = Math.max(TOTAL_H - count * (PANEL_H + PANEL_GAP), 200);
  const w       = el.clientWidth || 900;
  if (_lwChart) _lwChart.resize(w, mainH);
}

function _createRSIChart() {
  const container = document.getElementById('rsi-chart');
  _rsiChart = LightweightCharts.createChart(container, {
    width:  container.clientWidth || 900,
    height: 105,
    layout: { background: { type: 'solid', color: '#161b22' }, textColor: '#8b949e', fontSize: 11 },
    grid:   { vertLines: { color: '#1e2530' }, horzLines: { color: '#1e2530' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#30363d', scaleMargins: { top: 0.05, bottom: 0.05 } },
    timeScale: { borderColor: '#30363d', timeVisible: false, fixLeftEdge: true, fixRightEdge: true },
    handleScroll: false,
    handleScale: false,
  });
  // y축 0~100 고정을 위해 모든 RSI 시리즈에 autoscaleInfoProvider 적용
  const _fixedRsiScale = () => ({ priceRange: { minValue: 0, maxValue: 100 } });
  _rsiSeries = _rsiChart.addLineSeries({ color: '#e3b341', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true, autoscaleInfoProvider: _fixedRsiScale });
  _rsiOb     = _rsiChart.addLineSeries({ color: 'rgba(248,81,73,0.5)',  lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: _fixedRsiScale });
  _rsiOs     = _rsiChart.addLineSeries({ color: 'rgba(63,185,80,0.5)',  lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: _fixedRsiScale });
}

function _createMACDChart() {
  const container = document.getElementById('macd-chart');
  _macdChart = LightweightCharts.createChart(container, {
    width:  container.clientWidth || 900,
    height: 105,
    layout: { background: { type: 'solid', color: '#161b22' }, textColor: '#8b949e', fontSize: 11 },
    grid:   { vertLines: { color: '#1e2530' }, horzLines: { color: '#1e2530' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#30363d', scaleMargins: { top: 0.15, bottom: 0.15 } },
    timeScale: { borderColor: '#30363d', timeVisible: false, fixLeftEdge: true, fixRightEdge: true },
    handleScroll: false,
    handleScale: false,
  });
  _macdHist   = _macdChart.addHistogramSeries({
    color: 'rgba(63,185,80,0.7)', priceLineVisible: false, lastValueVisible: false,
  });
  _macdLine   = _macdChart.addLineSeries({
    color: '#58a6ff', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true,
    crosshairMarkerVisible: false,
  });
  _macdSignal = _macdChart.addLineSeries({
    color: '#ffa64d', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true,
    crosshairMarkerVisible: false,
  });
}

function _createSTOChart() {
  const container = document.getElementById('sto-chart');
  _stoChart = LightweightCharts.createChart(container, {
    width:  container.clientWidth || 900,
    height: 105,
    layout: { background: { type: 'solid', color: '#161b22' }, textColor: '#8b949e', fontSize: 11 },
    grid:   { vertLines: { color: '#1e2530' }, horzLines: { color: '#1e2530' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#30363d', scaleMargins: { top: 0.05, bottom: 0.05 } },
    timeScale: { borderColor: '#30363d', timeVisible: false, fixLeftEdge: true, fixRightEdge: true },
    handleScroll: false,
    handleScale: false,
  });
  const fixedScale = () => ({ priceRange: { minValue: 0, maxValue: 100 } });
  _stoK  = _stoChart.addLineSeries({ color: '#c9d1d9', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true,  autoscaleInfoProvider: fixedScale });
  _stoD  = _stoChart.addLineSeries({ color: '#ffa64d', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true,  autoscaleInfoProvider: fixedScale });
  _stoOb = _stoChart.addLineSeries({ color: 'rgba(248,81,73,0.5)',  lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: fixedScale });
  _stoOs = _stoChart.addLineSeries({ color: 'rgba(63,185,80,0.5)',  lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: fixedScale });
  // 메인 차트와 시간축·크로스헤어 동기화
  _lwChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (range && _stoChart) _stoChart.timeScale().setVisibleLogicalRange(range);
  });
  _lwChart.subscribeCrosshairMove(param => {
    if (!param.point) { if (_stoChart) _stoChart.clearCrosshairPosition(); return; }
    if (_stoChart && _stoK) _stoChart.setCrosshairPosition(param.point.x, 50, _stoK);
  });
}

// ── 지표 버튼 이벤트 ─────────────────────────────────────────────────────────
function _bindIndicatorEvents() {
  document.querySelectorAll('.ind-btn').forEach(btn => {
    // 초기 상태: _activeInds에 있으면 버튼 active 표시
    if (_activeInds.has(btn.dataset.ind)) btn.classList.add('active');
    btn.addEventListener('click', () => {
      const ind = btn.dataset.ind;
      if (_activeInds.has(ind)) {
        _activeInds.delete(ind);
        btn.classList.remove('active');
      } else {
        _activeInds.add(ind);
        btn.classList.add('active');
      }
      _applyIndicators();
    });
  });
}

// ── 가격 알림 ─────────────────────────────────────────────────────────────────
function _alertLoad() {
  try { return JSON.parse(localStorage.getItem(_ALERT_KEY) || '[]'); } catch { return []; }
}
function _alertSave(list) {
  localStorage.setItem(_ALERT_KEY, JSON.stringify(list));
}
function _alertAdd(ticker, targetPrice, direction) {
  const list = _alertLoad();
  list.push({ id: Date.now(), ticker, targetPrice, direction });
  _alertSave(list);
}
function _alertRemove(id) {
  _alertSave(_alertLoad().filter(a => a.id !== id));
}

function _alertCheck(ticker, price) {
  if (!ticker || price == null) return;
  const list = _alertLoad();
  for (const a of list) {
    if (a.ticker !== ticker) continue;
    if (_alertFired.has(a.id)) continue;
    const triggered = a.direction === 'above' ? price >= a.targetPrice : price <= a.targetPrice;
    if (!triggered) continue;
    _alertFired.add(a.id);
    _showNotification(ticker, a.targetPrice, a.direction, price);
    _alertRemove(a.id);
    _renderAlertList();
    _updateAlertBadge();
  }
}

function _showNotification(ticker, target, direction, price) {
  const msg = `${ticker} ${direction === 'above' ? '▲' : '▼'} $${target} 도달 (현재: $${price.toFixed(2)})`;
  if (Notification.permission === 'granted') {
    new Notification('📈 StockView 가격 알림', { body: msg, icon: '/static/img/icon.png' });
  } else {
    alert(msg);
  }
}

function _renderAlertList() {
  const el = document.getElementById('alert-list');
  if (!el) return;
  const list = _alertLoad().filter(a => a.ticker === _currentTicker);
  if (!list.length) {
    el.innerHTML = '<div class="alert-empty">설정된 알림 없음</div>';
    return;
  }
  el.innerHTML = list.map(a =>
    `<div class="alert-item">
      <span class="alert-dir ${a.direction === 'above' ? 'up' : 'down'}">${a.direction === 'above' ? '▲' : '▼'}</span>
      <span class="alert-price">$${a.targetPrice}</span>
      <button class="alert-del-btn" onclick="_alertRemove(${a.id});_renderAlertList();_updateAlertBadge()">✕</button>
    </div>`
  ).join('');
}

function _updateAlertBadge() {
  const badge = document.getElementById('chart-alert-badge');
  if (!badge) return;
  const cnt = _alertLoad().filter(a => a.ticker === _currentTicker).length;
  if (cnt > 0) { badge.textContent = cnt; badge.style.display = 'inline'; }
  else { badge.style.display = 'none'; }
}

function _bindAlertEvents() {
  const btn   = document.getElementById('chart-alert-btn');
  const panel = document.getElementById('chart-alert-panel');
  const addBtn = document.getElementById('alert-add-btn');

  btn?.addEventListener('click', () => {
    if (!_currentTicker) return;
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : '';
    if (!open) {
      document.getElementById('alert-ticker-label').textContent = _currentTicker;
      _renderAlertList();
      if (Notification.permission === 'default') Notification.requestPermission();
    }
  });

  addBtn?.addEventListener('click', () => {
    const price = parseFloat(document.getElementById('alert-price-input').value);
    const dir   = document.getElementById('alert-direction').value;
    if (!_currentTicker || isNaN(price) || price <= 0) return;
    _alertAdd(_currentTicker, price, dir);
    document.getElementById('alert-price-input').value = '';
    _renderAlertList();
    _updateAlertBadge();
  });

  document.getElementById('alert-price-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') addBtn?.click();
  });
}

// ── 비교 모드 ─────────────────────────────────────────────────────────────────
async function _loadCompareChart(ticker2) {
  if (!_currentTicker || !ticker2) return;
  _compareTicker = ticker2.toUpperCase();

  const enc1 = encodeURIComponent(_currentTicker);
  const enc2 = encodeURIComponent(_compareTicker);
  const mkUrl = (enc) => _currentInterval === '1d'
    ? `/api/chart/${enc}?interval=1d&period=${_currentPeriod}`
    : `/api/chart/${enc}?interval=${_currentInterval}`;

  let data1, data2;
  try {
    [data1, data2] = await Promise.all([api(mkUrl(enc1)), api(mkUrl(enc2))]);
  } catch { return; }
  if (!data1.length || !data2.length) return;

  // 공통 타임스탬프만 사용 (교집합)
  const set2 = new Set(data2.map(d => d.time));
  const f1   = data1.filter(d => set2.has(d.time));
  const set1 = new Set(f1.map(d => d.time));
  const f2   = data2.filter(d => set1.has(d.time));
  if (!f1.length) return;

  const base1 = f1[0].close;
  const base2 = f2[0].close;
  const norm1 = f1.map(d => ({ time: d.time, value: +(d.close / base1 * 100).toFixed(3) }));
  const norm2 = f2.map(d => ({ time: d.time, value: +(d.close / base2 * 100).toFixed(3) }));

  // 캔들/볼륨 숨김
  _candleSeries.applyOptions({ visible: false });
  _volSeries.applyOptions({ visible: false });
  document.getElementById('rsi-panel').style.display  = 'none';
  document.getElementById('macd-panel').style.display = 'none';
  document.getElementById('sto-panel').style.display  = 'none';
  document.querySelectorAll('.ind-btn').forEach(b => { b.disabled = true; b.style.opacity = '.4'; });

  // 기존 비교 시리즈 제거
  if (_cmpMainSeries) { _lwChart.removeSeries(_cmpMainSeries); _cmpMainSeries = null; }
  if (_cmpSeries)     { _lwChart.removeSeries(_cmpSeries);     _cmpSeries     = null; }

  _cmpMainSeries = _lwChart.addLineSeries({
    color: '#58a6ff', lineWidth: 2.5,
    priceLineVisible: false, lastValueVisible: true,
    title: _currentTicker,
    crosshairMarkerRadius: 4,
  });
  _cmpSeries = _lwChart.addLineSeries({
    color: '#ffa64d', lineWidth: 2.5,
    priceLineVisible: false, lastValueVisible: true,
    title: _compareTicker,
    crosshairMarkerRadius: 4,
  });
  _cmpMainSeries.setData(norm1);
  _cmpSeries.setData(norm2);
  _lwChart.timeScale().fitContent();

  _compareMode = true;

  // 범례 표시
  const legend = document.getElementById('cmp-legend');
  if (legend) {
    legend.style.display = '';
    document.getElementById('cmp-leg-main').textContent    = _currentTicker;
    document.getElementById('cmp-leg-compare').textContent = _compareTicker;
  }
  // 비교 버튼 활성 표시
  document.getElementById('chart-cmp-toggle')?.classList.add('active');
}

function _exitCompare() {
  _compareMode   = false;
  _compareTicker = null;

  if (_cmpMainSeries) { _lwChart.removeSeries(_cmpMainSeries); _cmpMainSeries = null; }
  if (_cmpSeries)     { _lwChart.removeSeries(_cmpSeries);     _cmpSeries     = null; }

  _candleSeries.applyOptions({ visible: true });
  _volSeries.applyOptions({ visible: true });

  // 활성 지표 패널 복원
  if (_activeInds.has('rsi'))  document.getElementById('rsi-panel').style.display  = '';
  if (_activeInds.has('macd')) document.getElementById('macd-panel').style.display = '';
  if (_activeInds.has('sto'))  document.getElementById('sto-panel').style.display  = '';

  document.querySelectorAll('.ind-btn').forEach(b => { b.disabled = false; b.style.opacity = ''; });

  const row = document.getElementById('chart-compare-row');
  if (row) row.style.display = 'none';
  const inp = document.getElementById('chart-cmp-input');
  if (inp) inp.value = '';

  const legend = document.getElementById('cmp-legend');
  if (legend) legend.style.display = 'none';

  document.getElementById('chart-cmp-toggle')?.classList.remove('active');
}

function _bindCompareEvents() {
  const toggleBtn = document.getElementById('chart-cmp-toggle');
  const goBtn     = document.getElementById('chart-cmp-go');
  const clearBtn  = document.getElementById('chart-cmp-clear');
  const input     = document.getElementById('chart-cmp-input');

  const _run = async () => {
    const t = input?.value.trim().toUpperCase();
    if (!t || !_currentTicker) return;
    if (t === _currentTicker) { input.value = ''; return; }
    await _loadCompareChart(t);
  };

  toggleBtn?.addEventListener('click', () => {
    if (_compareMode) {
      _exitCompare();
    } else {
      const row = document.getElementById('chart-compare-row');
      if (row) row.style.display = '';
      input?.focus();
    }
  });

  goBtn?.addEventListener('click', _run);
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') _run(); });
  clearBtn?.addEventListener('click', _exitCompare);
}

function _renderHeader(stock) {
  document.getElementById('chart-ticker-label').textContent  = stock.ticker;
  document.getElementById('chart-company-label').textContent =
    stock.name_ko ? `${stock.name} (${stock.name_ko})` : stock.name;
  _updatePriceBadge(stock);
}

function _updatePriceBadge(stock) {
  const cls  = colorCls(stock.change_pct || 0);
  const isKr = _isKrStock(stock.ticker || '');
  const price   = isKr
    ? _fmtKrPrice(stock.price)
    : (stock.price ? fmt$(stock.price) : '—');
  const change  = stock.change != null
    ? `${stock.change >= 0 ? '+' : ''}${isKr ? _fmtKrPrice(Math.abs(stock.change)) : fmt$(stock.change)}`
    : '—';
  const pct = stock.change_pct != null ? fmtPct(stock.change_pct) : '—';
  document.getElementById('chart-price-badge').innerHTML = `
    <span class="${cls}" style="font-size:20px;font-weight:800">${price}</span><br>
    <span class="${cls}">${change} (${pct})</span>
  `;
}

function _setUpdatedAt(text) {
  const el = document.getElementById('chart-updated-at');
  if (el) el.textContent = text ? `업데이트: ${text}` : '';
}

// ── 자동 갱신 ─────────────────────────────────────────────────────────────────
function _startAutoRefresh() {
  const liveBadge = document.getElementById('chart-live-badge');
  if (liveBadge) liveBadge.style.display = 'inline';

  // 30초마다 현재가 + 가격 배지 갱신
  _priceTimer = setInterval(async () => {
    if (!_currentTicker) return;
    try {
      if (_isIndex(_currentTicker)) {
        const indices = await api('/api/indices');
        const map = { '^GSPC':'S&P 500','^IXIC':'NASDAQ','^DJI':'Dow Jones',
                      '^RUT':'Russell 2000','^VIX':'VIX','CL=F':'WTI Crude','GC=F':'Gold' };
        const idx = indices.find(i => map[_currentTicker] === i.name);
        if (idx) {
          const s = { ticker: _currentTicker, price: idx.value,
                      change: idx.change, change_pct: idx.change_pct,
                      name: _INDEX_NAMES[_currentTicker] || _currentTicker,
                      name_ko:'', sector:'Index', volume:null,
                      market_cap:null, pe:null, eps:null,
                      week52_high:null, week52_low:null };
          _updatePriceBadge(s);
          renderStockInfo(s);
          _alertCheck(_currentTicker, s.price);
        }
      } else {
        const stock = await api(`/api/stock/${encodeURIComponent(_currentTicker)}`);
        _updatePriceBadge(stock);
        renderStockInfo(stock);
        _alertCheck(_currentTicker, stock.price);
      }
    } catch {}
  }, 30_000);

  // interval별 주기로 캔들 업데이트
  const candleMs = _CANDLE_REFRESH[_currentInterval] || 60_000;
  _candleTimer = setInterval(async () => {
    if (!_currentTicker) return;
    try {
      const enc = encodeURIComponent(_currentTicker);
      const chartUrl = _currentInterval === '1d'
        ? `/api/chart/${enc}?interval=1d&period=${_currentPeriod}`
        : `/api/chart/${enc}?interval=${_currentInterval}`;
      const ohlcv = await api(chartUrl);
      if (!ohlcv.length) return;

      const latest = ohlcv[ohlcv.length - 1];
      const prev   = _lastOhlcv[_lastOhlcv.length - 1];

      if (prev && latest.time === prev.time) {
        // 같은 날짜: 마지막 캔들만 업데이트 (화면 깜빡임 없음)
        _candleSeries.update({
          time: latest.time, open: latest.open,
          high: latest.high, low: latest.low, close: latest.close,
        });
        _volSeries.update({
          time:  latest.time,
          value: latest.volume,
          color: latest.close >= latest.open ? 'rgba(63,185,80,.5)' : 'rgba(248,81,73,.5)',
        });
      } else {
        // 새 날짜 캔들 추가: 전체 재렌더
        _lastOhlcv = ohlcv;
        _renderCandles(ohlcv);
      }

      _lastOhlcv = ohlcv;
      _setUpdatedAt(new Date().toLocaleTimeString('ko-KR'));
    } catch {}
  }, candleMs);
}

// ── 종목 정보 사이드바 ────────────────────────────────────────────────────────
function renderStockInfo(s) {
  const cls    = colorCls(s.change_pct || 0);
  const isKr   = _isKrStock(s.ticker || '');
  const fmtP   = v => isKr ? _fmtKrPrice(v) : fmt$(v);
  const fmtKrCap = v => v >= 1e12 ? (v/1e12).toFixed(1)+'조원' : v >= 1e8 ? Math.round(v/1e8)+'억원' : '—';
  const peStr  = s.pe  > 0 ? s.pe.toFixed(1) : '—';
  const epsStr = s.eps != null && s.eps !== 0
    ? (s.eps > 0 ? fmtP(s.eps) : `<span class="down">${fmtP(Math.abs(s.eps))}</span>`)
    : '—';
  const capStr = isKr
    ? (s.market_cap ? fmtKrCap(s.market_cap) : '—')
    : (s.market_cap ? fmtCap(s.market_cap) : '—');
  const hiPct  = s.week52_high && s.price
    ? ((s.price / s.week52_high - 1) * 100).toFixed(1) + '%'
    : '—';

  document.getElementById('stock-info-panel').innerHTML = `
    <div class="info-section-title">Key Statistics</div>
    <div class="info-row">
      <span class="info-label">Price</span>
      <span class="info-val">${s.price ? fmtP(s.price) : '—'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Change</span>
      <span class="info-val ${cls}">${s.change != null ? (s.change >= 0 ? '+' : '') + fmtP(Math.abs(s.change)) : '—'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Change %</span>
      <span class="info-val ${cls}">${s.change_pct != null ? fmtPct(s.change_pct) : '—'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Volume</span>
      <span class="info-val">${s.volume ? fmtVol(s.volume) : '—'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Mkt Cap</span>
      <span class="info-val">${capStr}</span>
    </div>
    <div class="info-section-title" style="margin-top:4px">Valuation</div>
    <div class="info-row">
      <span class="info-label">P/E Ratio</span>
      <span class="info-val">${peStr}</span>
    </div>
    <div class="info-row">
      <span class="info-label">EPS</span>
      <span class="info-val">${epsStr}</span>
    </div>
    <div class="info-row">
      <span class="info-label">${isKr ? '업종' : 'Sector'}</span>
      <span class="info-val info-sector-badge" style="font-size:11px">${s.sector || '—'}</span>
    </div>
    <div class="info-section-title" style="margin-top:4px">52-Week Range</div>
    <div class="info-row">
      <span class="info-label">High</span>
      <span class="info-val up">${s.week52_high ? fmtP(s.week52_high) : '—'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Low</span>
      <span class="info-val down">${s.week52_low ? fmtP(s.week52_low) : '—'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">vs 52W High</span>
      <span class="info-val ${colorCls(s.price && s.week52_high ? s.price/s.week52_high*100-100 : 0)}">
        ${hiPct}
      </span>
    </div>
    <div id="stock-news-section"></div>
    ${isKr ? '<div id="kr-investor-section"></div>' : ''}
  `;
  if (isKr) _loadKrInvestor(s.ticker);
}

async function _loadKrInvestor(ticker) {
  const section = document.getElementById('kr-investor-section');
  if (!section) return;
  const code = ticker.replace(/\.(KS|KQ)$/, '');
  section.innerHTML = `<div class="info-section-title" style="margin-top:10px">수급 동향 (최근 5일)</div>
    <div style="color:#8b949e;font-size:11px;padding:4px 0">Loading…</div>`;
  try {
    const rows = await api(`/api/kr-investor/${code}`);
    if (!rows || !rows.length) {
      section.innerHTML = `<div class="info-section-title" style="margin-top:10px">수급 동향</div>
        <div style="color:#8b949e;font-size:11px;padding:4px 0">정보 없음</div>`;
      return;
    }
    const fmtV = v => {
      if (!v) return '<span style="color:#8b949e">—</span>';
      const abs = Math.abs(v).toLocaleString('ko-KR');
      return v >= 0
        ? `<span class="up">+${abs}</span>`
        : `<span class="down">-${abs}</span>`;
    };
    const header = `<div class="investor-row investor-header">
      <span>날짜</span><span>개인</span><span>외인</span><span>기관</span>
    </div>`;
    const body = rows.map(r => `
      <div class="investor-row">
        <span class="investor-date">${r.date.slice(5)}</span>
        ${fmtV(r.individual)}${fmtV(r.foreign)}${fmtV(r.institution)}
      </div>`).join('');
    section.innerHTML = `<div class="info-section-title" style="margin-top:10px">수급 동향 (최근 5일)</div>
      <div class="investor-table">${header}${body}</div>`;
  } catch {
    section.innerHTML = '';
  }
}

async function _loadStockNews(ticker) {
  const section = document.getElementById('stock-news-section');
  if (!section) return;
  section.innerHTML = `<div class="info-section-title" style="margin-top:10px">Related News</div>
    <div style="color:#8b949e;font-size:11px;padding:4px 0">Loading…</div>`;
  try {
    const news = await api(`/api/stock-news/${encodeURIComponent(ticker)}`);
    if (!news || !news.length) {
      section.innerHTML = `<div class="info-section-title" style="margin-top:10px">Related News</div>
        <div style="color:#8b949e;font-size:11px;padding:4px 0">No recent news</div>`;
      return;
    }
    const items = news.slice(0, 8).map(n => {
      const cls = n.sentiment === 'positive' ? 'up' : n.sentiment === 'negative' ? 'down' : '';
      return `<div class="stock-news-item" onclick="window.open('${n.url}','_blank')">
        <span class="stock-news-dot ${cls}"></span>
        <span class="stock-news-title">${n.title}</span>
        <div class="stock-news-meta">${n.source} · ${n.time}</div>
      </div>`;
    }).join('');
    section.innerHTML = `<div class="info-section-title" style="margin-top:10px">Related News</div>${items}`;
  } catch {
    section.innerHTML = '';
  }
}
