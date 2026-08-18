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
let _priceTimer     = null;
let _candleTimer    = null;
let _lastOhlcv      = [];

// ── 기술 지표 상태 ────────────────────────────────────────────────────────────
const _activeInds = new Set(['ma5','ma20','ma60','bb','rsi','macd','sto','volma']);
const _indSeries  = { ma5: null, ma20: null, ma60: null, ma120: null, ma240: null, bbFill: null, bbMask: null, bbU: null, bbM: null, bbL: null, volma: null };
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
      rightOffset: 40, // 마지막 봉 오른쪽 여백(HTS처럼) — 추세선을 미래 방향으로 그릴 공간 확보. fixRightEdge와 같이 쓰면 여백이 무시되므로 fixRightEdge는 뺌
    },
    // 좌클릭 드래그는 국내 HTS 방식 구간 확대/축소 제스처로 대체 (_bindChartZoomEvents 참고) — 기본 패닝은 끔
    handleScroll: { pressedMouseMove: false },
    // 휠/핀치 줌도 끔 — 커스텀 드래그 제스처와 동시에 반응하면 터치에서 충돌하므로 줌 조작은 하나로 통일
    handleScale: false,
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
          if (_prevVisibleRange) {
            _lwChart.timeScale().setVisibleLogicalRange(_prevVisibleRange);
            _prevVisibleRange = null;
          }
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
      _prevVisibleRange = timeScale.getVisibleLogicalRange();
      timeScale.setVisibleRange({
        from: t1 < t2 ? t1 : t2,
        to:   t1 < t2 ? t2 : t1,
      });
    } else {
      // 오른쪽 → 왼쪽: 전체보기로 복귀
      timeScale.fitContent();
    }
  };
  container.addEventListener('pointerup', finishDrag);
  container.addEventListener('pointerleave', finishDrag);
  container.addEventListener('pointercancel', finishDrag);

  container.addEventListener('dblclick', () => {
    if (!_prevVisibleRange) return;
    _lwChart.timeScale().setVisibleLogicalRange(_prevVisibleRange);
    _prevVisibleRange = null;
  });

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

function _bindPeriodEvents() {
  // 기간 버튼 (1D interval일 때만 활성)
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _currentCustomYears = null; // 직접입력과 상호 배타
      document.getElementById('chart-years-input').classList.remove('active');
      if (btn.dataset.period === _currentPeriod) return;
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _currentPeriod = btn.dataset.period;
      if (_currentTicker) loadChart(_currentTicker);
    });
  });

  // 기간 직접 입력(연수) — 2Y 이상 임의 기간 조회
  const yearsInput = document.getElementById('chart-years-input');
  const applyCustomYears = () => {
    const n = parseInt(yearsInput.value, 10);
    if (!Number.isFinite(n) || n < _CUSTOM_YEARS_MIN || n > _CUSTOM_YEARS_MAX) return;
    _currentCustomYears = n;
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    yearsInput.classList.add('active');
    if (_currentTicker) loadChart(_currentTicker);
  };
  document.getElementById('chart-years-go-btn').addEventListener('click', applyCustomYears);
  yearsInput.addEventListener('keydown', e => { if (e.key === 'Enter') applyCustomYears(); });

  // interval 버튼 (1m/5m/15m/30m/1H/1D)
  document.querySelectorAll('.interval-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const iv = btn.dataset.interval;
      if (iv === _currentInterval) return;
      document.querySelectorAll('.interval-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _currentInterval = iv;
      // 기간 버튼(1M~2Y)은 1D에서만 의미 있음, 직접입력(연수)은 1D/월봉/연봉 전부에서 유용
      const pg = document.getElementById('period-group');
      const sep = document.querySelector('.chart-sep');
      const yg = document.querySelector('.chart-years-group');
      const showPeriodButtons = iv === '1d';
      const showYearsInput    = _DAILY_FAMILY_INTERVALS.has(iv);
      if (pg)  pg.style.display  = showPeriodButtons ? '' : 'none';
      if (sep) sep.style.display = showPeriodButtons ? '' : 'none';
      if (yg)  yg.style.display  = showYearsInput    ? '' : 'none';
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
      _resizeDrawCanvas();
    }
  });
  resizeObs.observe(document.getElementById('lw-chart'));
}

