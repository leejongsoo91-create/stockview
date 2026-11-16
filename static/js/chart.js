/* ═══════════════════════════════════════════════════════════════
   chart.js — Lightweight Charts 캔들스틱 차트 (실시간 갱신)
   ═══════════════════════════════════════════════════════════════ */

let _lwChart        = null;
let _candleSeries   = null;
let _volSeries      = null;
let _currentTicker  = null;
let _currentPeriod  = '1y';
let _currentCustomYears = null; // 기간 직접 입력(연수) — period 버튼과 상호 배타
let _currentInterval = '1d';
let _chartType      = 'candle';  // 차트 종류: candle | line | bar
let _scaleMode      = 'auto';    // 세로 범위: auto(캔들 기준) | all(지표 포함) | log | pct
const _RIGHT_PAD_BARS = 10;      // 처음 화면에서 마지막 봉 오른쪽에 둘 빈 칸 수(파란점선 미래 일부가 보이는 정도)

// 차트 보기 설정 저장 — localStorage 'CHV' = { iv, period, years, type, scale }
const _CHV_KEY = 'CHV';
const _CHV_INTERVALS = ['1m', '5m', '15m', '30m', '60m', '1d', 'mo', 'yr'];
(function _loadChartView() {
  try {
    const v = JSON.parse(localStorage.getItem(_CHV_KEY) || 'null');
    if (!v || typeof v !== 'object') return;
    if (_CHV_INTERVALS.includes(v.iv)) _currentInterval = v.iv;
    if (['1mo', '3mo', '6mo', '1y', '2y'].includes(v.period)) _currentPeriod = v.period;
    if (Number.isInteger(v.years) && v.years >= 1 && v.years <= 30) _currentCustomYears = v.years;
    if (['candle', 'line', 'bar'].includes(v.type)) _chartType = v.type;
    if (['auto', 'all', 'log', 'pct'].includes(v.scale)) _scaleMode = v.scale;
  } catch {}
})();
function _saveChartView() {
  try {
    localStorage.setItem(_CHV_KEY, JSON.stringify({
      iv: _currentInterval, period: _currentPeriod, years: _currentCustomYears, type: _chartType, scale: _scaleMode,
    }));
  } catch {}
}
let _priceTimer     = null;
let _candleTimer    = null;
let _lastOhlcv      = [];
let _chartIsDummy   = false;  // 현재 표시 중인 OHLCV가 서버 폴백 더미(_dummy 태그)인지

// ── 기술 지표 정의 (지표 버튼 줄 · ⚙ 설정 창 · ? 가이드가 모두 이 표 하나를 쓴다) ──────────
// tab: 가이드 탭 / period: 이동평균 기간 / color(2): 차트에 실제로 그리는 색과 같게 유지
const _IND_TABS = [
  { id: 'ma',   name: '이평선' },
  { id: 'band', name: '밴드' },
  { id: 'sub',  name: '보조지표' },
  { id: 'vol',  name: '거래량' },
];
const _IND_DEFS = [
  { id: 'ma5',   tab: 'ma', name: '5일',   title: '5일 이동평균선',   period: 5,   color: '#f59e0b',
    calc: '최근 5일 종가 평균', what: '최근 5일 종가 평균. 단기 흐름을 보여주는 선.',
    how: '가장 빠르게 움직이는 선이에요. 주가가 이 선 위에 붙어 가면 요 며칠 힘이 좋은 거예요.' },
  { id: 'ma20',  tab: 'ma', name: '20일',  title: '20일 이동평균선',  period: 20,  color: '#22c55e',
    calc: '최근 20일(약 1개월) 종가 평균', what: '약 1개월 종가 평균. 단기 추세의 중심선.',
    how: '주가가 이 선 위에 있으면 최근 한 달 평균보다 비싸게 거래되는 중이에요. 선이 위로 휘면 오르는 흐름이에요.' },
  { id: 'ma60',  tab: 'ma', name: '60일',  title: '60일 이동평균선',  period: 60,  color: '#d0d7de',
    calc: '최근 60일(약 3개월) 종가 평균', what: '약 3개월 종가 평균. 중기 추세·수급선으로 봐요.',
    how: '큰 흐름의 바닥이나 천장 역할을 자주 해요. 주가가 이 선 위에서 버티면 중기 흐름이 살아 있는 거예요.' },
  { id: 'ma112', tab: 'ma', name: '112일', title: '112일 이동평균선', period: 112, color: '#ec4899',
    calc: '최근 112일(약 6개월) 종가 평균', what: '약 6개월 평균. 중기 추세의 방향을 보여주는 선.',
    how: '반년 평균이라 천천히 움직여요. 주가가 이 선을 아래에서 위로 넘으면 반년 흐름이 좋아진 것으로 봐요.' },
  { id: 'ma224', tab: 'ma', name: '224일', title: '224일 이동평균선', period: 224, color: '#a855f7',
    calc: '최근 224일(약 1년) 종가 평균', what: '약 1년 평균. 이 선 위면 1년 평균보다 비싼 것, 아래면 싼 것.',
    how: '이 선을 아래에서 위로 넘으면 1년 흐름이 바뀌는 신호로 많이 봐요.' },
  { id: 'ma448', tab: 'ma', name: '448일', title: '448일 이동평균선', period: 448, color: '#06b6d4',
    calc: '최근 448일(약 2년) 종가 평균', what: '약 2년 평균. 장기 대세 추세를 판단하는 선.',
    how: '아주 천천히 움직여요. 주가가 이 선 아래에 오래 있으면 긴 하락 흐름 속에 있는 거예요.' },
  { id: 'bb',    tab: 'band', name: '볼린저', title: '볼린저밴드', color: 'rgba(188,140,255,0.95)',
    calc: '20일 평균 ± 표준편차×2', what: '주가의 통계적 범위. 위·아래 밴드를 벗어나면 과열 또는 과매도 신호.',
    how: '가격은 대부분 두 밴드 사이에서 움직여요. 위 밴드에 닿으면 많이 오른 것, 아래 밴드에 닿으면 많이 빠진 것으로 읽어요.' },
  { id: 'blue',  tab: 'band', name: '파란점선', title: '파란점선', color: '#2f81f7', dash: true,
    calc: 'EMA26 + 대표가(고+저+종)/3의 26일 표준편차×2.5, 25봉 앞으로',
    what: '26일 지수평균에 변동폭을 더해 25봉 앞으로 옮긴 위쪽 선. 그래서 오늘 이후 25봉까지 그려져요.',
    how: '주가 위에 걸린 "넘어야 할 벽"이에요. 주가가 이 점선을 넘어서면 벽을 깬 거예요.' },
  { id: 'rsi',   tab: 'sub', name: 'RSI', title: 'RSI (상대강도지수)', color: '#e3b341',
    calc: '14일 기준, 0~100', what: '0~100. 70 이상이면 과매수(너무 올라 조정 가능), 30 이하면 과매도(너무 빠져 반등 가능).',
    how: '선이 위쪽 띠(70)를 넘으면 너무 달아오른 것, 아래쪽 띠(30) 밑이면 너무 식은 거예요. 띠 안으로 돌아올 때를 눈여겨봐요.' },
  { id: 'macd',  tab: 'sub', name: 'MACD', title: 'MACD', color: '#58a6ff', color2: '#ffa64d',
    calc: 'EMA12 − EMA26, 신호선 EMA9', what: '추세의 방향과 강도를 보는 지표. 0선 위로 올라가면 상승 힘.',
    how: '파란 MACD선이 주황 신호선을 위로 넘으면 오르는 힘이 붙는 중이에요. 막대가 0선 위에서 커지면 그 힘이 세지는 거예요.' },
  { id: 'sto',   tab: 'sub', name: '스토캐스틱', title: '스토캐스틱', color: '#c9d1d9', color2: '#ffa64d',
    calc: '%K 14일, %D 3일', what: '오늘 종가가 최근 14일 범위에서 어디쯤인지(0~100). 80 이상 과매수, 20 이하 과매도.',
    how: '선이 위쪽(80)에 붙으면 요즘 움직인 범위의 꼭대기, 아래쪽(20)에 붙으면 바닥 근처예요. 두 선이 엇갈릴 때를 눈여겨봐요.' },
  { id: 'volma', tab: 'vol', name: '거래량 MA', title: '거래량 이동평균', color: 'rgba(255,166,77,0.95)',
    calc: '최근 20일 거래량 평균', what: '최근 거래량의 평균 수준을 보여주는 선.',
    how: '오늘 거래량 막대가 이 선보다 훨씬 길면 평소보다 관심이 몰린 날이에요. 가격이 크게 움직일 때 거래량이 같이 늘면 믿을 만한 움직임이에요.' },
];
const _IND_MA = _IND_DEFS.filter(d => d.period);

// 켜진 지표 저장 — localStorage 'CHI' = { on: [켜진 id], known: [저장 당시 있던 id] }
// known에 없는 지표(나중에 새로 생긴 것)는 기본값(켜짐)으로 둔다. 저장값이 없으면 전체 켜짐.
const _CHI_KEY = 'CHI';
function _loadActiveInds() {
  const all = _IND_DEFS.map(d => d.id);
  try {
    const saved = JSON.parse(localStorage.getItem(_CHI_KEY) || 'null');
    if (saved && Array.isArray(saved.on) && Array.isArray(saved.known)) {
      return new Set(all.filter(id => saved.on.includes(id) || !saved.known.includes(id)));
    }
  } catch {}
  return new Set(all);
}
function _saveActiveInds() {
  try {
    localStorage.setItem(_CHI_KEY, JSON.stringify({ on: [..._activeInds], known: _IND_DEFS.map(d => d.id) }));
  } catch {}
}

// ── 기술 지표 상태 ────────────────────────────────────────────────────────────
const _activeInds = _loadActiveInds();
const _indSeries  = { bbFill: null, bbMask: null, bbU: null, bbM: null, bbL: null, volma: null, blue: null };
_IND_MA.forEach(d => { _indSeries[d.id] = null; });
// 일봉 화면 기간 앞쪽 봉(/api/chart-warmup) — 긴 이평선·파란점선을 화면 첫 봉부터 그리기 위한 계산 전용
let   _warmOhlcv  = [];
let   _warmKey    = '';
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
  'mo': 1_800_000, 'yr': 1_800_000, // 월봉·연봉은 자주 안 변해서 30분 주기면 충분
};

// 지수 심볼 → 표시 이름 매핑
const _INDEX_NAMES = {
  '^GSPC': 'S&P 500 지수',
  '^IXIC': '나스닥 종합지수',
  '^DJI':  '다우존스 산업평균지수',
  '^RUT':  '러셀 2000 지수',
  '^SOX':  '필라델피아 반도체 지수',
  '^VIX':  'CBOE 변동성 지수(VIX)',
  'CL=F':  'WTI 원유 선물',
  'GC=F':  '금 선물',
};

// 차트 제목 옆 표시용 기호 — 야후 내부 심볼(^GSPC·KRW=X) 대신 흔히 쓰는 표기.
// 표시 전용: 데이터 요청·그리기·알림 저장 키는 계속 야후 심볼을 쓴다.
const _INDEX_DISPLAY_SYMBOL = {
  '^GSPC': 'SPX', '^IXIC': 'COMP', '^DJI': 'DJI', '^RUT': 'RUT', '^SOX': 'SOX', '^VIX': 'VIX',
  '^TNX': 'US10Y', '^KS11': 'KOSPI', '^KQ11': 'KOSDAQ',
  'CL=F': 'CL', 'GC=F': 'GC', 'ES=F': 'ES', 'YM=F': 'YM', 'NQ=F': 'NQ',
  'KRW=X': 'USD/KRW', 'JPY=X': 'USD/JPY', 'EURUSD=X': 'EUR/USD', 'DX-Y.NYB': 'DXY', 'BTC-USD': 'BTC/USD',
};

// 지수·선물 → 관련(추종) ETF 버튼 (최대 2개). ^SOX(지수)와 SOXX(ETF)는 다른 상품이라 함께 보여 줌
const _INDEX_RELATED_ETF = {
  '^GSPC': ['SPY', 'VOO'], 'ES=F': ['SPY', 'VOO'],
  '^IXIC': ['QQQ'], 'NQ=F': ['QQQ'],
  '^DJI': ['DIA'], 'YM=F': ['DIA'],
  '^RUT': ['IWM'],
  '^SOX': ['SOXX', 'SMH'],
  'GC=F': ['GLD'], 'CL=F': ['USO'],
  'BTC-USD': ['IBIT'], '^TNX': ['IEF'], 'DX-Y.NYB': ['UUP'],
  '^KS11': [['069500.KS', 'KODEX 200']], '^KQ11': [['229200.KS', 'KODEX 코스닥150']],
};

