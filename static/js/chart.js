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
const _activeInds = new Set();
const _indSeries  = { ma5: null, ma20: null, ma60: null, bbU: null, bbM: null, bbL: null, volma: null };
let   _rsiChart   = null;
let   _rsiSeries  = null;
let   _rsiOb      = null;   // 과매수 기준선
let   _rsiOs      = null;   // 과매도 기준선

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
  const W = container.clientWidth  || 900;
  const H = 500;

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

  _volSeries = _lwChart.addHistogramSeries({
    priceFormat:  { type: 'volume' },
    priceScaleId: 'vol',
  });
  _lwChart.priceScale('vol').applyOptions({
    scaleMargins: { top: 0.78, bottom: 0 },
    borderVisible: false,
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
      if (_lwChart) _lwChart.resize(entry.contentRect.width, entry.contentRect.height);
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
    _setLine('bbU', 'rgba(188,140,255,0.7)', 1);
    _setLine('bbM', 'rgba(188,140,255,0.4)', 1);
    _setLine('bbL', 'rgba(188,140,255,0.7)', 1);
    _indSeries.bbU.setData(_toData(bb.upper));
    _indSeries.bbM.setData(_toData(bb.mid));
    _indSeries.bbL.setData(_toData(bb.lower));
  } else { _rmLine('bbU'); _rmLine('bbM'); _rmLine('bbL'); }

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
    // 기준선 데이터 업데이트
    const t0 = times[0], t1 = times[times.length - 1];
    _rsiOb.setData([{ time: t0, value: 70 }, { time: t1, value: 70 }]);
    _rsiOs.setData([{ time: t0, value: 30 }, { time: t1, value: 30 }]);
  } else {
    rsiPanel.style.display = 'none';
  }
}

function _createRSIChart() {
  const container = document.getElementById('rsi-chart');
  _rsiChart = LightweightCharts.createChart(container, {
    width:  container.clientWidth || 900,
    height: 120,
    layout: { background: { type: 'solid', color: '#161b22' }, textColor: '#8b949e', fontSize: 11 },
    grid:   { vertLines: { color: '#1e2530' }, horzLines: { color: '#1e2530' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#30363d', scaleMargins: { top: 0.1, bottom: 0.1 } },
    timeScale: { borderColor: '#30363d', timeVisible: true, fixLeftEdge: true, fixRightEdge: true },
    handleScroll: false,
    handleScale: false,
  });
  _rsiSeries = _rsiChart.addLineSeries({ color: '#e3b341', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true });
  _rsiOb     = _rsiChart.addLineSeries({ color: 'rgba(248,81,73,0.5)',  lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  _rsiOs     = _rsiChart.addLineSeries({ color: 'rgba(63,185,80,0.5)',  lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
}

// ── 지표 버튼 이벤트 ─────────────────────────────────────────────────────────
function _bindIndicatorEvents() {
  document.querySelectorAll('.ind-btn').forEach(btn => {
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
  document.getElementById('rsi-panel').style.display = 'none';
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
  const peStr  = s.pe  > 0 ? s.pe.toFixed(1) : '—';
  const epsStr = s.eps != null && s.eps !== 0
    ? (s.eps > 0 ? fmtP(s.eps) : `<span class="down">${fmtP(s.eps)}</span>`)
    : '—';
  const capStr = s.market_cap ? fmtCap(s.market_cap) : '—';
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
      <span class="info-label">Sector</span>
      <span class="info-val" style="font-size:11.5px">${s.sector || '—'}</span>
    </div>
    <div class="info-section-title" style="margin-top:4px">52-Week Range</div>
    <div class="info-row">
      <span class="info-label">High</span>
      <span class="info-val up">${s.week52_high ? fmt$(s.week52_high) : '—'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Low</span>
      <span class="info-val down">${s.week52_low ? fmt$(s.week52_low) : '—'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">vs 52W High</span>
      <span class="info-val ${colorCls(s.price && s.week52_high ? s.price/s.week52_high*100-100 : 0)}">
        ${hiPct}
      </span>
    </div>
    <div id="stock-news-section"></div>
  `;
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