// interval/기간(버튼 또는 직접입력 연수) 상태에 맞는 /api/chart URL 조립 (loadChart·자동갱신 공용)
// 1d/mo(월봉)/yr(연봉)는 기간버튼·직접입력(연수)을 함께 씀, 나머지(분/시)는 인터벌만 지정
const _DAILY_FAMILY_INTERVALS = new Set(['1d', 'mo', 'yr']);

function _buildChartUrl(ticker) {
  const enc = encodeURIComponent(ticker);
  if (!_DAILY_FAMILY_INTERVALS.has(_currentInterval)) return `/api/chart/${enc}?interval=${_currentInterval}`;
  if (_currentCustomYears) return `/api/chart/${enc}?interval=${_currentInterval}&years=${_currentCustomYears}`;
  return `/api/chart/${enc}?interval=${_currentInterval}&period=${_currentPeriod}`;
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
    const chartUrl = _buildChartUrl(ticker);

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
    _loadDrawingsForCurrentTicker();
    _renderHeader(stockData);
    renderStockInfo(stockData);
    _setUpdatedAt(new Date().toLocaleTimeString('ko-KR'));
    _updateAlertBadge();
    document.getElementById('chart-alert-panel').style.display = 'none';

    if (!_isIndex(ticker)) {
      _loadStockNews(ticker);
      renderStockAnalysis(ticker);
    } else {
      document.getElementById('stock-analysis-card').style.display = 'none';
    }

    _startAutoRefresh();

  } catch {
    document.getElementById('stock-info-panel').innerHTML =
      `<div class="info-placeholder" style="color:#f85149">Ticker "${ticker}" not found</div>`;
    document.getElementById('chart-ticker-label').textContent  = ticker;
    document.getElementById('chart-company-label').textContent = '';
  }
}

function _renderCandles(ohlcv, { fit = true } = {}) {
  _candleSeries.setData(ohlcv.map(d => ({
    time: d.time, open: d.open, high: d.high, low: d.low, close: d.close,
  })));
  _volSeries.setData(ohlcv.map(d => ({
    time:  d.time,
    value: d.volume,
    color: d.close >= d.open ? 'rgba(63,185,80,.5)' : 'rgba(248,81,73,.5)',
  })));
  if (fit) _lwChart.timeScale().fitContent();
  _applyIndicators();
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

  // MA120
  if (_activeInds.has('ma120') && closes.length >= 120) {
    _setLine('ma120', '#3fb950');
    _indSeries.ma120.setData(_toData(_calcMA(closes, 120)));
  } else { _rmLine('ma120'); }

  // MA240
  if (_activeInds.has('ma240') && closes.length >= 240) {
    _setLine('ma240', '#f778ba');
    _indSeries.ma240.setData(_toData(_calcMA(closes, 240)));
  } else { _rmLine('ma240'); }

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
  // 지수(S&P500·VIX 등)는 관심종목 대상이 아니라 ★ 버튼 숨김
  const starWrap = document.getElementById('chart-star-wrap');
  if (starWrap) starWrap.innerHTML = _isIndex(stock.ticker) ? '' : starBtn(stock.ticker);
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
      const chartUrl = _buildChartUrl(_currentTicker);
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
    data = await api(`/api/stock-analysis/${encodeURIComponent(ticker)}`);
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
    const url = _isKrStock(ticker)
      ? `/api/kr-news/${encodeURIComponent(ticker)}`
      : `/api/stock-news/${encodeURIComponent(ticker)}`;
    const news = await api(url);
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