function _relatedEtfHtml(ticker) {
  const list = _INDEX_RELATED_ETF[ticker];
  if (!list) return '';
  const btns = list.map(e => {
    const [t, label] = Array.isArray(e) ? e : [e, e];
    return `<button class="quick-btn related-etf-btn" data-ticker="${t}" title="${t} 차트 열기">${label}</button>`;
  }).join('');
  return `<span class="related-etf"><span class="related-etf-label">관련 ETF</span>${btns}</span>`;
}

function _isIndex(ticker) {
  return ticker.startsWith('^') || ticker.endsWith('=F') || ticker.endsWith('=X')
    || (typeof _INDEX_SYMBOL !== 'undefined' && Object.values(_INDEX_SYMBOL).includes(ticker));
}

// 차트 심볼 → /api/indices 이름 (main.js _INDEX_SYMBOL의 반대 방향 — 19개 전부. 예전엔 8개만 있어
// 나머지 지수는 현재가·등락률을 못 찾고 0%로 표시됐음)
function _indexNameOf(ticker) {
  if (typeof _INDEX_SYMBOL === 'undefined') return null;
  return Object.keys(_INDEX_SYMBOL).find(n => _INDEX_SYMBOL[n] === ticker) || null;
}

function _isKrStock(ticker) {
  return ticker.endsWith('.KS') || ticker.endsWith('.KQ');
}

// 차트 화면 금액 표시: 지수·환율·금리·비트코인은 통화 기호 없이 숫자(코스피 "$5,383.80"·달러/원 "$1,355.80"으로
// 나오던 문제), 국내 ₩, 미국 $. 변동액 부호는 기호 앞(-₩16,500 — 국내 하락 금액에 - 가 빠지던 문제)
function _fmtQuote(v, ticker) {
  if (v == null) return '—';
  if (_isIndex(ticker || '')) return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return fmtPrice(v, ticker || '');
}
function _fmtQuoteChange(v, ticker) {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '-') + _fmtQuote(Math.abs(v), ticker);
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
  _bindChartZoomEvents();
  _bindDrawToolEvents();
  _bindDrawColorEvent();
}

// 차트 탭 이탈 시 타이머 정지 (main.js에서 호출)
function stopChartTimers() {
  if (_priceTimer)  { clearInterval(_priceTimer);  _priceTimer  = null; }
  if (_candleTimer) { clearInterval(_candleTimer); _candleTimer = null; }
  const badge = document.getElementById('chart-live-badge');
  if (badge) badge.style.display = 'none';
}

// ── LW 차트 생성 ─────────────────────────────────────────────────────────────
// ── 차트 종류(캔들·라인·바) · 세로 범위 · 화면 맞춤 ──────────────────────────────
// 메인 시리즈는 항상 _candleSeries 변수 하나 — 신호 화살표·수평선·좌표 변환이 모두 이걸 쓰므로
// 종류를 바꿀 땐 시리즈를 새로 만들고 데이터·화살표·수평선을 다시 붙인다.
function _createMainSeries() {
  if (_chartType === 'line') {
    return _lwChart.addLineSeries({ color: '#58a6ff', lineWidth: 2, crosshairMarkerVisible: true });
  }
  if (_chartType === 'bar') {
    return _lwChart.addBarSeries({ upColor: '#3fb950', downColor: '#f85149', thinBars: false });
  }
  return _lwChart.addCandlestickSeries({
    upColor:         '#3fb950',
    downColor:       '#f85149',
    borderUpColor:   '#3fb950',
    borderDownColor: '#f85149',
    wickUpColor:     '#3fb950',
    wickDownColor:   '#f85149',
  });
}

function _mainPoint(d) {
  return _chartType === 'line'
    ? { time: d.time, value: d.close }
    : { time: d.time, open: d.open, high: d.high, low: d.low, close: d.close };
}

function _hlineOpts(d) {
  return { price: d.points[0].price, color: d.color || '#58a6ff', lineWidth: 1,
           lineStyle: LightweightCharts.LineStyle.Solid, axisLabelVisible: true, title: '' };
}

function _setChartType(type) {
  if (type === _chartType || !_lwChart) { _chartType = type; return; }
  _chartType = type;
  _drawings.forEach(d => {   // 수평선은 메인 시리즈에 붙어 있어 옮겨 단다
    if (d._priceLineRef) { try { _candleSeries.removePriceLine(d._priceLineRef); } catch {} d._priceLineRef = null; }
  });
  const range = _lwChart.timeScale().getVisibleLogicalRange();
  _lwChart.removeSeries(_candleSeries);
  _candleSeries = _createMainSeries();
  if (_lastOhlcv.length) _candleSeries.setData(_lastOhlcv.map(_mainPoint));
  _drawings.forEach(d => { if (d.type === 'hline') d._priceLineRef = _candleSeries.createPriceLine(_hlineOpts(d)); });
  if (_compareMode) _candleSeries.applyOptions({ visible: false });
  else _applyIndicators();   // 신호 화살표 다시 붙임
  if (range) _lwChart.timeScale().setVisibleLogicalRange(range);
  _redrawDrawings();
}

// 세로 범위: auto/log/pct는 캔들(메인 시리즈)만으로 눈금을 잡아 캔들이 화면을 채운다 — 멀리 있는
// 긴 이평선은 화면 밖으로 나갈 수 있음. all(지표 포함)은 예전처럼 모든 선이 보이게 넓힌다.
function _overlayScaleOpts() {
  return { autoscaleInfoProvider: _scaleMode === 'all' ? (orig => orig()) : () => null };
}
function _applyScaleMode() {
  if (!_lwChart) return;
  const mode = _scaleMode === 'log' ? LightweightCharts.PriceScaleMode.Logarithmic
             : _scaleMode === 'pct' ? LightweightCharts.PriceScaleMode.Percentage
             : LightweightCharts.PriceScaleMode.Normal;
  _lwChart.priceScale('right').applyOptions({ mode });
  Object.entries(_indSeries).forEach(([k, ser]) => { if (ser && k !== 'volma') ser.applyOptions(_overlayScaleOpts()); });
}

// 처음 화면·전체보기: 첫 봉 ~ 마지막 봉 + 10칸 (fitContent는 파란점선 미래 25칸까지 넣어 빈 곳이 커짐)
function _fitChart() {
  const n = _lastOhlcv.length;
  if (!n) { _lwChart.timeScale().fitContent(); return; }
  _lwChart.timeScale().setVisibleLogicalRange({ from: 0, to: n - 1 + _RIGHT_PAD_BARS });
}

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
      rightOffset: _RIGHT_PAD_BARS, // 마지막 봉 오른쪽 여백(HTS처럼) — 11-16 40→10칸(빈 공간이 너무 많았음). fixRightEdge와 같이 쓰면 여백이 무시되므로 fixRightEdge는 뺌
    },
    // 좌클릭 드래그는 국내 HTS 방식 구간 확대/축소 제스처로 대체 (_bindChartZoomEvents 참고) — 기본 패닝은 끔
    handleScroll: { pressedMouseMove: false },
    // 휠/핀치 줌도 끔 — 커스텀 드래그 제스처와 동시에 반응하면 터치에서 충돌하므로 줌 조작은 하나로 통일
    handleScale: false,
  });

  _candleSeries = _createMainSeries();   // 캔들·라인·바 중 저장된 차트 종류

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

  _applyScaleMode();

  // 서브 패널(RSI·MACD) 시간축 동기화 + 그리기 도구 재렌더
  _lwChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (!range) return;
    if (_rsiChart)  _rsiChart.timeScale().setVisibleLogicalRange(range);
    if (_macdChart) _macdChart.timeScale().setVisibleLogicalRange(range);
    _redrawDrawings();
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

  // 구간 확대 드래그 시 표시할 선택 박스 (컨테이너 안에 절대 위치로 삽입)
  _zoomBoxEl = document.createElement('div');
  _zoomBoxEl.className = 'chart-zoom-box';
  container.appendChild(_zoomBoxEl);

  // 그리기 도구용 캔버스 오버레이
  _drawCanvas = document.createElement('canvas');
  _drawCanvas.id = 'chart-draw-canvas';
  container.appendChild(_drawCanvas);
  _drawCtx = _drawCanvas.getContext('2d');
  _resizeDrawCanvas();
}

// ── 국내 HTS 방식 구간 확대/축소 (왼쪽 드래그 방향 감지) ────────────────────────
let _zoomBoxEl        = null;
let _zoomDragStartX   = null;
let _prevVisibleRange = null;   // 더블클릭으로 되돌아갈 직전 화면 범위 (1단계)
const _ZOOM_DRAG_MIN_PX = 5;    // 이보다 작은 드래그는 클릭으로 간주해 무시

// ⌖ 포커싱 — 확대 상태는 _prevVisibleRange(되돌아갈 범위)가 있느냐로 판단(드래그 확대와 공용)
let _lastHoverLogical = null;
const _FOCUS_MIN_BARS = 20;     // 포커싱 화면 최소 봉 수
function _toggleFocus(centerLogical) {
  if (!_lwChart || _compareMode) return;
  const ts = _lwChart.timeScale();
  if (_prevVisibleRange) {
    ts.setVisibleLogicalRange(_prevVisibleRange);
    _prevVisibleRange = null;
  } else {
    const cur = ts.getVisibleLogicalRange();
    if (!cur) return;
    const width = Math.max(_FOCUS_MIN_BARS, (cur.to - cur.from) * 0.3);
    const c = centerLogical != null && isFinite(centerLogical) ? centerLogical : (cur.from + cur.to) / 2;
    _prevVisibleRange = cur;
    ts.setVisibleLogicalRange({ from: c - width / 2, to: c + width / 2 });
  }
  _syncFocusBtn();
}
function _syncFocusBtn() {
  const fb = document.getElementById('chart-focus-btn');
  if (!fb) return;
  const on = !!_prevVisibleRange;
  fb.classList.toggle('active', on);
  fb.setAttribute('aria-pressed', on);
  if (fb.dataset.baseTitle) fb.title = fb.dataset.baseTitle + (on ? '\n(지금 확대 중 — 누르면 원래대로)' : '\n(지금 원래 구간)');
}

