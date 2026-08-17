/* ═══════════════════════════════════════════════════════════════
   portfolio.js — 포트폴리오 손익 계산 (localStorage 기반)
   ═══════════════════════════════════════════════════════════════ */

const PT_KEY = 'stockview_portfolio';

// ── 포트폴리오 저장소 ─────────────────────────────────────────────────────────
// 구조: { "AAPL": { qty: 10, avgPrice: 150.00 }, ... }
const PT = {
  _data: null,

  load() {
    if (this._data) return this._data;
    try { this._data = JSON.parse(localStorage.getItem(PT_KEY) || '{}'); }
    catch { this._data = {}; }
    return this._data;
  },

  save() { localStorage.setItem(PT_KEY, JSON.stringify(this._data)); },

  set(ticker, qty, avgPrice) {
    this.load()[ticker] = { qty: parseFloat(qty), avgPrice: parseFloat(avgPrice) };
    this.save();
  },

  remove(ticker) {
    delete this.load()[ticker];
    this.save();
    PTG.remove(ticker);
  },

  tickers() { return Object.keys(this.load()); },
  count()   { return this.tickers().length; },
};

// ── 포트폴리오 메모/목표가 저장소 (Watchlist WLN과 동일 구조, 별도 키) ─────────
const PTN_KEY = 'stockview_portfolio_notes';
const PTN = {
  _map: null,
  load() {
    if (this._map) return this._map;
    try { this._map = JSON.parse(localStorage.getItem(PTN_KEY) || '{}'); }
    catch { this._map = {}; }
    return this._map;
  },
  save() { localStorage.setItem(PTN_KEY, JSON.stringify(this._map)); },
  get(ticker) { return this.load()[ticker] || {}; },
  setMemo(ticker, memo) {
    const m = this.load();
    const cur = { ...(m[ticker] || {}) };
    if (memo) cur.memo = memo; else delete cur.memo;
    if (Object.keys(cur).length) m[ticker] = cur; else delete m[ticker];
    this.save();
  },
  setTarget(ticker, target) {
    const m = this.load();
    const cur = { ...(m[ticker] || {}) };
    const n = parseFloat(target);
    if (target !== '' && Number.isFinite(n)) cur.target = n; else delete cur.target;
    if (Object.keys(cur).length) m[ticker] = cur; else delete m[ticker];
    this.save();
  },
};

// ── 포트폴리오 그룹 저장소 (Watchlist WLG와 동일 구조, 별도 키) ────────────────
const PTG_KEY = 'stockview_portfolio_groups';
const PTG_NAMES_KEY = 'stockview_portfolio_group_names';
const PTG = {
  _map: null,
  _names: null,
  load() {
    if (this._map) return this._map;
    try { this._map = JSON.parse(localStorage.getItem(PTG_KEY) || '{}'); }
    catch { this._map = {}; }
    return this._map;
  },
  save() { localStorage.setItem(PTG_KEY, JSON.stringify(this._map)); },
  get(ticker) { return this.load()[ticker] || ''; },
  set(ticker, group) {
    const m = this.load();
    if (group) { m[ticker] = group; this.addGroupName(group); } else delete m[ticker];
    this.save();
  },
  remove(ticker) { this.set(ticker, ''); },
  loadNames() {
    if (this._names) return this._names;
    try { this._names = JSON.parse(localStorage.getItem(PTG_NAMES_KEY) || '[]'); }
    catch { this._names = []; }
    return this._names;
  },
  saveNames() { localStorage.setItem(PTG_NAMES_KEY, JSON.stringify(this._names)); },
  addGroupName(name) {
    const names = this.loadNames();
    if (!names.includes(name)) { names.push(name); this.saveNames(); }
  },
  allGroups(tickers) {
    const m = this.load();
    const set = new Set(this.loadNames());
    tickers.forEach(t => { if (m[t]) set.add(m[t]); });
    return [...set].sort();
  },
};
let _ptGroupFilter = '전체';

// ── 차트 색상 ─────────────────────────────────────────────────────────────────
const _SECTOR_COLORS = {
  'Technology':       '#58a6ff',
  'Finance':          '#3fb950',
  'Healthcare':       '#ff7b72',
  'Energy':           '#d2a522',
  'Consumer Disc.':   '#bc8cff',
  'Consumer Staples': '#56d364',
  'Industrial':       '#96b9ff',
  'Communication':    '#ffa64d',
  'Real Estate':      '#ffd400',
  'Materials':        '#a0e6b4',
  'Utilities':        '#8cc8ff',
  'Other':            '#8b949e',
};
const _HOLDING_COLORS = [
  '#58a6ff','#3fb950','#ff7b72','#d2a522',
  '#bc8cff','#56d364','#ffa64d','#ffd400','#8b949e',
];

