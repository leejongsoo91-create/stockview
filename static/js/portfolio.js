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
  },

  tickers() { return Object.keys(this.load()); },
  count()   { return this.tickers().length; },
};

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
  try {
    const all = await api('/api/stocks');
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
            <th class="num">수량</th>
            <th class="num">평균단가</th>
            <th class="num">현재가</th>
            <th class="num">손익($)</th>
            <th class="num">수익률(%)</th>
            <th class="num">투자금액</th>
            <th class="num">평가금액</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => {
            const cls    = _clsPnl(r.pnl);
            const name   = r.stock.name   || r.ticker;
            const nameKo = r.stock.name_ko || '';
            return `
              <tr onclick="navigateToChart('${r.ticker}')">
                <td onclick="event.stopPropagation()">${starBtn(r.ticker)}</td>
                <td class="td-ticker">${r.ticker}</td>
                <td class="td-name">${name}
                  ${nameKo ? `<span class="td-name-ko">(${nameKo})</span>` : ''}
                </td>
                <td class="num">${r.qty.toLocaleString()}</td>
                <td class="num">$${r.avgPrice.toFixed(2)}</td>
                <td class="num">${r.curPrice ? fmt$(r.curPrice) : '—'}</td>
                <td class="num ${cls}">${_fmtPnl(r.pnl)}</td>
                <td class="num ${cls}">${_fmtPnlPct(r.pnlPct)}</td>
                <td class="num">$${r.cost.toLocaleString('en-US',{minimumFractionDigits:2})}</td>
                <td class="num">${r.value != null ? '$' + r.value.toLocaleString('en-US',{minimumFractionDigits:2}) : '—'}</td>
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
        <div class="pt-chart-title">종목별 비중</div>
        <div class="pt-chart-inner">
          <div id="pt-holding-donut"></div>
          <div class="pt-legend" id="pt-holding-legend"></div>
        </div>
      </div>
    </div>
    <div id="pt-chart-tooltip" class="pt-chart-tooltip"></div>`;

  const updatedAt = new Date().toLocaleTimeString('ko-KR');
  container.innerHTML = `
    <div class="pt-toolbar">
      <span class="pt-count-label">${tickers.length}개 종목</span>
      <span class="pt-updated">업데이트: ${updatedAt}</span>
    </div>
    ${summaryHtml}
    ${chartsHtml}
    ${tableHtml}`;

  _renderCharts(rows, totalValue);
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