function _bindChartZoomEvents() {
  const container = document.getElementById('lw-chart');
  // 터치 더블탭 감지용 (마우스의 dblclick에 해당 — 전체보기 복귀)
  let _lastTapTime = 0, _lastTapX = null, _lastTapY = null;

  // pointerdown/move/up: 마우스·터치·펜을 하나의 이벤트로 통합 처리(로직 중복 없이 터치 지원)
  container.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // 마우스는 왼쪽 버튼만, 터치/펜은 통과
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // 1) 그리기 도구가 켜져 있으면 줌 대신 그리기 클릭 처리
    if (_drawTool) {
      _handleDrawClick(x, y);
      return;
    }

    // 2) 선택된 그림의 손잡이를 잡으면 끝점 드래그 시작
    if (_selectedDrawId) {
      const hp = _hitTestHandle(_selectedDrawId, x, y);
      if (hp != null) {
        _dragHandleInfo = { id: _selectedDrawId, pointIndex: hp };
        return;
      }
    }

    // 3) 평소: 기존 HTS 줌 드래그 시작
    _selectedDrawId = null;
    _redrawDrawings();
    _zoomDragStartX = x;
    _zoomBoxEl.style.left  = `${_zoomDragStartX}px`;
    _zoomBoxEl.style.width = '0px';
    _zoomBoxEl.style.display = 'block';
  });

  container.addEventListener('pointermove', e => {
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // 손잡이 드래그 중: 끝점 위치 실시간 갱신
    if (_dragHandleInfo) {
      _updateDragHandle(x, y);
      return;
    }

    // 2클릭 도구(추세선/피보나치)의 첫 점을 찍은 후 마우스를 따라다니는 미리보기
    if (_drawTool && _drawPending) {
      const time = _xToTime(x), price = _yToPrice(y);
      if (time != null && price != null) {
        _drawPreview = { type: _drawTool, points: [_drawPending, { time, price }] };
        _redrawDrawings();
      }
      return;
    }

    if (_zoomDragStartX == null) return;
    const left  = Math.min(_zoomDragStartX, x);
    const width = Math.abs(x - _zoomDragStartX);
    _zoomBoxEl.style.left  = `${left}px`;
    _zoomBoxEl.style.width = `${width}px`;
  });

  const finishDrag = e => {
    if (_dragHandleInfo) {
      _dragHandleInfo = null;
      _persistCurrentDrawings();
      return;
    }
    if (_zoomDragStartX == null) return;
    const container = document.getElementById('lw-chart');
    const rect = container.getBoundingClientRect();
    const endX = e.clientX - rect.left;
    const endY = e.clientY - rect.top;
    const startX = _zoomDragStartX;
    _zoomDragStartX = null;
    _zoomBoxEl.style.display = 'none';

    const deltaPx = endX - startX;
    if (Math.abs(deltaPx) < _ZOOM_DRAG_MIN_PX) {
      // 클릭(탭)으로 간주 — 기존 그림 선택 시도
      const hit = _hitTestDrawings(endX, endY);
      _selectedDrawId = hit ? hit.id : null;
      _redrawDrawings();

      // 터치 더블탭 — 마우스 dblclick과 동일하게 전체보기 복귀(더블클릭이 없는 터치용 대체 제스처)
      if (e.pointerType === 'touch') {
        const now = Date.now();
        const near = _lastTapX != null && Math.hypot(endX - _lastTapX, endY - _lastTapY) < 25;
        if (near && (now - _lastTapTime) < 350) {
          _toggleFocus(_lwChart.timeScale().coordinateToLogical(endX));
          _lastTapTime = 0; _lastTapX = null; _lastTapY = null;
        } else {
          _lastTapTime = now; _lastTapX = endX; _lastTapY = endY;
        }
      }
      return;
    }

    const timeScale = _lwChart.timeScale();
    if (deltaPx > 0) {
      // 왼쪽 → 오른쪽: 드래그한 구간만 확대
      const t1 = timeScale.coordinateToTime(startX);
      const t2 = timeScale.coordinateToTime(endX);
      if (t1 == null || t2 == null) return;
      if (!_prevVisibleRange) _prevVisibleRange = timeScale.getVisibleLogicalRange();
      timeScale.setVisibleRange({
        from: t1 < t2 ? t1 : t2,
        to:   t1 < t2 ? t2 : t1,
      });
      _syncFocusBtn();
    } else {
      // 오른쪽 → 왼쪽: 전체보기로 복귀
      _fitChart();
      _prevVisibleRange = null;
      _syncFocusBtn();
    }
  };
  container.addEventListener('pointerup', finishDrag);
  container.addEventListener('pointerleave', finishDrag);
  container.addEventListener('pointercancel', finishDrag);

  // 더블클릭 = ⌖ 포커싱 버튼과 같음: 확대돼 있으면 원래대로, 아니면 그 자리를 가운데로 확대
  container.addEventListener('dblclick', e => {
    if (_drawTool) return;
    const rect = container.getBoundingClientRect();
    _toggleFocus(_lwChart.timeScale().coordinateToLogical(e.clientX - rect.left));
  });

  // ⌖ 버튼: 마지막으로 마우스가 있던 차트 위치를 가운데로 (차트 위를 지나간 적 없으면 화면 가운데)
  _lwChart.subscribeCrosshairMove(param => {
    if (param.point) _lastHoverLogical = _lwChart.timeScale().coordinateToLogical(param.point.x);
  });
  const fb = document.getElementById('chart-focus-btn');
  if (fb) {
    fb.dataset.baseTitle = fb.title;
    fb.addEventListener('click', () => _toggleFocus(_lastHoverLogical));
    _syncFocusBtn();
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _drawTool) _exitDrawMode();
  });
}

// ── 차트 그리기 도구 (추세선/수평선/수직선/피보나치 되돌림) ───────────────────
// 좌클릭 드래그를 HTS 줌 제스처와 나눠 쓰므로, 도구가 켜진 동안엔 줌이 잠깐 꺼짐(_bindChartZoomEvents 참고)
const DRAW_KEY = 'stockview_chart_drawings';
let _drawCanvas      = null;
let _drawCtx         = null;
let _drawings        = [];     // 현재 종목의 그림들: {id, type, points:[{time,price}], color, _priceLineRef?}
let _drawTool        = null;   // 'trend'|'hline'|'vline'|'fib'|null
let _drawPending     = null;   // 2클릭 도구(trend/fib)의 첫 번째 점
let _drawPreview     = null;   // 두 번째 점 확정 전 마우스 추적 미리보기
let _selectedDrawId  = null;   // 손잡이가 표시 중인 그림 id
let _dragHandleInfo  = null;   // 손잡이 드래그 중: {id, pointIndex}
let _drawIdSeq       = 1;
let _currentDrawColor = '#58a6ff'; // 색상 선택기로 바꾸면 이후 새 그림 + 선택된 그림에 적용
const _DRAW_TYPE_LABEL = { trend: '📈 추세선', hline: '➖ 수평선', vline: '┃ 수직선', fib: '🌀 피보나치' };

function _xToTime(x) { return _lwChart.timeScale().coordinateToTime(x); }
function _yToPrice(y) { return _candleSeries.coordinateToPrice(y); }
function _timeToX(time) { return _lwChart.timeScale().timeToCoordinate(time); }
function _priceToY(price) { return _candleSeries.priceToCoordinate(price); }

function _resizeDrawCanvas() {
  if (!_drawCanvas) return;
  const container = document.getElementById('lw-chart');
  const w = container.clientWidth;
  const h = container.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  _drawCanvas.width  = w * dpr;
  _drawCanvas.height = h * dpr;
  _drawCanvas.style.width  = w + 'px';
  _drawCanvas.style.height = h + 'px';
  _drawCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  _redrawDrawings();
}

// ── 저장/불러오기 (티커별 localStorage) ───────────────────────────────────────
function _loadAllDrawings() {
  try { return JSON.parse(localStorage.getItem(DRAW_KEY) || '{}'); }
  catch { return {}; }
}
function _saveAllDrawings(all) { localStorage.setItem(DRAW_KEY, JSON.stringify(all)); }

function _persistCurrentDrawings() {
  if (!_currentTicker) return;
  const all = _loadAllDrawings();
  const serializable = _drawings.map(({ _priceLineRef, ...rest }) => rest);
  if (serializable.length) all[_currentTicker] = serializable; else delete all[_currentTicker];
  _saveAllDrawings(all);
}

function _clearDrawingsRuntime() {
  _drawings.forEach(d => {
    if (d.type === 'hline' && d._priceLineRef) {
      try { _candleSeries.removePriceLine(d._priceLineRef); } catch {}
    }
  });
  _drawings = [];
  _selectedDrawId = null;
  _drawPending = null;
  _drawPreview = null;
}

function _loadDrawingsForCurrentTicker() {
  _clearDrawingsRuntime();
  const saved = (_loadAllDrawings()[_currentTicker] || []).map(d => ({ ...d }));
  saved.forEach(d => {
    if (d.type === 'hline') {
      d._priceLineRef = _candleSeries.createPriceLine({
        price: d.points[0].price,
        color: d.color || '#58a6ff',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Solid,
        axisLabelVisible: true,
        title: '',
      });
    }
  });
  _drawings = saved;
  _renderDrawList();
  _redrawDrawings();
}

// ── 도구 모드 전환 ────────────────────────────────────────────────────────────
function _bindDrawToolEvents() {
  document.querySelectorAll('.draw-tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      if (_drawTool === tool) { _exitDrawMode(); return; }
      _drawTool = tool;
      _drawPending = null;
      _drawPreview = null;
      _selectedDrawId = null;
      document.querySelectorAll('.draw-tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const lw = document.getElementById('lw-chart');
      if (lw) lw.classList.add('draw-active');
      const hint = document.getElementById('draw-mode-hint');
      if (hint) hint.style.display = 'inline';
      _redrawDrawings();
    });
  });
}

function _bindDrawColorEvent() {
  const picker = document.getElementById('draw-color-picker');
  if (!picker) return;
  picker.addEventListener('input', () => {
    _currentDrawColor = picker.value;
    // 선택된 그림이 있으면 그 자리에서 색상도 즉시 반영
    if (_selectedDrawId) {
      const d = _drawings.find(x => x.id === _selectedDrawId);
      if (d) {
        d.color = _currentDrawColor;
        if (d.type === 'hline' && d._priceLineRef) {
          d._priceLineRef.applyOptions({ color: _currentDrawColor });
        }
        _redrawDrawings();
        _persistCurrentDrawings();
      }
    }
  });
}

function _exitDrawMode() {
  _drawTool = null;
  _drawPending = null;
  _drawPreview = null;
  document.querySelectorAll('.draw-tool-btn').forEach(b => b.classList.remove('active'));
  const lw = document.getElementById('lw-chart');
  if (lw) lw.classList.remove('draw-active');
  const hint = document.getElementById('draw-mode-hint');
  if (hint) hint.style.display = 'none';
  _redrawDrawings();
}

// ── 그리기 생성 ───────────────────────────────────────────────────────────────
function _handleDrawClick(x, y) {
  const time = _xToTime(x), price = _yToPrice(y);
  if (time == null || price == null) return; // 유효한 캔들 영역 밖 클릭은 무시

  if (_drawTool === 'hline') {
    _addDrawing({ type: 'hline', points: [{ time: null, price }] });
    _exitDrawMode();
    return;
  }
  if (_drawTool === 'vline') {
    _addDrawing({ type: 'vline', points: [{ time, price: null }] });
    _exitDrawMode();
    return;
  }
  // trend / fib: 두 번 클릭
  if (!_drawPending) {
    _drawPending = { time, price };
    return;
  }
  _addDrawing({ type: _drawTool, points: [_drawPending, { time, price }] });
  _exitDrawMode();
}

function _addDrawing(partial) {
  const d = { id: 'd' + (_drawIdSeq++), color: _currentDrawColor, ...partial };
  if (d.type === 'hline') {
    d._priceLineRef = _candleSeries.createPriceLine({
      price: d.points[0].price,
      color: d.color,
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Solid,
      axisLabelVisible: true,
      title: '',
    });
  }
  _drawings.push(d);
  _persistCurrentDrawings();
  _renderDrawList();
  _redrawDrawings();
}

function _deleteDrawing(id) {
  const idx = _drawings.findIndex(d => d.id === id);
  if (idx === -1) return;
  const d = _drawings[idx];
  if (d.type === 'hline' && d._priceLineRef) {
    try { _candleSeries.removePriceLine(d._priceLineRef); } catch {}
  }
  _drawings.splice(idx, 1);
  if (_selectedDrawId === id) _selectedDrawId = null;
  _persistCurrentDrawings();
  _renderDrawList();
  _redrawDrawings();
}

function clearAllDrawings() {
  if (!_drawings.length) return;
  if (!confirm(`${_currentTicker}의 그린 선 ${_drawings.length}개를 모두 삭제하시겠습니까?`)) return;
  _clearDrawingsRuntime();
  _persistCurrentDrawings();
  _renderDrawList();
  _redrawDrawings();
}

function _selectDrawing(id) {
  _selectedDrawId = id;
  _redrawDrawings();
}

// ── 히트테스팅 (클릭 선택 / 손잡이 드래그) ─────────────────────────────────────
function _distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = x1 + t * dx, ey = y1 + t * dy;
  return Math.hypot(px - ex, py - ey);
}

function _pointToScreen(p) {
  const x = _timeToX(p.time), y = _priceToY(p.price);
  if (x == null || y == null) return null;
  return { x, y };
}

function _hitTestDrawings(x, y, threshold = 6) {
  for (let i = _drawings.length - 1; i >= 0; i--) {
    const d = _drawings[i];
    if (d.type === 'hline') {
      const py = _priceToY(d.points[0].price);
      if (py != null && Math.abs(y - py) <= threshold) return d;
    } else if (d.type === 'vline') {
      const px = _timeToX(d.points[0].time);
      if (px != null && Math.abs(x - px) <= threshold) return d;
    } else if (d.type === 'trend') {
      const p1 = _pointToScreen(d.points[0]), p2 = _pointToScreen(d.points[1]);
      if (p1 && p2 && _distToSegment(x, y, p1.x, p1.y, p2.x, p2.y) <= threshold) return d;
    } else if (d.type === 'fib') {
      const p1 = _pointToScreen(d.points[0]), p2 = _pointToScreen(d.points[1]);
      if (p1 && p2) {
        const xMin = Math.min(p1.x, p2.x) - threshold, xMax = Math.max(p1.x, p2.x) + threshold;
        const yMin = Math.min(p1.y, p2.y) - threshold, yMax = Math.max(p1.y, p2.y) + threshold;
        if (x >= xMin && x <= xMax && y >= yMin && y <= yMax) return d;
      }
    }
  }
  return null;
}

// hline/vline은 선 전체 어디를 잡아도 드래그 가능(끝점이 하나뿐이라 실질적으로 하나의 손잡이)
function _hitTestHandle(drawId, x, y, threshold = 8) {
  const d = _drawings.find(dr => dr.id === drawId);
  if (!d) return null;
  if (d.type === 'hline') {
    const py = _priceToY(d.points[0].price);
    return (py != null && Math.abs(y - py) <= threshold) ? 0 : null;
  }
  if (d.type === 'vline') {
    const px = _timeToX(d.points[0].time);
    return (px != null && Math.abs(x - px) <= threshold) ? 0 : null;
  }
  for (let i = 0; i < d.points.length; i++) {
    const p = _pointToScreen(d.points[i]);
    if (p && Math.hypot(x - p.x, y - p.y) <= threshold) return i;
  }
  return null;
}