// ── 유틸 ──────────────────────────────────────────────────────────────────────
function _fmtPnl(n) {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '';
  return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function _fmtPnlPct(n) {
  if (n == null) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}
function _clsPnl(n) { return n == null ? '' : n >= 0 ? 'up' : 'down'; }

// ── 도넛 차트 ─────────────────────────────────────────────────────────────────
function _drawDonut(svgId, legendId, slices, total) {
  const W = 180, H = 180, R = 78, r = 50;
  const el = document.getElementById(svgId);
  if (!el || !slices.length) return;

  const pie      = d3.pie().sort(null).value(d => d.value);
  const arc      = d3.arc().outerRadius(R).innerRadius(r);
  const arcHover = d3.arc().outerRadius(R + 6).innerRadius(r);
  const tooltip  = document.getElementById('pt-chart-tooltip');

  const svg = d3.select(el).append('svg')
    .attr('width', W).attr('height', H)
    .append('g').attr('transform', `translate(${W / 2},${H / 2})`);

  svg.selectAll('path')
    .data(pie(slices))
    .enter().append('path')
    .attr('d', arc)
    .attr('fill', d => d.data.color)
    .attr('stroke', '#0d1117')
    .attr('stroke-width', 1.5)
    .on('mouseover', function(event, d) {
      d3.select(this).attr('d', arcHover);
      const pct = total > 0 ? (d.data.value / total * 100).toFixed(1) : '0';
      if (!tooltip) return;
      tooltip.style.display = 'block';
      tooltip.innerHTML = `<strong>${d.data.label}</strong><br>
        $${d.data.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}<br>
        <span style="color:#8b949e">${pct}%</span>`;
    })
    .on('mousemove', event => {
      if (!tooltip) return;
      const pad = 12;
      let x = event.clientX + pad, y = event.clientY + pad;
      if (x + tooltip.offsetWidth  > window.innerWidth  - 8) x = event.clientX - tooltip.offsetWidth  - pad;
      if (y + tooltip.offsetHeight > window.innerHeight - 8) y = event.clientY - tooltip.offsetHeight - pad;
      tooltip.style.left = x + 'px';
      tooltip.style.top  = y + 'px';
    })
    .on('mouseout', function() {
      d3.select(this).attr('d', arc);
      if (tooltip) tooltip.style.display = 'none';
    });

  // 범례
  const leg = document.getElementById(legendId);
  if (!leg) return;
  leg.innerHTML = slices.map(s => {
    const pct = total > 0 ? (s.value / total * 100).toFixed(1) : '0';
    return `<div class="pt-leg-item">
      <span class="pt-leg-dot" style="background:${s.color}"></span>
      <span class="pt-leg-label">${s.label}</span>
      <span class="pt-leg-pct">${pct}%</span>
    </div>`;
  }).join('');
}

function _renderCharts(rows, totalValue) {
  const valued = rows.filter(r => r.value != null && r.value > 0);
  if (!valued.length) return;

  // 섹터 집계
  const sectorMap = {};
  valued.forEach(r => {
    const sec = (r.stock && r.stock.sector) || 'Other';
    sectorMap[sec] = (sectorMap[sec] || 0) + r.value;
  });
  const sectorSlices = Object.entries(sectorMap)
    .map(([label, value]) => ({ label, value, color: _SECTOR_COLORS[label] || _SECTOR_COLORS['Other'] }))
    .sort((a, b) => b.value - a.value);

  // 종목별 비중 (상위 8 + Others)
  const sorted = [...valued].sort((a, b) => (b.value || 0) - (a.value || 0));
  const holdingSlices = sorted.slice(0, 8).map((r, i) => ({
    label: r.ticker,
    value: r.value,
    color: _HOLDING_COLORS[i % _HOLDING_COLORS.length],
  }));
  const rest = sorted.slice(8);
  if (rest.length) {
    holdingSlices.push({
      label: 'Others',
      value: rest.reduce((s, r) => s + (r.value || 0), 0),
      color: '#8b949e',
    });
  }

  _drawDonut('pt-sector-donut',  'pt-sector-legend',  sectorSlices,  totalValue);
  _drawDonut('pt-holding-donut', 'pt-holding-legend', holdingSlices, totalValue);
  _drawIndexSectorDonut();
  _drawReturnChart(rows);
}

// 10번: 지수(US 전종목 시총가중 근사) 섹터 비중 — 실제 S&P500 공식 가중치 소스가 없어
// 보유 유니버스 시가총액 합으로 근사한다(Russell 2000과 동일한 제약, [[project-remote-access]] 무관).
function _drawIndexSectorDonut() {
  const universe = window._scStocks || [];
  if (!universe.length) return;
  const capMap = {};
  let totalCap = 0;
  universe.forEach(s => {
    if (typeof _isAbnormalListing === 'function' && _isAbnormalListing(s)) return;
    if (!s.market_cap) return;
    const sec = s.sector || 'Other';
    capMap[sec] = (capMap[sec] || 0) + s.market_cap;
    totalCap += s.market_cap;
  });
  const slices = Object.entries(capMap)
    .map(([label, value]) => ({ label, value, color: _SECTOR_COLORS[label] || _SECTOR_COLORS['Other'] }))
    .sort((a, b) => b.value - a.value);
  _drawDonut('pt-index-sector-donut', 'pt-index-sector-legend', slices, totalCap);
}

function _drawReturnChart(rows) {
  const el = document.getElementById('pt-return-chart');
  if (!el) return;
  const data = rows
    .filter(r => r.pnlPct != null)
    .sort((a, b) => b.pnlPct - a.pnlPct);
  if (!data.length) { el.innerHTML = '<span style="color:var(--muted);font-size:12px">데이터 없음</span>'; return; }

  const maxAbs = Math.max(...data.map(r => Math.abs(r.pnlPct)), 0.01);
  const BAR_H  = 22;
  const GAP    = 4;
  const LABEL_W = 48;
  const VALUE_W = 46;
  const W = el.clientWidth || 280;
  const barW = W - LABEL_W - VALUE_W - 4;
  const H = data.length * (BAR_H + GAP);

  const bars = data.map((r, i) => {
    const pct    = r.pnlPct;
    const color  = pct >= 0 ? 'var(--green)' : 'var(--red)';
    const w      = Math.round(Math.abs(pct) / maxAbs * (barW / 2));
    const xBase  = LABEL_W + barW / 2;
    const x      = pct >= 0 ? xBase : xBase - w;
    const y      = i * (BAR_H + GAP);
    const sign   = pct >= 0 ? '+' : '';
    return `
      <text x="${LABEL_W - 4}" y="${y + BAR_H * 0.72}" text-anchor="end" font-size="11" fill="var(--text)">${r.ticker}</text>
      <rect x="${x}" y="${y}" width="${w || 1}" height="${BAR_H}" rx="2" fill="${color}" opacity="0.85"/>
      <line x1="${xBase}" y1="${y}" x2="${xBase}" y2="${y + BAR_H}" stroke="var(--border)" stroke-width="1"/>
      <text x="${LABEL_W + barW + 4}" y="${y + BAR_H * 0.72}" font-size="11" fill="${color}">${sign}${pct.toFixed(1)}%</text>`;
  }).join('');

  el.innerHTML = `<svg width="${W}" height="${H}" style="overflow:visible">
    <line x1="${LABEL_W + barW/2}" y1="0" x2="${LABEL_W + barW/2}" y2="${H}" stroke="var(--border)" stroke-width="1"/>
    ${bars}
  </svg>`;
}

// ── 포트폴리오 평가액 히스토리 ────────────────────────────────────────────────
const _PT_HISTORY_KEY = 'pt_history';
const _PT_HISTORY_MAX = 200;

function _recordPtSnapshot(totalValue) {
  let history = [];
  try { history = JSON.parse(localStorage.getItem(_PT_HISTORY_KEY)) || []; } catch {}
  const now = Date.now();
  // 마지막 스냅샷과 5분 이상 간격이 있을 때만 저장 (너무 잦은 기록 방지)
  const last = history[history.length - 1];
  if (last && now - last.ts < 5 * 60 * 1000) {
    last.v = totalValue; // 같은 시간대면 값만 갱신
  } else {
    history.push({ ts: now, v: totalValue });
  }
  if (history.length > _PT_HISTORY_MAX) history.splice(0, history.length - _PT_HISTORY_MAX);
  localStorage.setItem(_PT_HISTORY_KEY, JSON.stringify(history));
}

function _drawHistoryChart() {
  const el = document.getElementById('pt-history-chart');
  if (!el) return;
  let history = [];
  try { history = JSON.parse(localStorage.getItem(_PT_HISTORY_KEY)) || []; } catch {}
  if (history.length < 2) {
    el.innerHTML = '<span class="pt-history-empty">데이터가 쌓이면 차트가 표시됩니다 (방문할 때마다 기록됩니다)</span>';
    return;
  }
  _renderHistorySvg(history, null);
  _loadBenchmarkSeries(history).then(bench => {
    if (bench) _renderHistorySvg(history, bench);
  });
}

// 4번: S&P500 벤치마크 — 실제 지수 % 변동률을 포트폴리오 시작값 기준 달러로 환산해
// 같은 y축에 겹쳐 그린다("이 돈을 S&P500에 넣었으면" 비교). 10분 캐시로 재조회 최소화.
let _ptBenchCache = { ts: 0, closes: null };

async function _loadBenchmarkSeries(history) {
  try {
    if (!_ptBenchCache.closes || Date.now() - _ptBenchCache.ts > 10 * 60 * 1000) {
      // /api/chart/<ticker>는 [{time:'YYYY-MM-DD', open, high, low, close, volume}, ...] 배열 반환
      const rows = await api(`/api/chart/${encodeURIComponent('^GSPC')}?interval=1d&period=2y`);
      const closes = (Array.isArray(rows) ? rows : [])
        .map(r => ({ ts: new Date(r.time).getTime(), close: r.close }))
        .filter(x => x.close != null && !isNaN(x.ts));
      _ptBenchCache = { ts: Date.now(), closes };
    }
    const closes = _ptBenchCache.closes;
    if (!closes || closes.length < 2) return null;

    // 각 스냅샷 시각에 가장 가까운 지수 종가 찾기
    const closeAt = ts => {
      let best = closes[0];
      for (const c of closes) {
        if (c.ts > ts) break;
        best = c;
      }
      return best.close;
    };
    const baseClose = closeAt(history[0].ts);
    if (!baseClose) return null;
    return history.map(d => history[0].v * (closeAt(d.ts) / baseClose));
  } catch (e) {
    console.warn('benchmark series load failed', e);
    return null;
  }
}

function _renderHistorySvg(history, bench) {
  const el = document.getElementById('pt-history-chart');
  if (!el) return;

  const W = el.clientWidth || 600;
  const H = 140;
  const PAD = { t: 12, r: 10, b: 28, l: 58 };
  const iW = W - PAD.l - PAD.r;
  const iH = H - PAD.t - PAD.b;

  const vals = history.map(d => d.v).concat(bench || []);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const vRange = maxV - minV || 1;

  const xScale = i => PAD.l + (i / (history.length - 1)) * iW;
  const yScale = v => PAD.t + iH - ((v - minV) / vRange) * iH;

  // 라인 path
  const points = history.map((d, i) => `${xScale(i)},${yScale(d.v)}`).join(' ');
  const firstX = xScale(0), lastX = xScale(history.length - 1);
  const firstY = yScale(history[0].v), lastY = yScale(history[history.length - 1].v);

  // 영역 채우기
  const areaPath = `M${firstX},${firstY} L${points.split(' ').slice(1).join(' L')} L${lastX},${PAD.t + iH} L${firstX},${PAD.t + iH} Z`;

  // Y축 레이블 (최대/최소/현재)
  const fmt = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const curVal = history[history.length - 1].v;
  const isUp = curVal >= history[0].v;
  const lineColor = isUp ? 'var(--green)' : 'var(--red)';

  // X축 레이블 (첫/마지막 날짜)
  const fmtDate = ts => new Date(ts).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });

  const benchSvg = bench ? (() => {
    const benchPoints = bench.map((v, i) => `${xScale(i)},${yScale(v)}`).join(' ');
    const benchCur = bench[bench.length - 1];
    const benchUp = benchCur >= bench[0];
    return `
    <polyline points="${benchPoints}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4,3"/>
    <text x="${lastX + 4}" y="${yScale(benchCur) + 4}" font-size="10" fill="var(--muted)" font-weight="600">S&amp;P500 ${benchUp ? '+' : ''}${((benchCur/bench[0]-1)*100).toFixed(1)}%</text>`;
  })() : '';

  const legend = bench ? `
    <g font-size="10">
      <rect x="${PAD.l}" y="0" width="10" height="2.5" fill="${lineColor}"/>
      <text x="${PAD.l + 14}" y="4" fill="var(--muted)">포트폴리오</text>
      <rect x="${PAD.l + 70}" y="0" width="10" height="2.5" fill="var(--muted)"/>
      <text x="${PAD.l + 84}" y="4" fill="var(--muted)">S&amp;P500 (동일 원금 가정)</text>
    </g>` : '';

  el.innerHTML = `<svg width="${W}" height="${H}" style="overflow:visible">
    <defs>
      <linearGradient id="pt-hist-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${lineColor}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${lineColor}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${legend}
    <path d="${areaPath}" fill="url(#pt-hist-grad)"/>
    ${benchSvg}
    <polyline points="${points}" fill="none" stroke="${lineColor}" stroke-width="1.5"/>
    <circle cx="${lastX}" cy="${lastY}" r="3" fill="${lineColor}"/>
    <text x="${PAD.l - 4}" y="${PAD.t + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${fmt(maxV)}</text>
    <text x="${PAD.l - 4}" y="${PAD.t + iH + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${fmt(minV)}</text>
    <text x="${lastX + 4}" y="${lastY + 4}" font-size="10" fill="${lineColor}" font-weight="600">${fmt(curVal)}</text>
    <text x="${firstX}" y="${H - 4}" text-anchor="start" font-size="10" fill="var(--muted)">${fmtDate(history[0].ts)}</text>
    <text x="${lastX}" y="${H - 4}" text-anchor="end" font-size="10" fill="var(--muted)">${fmtDate(history[history.length-1].ts)}</text>
    <line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${PAD.t + iH}" stroke="var(--border)" stroke-width="1"/>
    <line x1="${PAD.l}" y1="${PAD.t + iH}" x2="${PAD.l + iW}" y2="${PAD.t + iH}" stroke="var(--border)" stroke-width="1"/>
  </svg>`;
}