function _updateDragHandle(x, y) {
  const d = _drawings.find(dr => dr.id === _dragHandleInfo.id);
  if (!d) return;
  if (d.type === 'hline') {
    const price = _yToPrice(y);
    if (price == null) return;
    d.points[0] = { time: null, price };
    if (d._priceLineRef) d._priceLineRef.applyOptions({ price });
    _renderDrawList();
    return;
  }
  if (d.type === 'vline') {
    const time = _xToTime(x);
    if (time == null) return;
    d.points[0] = { time, price: null };
  } else {
    const time = _xToTime(x), price = _yToPrice(y);
    if (time == null || price == null) return;
    d.points[_dragHandleInfo.pointIndex] = { time, price };
  }
  _renderDrawList();
  _redrawDrawings();
}

// ── 렌더링 ────────────────────────────────────────────────────────────────────
function _redrawDrawings() {
  if (!_drawCtx || !_drawCanvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = _drawCanvas.width / dpr, h = _drawCanvas.height / dpr;
  _drawCtx.clearRect(0, 0, w, h);

  _drawings.forEach(d => _drawOne(d, d.id === _selectedDrawId, false));
  if (_drawPreview) _drawOne(_drawPreview, false, true);
}

function _drawOne(d, selected, isPreview) {
  const ctx = _drawCtx;
  if (!ctx) return;

  if (d.type === 'hline') {
    // 라인 자체는 라이브러리(createPriceLine)가 그려줌 — 손잡이만 캔버스에 표시
    if (selected) _drawHandle(d);
    return;
  }

  ctx.save();
  ctx.lineWidth = selected ? 2 : 1.5;
  ctx.strokeStyle = isPreview ? 'rgba(255,255,255,.5)' : (d.color || '#58a6ff');
  ctx.setLineDash(isPreview ? [4, 4] : []);

  if (d.type === 'vline') {
    const x = _timeToX(d.points[0].time);
    if (x != null) {
      const h = _drawCanvas.height / (window.devicePixelRatio || 1);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  } else if (d.type === 'trend') {
    const p1 = _pointToScreen(d.points[0]), p2 = _pointToScreen(d.points[1]);
    if (p1 && p2) {
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  } else if (d.type === 'fib') {
    const p1 = d.points[0], p2 = d.points[1];
    const x1 = _timeToX(p1.time), x2 = _timeToX(p2.time);
    if (x1 != null && x2 != null) {
      const xMin = Math.min(x1, x2), xMax = Math.max(x1, x2);
      [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].forEach(lv => {
        const price = p1.price + (p2.price - p1.price) * lv;
        const y = _priceToY(price);
        if (y == null) return;
        ctx.beginPath();
        ctx.moveTo(xMin, y);
        ctx.lineTo(xMax, y);
        ctx.stroke();
        if (!isPreview) {
          ctx.fillStyle = ctx.strokeStyle;
          ctx.font = '10px sans-serif';
          ctx.fillText(`${(lv * 100).toFixed(1)}%`, xMax + 4, y + 3);
        }
      });
    }
  }
  ctx.restore();

  if (selected) _drawHandle(d);
}

function _drawHandle(d) {
  const ctx = _drawCtx;
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#e3b341';
  ctx.lineWidth = 2;
  const dot = (x, y) => { if (x == null || y == null) return; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); };

  if (d.type === 'hline') {
    const w = _drawCanvas.width / (window.devicePixelRatio || 1);
    dot(w - 40, _priceToY(d.points[0].price));
  } else if (d.type === 'vline') {
    const h = _drawCanvas.height / (window.devicePixelRatio || 1);
    dot(_timeToX(d.points[0].time), h - 30);
  } else {
    d.points.forEach(p => { const s = _pointToScreen(p); if (s) dot(s.x, s.y); });
  }
  ctx.restore();
}

function _fmtDrawTime(t) {
  if (t == null) return '';
  return typeof t === 'string' ? t : new Date(t * 1000).toLocaleDateString('ko-KR');
}

function _renderDrawList() {
  const card = document.getElementById('chart-draw-list-card');
  const list = document.getElementById('chart-draw-list');
  if (!card || !list) return;
  if (!_drawings.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  list.innerHTML = _drawings.map(d => {
    let detail;
    if (d.type === 'hline') detail = (d.points[0].price ?? 0).toFixed(2);
    else if (d.type === 'vline') detail = _fmtDrawTime(d.points[0].time);
    else detail = `${_fmtDrawTime(d.points[0].time)} → ${_fmtDrawTime(d.points[1].time)}`;
    return `<div class="draw-item">
      <span class="draw-item-icon">${_DRAW_TYPE_LABEL[d.type]}</span>
      <span class="draw-item-label" onclick="_selectDrawing('${d.id}')">${detail}</span>
      <button class="draw-item-del" onclick="_deleteDrawing('${d.id}')" title="삭제">✕</button>
    </div>`;
  }).join('');
}

// 티커/코드 직접 일치가 없으면 한글·영문 종목명으로 검색해 티커를 찾는다
// (헤더의 전역 검색과 동일한 window._scStocks/_krStocks 데이터를 재사용)
// market: 'us' | 'kr' — 선택된 시장 안에서만 검색 (교차 매칭 안 함)
let _chartSearchMarket = 'us';

function _resolveChartTicker(raw, market = _chartSearchMarket) {
  const q = (raw || '').trim();
  if (!q) return null;
  const qUpper = q.toUpperCase();
  const qLower = q.toLowerCase();

  if (market === 'kr') {
    const krStocks = window._krStocks || [];
    const krExact = krStocks.find(s => s.code === q || (s.ticker || '').toUpperCase() === qUpper);
    if (krExact) return krExact.ticker;

    const krByName = krStocks.filter(s => (s.name || '').includes(q));
    if (krByName.length) {
      krByName.sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0));
      return krByName[0].ticker;
    }
    // 매칭 실패 시 입력값 그대로 시도 (6자리 코드 등)
    return q;
  }

  const usStocks = window._scStocks || [];
  const usExact = usStocks.find(s => s.ticker.toUpperCase() === qUpper);
  if (usExact) return usExact.ticker;

  const usByName = usStocks.filter(s =>
    (s.name_ko && s.name_ko.includes(q)) ||
    (s.name || '').toLowerCase().includes(qLower)
  );
  if (usByName.length) {
    usByName.sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0));
    return usByName[0].ticker;
  }

  // 매칭 실패 시 입력값을 그대로 티커로 간주 (추적 목록 밖 종목 지원)
  return qUpper;
}

// ── 이벤트 바인딩 ─────────────────────────────────────────────────────────────
function _bindSearchEvents() {
  const input    = document.getElementById('chart-input');
  const dropdown = document.getElementById('chart-search-dropdown');
  const go = () => {
    const t = _resolveChartTicker(input.value);
    if (t) loadChart(t);
    if (dropdown) dropdown.style.display = 'none';
  };
  document.getElementById('chart-go-btn').addEventListener('click', go);

  let _csTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(_csTimer);
    const q = input.value.trim();
    if (!q || !dropdown) { if (dropdown) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; } return; }
    _csTimer = setTimeout(() => _chartSearchPreview(q), 200);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') go();
    if (e.key === 'Escape' && dropdown) dropdown.style.display = 'none';
  });
  document.addEventListener('click', e => {
    const wrap = document.getElementById('chart-search-wrap');
    if (dropdown && wrap && !wrap.contains(e.target)) dropdown.style.display = 'none';
  });

  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => loadChart(btn.dataset.ticker));
  });

  // US/KR 검색 시장 토글
  document.querySelectorAll('.chart-mkt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chart-mkt-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _chartSearchMarket = btn.dataset.mkt;
      input.placeholder = _chartSearchMarket === 'kr'
        ? '티커 또는 종목명 (e.g. 005930, 삼성전자)'
        : '티커 또는 종목명 (e.g. AAPL)';
      input.focus();
      if (dropdown) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; }
    });
  });
}

// 입력 중 종목 미리보기 드롭다운 (헤더 전역검색과 동일한 window._scStocks/_krStocks 재사용,
// _chartSearchMarket으로 선택된 시장 안에서만 검색)
function _chartSearchPreview(q) {
  const dropdown = document.getElementById('chart-search-dropdown');
  if (!dropdown) return;
  const qLower = q.toLowerCase();

  let results;
  if (_chartSearchMarket === 'kr') {
    const krStocks = window._krStocks || [];
    results = krStocks.filter(s =>
      (s.code || '').toLowerCase().includes(qLower) ||
      (s.name || '').toLowerCase().includes(qLower)
    ).sort(_gsTickerRank(qLower, s => s.code)).slice(0, 8).map(s => ({ ...s, _isKr: true }));
  } else {
    const usStocks = window._scStocks || [];
    results = usStocks.filter(s =>
      s.ticker.toLowerCase().includes(qLower) ||
      (s.name_ko && s.name_ko.includes(q)) ||
      (s.name || '').toLowerCase().includes(qLower)
    ).sort(_gsTickerRank(qLower, s => s.ticker)).slice(0, 8).map(s => ({ ...s, _isKr: false }));
  }

  if (!results.length) {
    dropdown.innerHTML = `<div class="gs-empty">결과 없음</div>`;
    dropdown.style.display = 'block';
    return;
  }

  dropdown.innerHTML = results.map(s => {
    const pct  = s.change_pct ?? 0;
    const cls  = pct >= 0 ? 'up' : 'down';
    const disp = s._isKr ? s.code : s.ticker;
    const name = s._isKr ? s.name : (s.name_ko || s.name || '');
    return `<div class="gs-item" onclick="_chartSearchSelect('${s.ticker}')">
      <span class="gs-ticker">${disp}</span>
      <span class="gs-name">${name}</span>
      <span class="gs-pct ${cls}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>
    </div>`;
  }).join('');
  dropdown.style.display = 'block';
}

function _chartSearchSelect(ticker) {
  const input    = document.getElementById('chart-input');
  const dropdown = document.getElementById('chart-search-dropdown');
  if (input) input.value = '';
  if (dropdown) dropdown.style.display = 'none';
  loadChart(ticker);
}

const _CUSTOM_YEARS_MIN = 1;
const _CUSTOM_YEARS_MAX = 30;

// ── 차트 보기 드롭다운 (봉 · 차트 종류 · 기간 · 세로 범위) ─────────────────────────
// 기간 값: '1mo'~'2y' = 기간 프리셋, 'yN' = N년(직접 연수 조회), '' = 월봉·연봉 기본(10년), 'custom' = 직접 입력
function _periodOptions() {
  if (_currentInterval === '1d') {
    return [['1mo', '1개월'], ['3mo', '3개월'], ['6mo', '6개월'], ['1y', '1년'], ['2y', '2년'],
            ['y5', '5년'], ['y10', '10년'], ['custom', '직접 입력…']];
  }
  if (_currentInterval === 'mo' || _currentInterval === 'yr') {
    return [['', '기본(10년)'], ['y5', '5년'], ['y20', '20년'], ['y30', '30년'], ['custom', '직접 입력…']];
  }
  return [];   // 분봉·시봉은 기간 없음
}

function _renderPeriodSelect() {
  const sel = document.getElementById('chart-period-sel');
  const yg  = document.getElementById('chart-years-group');
  if (!sel) return;
  const opts = _periodOptions();
  sel.hidden = !opts.length;
  sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  let val;
  if (_currentCustomYears) val = opts.some(([v]) => v === 'y' + _currentCustomYears) ? 'y' + _currentCustomYears : 'custom';
  else val = _currentInterval === '1d' ? _currentPeriod : '';
  sel.value = val;
  const showYears = !!opts.length && val === 'custom';
  yg.hidden = !showYears;
  if (showYears && _currentCustomYears) document.getElementById('chart-years-input').value = _currentCustomYears;
}

function _bindPeriodEvents() {
  const ivSel    = document.getElementById('chart-interval-sel');
  const typeSel  = document.getElementById('chart-type-sel');
  const perSel   = document.getElementById('chart-period-sel');
  const scaleSel = document.getElementById('chart-scale-sel');
  const yg       = document.getElementById('chart-years-group');
  const yearsInput = document.getElementById('chart-years-input');
  ivSel.value = _currentInterval;
  typeSel.value = _chartType;
  scaleSel.value = _scaleMode;
  _renderPeriodSelect();

  const reload = () => { _saveChartView(); if (_currentTicker) loadChart(_currentTicker); };

  ivSel.addEventListener('change', () => {
    if (ivSel.value === _currentInterval) return;
    _currentInterval = ivSel.value;
    _renderPeriodSelect();
    reload();
  });

  perSel.addEventListener('change', () => {
    const v = perSel.value;
    if (v === 'custom') {          // 연수 입력칸을 열고 [조회]를 기다림
      yg.hidden = false;
      yearsInput.focus();
      return;
    }
    yg.hidden = true;
    if (v.startsWith('y')) _currentCustomYears = parseInt(v.slice(1), 10);
    else { _currentCustomYears = null; if (v) _currentPeriod = v; }
    reload();
  });

  // 기간 직접 입력(연수) — 1~30년
  const applyCustomYears = () => {
    const n = parseInt(yearsInput.value, 10);
    if (!Number.isFinite(n) || n < _CUSTOM_YEARS_MIN || n > _CUSTOM_YEARS_MAX) return;
    _currentCustomYears = n;
    _renderPeriodSelect();
    reload();
  };
  document.getElementById('chart-years-go-btn').addEventListener('click', applyCustomYears);
  yearsInput.addEventListener('keydown', e => { if (e.key === 'Enter') applyCustomYears(); });

  typeSel.addEventListener('change', () => {
    _setChartType(typeSel.value);
    _saveChartView();
  });

  scaleSel.addEventListener('change', () => {
    _scaleMode = scaleSel.value;
    _applyScaleMode();
    _saveChartView();
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
      _resizeDrawCanvas();
    }
  });
  resizeObs.observe(document.getElementById('lw-chart'));
}

// interval/기간(버튼 또는 직접입력 연수) 상태에 맞는 /api/chart URL 조립 (loadChart·자동갱신 공용)
// 1d/mo(월봉)/yr(연봉)는 기간버튼·직접입력(연수)을 함께 씀, 나머지(분/시)는 인터벌만 지정
const _DAILY_FAMILY_INTERVALS = new Set(['1d', 'mo', 'yr']);

function _buildChartUrl(ticker) {
  const enc = encTk(ticker);
  if (!_DAILY_FAMILY_INTERVALS.has(_currentInterval)) return `/api/chart/${enc}?interval=${_currentInterval}`;
  if (_currentCustomYears) return `/api/chart/${enc}?interval=${_currentInterval}&years=${_currentCustomYears}`;
  return `/api/chart/${enc}?interval=${_currentInterval}&period=${_currentPeriod}`;
}

// ── 차트 데이터 로드 ─────────────────────────────────────────────────────────
// 차트를 빠르게 바꾸면(시세 띠 연속 클릭 등) 늦게 도착한 이전 종목 응답이 새 종목 화면을 덮어쓰고,
// 끝난 이전 요청이 자동 갱신 타이머까지 다시 켰음 — 요청 번호로 마지막 요청만 반영한다.
let _chartReqSeq = 0;