// ── 포트폴리오 탭 진입 ────────────────────────────────────────────────────────
let _ptRefreshTimer = null;

function initPortfolio() {
  renderPortfolio();
  // WebSocket으로 갱신하므로 polling 불필요 (WebSocket 미연결 시 폴백)
  if (typeof io === 'undefined') _startPtRefresh();
  _updatePtCount();
}

function stopPortfolioRefresh() {
  if (_ptRefreshTimer) { clearInterval(_ptRefreshTimer); _ptRefreshTimer = null; }
}

function _startPtRefresh() {
  stopPortfolioRefresh();
  _ptRefreshTimer = setInterval(() => {
    const view = document.getElementById('view-portfolio');
    if (view && view.classList.contains('active')) renderPortfolio();
  }, 30_000);
}

function _updatePtCount() {
  const cnt = PT.count();
  const badge = document.getElementById('pt-count');
  if (badge) {
    badge.textContent = cnt > 0 ? cnt : '';
    badge.style.display = cnt > 0 ? 'inline-block' : 'none';
  }
}

// ── CSV 내보내기/가져오기 ─────────────────────────────────────────────────────
async function exportPortfolioCSV() {
  const data    = PT.load();
  const tickers = PT.tickers();
  if (!tickers.length) return;

  let priceMap = {};
  try {
    const all = await api('/api/stocks');
    all.forEach(s => { priceMap[s.ticker] = s; });
    for (const t of tickers) {
      if (!priceMap[t]) { try { priceMap[t] = await api(`/api/stock/${t}`); } catch {} }
    }
  } catch {}

  const headers = ['Ticker', 'Qty', 'AvgPrice', 'Name', 'CurrentPrice'];
  const rows = tickers.map(t => {
    const { qty, avgPrice } = data[t];
    const s = priceMap[t] || {};
    return [
      t, qty, avgPrice,
      `"${(s.name || '').replace(/"/g, '""')}"`,
      s.price != null ? s.price : '',
    ].join(',');
  });

  const csv  = [headers.join(','), ...rows].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `portfolio_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function importPortfolioCSV(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text  = String(reader.result).replace(/^﻿/, '');
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (!lines.length) { alert('빈 파일입니다.'); return; }

      const header    = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
      const hasHeader = header.includes('ticker');
      const tIdx      = hasHeader ? header.indexOf('ticker')    : 0;
      const qIdx      = hasHeader ? header.indexOf('qty')       : 1;
      const pIdx      = hasHeader ? header.indexOf('avgprice')  : 2;
      const startIdx  = hasHeader ? 1 : 0;

      if (qIdx === -1 || pIdx === -1) { alert('CSV에 Qty/AvgPrice 컬럼이 필요합니다.'); return; }

      let added = 0;
      for (let i = startIdx; i < lines.length; i++) {
        const cols   = lines[i].split(',');
        const ticker = (cols[tIdx] || '').trim().toUpperCase().replace(/^"|"$/g, '');
        const qty    = parseFloat(cols[qIdx]);
        const price  = parseFloat(cols[pIdx]);
        if (!ticker || !Number.isFinite(qty) || !Number.isFinite(price)) continue;
        PT.set(ticker, qty, price);
        added++;
      }
      alert(`${added}개 종목을 포트폴리오에 반영했습니다.`);
      _updatePtCount();
      renderPortfolio();
    } catch (e) {
      alert('CSV 파일을 읽는 중 오류가 발생했습니다.');
    }
  };
  reader.readAsText(file);
}

// ── 포트폴리오 렌더링 ─────────────────────────────────────────────────────────
async function renderPortfolio() {
  const container = document.getElementById('pt-content');
  if (!container) return;
  const tickers = PT.tickers();

  if (tickers.length === 0) {
    container.innerHTML = `
      <div class="pt-empty">
        <div class="pt-empty-icon">📊</div>
        <div class="pt-empty-text">포트폴리오가 비어 있습니다</div>
        <div class="pt-empty-sub">아래 [+ 종목 추가] 버튼을 눌러 보유 종목을 등록하세요</div>
      </div>`;
    return;
  }

  container.innerHTML = `<div class="pt-loading">데이터 불러오는 중...</div>`;

  // 전체 종목에서 해당 티커 가격 조회
  let priceMap = {};
  let sigMap = {};
  try {
    const [all, sm] = await Promise.all([api('/api/stocks'), loadDailySignalMap()]);
    sigMap = sm;
    all.forEach(s => { priceMap[s.ticker] = s; });
    // API에 없는 종목은 개별 조회
    for (const t of tickers) {
      if (!priceMap[t]) {
        try { priceMap[t] = await api(`/api/stock/${t}`); } catch {}
      }
    }
  } catch {}

  const data = PT.load();
  let totalCost = 0, totalValue = 0;

  const rows = tickers.map(ticker => {
    const { qty, avgPrice } = data[ticker];
    const stock = priceMap[ticker] || {};
    const curPrice = stock.price || null;
    const cost     = qty * avgPrice;
    const value    = curPrice ? qty * curPrice : null;
    const pnl      = value != null ? value - cost : null;
    const pnlPct   = pnl  != null ? (pnl / cost) * 100 : null;

    if (value  != null) totalValue += value;
    totalCost += cost;

    return { ticker, qty, avgPrice, curPrice, cost, value, pnl, pnlPct, stock };
  });

  const totalPnl    = totalValue - totalCost;
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : null;

  // 그룹 필터 탭 구성 (Watchlist와 동일 패턴) — 표에 보여줄 행만 걸러냄, 요약카드·차트는 전체 유지
  const groups = PTG.allGroups(tickers);
  if (!groups.includes(_ptGroupFilter) && _ptGroupFilter !== '전체' && _ptGroupFilter !== '미분류') {
    _ptGroupFilter = '전체';
  }
  const groupTabsHtml = ['전체', ...groups, '미분류'].map(g => {
    const cnt = g === '전체' ? rows.length
      : g === '미분류' ? rows.filter(r => !PTG.get(r.ticker)).length
      : rows.filter(r => PTG.get(r.ticker) === g).length;
    return `<button class="report-tag${g === _ptGroupFilter ? ' active' : ''}" onclick="_ptSelectGroupFilter('${g}')">${g} <span class="wl-group-count">${cnt}</span></button>`;
  }).join('') + `<button class="wl-group-add-btn" onclick="_ptAddGroupPrompt()" title="새 그룹 추가">+ 그룹</button>`;

  const filteredRows = _ptGroupFilter === '전체' ? rows
    : _ptGroupFilter === '미분류' ? rows.filter(r => !PTG.get(r.ticker))
    : rows.filter(r => PTG.get(r.ticker) === _ptGroupFilter);

  const groupOptionsHtml = (current) => ['', ...groups].map(g =>
    `<option value="${g}" ${g === current ? 'selected' : ''}>${g || '(없음)'}</option>`
  ).join('') + `<option value="__new__">+ 새 그룹...</option>`;

  // 요약 카드
  const summaryHtml = `
    <div class="pt-summary">
      <div class="pt-sum-card">
        <div class="pt-sum-label">총 투자금액</div>
        <div class="pt-sum-val">$${totalCost.toLocaleString('en-US', {minimumFractionDigits:2})}</div>
      </div>
      <div class="pt-sum-card">
        <div class="pt-sum-label">현재 평가금액</div>
        <div class="pt-sum-val">$${totalValue > 0 ? totalValue.toLocaleString('en-US', {minimumFractionDigits:2}) : '—'}</div>
      </div>
      <div class="pt-sum-card">
        <div class="pt-sum-label">총 손익</div>
        <div class="pt-sum-val ${_clsPnl(totalPnl)}">${_fmtPnl(totalValue > 0 ? totalPnl : null)}</div>
      </div>
      <div class="pt-sum-card">
        <div class="pt-sum-label">총 수익률</div>
        <div class="pt-sum-val ${_clsPnl(totalPnlPct)}">${_fmtPnlPct(totalValue > 0 ? totalPnlPct : null)}</div>
      </div>
    </div>`;

  // 테이블
  const tableHtml = `
    <div class="table-wrap">
      <table class="pt-table">
        <thead>
          <tr>
            <th></th>
            <th>Ticker</th>
            <th>Name</th>
            <th>Group</th>
            <th>Signal</th>
            <th class="num">수량</th>
            <th class="num">평균단가</th>
            <th class="num">현재가</th>
            <th class="num">손익($)</th>
            <th class="num">수익률(%)</th>
            <th class="num">투자금액</th>
            <th class="num">평가금액</th>
            <th>메모</th>
            <th class="num">목표가</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${filteredRows.map(r => {
            const cls    = _clsPnl(r.pnl);
            const name   = r.stock.name   || r.ticker;
            const nameKo = r.stock.name_ko || '';
            return `
              <tr onclick="navigateToChart('${r.ticker}')">
                <td onclick="event.stopPropagation()" class="sc-check-cell">${_cmpCheckboxHtml('pt', r.ticker)}${starBtn(r.ticker)}</td>
                <td class="td-ticker">${r.ticker}</td>
                <td class="td-name">${name}
                  ${nameKo ? `<span class="td-name-ko">(${nameKo})</span>` : ''}
                </td>
                <td onclick="event.stopPropagation()">
                  <select class="wl-group-select" onchange="_ptOnGroupChange('${r.ticker}', this)">
                    ${groupOptionsHtml(PTG.get(r.ticker))}
                  </select>
                </td>
                <td>${signalBadgeHtml(r.ticker, sigMap)}</td>
                <td class="num">${r.qty.toLocaleString()}</td>
                <td class="num">$${r.avgPrice.toFixed(2)}</td>
                <td class="num">${r.curPrice ? fmt$(r.curPrice) : '—'}</td>
                <td class="num ${cls}">${_fmtPnl(r.pnl)}</td>
                <td class="num ${cls}">${_fmtPnlPct(r.pnlPct)}</td>
                <td class="num">$${r.cost.toLocaleString('en-US',{minimumFractionDigits:2})}</td>
                <td class="num">${r.value != null ? '$' + r.value.toLocaleString('en-US',{minimumFractionDigits:2}) : '—'}</td>
                <td onclick="event.stopPropagation()">
                  <input type="text" class="wl-memo-input" placeholder="메모"
                         value="${_wlEsc(PTN.get(r.ticker).memo)}"
                         onchange="PTN.setMemo('${r.ticker}', this.value.trim())">
                </td>
                <td class="num wl-target-cell" onclick="event.stopPropagation()">
                  <input type="number" step="0.01" class="wl-target-input" placeholder="목표가"
                         value="${PTN.get(r.ticker).target ?? ''}"
                         onchange="PTN.setTarget('${r.ticker}', this.value); renderPortfolio();">
                  ${_wlTargetStatusHtml(r.curPrice, PTN.get(r.ticker).target)}
                </td>
                <td onclick="event.stopPropagation()">
                  <button class="pt-edit-btn" onclick="openPtModal('${r.ticker}', ${r.qty}, ${r.avgPrice})" title="수정">✎</button>
                  <button class="pt-del-btn" onclick="removePtStock('${r.ticker}')" title="삭제">✕</button>
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  const chartsHtml = `
    <div class="pt-charts-area">
      <div class="pt-chart-card">
        <div class="pt-chart-title">섹터 분산</div>
        <div class="pt-chart-inner">
          <div id="pt-sector-donut"></div>
          <div class="pt-legend" id="pt-sector-legend"></div>
        </div>
      </div>
      <div class="pt-chart-card">
        <div class="pt-chart-title">지수 대비 섹터 비중 <span class="pt-approx-badge" title="공식 지수 가중치가 아닌, US 전종목 시가총액 가중 근사치입니다">근사치</span></div>
        <div class="pt-chart-inner">
          <div id="pt-index-sector-donut"></div>
          <div class="pt-legend" id="pt-index-sector-legend"></div>
        </div>
      </div>
      <div class="pt-chart-card">
        <div class="pt-chart-title">종목별 비중</div>
        <div class="pt-chart-inner">
          <div id="pt-holding-donut"></div>
          <div class="pt-legend" id="pt-holding-legend"></div>
        </div>
      </div>
      <div class="pt-chart-card pt-return-card">
        <div class="pt-chart-title">종목별 수익률</div>
        <div id="pt-return-chart" class="pt-return-chart"></div>
      </div>
    </div>
    <div id="pt-chart-tooltip" class="pt-chart-tooltip"></div>
    <div class="pt-history-card">
      <div class="pt-chart-title">포트폴리오 평가액 히스토리</div>
      <div id="pt-history-chart" class="pt-history-chart"></div>
    </div>`;

  const updatedAt = new Date().toLocaleTimeString('ko-KR');
  container.innerHTML = `
    <div class="pt-toolbar">
      <span class="pt-count-label">${tickers.length}개 종목</span>
      <span class="pt-updated">업데이트: ${updatedAt}</span>
    </div>
    ${summaryHtml}
    ${chartsHtml}
    <div id="pt-cmp-bar" class="sc-bulk-bar no-print" style="display:${_cmpSel.pt.size > 0 ? '' : 'none'}">
      <span id="pt-cmp-count" class="sc-bulk-count">${_cmpSel.pt.size}개 선택됨 (2~5개)</span>
      <button class="sc-bulk-add-btn" onclick="_cmpOpenFromScope('pt')">📊 비교차트 보기</button>
      <button class="sc-bulk-clear-btn" onclick="_cmpClear('pt')">선택 해제</button>
    </div>
    <div class="news-filter-bar wl-group-tabs">${groupTabsHtml}</div>
    ${tableHtml}`;

  _renderCharts(rows, totalValue);
  if (totalValue > 0) _recordPtSnapshot(totalValue);
  _drawHistoryChart();
}

// ── 그룹 필터/배정 (Watchlist와 동일 패턴) ─────────────────────────────────────
function _ptSelectGroupFilter(group) {
  _ptGroupFilter = group;
  renderPortfolio();
}

function _ptAddGroupPrompt() {
  const name = prompt('새 그룹 이름을 입력하세요 (예: 성장주, 배당주)');
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  PTG.addGroupName(trimmed);
  _ptGroupFilter = trimmed;
  renderPortfolio();
}

function _ptOnGroupChange(ticker, sel) {
  let value = sel.value;
  if (value === '__new__') {
    const name = prompt('새 그룹 이름을 입력하세요');
    if (!name || !name.trim()) { renderPortfolio(); return; }
    value = name.trim();
  }
  PTG.set(ticker, value);
  renderPortfolio();
}

// ── 종목 삭제 ─────────────────────────────────────────────────────────────────
function removePtStock(ticker) {
  if (!confirm(`${ticker}을(를) 포트폴리오에서 삭제하시겠습니까?`)) return;
  PT.remove(ticker);
  _updatePtCount();
  renderPortfolio();
}

// ── 종목 추가/수정 모달 ────────────────────────────────────────────────────────
function openPtModal(ticker = '', qty = '', avgPrice = '') {
  const modal = document.getElementById('pt-modal');
  const t     = document.getElementById('pt-modal-ticker');
  const q     = document.getElementById('pt-modal-qty');
  const p     = document.getElementById('pt-modal-price');

  t.value = ticker;
  t.disabled = !!ticker;   // 수정 시 티커 변경 불가
  q.value = qty;
  p.value = avgPrice;

  modal.style.display = 'flex';
  (ticker ? q : t).focus();
}

function closePtModal() {
  document.getElementById('pt-modal').style.display = 'none';
}

function savePtModal() {
  const ticker   = document.getElementById('pt-modal-ticker').value.trim().toUpperCase();
  const qty      = parseFloat(document.getElementById('pt-modal-qty').value);
  const avgPrice = parseFloat(document.getElementById('pt-modal-price').value);

  if (!ticker)          { alert('종목 티커를 입력하세요 (예: AAPL)'); return; }
  if (!qty || qty <= 0) { alert('수량을 올바르게 입력하세요'); return; }
  if (!avgPrice || avgPrice <= 0) { alert('평균단가를 올바르게 입력하세요'); return; }

  PT.set(ticker, qty, avgPrice);
  _updatePtCount();
  closePtModal();
  renderPortfolio();
}

// ESC 키로 모달 닫기
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closePtModal();
});