async function loadChart(ticker) {
  const reqId = ++_chartReqSeq;
  const stale = () => reqId !== _chartReqSeq;
  ticker = ticker.toUpperCase();
  if (_compareMode) _exitCompare();   // 새 종목 로드 시 비교 모드 종료
  _currentTicker = ticker;
  document.getElementById('chart-input').value = ticker;

  // 헤더 초기화
  const _idxNm = _isIndex(ticker) ? _indexNameOf(ticker) : null;
  document.getElementById('chart-ticker-label').textContent  = _INDEX_NAMES[ticker] || (_idxNm ? koIndex(_idxNm) : ticker);
  document.getElementById('chart-company-label').textContent = '…';
  document.getElementById('chart-price-badge').innerHTML     = '';
  document.getElementById('stock-info-panel').innerHTML      = '<div class="info-placeholder">불러오는 중…</div>';
  _setUpdatedAt('');
  _setNotFound(null);

  // 기존 타이머 정지
  stopChartTimers();

  try {
    const encodedTicker = encTk(ticker);
    const chartUrl = _buildChartUrl(ticker);

    let ohlcv, stockData;

    if (_isIndex(ticker)) {
      // 지수: OHLCV만 가져오고, 현재가는 /api/indices에서 추출
      ohlcv = await api(chartUrl);
      const indices = await api('/api/indices');
      if (stale()) return;
      const idxName = _indexNameOf(ticker);
      const idx = indices.find(i => i.name === idxName);
      const dispName = _INDEX_NAMES[ticker] || (idxName ? koIndex(idxName) : ticker);
      stockData = idx
        ? { ticker, name: dispName, name_ko: '',
            sector: 'Index', price: idx.value, change: idx.change,
            change_pct: idx.change_pct, volume: null,
            market_cap: null, pe: null, eps: null,
            week52_high: null, week52_low: null }
        : { ticker, name: dispName, name_ko: '',
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
    if (stale()) return;

    if (!ohlcv.length) throw new Error('No data');

    _chartIsDummy = _isDummyOhlcv(ohlcv);
    _setDummyBanner(_chartIsDummy, ticker);
    const warmKey = _warmKeyFor(ticker);
    if (warmKey !== _warmKey) { _warmOhlcv = []; _warmKey = ''; }   // 다른 종목·기간의 앞쪽 봉이 섞이지 않게
    _lastOhlcv = ohlcv;
    _renderCandles(ohlcv);
    _loadWarmup(ticker, warmKey, stale);   // 긴 이평선용 앞쪽 봉 — 받으면 지표만 다시 그림(기다리지 않음)
    _loadDrawingsForCurrentTicker();
    _renderHeader(stockData);
    renderStockInfo(stockData);
    _setUpdatedAt(new Date().toLocaleTimeString('ko-KR'));
    _updateAlertBadge();
    document.getElementById('chart-alert-panel').style.display = 'none';

    if (!_isIndex(ticker)) _loadStockNews(ticker);
    if (!_isIndex(ticker) && stockKind(stockData) === 'stock') {
      renderStockAnalysis(ticker);
      renderFinancials(ticker);
    } else {
      // 지수·ETF(홈 섹터 칩 등)는 종합 진단·재무제표가 없음 — 요청하면 404
      document.getElementById('stock-analysis-card').style.display = 'none';
      document.getElementById('financials-card').style.display = 'none';
    }

    _startAutoRefresh();

  } catch {
    if (stale()) return;
    // 11-12: 예전엔 제목만 바뀌고 이전 종목의 차트·신호·진단·재무가 그대로 남아 착각할 수 있었음
    stopChartTimers();
    _setDummyBanner(false);
    ['signal-card', 'stock-analysis-card', 'financials-card'].forEach(id => {
      const el = document.getElementById(id); if (el) el.style.display = 'none';
    });
    document.getElementById('chart-price-badge').innerHTML = '';
    const starWrap = document.getElementById('chart-star-wrap');
    if (starWrap) starWrap.innerHTML = '';
    document.getElementById('stock-info-panel').innerHTML =
      `<div class="info-placeholder" style="color:var(--red)">"${_escHtml(ticker)}" 종목을 찾을 수 없습니다</div>`;
    document.getElementById('chart-ticker-label').textContent  = ticker;
    document.getElementById('chart-company-label').textContent = '';
    _setNotFound(ticker);
  }
}

// ── 긴 이동평균선용 앞쪽 봉 (/api/chart-warmup, 일봉만) ─────────────────────────
function _warmKeyFor(ticker) {
  if (_currentInterval !== '1d') return '';
  return `${ticker}|${_currentCustomYears ? _currentCustomYears + 'y' : _currentPeriod}`;
}

async function _loadWarmup(ticker, key, stale) {
  if (!key || key === _warmKey || _chartIsDummy) return;
  const q = _currentCustomYears ? `years=${_currentCustomYears}` : `period=${_currentPeriod}`;
  try {
    const warm = await api(`/api/chart-warmup/${encTk(ticker)}?${q}`);
    if (stale() || _warmKeyFor(_currentTicker) !== key) return;
    const first = _lastOhlcv.length ? _lastOhlcv[0].time : null;
    // 서버가 화면 첫 봉보다 앞선 봉만 준다 — 혹시 겹치면 쓰지 않음(선이 어긋나는 것 방지)
    if (!Array.isArray(warm) || !warm.length || !first || warm[warm.length - 1].time >= first) return;
    _warmOhlcv = warm;
    _warmKey   = key;
    if (!_compareMode) _applyIndicators();
  } catch {}
}

// 없는 종목 안내 — 차트 영역 전체를 덮어 이전 종목 차트가 보이지 않게 함. null이면 숨김
function _setNotFound(ticker) {
  const main = document.querySelector('.chart-main');
  if (!main) return;
  let el = document.getElementById('chart-notfound');
  if (!ticker) { if (el) el.hidden = true; return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'chart-notfound';
    el.className = 'chart-notfound';
    main.appendChild(el);
  }
  const header = main.querySelector('.chart-header');
  el.style.top = (header ? header.offsetHeight : 64) + 'px';
  el.innerHTML = `<div class="chart-notfound-box">
    <div class="chart-notfound-title">"${_escHtml(ticker)}" 종목을 찾을 수 없습니다</div>
    <div class="chart-notfound-sub">티커를 다시 확인해 주세요. 예: AAPL, BRK/B, 005930.KS</div>
  </div>`;
  el.hidden = false;
}

// ── 예시(더미) 데이터 경고 배너 ──────────────────────────────────────────────
function _isDummyOhlcv(ohlcv) {
  return Array.isArray(ohlcv) && ohlcv.length > 0 && ohlcv[0]._dummy === true;
}

function _setDummyBanner(show, ticker) {
  let el = document.getElementById('chart-dummy-banner');
  if (!el) {
    const anchor = document.getElementById('lw-chart');
    if (!anchor) return;
    el = document.createElement('div');
    el.id = 'chart-dummy-banner';
    el.className = 'chart-dummy-banner';
    el.hidden = true;
    anchor.parentNode.insertBefore(el, anchor);
  }
  if (show) {
    el.textContent = `⚠️ 예시 데이터입니다 — ${ticker || ''} 실시간 시세를 불러오지 못했습니다. 잠시 후 자동 재시도합니다.`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function _renderCandles(ohlcv, { fit = true } = {}) {
  _candleSeries.setData(ohlcv.map(_mainPoint));
  _volSeries.setData(ohlcv.map(d => ({
    time:  d.time,
    value: d.volume,
    color: d.close >= d.open ? 'rgba(63,185,80,.5)' : 'rgba(248,81,73,.5)',
  })));
  // 지표(파란점선의 미래 25칸 포함)를 먼저 붙인 뒤 화면을 맞춰야 맞춘 범위가 밀리지 않는다
  _applyIndicators();
  if (fit) { _fitChart(); _prevVisibleRange = null; _syncFocusBtn(); }
}

// ── 기술 지표 계산 ────────────────────────────────────────────────────────────
// data_fetcher.py의 _sig_ema/_sig_rsi/_sig_macd/_sig_sto/_sig_bb/_sig_rsi_divergence/
// _sig_weekly_trend/_sig_candle_patterns(1797줄~)가 이 계산들을 서버 배치용으로
// 동일 로직으로 복제해둔 상태 — 여기(MA/BB/RSI다이버전스/주봉리샘플/캔들패턴/MACD/
// STO/RSI) 중 하나를 고치면 반대쪽도 같이 확인할 것.
function _calcMA(closes, period) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    return closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

// 파란점선: EMA26(종가) + 대표가(고+저+종)/3의 26일 표준편차 × 2.5 를 25봉 앞(미래 쪽)으로 옮긴 선.
// bars = 앞쪽 warmup + 화면 봉, warmLen = 앞쪽 봉 수, times = 화면 봉 시각.
// 반환: Lightweight Charts 선 데이터 — 화면 기간 + 마지막 봉 이후 25개 미래 시각까지.
// 화면 표시 전용(신호 계산에는 쓰지 않음 → data_fetcher.py 이중 구현 대상 아님)
const _BLUE_SHIFT = 25;
function _calcBlueDotted(bars, warmLen, times) {
  const n = 26, k = 2.5;
  const closes = bars.map(b => b.close);
  const tp     = bars.map(b => (b.high + b.low + b.close) / 3);
  const ema    = _calcEMA(closes, n);
  const out = [];
  const future = _futureTimes(times, _BLUE_SHIFT);
  for (let i = n - 1; i < bars.length; i++) {
    if (ema[i] == null) continue;
    const s = tp.slice(i - n + 1, i + 1);
    const m = s.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / n);
    const j = i + _BLUE_SHIFT - warmLen;          // 화면 봉 기준 위치
    if (j < 0) continue;
    const t = j < times.length ? times[j] : future[j - times.length];
    if (t == null) continue;
    out.push({ time: t, value: +(ema[i] + k * sd).toFixed(4) });
  }
  return out;
}

// 마지막 봉 다음부터 count개의 미래 시각. 일봉은 주말 건너뜀(공휴일은 모름), 월봉·연봉은 달·해 단위,
// 분봉·시봉(숫자 시각)은 마지막 간격만큼.
function _futureTimes(times, count) {
  if (!times.length) return [];
  const last = times[times.length - 1];
  const res = [];
  if (typeof last === 'number') {
    const step = times.length > 1 ? last - times[times.length - 2] : 60;
    for (let i = 1; i <= count; i++) res.push(last + step * i);
    return res;
  }
  const d = new Date(last + 'T00:00:00Z');
  const fmt = x => x.toISOString().slice(0, 10);
  while (res.length < count) {
    if (_currentInterval === 'mo')      d.setUTCMonth(d.getUTCMonth() + 1);
    else if (_currentInterval === 'yr') d.setUTCFullYear(d.getUTCFullYear() + 1);
    else {
      d.setUTCDate(d.getUTCDate() + 1);
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    }
    res.push(fmt(d));
  }
  return res;
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
// bar.time은 인터벌에 따라 형식이 다름: 분봉~시봉은 UTC 초단위 숫자, 일봉 이상은 "YYYY-MM-DD" 문자열
function _parseBarTime(t) {
  if (typeof t === 'number') return new Date(t * 1000);
  return new Date(t + 'T00:00:00Z');
}
function _resampleWeekly(ohlcv) {
  const byWeek = new Map();
  for (const bar of ohlcv) {
    const d   = _parseBarTime(bar.time);
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
        ..._overlayScaleOpts(),
      });
    }
  };
  const _rmLine = key => {
    if (_indSeries[key]) { _lwChart.removeSeries(_indSeries[key]); _indSeries[key] = null; }
  };
  const _toData = (vals) => vals.map((v, i) => v != null ? { time: times[i], value: +v.toFixed(4) } : null).filter(Boolean);

  // 이동평균선 6개 (5·20·60·112·224·448) — 일봉이면 화면 앞쪽 봉(warmup)까지 이어 붙여 계산하고
  // 화면 기간 부분만 그린다. 그래서 1년 화면에서도 448일선이 첫 봉부터 나온다.
  const warm     = _currentInterval === '1d' ? _warmOhlcv : [];
  const fullBars = warm.length ? warm.concat(_lastOhlcv) : _lastOhlcv;
  const fullC    = fullBars.map(d => d.close);
  const visible  = vals => vals.slice(warm.length);   // 계산 결과에서 화면 기간만
  for (const d of _IND_MA) {
    if (_activeInds.has(d.id) && fullC.length >= d.period) {
      _setLine(d.id, d.color, d.period >= 112 ? 1.6 : 1.5);
      _indSeries[d.id].setData(_toData(visible(_calcMA(fullC, d.period))));
    } else { _rmLine(d.id); }
  }

  // 파란점선 — EMA26(종가) + 대표가 26일 표준편차×2.5, 25봉 앞으로 옮김(오늘 이후 25봉까지 그려짐)
  if (_activeInds.has('blue') && fullBars.length >= 27) {
    if (!_indSeries.blue) {
      _indSeries.blue = _lwChart.addLineSeries({
        color: '#2f81f7', lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        ..._overlayScaleOpts(),
      });
    }
    _indSeries.blue.setData(_calcBlueDotted(fullBars, warm.length, times));
  } else { _rmLine('blue'); }

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

  if (_chartIsDummy) {
    // 예시 데이터 위에 가짜 매수/매도 신호를 띄우지 않는다
    _candleSeries.setMarkers([]);
    const sc = document.getElementById('signal-card');
    if (sc) sc.style.display = 'none';
  } else {
    _applySignalMarkers();
    _renderSignalCard();
  }
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
        text: (s >= 3 ? '강력매수 ' : '매수 ') + price,
      });
    } else if (s <= -threshold) {
      markers.push({
        time: times[i], position: 'aboveBar',
        color: s <= -3 ? '#f85149' : '#ffa64d',
        shape: 'arrowDown', size: s <= -3 ? 3 : 1.5,
        text: (s <= -3 ? '강력매도 ' : '매도 ') + price,
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
    ? (patArr[n-1] !== 0 ? '망치형' : '상승 장악형')
    : patScore < 0
    ? (patArr[n-1] !== 0 ? '유성형' : '하락 장악형')
    : '—';
  rows.push({ label: 'CANDLE', score: 0, detail: patName, infoOnly: true, tone: patScore });

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

  const scoreColor = finalTotal > 0 ? 'var(--green)' : finalTotal < 0 ? 'var(--red)' : 'var(--muted)';
  const scoreLabel = finalTotal >= 3 ? '강력 매수'  : finalTotal === 2  ? '매수'
                   : finalTotal <= -3 ? '강력 매도' : finalTotal === -2 ? '매도'
                   : finalTotal === 1 ? '약한 매수'  : finalTotal === -1 ? '약한 매도' : '중립';

  const trendColor = trendUp ? 'var(--green)' : trendDown ? 'var(--red)' : 'var(--muted)';
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
  const wTrendColor = wTrendNow ===  1 ? 'var(--green)' : wTrendNow === -1 ? 'var(--red)' : 'var(--muted)';
  const wTrendLabel = wTrendNow ===  1 ? '▲ 주봉 상승' : wTrendNow === -1 ? '▼ 주봉 하락' : '— 중립';
  const weeklyRow  = `<div class="sc-row sc-trend-row">
    <span class="sc-label">주봉 MA13</span>
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
    : lastPb == null   ? 'var(--muted)'
    : lastPb < 0.20    ? 'var(--green)'
    : lastPb < 0.35    ? 'var(--accent)'
    : lastPb > 0.80    ? 'var(--red)'
    : lastPb > 0.65    ? '#ffa64d'
    : 'var(--muted)';
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
      const ic = r.detail === '—' ? 'var(--muted)' : r.tone > 0 ? 'var(--accent)' : '#ffa64d';
      return `<div class="sc-row">
        <span class="sc-label">${r.label === 'CANDLE' ? '캔들' : r.label}</span>
        <span class="sc-val" style="color:${ic}">${r.detail}</span>
        <span class="sc-sig" style="color:var(--muted);opacity:.7">참고</span>
      </div>`;
    }
    // 추세 반대 신호는 회색으로 표시 (필터됨)
    const filtered = (trendUp && r.score < 0) || (trendDown && r.score > 0);
    const ic = filtered ? 'var(--muted)'
             : r.score > 0 ? 'var(--green)' : r.score < 0 ? 'var(--red)' : 'var(--muted)';
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
  const scoreBg = finalTotal > 0 ? 'var(--green-bg)'
                : finalTotal < 0 ? 'var(--red-bg)'
                : 'rgba(139,148,158,0.08)';
  card.innerHTML = `
    <div class="sc-banner" style="background:${scoreBg};border-left-color:${scoreColor}">
      <div class="sc-title">종합 신호</div>
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
    timeScale: { borderColor: '#30363d', timeVisible: false, fixLeftEdge: true }, // fixRightEdge 빼서 메인차트 rightOffset 여백과 정렬 맞춤
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
    timeScale: { borderColor: '#30363d', timeVisible: false, fixLeftEdge: true }, // fixRightEdge 빼서 메인차트 rightOffset 여백과 정렬 맞춤
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
    timeScale: { borderColor: '#30363d', timeVisible: false, fixLeftEdge: true }, // fixRightEdge 빼서 메인차트 rightOffset 여백과 정렬 맞춤
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

// ── 지표 버튼 줄 · ⚙ 설정 창 · ? 가이드 ──────────────────────────────────────
// 셋 다 _IND_DEFS 하나로 만들고, 켜기/끄기는 _setIndicator() 한 곳에서 처리해 서로 연동된다.
const _indDot = d => {
  if (d.dash)   return `<span class="ind-dot ind-dot-dash" style="border-color:${d.color}"></span>`;
  if (d.color2) return `<span class="ind-dot" style="background:linear-gradient(90deg,${d.color} 50%,${d.color2} 50%)"></span>`;
  return `<span class="ind-dot" style="background:${d.color}"></span>`;
};

function _setIndicator(id, on) {
  if (on) _activeInds.add(id); else _activeInds.delete(id);
  _saveActiveInds();
  _syncIndicatorUI();
  if (!_compareMode) _applyIndicators();
}

function _syncIndicatorUI() {
  document.querySelectorAll('.ind-btn[data-ind]').forEach(b => b.classList.toggle('active', _activeInds.has(b.dataset.ind)));
  document.querySelectorAll('.ind-switch[data-ind]').forEach(s => {
    const on = _activeInds.has(s.dataset.ind);
    s.classList.toggle('on', on);
    s.setAttribute('aria-checked', on);
  });
  const gs = document.getElementById('ind-guide-switch');
  if (gs && _guideCur) {
    const on = _activeInds.has(_guideCur);
    gs.classList.toggle('on', on);
    gs.setAttribute('aria-checked', on);
  }
}

function _bindIndicatorEvents() {
  // 지표 버튼 줄 (범례 겸 빠른 켜기/끄기)
  const wrap = document.getElementById('ind-btns');
  if (wrap) {
    wrap.innerHTML = _IND_DEFS.map(d =>
      `<button class="ind-btn" data-ind="${d.id}" title="${_escHtml(d.title + ' — ' + d.what)}">${_indDot(d)}${d.name}</button>`).join('');
    wrap.addEventListener('click', e => {
      const b = e.target.closest('.ind-btn');
      if (b && !b.disabled) _setIndicator(b.dataset.ind, !_activeInds.has(b.dataset.ind));
    });
  }
  _bindIndicatorSettings();
  _bindIndicatorGuide();
  _syncIndicatorUI();
}

// ⚙ 지표 설정 창 — 탭별 묶음 + 켜기/끄기 스위치, ⓘ는 가이드의 해당 지표로 이동
function _bindIndicatorSettings() {
  const btn = document.getElementById('ind-settings-btn');
  const box = document.getElementById('ind-settings');
  if (!btn || !box) return;
  box.innerHTML = `
    <div class="ind-set-head">
      <span class="ind-set-title">지표 설정</span>
      <button class="ind-set-close" data-act="close" aria-label="닫기">✕</button>
    </div>
    ${_IND_TABS.map(t => `
      <div class="ind-set-group">
        <div class="ind-set-group-name">${t.name}</div>
        ${_IND_DEFS.filter(d => d.tab === t.id).map(d => `
          <div class="ind-set-row">
            ${_indDot(d)}<span class="ind-set-name">${d.name}</span>
            <span class="ind-set-sub">${_escHtml(d.calc)}</span>
            <button class="ind-set-info" data-info="${d.id}" title="${_escHtml(d.title)} 뜻 보기" aria-label="${_escHtml(d.title)} 뜻 보기">ⓘ</button>
            <button class="ind-switch" data-ind="${d.id}" role="switch" aria-checked="false" aria-label="${_escHtml(d.title)}"></button>
          </div>`).join('')}
      </div>`).join('')}
    <div class="ind-set-foot">
      <button class="ind-set-btn" data-act="all-on">전체 켜기</button>
      <button class="ind-set-btn" data-act="all-off">전체 끄기</button>
    </div>`;

  const close = () => { box.hidden = true; btn.classList.remove('active'); };
  btn.addEventListener('click', e => {
    e.stopPropagation();
    box.hidden = !box.hidden;
    btn.classList.toggle('active', !box.hidden);
  });
  box.addEventListener('click', e => {
    e.stopPropagation();
    const sw = e.target.closest('.ind-switch');
    if (sw) { if (!_compareMode) _setIndicator(sw.dataset.ind, !_activeInds.has(sw.dataset.ind)); return; }
    const info = e.target.closest('.ind-set-info');
    if (info) { close(); _openIndicatorGuide(info.dataset.info); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') close();
    if (act === 'all-on' || act === 'all-off') {
      if (_compareMode) return;
      _IND_DEFS.forEach(d => act === 'all-on' ? _activeInds.add(d.id) : _activeInds.delete(d.id));
      _saveActiveInds(); _syncIndicatorUI(); _applyIndicators();
    }
  });
  document.addEventListener('click', () => { if (!box.hidden) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !box.hidden) close(); });
}

// ? 지표 가이드 — 탭(이평선·밴드·보조지표·거래량) → 지표 칩 → 예시 그림 + 무엇인가/어떻게 읽나
let _guideTab = 'ma';
let _guideCur = null;

function _openIndicatorGuide(id) {
  const d = _IND_DEFS.find(x => x.id === id) || _IND_DEFS[0];
  _guideTab = d.tab; _guideCur = d.id;
  document.getElementById('ind-guide').hidden = false;
  _renderIndicatorGuide();
  document.getElementById('ind-guide-close').focus();
}

function _bindIndicatorGuide() {
  const bd = document.getElementById('ind-guide');
  if (!bd) return;
  const close = () => { bd.hidden = true; };
  document.getElementById('ind-help-btn')?.addEventListener('click', () => _openIndicatorGuide(_guideCur || 'ma5'));
  document.getElementById('ind-guide-close').addEventListener('click', close);
  bd.addEventListener('click', e => { if (e.target === bd) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !bd.hidden) close(); });
  document.getElementById('ind-guide-tabs').addEventListener('click', e => {
    const t = e.target.closest('[data-tab]'); if (!t) return;
    _guideTab = t.dataset.tab;
    _guideCur = _IND_DEFS.find(d => d.tab === _guideTab).id;
    _renderIndicatorGuide();
  });
  document.getElementById('ind-guide-chips').addEventListener('click', e => {
    const c = e.target.closest('[data-ind]'); if (!c) return;
    _guideCur = c.dataset.ind; _renderIndicatorGuide();
  });
  document.getElementById('ind-guide-switch').addEventListener('click', () => {
    if (_guideCur && !_compareMode) _setIndicator(_guideCur, !_activeInds.has(_guideCur));
  });
}

function _renderIndicatorGuide() {
  const d = _IND_DEFS.find(x => x.id === _guideCur);
  if (!d) return;
  document.getElementById('ind-guide-tabs').innerHTML = _IND_TABS.map(t =>
    `<button class="ind-guide-tab${t.id === _guideTab ? ' active' : ''}" data-tab="${t.id}">${t.name}</button>`).join('');
  document.getElementById('ind-guide-chips').innerHTML = _IND_DEFS.filter(x => x.tab === _guideTab).map(x =>
    `<button class="ind-guide-chip${x.id === d.id ? ' active' : ''}" data-ind="${x.id}">${_indDot(x)}${x.name}</button>`).join('');
  document.getElementById('ind-guide-dot').innerHTML   = _indDot(d);
  document.getElementById('ind-guide-title').textContent = d.title;
  document.getElementById('ind-guide-cat').textContent   = _IND_TABS.find(t => t.id === d.tab).name;
  document.getElementById('ind-guide-what').textContent  = d.what;
  document.getElementById('ind-guide-how').textContent   = d.how;
  document.getElementById('ind-guide-calc').textContent  = '계산: ' + d.calc;
  _syncIndicatorUI();
  document.getElementById('ind-guide-svg').innerHTML = _guideSvg(d);
}

// 가이드 예시 그림 — 고정된 가상 시세(하락 → 횡보 → 상승)로 그린 설명용 SVG.
// 긴 이평선은 짧은 예시 데이터 안에 들어가도록 기간을 줄여 그린다(모양 설명용).
let _guideBars = null;
function _guideData() {
  if (_guideBars) return _guideBars;
  const bars = []; let p = 100, s = 7;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  for (let i = 0; i < 140; i++) {
    const drift = i < 60 ? -0.25 : i < 95 ? 0.02 : 0.45;
    const o = p, c = p + drift + (rnd() - .5) * 2.2;
    bars.push({ open: o, close: c, high: Math.max(o, c) + rnd() * 1.2, low: Math.min(o, c) - rnd() * 1.2,
                volume: 50 + rnd() * 60 + (i > 95 ? 40 : 0) });
    p = c;
  }
  return (_guideBars = bars);
}

function _guideSvg(ind) {
  const bars = _guideData(), N = bars.length, closes = bars.map(b => b.close);
  const W = 700, isBlue = ind.id === 'blue', sub = ind.tab === 'sub' || ind.tab === 'vol';
  const priceH = sub ? 180 : 280, subTop = 195, subH = 95;
  const span = N - 1 + (isBlue ? _BLUE_SHIFT : 0);
  const x = i => 10 + (i / span) * (W - 20);
  const std = (a, n) => a.map((_, i) => { if (i < n - 1) return null; const s = a.slice(i - n + 1, i + 1), m = s.reduce((p, q) => p + q, 0) / n; return Math.sqrt(s.reduce((p, q) => p + (q - m) ** 2, 0) / n); });
  const SHOW = { ma5: 5, ma20: 20, ma60: 40, ma112: 60, ma224: 80, ma448: 100 };
  const over = [];
  if (ind.tab === 'ma') _IND_MA.forEach(m => over.push({ vals: _calcMA(closes, SHOW[m.id]), color: m.color, bold: m.id === ind.id, name: m.name + '선' }));
  if (ind.id === 'bb') { const b = _calcBB(closes);
    over.push({ vals: b.upper, color: ind.color, bold: true, label: '위 밴드' }, { vals: b.mid, color: ind.color, thin: true }, { vals: b.lower, color: ind.color, bold: true, label: '아래 밴드' }); }
  if (isBlue) { const tp = bars.map(b => (b.high + b.low + b.close) / 3), e = _calcEMA(closes, 26), s = std(tp, 26);
    over.push({ vals: [...Array(_BLUE_SHIFT).fill(null), ...e.map((v, i) => v == null ? null : v + 2.5 * s[i])], color: ind.color, bold: true, dash: true, label: '넘어야 할 벽' }); }
  let lo = Math.min(...bars.map(b => b.low)), hi = Math.max(...bars.map(b => b.high));
  over.forEach(o => o.vals.forEach(v => { if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
  const y = v => 10 + (1 - (v - lo) / (hi - lo)) * (priceH - 20);
  const out = [];
  for (let g = 0; g < 4; g++) { const gy = 10 + g * (priceH - 20) / 3; out.push(`<line x1="0" x2="${W}" y1="${gy}" y2="${gy}" stroke="#21262d"/>`); }
  const bw = Math.max(1.5, (W - 20) / span * 0.6), fade = ind.tab === 'ma' || ind.tab === 'band' ? .5 : .8;
  if (ind.id === 'bb') { const [u, , l] = over, pts = [];
    u.vals.forEach((v, i) => v != null && pts.push(`${x(i)},${y(v)}`));
    l.vals.map((v, i) => [v, i]).reverse().forEach(([v, i]) => v != null && pts.push(`${x(i)},${y(v)}`));
    out.push(`<polygon points="${pts.join(' ')}" fill="${ind.color}" opacity=".08"/>`); }
  bars.forEach((b, i) => { const col = b.close >= b.open ? '#3fb950' : '#f85149';
    out.push(`<line x1="${x(i)}" x2="${x(i)}" y1="${y(b.high)}" y2="${y(b.low)}" stroke="${col}" opacity="${fade}"/>`,
      `<rect x="${x(i) - bw / 2}" y="${y(Math.max(b.open, b.close))}" width="${bw}" height="${Math.max(1, Math.abs(y(b.open) - y(b.close)))}" fill="${col}" opacity="${fade}"/>`); });
  const pts = vals => vals.map((v, i) => v == null ? null : `${x(i)},${y(v)}`).filter(Boolean).join(' ');
  over.forEach(o => {
    out.push(`<polyline points="${pts(o.vals)}" fill="none" stroke="${o.color}" stroke-width="${o.bold ? 3 : o.thin ? 1 : 1.2}" opacity="${o.bold ? 1 : .35}"${o.dash ? ' stroke-dasharray="7 5"' : ''}/>`);
    const at = o.label ? Math.round((o.vals.length - 1) * .45) : o.vals.length - 1;
    if (o.label && o.vals[at] != null) out.push(`<text x="${x(at)}" y="${y(o.vals[at]) - 8}" class="ind-guide-svg-label">${o.label}</text>`);
    else if (o.bold && o.name) out.push(`<text x="${x(at) - 60}" y="${y(o.vals[at]) - 10}" class="ind-guide-svg-label">${o.name}</text>`);
  });
  if (isBlue) out.push(`<line x1="${x(N - 1)}" x2="${x(N - 1)}" y1="5" y2="${priceH}" stroke="#30363d" stroke-dasharray="3 3"/>`,
    `<text x="${x(N - 1) + 6}" y="20" class="ind-guide-svg-note">오늘 → 25봉 앞</text>`);
  if (sub) {
    out.push(`<line x1="0" x2="${W}" y1="${subTop - 6}" y2="${subTop - 6}" stroke="#30363d"/>`);
    const sy = (v, a, b) => subTop + (1 - (v - a) / (b - a)) * subH;
    const pl = (vals, a, b, col) => `<polyline points="${vals.map((v, i) => v == null ? null : `${x(i)},${sy(v, a, b)}`).filter(Boolean).join(' ')}" fill="none" stroke="${col}" stroke-width="2"/>`;
    const band = (v, a, b, t) => `<line x1="0" x2="${W}" y1="${sy(v, a, b)}" y2="${sy(v, a, b)}" stroke="#6e7681" stroke-dasharray="4 4"/><text x="6" y="${sy(v, a, b) - 4}" class="ind-guide-svg-note">${t}</text>`;
    if (ind.id === 'rsi') out.push(band(70, 0, 100, '70 과열'), band(30, 0, 100, '30 침체'), pl(_calcRSI(closes), 0, 100, ind.color));
    if (ind.id === 'macd') {
      const e12 = _calcEMA(closes, 12), e26 = _calcEMA(closes, 26);
      const m = e12.map((v, i) => v == null || e26[i] == null ? null : v - e26[i]);
      const mv = m.filter(v => v != null), sg = [...Array(m.length - mv.length).fill(null), ..._calcEMA(mv, 9)];
      const a = Math.min(...mv) - .5, b = Math.max(...mv) + .5;
      m.forEach((v, i) => { if (v == null || sg[i] == null) return; const h = v - sg[i];
        out.push(`<rect x="${x(i) - bw / 2}" y="${Math.min(sy(h, a, b), sy(0, a, b))}" width="${bw}" height="${Math.abs(sy(h, a, b) - sy(0, a, b))}" fill="${h >= 0 ? '#3fb950' : '#f85149'}" opacity=".4"/>`); });
      out.push(band(0, a, b, '0선'), pl(m, a, b, ind.color), pl(sg, a, b, ind.color2));
    }
    if (ind.id === 'sto') { const s = _calcStochastic(bars);
      out.push(band(80, 0, 100, '80 과매수'), band(20, 0, 100, '20 과매도'), pl(s.k, 0, 100, ind.color), pl(s.d, 0, 100, ind.color2)); }
    if (ind.id === 'volma') { const vs = bars.map(b => b.volume), top = Math.max(...vs) * 1.1;
      bars.forEach((b, i) => out.push(`<rect x="${x(i) - bw / 2}" y="${sy(b.volume, 0, top)}" width="${bw}" height="${subTop + subH - sy(b.volume, 0, top)}" fill="${b.close >= b.open ? '#3fb950' : '#f85149'}" opacity=".45"/>`));
      out.push(pl(_calcMA(vs, 20), 0, top, ind.color)); }
  }
  return out.join('');
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

// 차트 탭을 안 보고 있어도(다른 탭이거나 다른 티커를 보는 중이어도) 알림이 동작하도록,
// main.js의 stocks_update 소켓 푸시(5분 주기, US 전종목)에서 저장된 알림 티커들을 훑어 확인
function _checkAllAlerts(stocksArr) {
  const list = _alertLoad();
  if (!list.length || !stocksArr || !stocksArr.length) return;
  const alertTickers = new Set(list.map(a => a.ticker));
  for (const s of stocksArr) {
    if (alertTickers.has(s.ticker) && s.price != null) _alertCheck(s.ticker, s.price);
  }
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

  const enc1 = encTk(_currentTicker);
  const enc2 = encTk(_compareTicker);
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
  const isIdx = _isIndex(stock.ticker || '');
  // 지수·환율 등은 Yahoo 심볼(^KS11·KRW=X)이 낯설어 큰 제목을 한글 이름으로, 심볼은 옆에 작게
  document.getElementById('chart-ticker-label').textContent  = isIdx ? stock.name : stock.ticker;
  const companyEl = document.getElementById('chart-company-label');
  companyEl.textContent =
    isIdx ? (_INDEX_DISPLAY_SYMBOL[stock.ticker] || stock.ticker)
          : (stock.name_ko ? `${stock.name} (${stock.name_ko})` : stock.name);
  if (isIdx) companyEl.title = `야후 심볼: ${stock.ticker}`;
  else companyEl.removeAttribute('title');
  if (!isIdx && stockKind(stock) !== 'stock')
    companyEl.insertAdjacentHTML('beforeend', ' ' + kindBadgeHtml(stock));
  if (isIdx) {
    companyEl.insertAdjacentHTML('beforeend', _relatedEtfHtml(stock.ticker));
    companyEl.querySelectorAll('.related-etf-btn').forEach(b =>
      b.addEventListener('click', () => loadChart(b.dataset.ticker)));
  }
  _updatePriceBadge(stock);
  // 지수(S&P500·VIX 등)는 관심종목 대상이 아니라 ★ 버튼 숨김
  const starWrap = document.getElementById('chart-star-wrap');
  if (starWrap) starWrap.innerHTML = _isIndex(stock.ticker) ? '' : starBtn(stock.ticker);
}

function _updatePriceBadge(stock) {
  const cls  = colorCls(stock.change_pct || 0);
  const price  = stock.price ? _fmtQuote(stock.price, stock.ticker) : '—';
  const change = _fmtQuoteChange(stock.change, stock.ticker);
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

  // 10초마다 현재가 + 가격 배지 갱신 (서버가 보는 종목을 10초마다 네이버 실시간 값으로 갱신)
  _priceTimer = setInterval(async () => {
    if (!_currentTicker) return;
    try {
      if (_isIndex(_currentTicker)) {
        const indices = await api('/api/indices');
        const idxName = _indexNameOf(_currentTicker);
        const idx = indices.find(i => i.name === idxName);
        if (idx) {
          const s = { ticker: _currentTicker, price: idx.value,
                      change: idx.change, change_pct: idx.change_pct,
                      name: _INDEX_NAMES[_currentTicker] || koIndex(idxName),
                      name_ko:'', sector:'Index', volume:null,
                      market_cap:null, pe:null, eps:null,
                      week52_high:null, week52_low:null };
          _updatePriceBadge(s);
          renderStockInfo(s);
          _alertCheck(_currentTicker, s.price);
        }
      } else {
        const stock = await api(`/api/stock/${encTk(_currentTicker)}`);
        _updatePriceBadge(stock);
        renderStockInfo(stock);
        _alertCheck(_currentTicker, stock.price);
      }
    } catch {}
  }, 10_000);

  // interval별 주기로 캔들 업데이트
  const candleMs = _CANDLE_REFRESH[_currentInterval] || 60_000;
  _candleTimer = setInterval(async () => {
    if (!_currentTicker) return;
    try {
      const chartUrl = _buildChartUrl(_currentTicker);
      const ohlcv = await api(chartUrl);
      if (!ohlcv.length) return;

      const refDummy = _isDummyOhlcv(ohlcv);
      // 실데이터를 보고 있는데 이번 응답이 더미면(일시적 조회 실패) 갱신 건너뜀 — 화면 보존
      if (refDummy && !_chartIsDummy) return;
      // 더미를 보던 중 실데이터 복구 → 배너 내리고 지표/신호 정상화, 전체 재렌더
      if (!refDummy && _chartIsDummy) {
        _chartIsDummy = false;
        _setDummyBanner(false);
        _lastOhlcv = ohlcv;
        _renderCandles(ohlcv, { fit: false });
        _setUpdatedAt(new Date().toLocaleTimeString('ko-KR'));
        return;
      }

      const latest = ohlcv[ohlcv.length - 1];
      const prev   = _lastOhlcv[_lastOhlcv.length - 1];

      if (prev && latest.time === prev.time) {
        // 같은 날짜: 마지막 캔들만 업데이트 (화면 깜빡임 없음)
        _candleSeries.update(_mainPoint(latest));
        _volSeries.update({
          time:  latest.time,
          value: latest.volume,
          color: latest.close >= latest.open ? 'rgba(63,185,80,.5)' : 'rgba(248,81,73,.5)',
        });
      } else {
        // 새 날짜 캔들 추가: 데이터만 갱신, 사용자가 맞춰둔 확대/스크롤 위치는 유지
        _lastOhlcv = ohlcv;
        _renderCandles(ohlcv, { fit: false });
      }

      _lastOhlcv = ohlcv;
      _setUpdatedAt(new Date().toLocaleTimeString('ko-KR'));
    } catch {}
  }, candleMs);
}

// ── 종목 종합 진단 (참고용 — 항목별 근거만 제공, 자동 매수/매도 결론 없음) ─────
const _ANALYSIS_VERDICT_ICON  = { buy: '🟢', sell: '🔴', neutral: '⚪', unknown: '⚪' };
const _ANALYSIS_VERDICT_LABEL = { buy: '매수 우호', sell: '매도 우호', neutral: '중립', unknown: '정보부족' };

async function renderStockAnalysis(ticker) {
  const card = document.getElementById('stock-analysis-card');
  if (!card) return;
  card.style.display = '';
  card.innerHTML = `<div class="info-section-title">📊 종합 진단</div><div class="analysis-loading">분석 중…</div>`;

  let data;
  try {
    data = await api(`/api/stock-analysis/${encTk(ticker)}`);
  } catch {
    card.style.display = 'none';
    return;
  }
  if (!data || data.error || !data.items) {
    card.style.display = 'none';
    return;
  }

  const { items, info, summary } = data;

  const itemsHtml = items.map(it => `
    <div class="analysis-item">
      <span class="analysis-icon">${_ANALYSIS_VERDICT_ICON[it.verdict] || '⚪'}</span>
      <div class="analysis-item-body">
        <div class="analysis-item-label">${it.label} <span class="analysis-item-verdict verdict-${it.verdict}">${_ANALYSIS_VERDICT_LABEL[it.verdict] || ''}</span></div>
        <div class="analysis-item-detail">${it.detail}</div>
      </div>
    </div>`).join('');

  const infoHtml = (info || []).map(it => {
    if (it.key === 'news' && it.items && it.items.length) {
      return `
        <div class="analysis-info-block">
          <div class="analysis-info-label">${it.label} <span class="analysis-info-note">(${it.detail})</span></div>
          ${it.items.map(n => `<div class="analysis-news-item">${n.title}<span class="analysis-news-src"> — ${n.source}</span></div>`).join('')}
        </div>`;
    }
    return `<div class="analysis-info-block"><div class="analysis-info-label">${it.label}</div><div class="analysis-info-note">${it.detail}</div></div>`;
  }).join('');

  card.innerHTML = `
    <div class="info-section-title">📊 종합 진단 <span class="analysis-disclaimer">(참고용 · 투자 조언 아님)</span></div>
    <div class="analysis-summary">${summary.total}개 항목 중 매수 우호 ${summary.buy} · 매도 우호 ${summary.sell} · 중립 ${summary.neutral}</div>
    <div class="analysis-items">${itemsHtml}</div>
    ${infoHtml ? `<div class="analysis-info">${infoHtml}</div>` : ''}
  `;
}

// ── 재무제표 (KR: 네이버 금융 / US: SEC EDGAR) ────────────────────────────────
function _fmtFinNum(v, unit) {
  if (v == null) return '—';
  const sign = v < 0 ? '-' : '';
  const abs  = Math.abs(v);
  if (unit === 'USD') {
    if (abs >= 1e9) return sign + '$' + (abs / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(1) + 'M';
    return sign + '$' + abs.toLocaleString('en-US');
  }
  if (unit === 'USD/주') return sign + '$' + abs.toFixed(2);
  if (unit === '억원') {
    if (abs >= 10000) return sign + (abs / 10000).toFixed(1) + '조원';
    return sign + Math.round(abs).toLocaleString('ko-KR') + '억원';
  }
  if (unit === '원') return sign + Math.round(abs).toLocaleString('ko-KR') + '원';
  if (unit === '%')  return sign + abs.toFixed(2) + '%';
  if (unit === '배')  return sign + abs.toFixed(2) + '배';
  return String(v);
}

function _renderFinancialsTable(card, data, mode) {
  const periods = mode === 'quarterly' ? data.quarterly_periods : data.annual_periods;
  const hasQuarterly = data.quarterly_periods && data.quarterly_periods.length > 0;

  const toggleHtml = hasQuarterly ? `
    <div class="fin-toggle">
      <button class="fin-toggle-btn ${mode === 'annual' ? 'active' : ''}" data-mode="annual">연간</button>
      <button class="fin-toggle-btn ${mode === 'quarterly' ? 'active' : ''}" data-mode="quarterly">분기</button>
    </div>` : '';

  const theadHtml = `<tr><th>항목</th>${periods.map(p => `<th>${p}</th>`).join('')}</tr>`;
  const tbodyHtml = data.rows.map(r => {
    const vals = mode === 'quarterly' ? r.quarterly : r.annual;
    return `<tr><th class="fin-row-label">${r.label}</th>${vals.map(v => `<td>${_fmtFinNum(v, r.unit)}</td>`).join('')}</tr>`;
  }).join('');

  card.innerHTML = `
    <div class="info-section-title">📑 재무제표 <span class="analysis-disclaimer">(${data.market === 'KR' ? '네이버 금융' : 'SEC EDGAR'})</span></div>
    ${toggleHtml}
    <div class="fin-table-wrap"><table class="fin-table">
      <thead>${theadHtml}</thead>
      <tbody>${tbodyHtml}</tbody>
    </table></div>
  `;
  // 표가 사이드바(260px)보다 넓어 최신 연도(맨 오른쪽)가 가려졌음 → 처음부터 최신 쪽이 보이게
  const wrap = card.querySelector('.fin-table-wrap');
  if (wrap) wrap.scrollLeft = wrap.scrollWidth;

  if (hasQuarterly) {
    card.querySelectorAll('.fin-toggle-btn').forEach(btn => {
      btn.onclick = () => _renderFinancialsTable(card, data, btn.dataset.mode);
    });
  }
}

async function renderFinancials(ticker) {
  const card = document.getElementById('financials-card');
  if (!card) return;
  card.style.display = '';
  card.innerHTML = `<div class="info-section-title">📑 재무제표</div><div class="analysis-loading">불러오는 중…</div>`;

  let data;
  try {
    data = await api(`/api/financials/${encTk(ticker)}`);
  } catch {
    card.style.display = 'none';
    return;
  }
  if (!data || data.error || !data.rows || !data.annual_periods || !data.annual_periods.length) {
    card.style.display = 'none';
    return;
  }
  _renderFinancialsTable(card, data, 'annual');
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
    <div class="info-section-title">주요 지표</div>
    <div class="info-row">
      <span class="info-label">현재가</span>
      <span class="info-val">${s.price ? _fmtQuote(s.price, s.ticker) : '—'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">변동</span>
      <span class="info-val ${cls}">${_fmtQuoteChange(s.change, s.ticker)}</span>
    </div>
    <div class="info-row">
      <span class="info-label">등락률</span>
      <span class="info-val ${cls}">${s.change_pct != null ? fmtPct(s.change_pct) : '—'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">거래량</span>
      <span class="info-val">${s.volume ? fmtVol(s.volume) : '—'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">시가총액</span>
      <span class="info-val">${capStr}</span>
    </div>
    <div class="info-section-title" style="margin-top:4px">가치 평가</div>
    <div class="info-row">
      <span class="info-label">PER</span>
      <span class="info-val">${peStr}</span>
    </div>
    <div class="info-row">
      <span class="info-label">EPS</span>
      <span class="info-val">${epsStr}</span>
    </div>
    <div class="info-row">
      <span class="info-label">${isKr ? '업종' : '섹터'}</span>
      <span class="info-val info-sector-badge" style="font-size:11px">${stockKind(s) !== 'stock' ? stockKind(s).toUpperCase() : s.sector ? (isKr ? s.sector : koSector(s.sector)) : '—'}</span>
    </div>
    <div class="info-section-title" style="margin-top:4px">52주 범위</div>
    <div class="info-row">
      <span class="info-label">최고</span>
      <span class="info-val up">${s.week52_high ? fmtP(s.week52_high) : '—'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">최저</span>
      <span class="info-val down">${s.week52_low ? fmtP(s.week52_low) : '—'}</span>
    </div>
    <div class="info-row">
      <span class="info-label">52주 최고 대비</span>
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
    <div style="color:var(--muted);font-size:11px;padding:4px 0">불러오는 중…</div>`;
  try {
    const rows = await api(`/api/kr-investor/${code}`);
    if (!rows || !rows.length) {
      section.innerHTML = `<div class="info-section-title" style="margin-top:10px">수급 동향</div>
        <div style="color:var(--muted);font-size:11px;padding:4px 0">정보 없음</div>`;
      return;
    }
    const fmtV = v => {
      if (!v) return '<span style="color:var(--muted)">—</span>';
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
  section.innerHTML = `<div class="info-section-title" style="margin-top:10px">관련 뉴스</div>
    <div style="color:var(--muted);font-size:11px;padding:4px 0">불러오는 중…</div>`;
  try {
    const url = _isKrStock(ticker)
      ? `/api/kr-news/${encodeURIComponent(ticker)}`
      : `/api/stock-news/${encTk(ticker)}`;
    const news = await api(url);
    if (!news || !news.length) {
      section.innerHTML = `<div class="info-section-title" style="margin-top:10px">관련 뉴스</div>
        <div style="color:var(--muted);font-size:11px;padding:4px 0">최근 뉴스가 없습니다</div>`;
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
    section.innerHTML = `<div class="info-section-title" style="margin-top:10px">관련 뉴스</div>${items}`;
  } catch {
    section.innerHTML = '';
  }
}
