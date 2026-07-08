/* ═══════════════════════════════════════════════════════════════
   heatmap.js — D3 트리맵 히트맵 (sector → industry → stock)
   ═══════════════════════════════════════════════════════════════ */

let _hmStocks   = [];
let _hmTopN     = 500;
let _hmIndex    = 'all';
let _hmPeriod   = '1d';
let _hmPerfData = {};   // { '1w': {ticker: perf_pct}, '1m': {ticker: perf_pct} }
let _hmMembers  = {};
let _hmMarket   = 'us';  // 'us' | 'kr'
let _krHmStocks = [];
let _krHmFilter = 'all'; // 'all' | 'kospi200' | 'kosdaq150'
let _krHmPeriod   = '1d';
let _krHmPerfData = {};  // { '1w': {ticker: perf_pct}, '1m': {ticker: perf_pct} }

const _colorScale = d3.scaleLinear()
  .domain([-5, -2, -0.5, 0, 0.5, 2, 5])
  .range(['#7f1d1d','#b91c1c','#dc2626','#374151','#16a34a','#15803d','#14532d'])
  .clamp(true);

async function initHeatmap() {
  const [stocks, members] = await Promise.all([
    api('/api/stocks'),
    api('/api/index-members'),
  ]);
  _hmStocks  = stocks;
  _hmMembers = {
    sp500:       new Set(members.sp500),
    nasdaq100:   new Set(members.nasdaq100),
    dow30:       new Set(members.dow30),
    russell2000: new Set(members.russell2000),
  };

  // 시장 탭 (US / KR)
  document.querySelectorAll('.hm-mkt-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.hm-mkt-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _hmMarket = btn.dataset.hmmarket;
      const usIndexBar = document.getElementById('hm-index-bar');
      const krIndexBar = document.getElementById('hm-kr-index-bar');
      const toolbar    = document.querySelector('.heatmap-toolbar');
      if (_hmMarket === 'kr') {
        if (usIndexBar) usIndexBar.style.display = 'none';
        if (krIndexBar) krIndexBar.style.display = '';
        if (toolbar)    toolbar.style.display    = 'none';
        if (!_krHmStocks.length) {
          document.getElementById('heatmap-container').innerHTML =
            '<div style="text-align:center;padding:80px;color:var(--muted)">🇰🇷 국내주식 로딩 중…</div>';
          _krHmStocks = await api('/api/kr-stocks');
        }
        renderKrHeatmap();
      } else {
        if (usIndexBar) usIndexBar.style.display = '';
        if (krIndexBar) krIndexBar.style.display = 'none';
        if (toolbar)    toolbar.style.display    = '';
        renderHeatmap();
      }
    });
  });

  // KR 인덱스 탭 (전체 / KOSPI 200 / KOSDAQ 150)
  document.querySelectorAll('.hm-kr-idx-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.hm-kr-idx-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _krHmFilter = btn.dataset.krindex;
      renderKrHeatmap();
    });
  });

  // KR 기간 버튼 (1D / 1W / 1M)
  document.querySelectorAll('.hm-kr-period-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const p = btn.dataset.period;
      if (p === _krHmPeriod) return;
      document.querySelectorAll('.hm-kr-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _krHmPeriod = p;
      if (p !== '1d' && !_krHmPerfData[p]) {
        const countEl = document.getElementById('hm-kr-count-label');
        const prevText = countEl ? countEl.textContent : '';
        if (countEl) countEl.textContent = '수익률 로딩 중…';
        try {
          _krHmPerfData[p] = await api(`/api/heatmap-perf?period=${p}&market=kr`);
        } catch (e) {
          _krHmPerfData[p] = {};
        }
        if (countEl) countEl.textContent = prevText;
      }
      renderKrHeatmap();
    });
  });

  renderHeatmap();

  // 인덱스 탭
  document.querySelectorAll('.hm-idx-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.hm-idx-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _hmIndex = btn.dataset.index;
      renderHeatmap();
    });
  });

  // Top N 필터
  document.querySelectorAll('.hm-top-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.hm-top-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _hmTopN = parseInt(btn.dataset.top) || 0;
      renderHeatmap();
    });
  });

  // 기간 버튼 (1D / 1W / 1M)
  document.querySelectorAll('.hm-period-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const p = btn.dataset.period;
      if (p === _hmPeriod) return;
      document.querySelectorAll('.hm-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _hmPeriod = p;
      if (p !== '1d' && !_hmPerfData[p]) {
        const countEl = document.getElementById('hm-count-label');
        const prevText = countEl ? countEl.textContent : '';
        if (countEl) countEl.textContent = '수익률 로딩 중…';
        try {
          _hmPerfData[p] = await api(`/api/heatmap-perf?period=${p}`);
        } catch (e) {
          _hmPerfData[p] = {};
        }
        if (countEl) countEl.textContent = prevText;
      }
      renderHeatmap();
    });
  });

  // 리사이즈
  let _resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (document.getElementById('view-heatmap').classList.contains('active')) {
        if (_hmMarket === 'kr') renderKrHeatmap(); else renderHeatmap();
      }
    }, 200);
  });
}

function renderHeatmap() {
  const container = document.getElementById('heatmap-container');
  container.innerHTML = '';

  const W = container.clientWidth || window.innerWidth - 40;
  const H = Math.max(window.innerHeight - 240, 480);

  // 1) 인덱스 필터
  const pool = _hmIndex === 'all'
    ? _hmStocks
    : _hmStocks.filter(s => (_hmMembers[_hmIndex] || new Set()).has(s.ticker));

  // 2) 중복 클래스 주식 제거 (우선주·중복 클래스는 GOOGL/주요 클래스로 대표)
  const _HM_EXCLUDE = new Set(['GOOG', 'GOOGM', 'GOOGN', 'BRK.A', 'BF.A', 'BF.B', 'NWS', 'FOXA']);

  // 3) Top N 필터
  const sorted  = [...pool]
    .filter(s => !_HM_EXCLUDE.has(s.ticker))
    .sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0));
  const visible = (_hmTopN > 0 ? sorted.slice(0, _hmTopN) : sorted)
    .filter(s => s.price > 0);

  const countEl = document.getElementById('hm-count-label');
  if (countEl) countEl.textContent = visible.length + '개 종목';

  // 기간별 등락률 오버레이 (1W/1M 선택 시 perf_pct로 교체)
  const perfMap = _hmPeriod !== '1d' ? (_hmPerfData[_hmPeriod] || {}) : {};
  const displayStocks = _hmPeriod === '1d'
    ? visible
    : visible.map(s => ({
        ...s,
        change_pct: perfMap[s.ticker] !== undefined ? perfMap[s.ticker] : s.change_pct,
      }));

  // 3) sector → industry → stock 3단계 그룹핑
  const sectorMap = d3.group(displayStocks, d => d.sector || 'Other');
  const hierarchyData = {
    name: 'root',
    children: Array.from(sectorMap, ([sector, stocks]) => {
      const industryMap = d3.group(stocks, d => d.industry || sector);
      return {
        name: sector,
        children: Array.from(industryMap, ([ind, indStocks]) => ({
          name:     ind,
          sector:   sector,
          children: indStocks,
        })).filter(g => g.children.length > 0),
      };
    }).filter(g => g.children.length > 0),
  };

  const root = d3.hierarchy(hierarchyData)
    .sum(d => Math.max(d.market_cap || 0, 5))
    .sort((a, b) => b.value - a.value);

  d3.treemap()
    .size([W, H])
    .paddingOuter(3)
    .paddingTop(22)
    .paddingInner(1)
    (root);

  const svg = d3.select('#heatmap-container')
    .append('svg')
    .attr('width', W)
    .attr('height', H)
    .style('display', 'block');

  const defs = svg.append('defs');
  const tooltip = document.getElementById('heatmap-tooltip');

  // 평균 등락률 → 반투명 배경색
  function _avgFill(avgChg, alpha) {
    if (avgChg >=  0.5) return `rgba(22,163,74,${alpha})`;
    if (avgChg >=  0.1) return `rgba(22,163,74,${alpha * 0.55})`;
    if (avgChg <= -0.5) return `rgba(185,28,28,${alpha})`;
    if (avgChg <= -0.1) return `rgba(185,28,28,${alpha * 0.55})`;
    return `rgba(55,65,81,${alpha})`;
  }

  // 상위 상승/하락 종목 행 HTML
  function _topRows(leaves, n) {
    const sorted = [...leaves].sort((a, b) => (b.data.change_pct || 0) - (a.data.change_pct || 0));
    const gainers = sorted.slice(0, n).filter(d => (d.data.change_pct || 0) > 0);
    const losers  = sorted.slice(-n).reverse().filter(d => (d.data.change_pct || 0) < 0);
    const row = (d, isUp) => {
      const pct = d.data.change_pct || 0;
      const col = isUp ? '#4ade80' : '#f87171';
      return `<div style="display:flex;justify-content:space-between;gap:14px;margin:1px 0">
        <span style="color:#93c5fd;font-size:11px;font-weight:600">${d.data.ticker}</span>
        <span style="color:${col};font-size:11px;font-weight:700">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>
      </div>`;
    };
    let html = '';
    if (gainers.length) {
      html += `<div style="margin-top:6px;border-top:1px solid #30363d;padding-top:5px">
        <div style="color:#4ade80;font-size:10px;font-weight:600;margin-bottom:2px">▲ 상승</div>
        ${gainers.map(d => row(d, true)).join('')}</div>`;
    }
    if (losers.length) {
      html += `<div style="margin-top:5px;border-top:1px solid #30363d;padding-top:5px">
        <div style="color:#f87171;font-size:10px;font-weight:600;margin-bottom:2px">▼ 하락</div>
        ${losers.map(d => row(d, false)).join('')}</div>`;
    }
    return html;
  }

  // ── 섹터 레이어 (depth=1) ─────────────────────────────────────────────────
  const sectorNodes = root.children || [];

  sectorNodes.forEach(sector => {
    const sw = sector.x1 - sector.x0;
    const sh = sector.y1 - sector.y0;

    // 섹터 통계 미리 계산
    const sLeaves   = sector.leaves();
    const sCount    = sLeaves.length;
    const sAvgChg   = sLeaves.reduce((s, d) => s + (d.data.change_pct || 0), 0) / (sCount || 1);
    const sPosCount = sLeaves.filter(d => (d.data.change_pct || 0) >= 0).length;
    const sNegCount = sCount - sPosCount;
    const sTotalCap = sLeaves.reduce((s, d) => s + (d.data.market_cap || 0), 0);

    const sectorG = svg.append('g')
      .attr('class', 'sector-group')
      .attr('transform', `translate(${sector.x0},${sector.y0})`);

    sectorG.append('rect')
      .attr('width',  sw)
      .attr('height', sh)
      .attr('fill',   _avgFill(sAvgChg, 0.13))   // 항상 연한 배경색
      .attr('stroke', 'transparent')
      .attr('stroke-width', 2)
      .attr('rx', 4)
      .style('cursor', 'default')
      .on('mouseover', function(event) {
        d3.select(this)
          .attr('fill',   _avgFill(sAvgChg, 0.30))
          .attr('stroke', 'rgba(255,255,255,0.80)')
          .attr('stroke-width', 2);

        tooltip.style.display = 'block';
        tooltip.innerHTML = `
          <strong style="font-size:14px;color:#fff">${sector.data.name}</strong><br>
          <span style="color:${sAvgChg >= 0 ? '#4ade80' : '#f87171'};font-size:16px;font-weight:700">
            ${sAvgChg >= 0 ? '+' : ''}${sAvgChg.toFixed(2)}%
          </span>
          <span style="color:#8b949e;font-size:11px;margin-left:6px">섹터 평균</span><br>
          <div style="margin-top:5px;font-size:12px">
            <span style="color:#4ade80">▲ ${sPosCount}개</span>&nbsp;
            <span style="color:#f87171">▼ ${sNegCount}개</span>&nbsp;·&nbsp;
            <span style="color:#8b949e">${fmtCap(sTotalCap)}</span>
          </div>
          <div style="font-size:10px;color:#6e7681;margin-top:2px">
            업종 ${sector.children ? sector.children.length : 1}개 · 종목 ${sCount}개
          </div>
          ${_topRows(sLeaves, 3)}
        `;
      })
      .on('mousemove', event => {
        const pad = 12;
        let x = event.clientX + pad;
        let y = event.clientY + pad;
        const tw = tooltip.offsetWidth;
        const th = tooltip.offsetHeight;
        if (x + tw > window.innerWidth  - 8) x = event.clientX - tw - pad;
        if (y + th > window.innerHeight - 8) y = event.clientY - th - pad;
        tooltip.style.left = x + 'px';
        tooltip.style.top  = y + 'px';
      })
      .on('mouseout', function() {
        d3.select(this)
          .attr('fill',   _avgFill(sAvgChg, 0.13))
          .attr('stroke', 'transparent');
        tooltip.style.display = 'none';
      });

    // 섹터 레이블
    sectorG.append('text')
      .attr('x', 5)
      .attr('y', 15)
      .attr('fill', '#8b949e')
      .attr('font-size', '11px')
      .attr('font-weight', '700')
      .attr('pointer-events', 'none')
      .text(sector.data.name.toUpperCase());
  });

  // ── 업종(industry) 레이어 (depth=2) ──────────────────────────────────────
  const industryNodes = root.descendants().filter(d => d.depth === 2);

  industryNodes.forEach(ind => {
    const iw = ind.x1 - ind.x0;
    const ih = ind.y1 - ind.y0;
    if (iw < 30 || ih < 18) return;

    const indG = svg.append('g')
      .attr('class', 'industry-group')
      .attr('transform', `translate(${ind.x0},${ind.y0})`);

    // 업종 통계 미리 계산
    const iLeaves   = ind.leaves();
    const iCount    = iLeaves.length;
    const iAvgChg   = iLeaves.reduce((s, d) => s + (d.data.change_pct || 0), 0) / (iCount || 1);
    const iPosCount = iLeaves.filter(d => (d.data.change_pct || 0) >= 0).length;
    const iNegCount = iCount - iPosCount;
    const iTotalCap = iLeaves.reduce((s, d) => s + (d.data.market_cap || 0), 0);

    // 업종 배경 rect
    indG.append('rect')
      .attr('width',  iw)
      .attr('height', ih)
      .attr('fill',   _avgFill(iAvgChg, 0.10))   // 항상 연한 배경색
      .attr('stroke', 'transparent')
      .attr('stroke-width', 1.5)
      .attr('rx', 3)
      .style('cursor', 'default')
      .on('mouseover', function(event) {
        event.stopPropagation();
        d3.select(this)
          .attr('fill',   _avgFill(iAvgChg, 0.28))
          .attr('stroke', 'rgba(255,255,255,0.60)')
          .attr('stroke-width', 1.5);

        tooltip.style.display = 'block';
        tooltip.innerHTML = `
          <strong style="font-size:13px;color:#fff">${ind.data.name}</strong>
          <span style="color:#6e7681;font-size:11px;margin-left:4px">${ind.data.sector}</span><br>
          <span style="color:${iAvgChg >= 0 ? '#4ade80' : '#f87171'};font-size:15px;font-weight:700">
            ${iAvgChg >= 0 ? '+' : ''}${iAvgChg.toFixed(2)}%
          </span>
          <span style="color:#8b949e;font-size:11px;margin-left:6px">업종 평균</span><br>
          <div style="margin-top:4px;font-size:12px">
            <span style="color:#4ade80">▲ ${iPosCount}개</span>&nbsp;
            <span style="color:#f87171">▼ ${iNegCount}개</span>&nbsp;·&nbsp;
            <span style="color:#8b949e">${fmtCap(iTotalCap)}</span>
          </div>
          <div style="font-size:10px;color:#6e7681;margin-top:2px">종목 ${iCount}개</div>
          ${_topRows(iLeaves, 4)}
        `;
      })
      .on('mousemove', event => {
        event.stopPropagation();
        const pad = 12;
        let x = event.clientX + pad;
        let y = event.clientY + pad;
        const tw = tooltip.offsetWidth;
        const th = tooltip.offsetHeight;
        if (x + tw > window.innerWidth  - 8) x = event.clientX - tw - pad;
        if (y + th > window.innerHeight - 8) y = event.clientY - th - pad;
        tooltip.style.left = x + 'px';
        tooltip.style.top  = y + 'px';
      })
      .on('mouseout', function(event) {
        event.stopPropagation();
        d3.select(this)
          .attr('fill',   _avgFill(iAvgChg, 0.10))
          .attr('stroke', 'transparent');
        tooltip.style.display = 'none';
      });

    // 업종 레이블: 충분히 크고, 섹터 헤더(상단 22px)와 겹치지 않는 위치일 때만
    const distFromSectorTop = ind.y0 - ind.parent.y0;
    if (iw >= 60 && ih >= 24 && distFromSectorTop >= 20) {
      indG.append('text')
        .attr('x', 4)
        .attr('y', 14)
        .attr('fill', 'rgba(255,255,255,0.45)')
        .attr('font-size', '10px')
        .attr('font-weight', '600')
        .attr('pointer-events', 'none')
        .text(ind.data.name);
    }
  });

  // ── 종목 셀 (depth=3 / leaves) ────────────────────────────────────────────
  const leaf = svg.selectAll('g.cell')
    .data(root.leaves())
    .enter()
    .append('g')
    .attr('class', 'cell')
    .attr('transform', d => `translate(${d.x0},${d.y0})`);

  leaf.append('rect')
    .attr('width',  d => Math.max(0, d.x1 - d.x0))
    .attr('height', d => Math.max(0, d.y1 - d.y0))
    .attr('fill',   d => _colorScale(d.data.change_pct))
    .attr('rx', 2)
    .attr('stroke', '#0d1117')
    .attr('stroke-width', 1)
    .style('cursor', 'pointer')
    .on('mouseover', (event, d) => {
      event.stopPropagation();
      const pct = d.data.change_pct;
      const periodLabel = _hmPeriod === '1w' ? '1W' : _hmPeriod === '1m' ? '1M' : '1D';
      tooltip.style.display = 'block';
      tooltip.innerHTML = `
        <strong style="font-size:14px">${d.data.ticker}</strong>
        <span style="color:#8b949e;margin-left:6px;font-size:12px">${d.data.name}</span><br>
        ${d.data.name_ko ? `<span style="color:#6e7681;font-size:11px">${d.data.name_ko}</span><br>` : ''}
        Price: <strong>${fmt$(d.data.price)}</strong>&nbsp;
        <strong class="${pct >= 0 ? 'up' : 'down'}">${fmtPct(pct)}</strong>
        <span style="color:#6e7681;font-size:10px;margin-left:4px">(${periodLabel})</span><br>
        <span style="color:#8b949e;font-size:11px">${d.data.industry || d.data.sector} · ${fmtCap(d.data.market_cap)}</span>
      `;
    })
    .on('mousemove', (event, d) => {
      event.stopPropagation();
      const pad = 12;
      let x = event.clientX + pad;
      let y = event.clientY + pad;
      const tw = tooltip.offsetWidth;
      const th = tooltip.offsetHeight;
      if (x + tw > window.innerWidth  - 8) x = event.clientX - tw - pad;
      if (y + th > window.innerHeight - 8) y = event.clientY - th - pad;
      tooltip.style.left = x + 'px';
      tooltip.style.top  = y + 'px';
    })
    .on('mouseout', (event) => {
      event.stopPropagation();
      tooltip.style.display = 'none';
    })
    .on('click', (event, d) => {
      if (typeof openStockModal === 'function' && window._scStocks && window._scStocks.length)
        openStockModal(d.data.ticker);
      else
        navigateToChart(d.data.ticker);
    });

  // ── 셀 텍스트 ────────────────────────────────────────────────────────────
  leaf.each(function(d) {
    const cw = d.x1 - d.x0;
    const ch = d.y1 - d.y0;
    const g  = d3.select(this);
    if (cw < 14 || ch < 10) return;

    const clipId = 'clip-' + d.data.ticker.replace(/[^a-zA-Z0-9]/g, '_');
    defs.append('clipPath').attr('id', clipId)
      .append('rect').attr('x', 1).attr('y', 1)
      .attr('width', Math.max(0, cw - 2))
      .attr('height', Math.max(0, ch - 2));

    const tickerSize = Math.min(13, Math.max(7, cw / 5));
    const pctSize    = Math.min(11, Math.max(7, cw / 6));
    const showPct    = ch >= 30 && cw >= 28;

    g.append('text')
      .attr('x', cw / 2).attr('y', showPct ? ch / 2 - 7 : ch / 2 + 1)
      .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
      .attr('fill', 'rgba(255,255,255,.95)')
      .attr('font-size', tickerSize + 'px').attr('font-weight', '700')
      .attr('pointer-events', 'none')
      .attr('clip-path', 'url(#' + clipId + ')')
      .text(d.data.ticker);

    if (showPct) {
      g.append('text')
        .attr('x', cw / 2).attr('y', ch / 2 + 9)
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
        .attr('fill', 'rgba(255,255,255,.80)')
        .attr('font-size', pctSize + 'px')
        .attr('pointer-events', 'none')
        .attr('clip-path', 'url(#' + clipId + ')')
        .text(fmtPct(d.data.change_pct));
    }
  });
}

// ══════════════════════════════════════════════════════════════════
// KR 히트맵 (4-70) — 시장(KOSPI/KOSDAQ) → 업종 → 종목 3단계 트리맵
// ══════════════════════════════════════════════════════════════════
function renderKrHeatmap() {
  const container = document.getElementById('heatmap-container');
  container.innerHTML = '';

  const W = container.clientWidth || window.innerWidth - 40;
  const H = Math.max(window.innerHeight - 240, 480);

  const allStocks = _krHmStocks.filter(s => s.market_cap > 0 && s.price > 0);
  if (!allStocks.length) {
    container.innerHTML = '<div style="text-align:center;padding:80px;color:var(--muted)">데이터 없음</div>';
    return;
  }

  // 인덱스 필터 적용
  let stocks;
  if (_krHmFilter === 'kospi') {
    stocks = allStocks.filter(s => s.market === 'KOSPI');
  } else if (_krHmFilter === 'kosdaq') {
    stocks = allStocks.filter(s => s.market === 'KOSDAQ');
  } else if (_krHmFilter === 'kospi200') {
    stocks = [...allStocks]
      .filter(s => s.market === 'KOSPI')
      .sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0))
      .slice(0, 200);
  } else if (_krHmFilter === 'kosdaq150') {
    stocks = [...allStocks]
      .filter(s => s.market === 'KOSDAQ')
      .sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0))
      .slice(0, 150);
  } else {
    stocks = allStocks;
  }

  // 기간별 등락률 오버레이 (1W/1M 선택 시 perf_pct로 교체)
  if (_krHmPeriod !== '1d') {
    const krPerfMap = _krHmPerfData[_krHmPeriod] || {};
    stocks = stocks.map(s => ({
      ...s,
      change_pct: krPerfMap[s.ticker] !== undefined ? krPerfMap[s.ticker] : s.change_pct,
    }));
  }

  const countEl = document.getElementById('hm-kr-count-label');
  if (countEl) {
    if (_krHmFilter === 'kospi') {
      countEl.textContent = `KOSPI ${stocks.length}개`;
    } else if (_krHmFilter === 'kosdaq') {
      countEl.textContent = `KOSDAQ ${stocks.length}개`;
    } else if (_krHmFilter === 'kospi200') {
      countEl.textContent = `KOSPI 200 (시총 상위 ${stocks.length}개)`;
    } else if (_krHmFilter === 'kosdaq150') {
      countEl.textContent = `KOSDAQ 150 (시총 상위 ${stocks.length}개)`;
    } else {
      const kospi  = stocks.filter(s => s.market === 'KOSPI').length;
      const kosdaq = stocks.filter(s => s.market === 'KOSDAQ').length;
      countEl.textContent = `KOSPI ${kospi}개 · KOSDAQ ${kosdaq}개`;
    }
  }

  // 시장 → 업종 → 종목 3단계 그룹화
  const byMarket = {};
  for (const s of stocks) {
    const mkt = s.market || 'KOSPI';
    const sec = s.sector || '기타';
    if (!byMarket[mkt]) byMarket[mkt] = {};
    if (!byMarket[mkt][sec]) byMarket[mkt][sec] = [];
    byMarket[mkt][sec].push(s);
  }

  const root = d3.hierarchy({
    name: 'root',
    children: ['KOSPI', 'KOSDAQ'].filter(m => byMarket[m]).map(mkt => ({
      name: mkt,
      children: Object.entries(byMarket[mkt]).map(([sec, items]) => ({
        name:   sec,
        market: mkt,
        children: items.map(s => ({
          code:       s.code,
          ticker:     s.ticker,
          label:      s.name,
          market:     s.market,
          sector:     s.sector,
          market_cap: s.market_cap,
          change_pct: s.change_pct || 0,
          price:      s.price,
        })),
      })),
    })),
  }).sum(d => d.market_cap || 0);

  d3.treemap()
    .size([W, H])
    .paddingOuter(4)
    .paddingTop(20)
    .paddingInner(1)
    (root);

  const svg = d3.select(container).append('svg').attr('width', W).attr('height', H);
  const defs = svg.append('defs');
  const tooltip = document.getElementById('heatmap-tooltip');

  // ── 시장 레이어 (depth=1) KOSPI/KOSDAQ ──────────────────────────
  (root.children || []).forEach(mkt => {
    const mw = mkt.x1 - mkt.x0, mh = mkt.y1 - mkt.y0;
    const mLeaves = mkt.leaves();
    const mAvg = mLeaves.reduce((s, d) => s + (d.data.change_pct || 0), 0) / (mLeaves.length || 1);
    const isKosdaq = mkt.data.name === 'KOSDAQ';

    svg.append('rect')
      .attr('x', mkt.x0).attr('y', mkt.y0)
      .attr('width', mw).attr('height', mh)
      .attr('fill', _avgFillKr(mAvg, 0.08))
      .attr('stroke', isKosdaq ? 'rgba(251,191,36,.4)' : 'rgba(99,102,241,.4)')
      .attr('stroke-width', 2)
      .attr('rx', 4);

    // 시장 레이블
    svg.append('text')
      .attr('x', mkt.x0 + 5).attr('y', mkt.y0 + 14)
      .attr('fill', isKosdaq ? '#fbbf24' : '#818cf8')
      .attr('font-size', '12px').attr('font-weight', '800')
      .attr('pointer-events', 'none')
      .text(mkt.data.name);
  });

  // ── 업종 레이어 (depth=2) ─────────────────────────────────────────
  root.descendants().filter(d => d.depth === 2).forEach(sec => {
    const sw = sec.x1 - sec.x0, sh = sec.y1 - sec.y0;
    const sLeaves = sec.leaves();
    const sAvg = sLeaves.reduce((s, d) => s + (d.data.change_pct || 0), 0) / (sLeaves.length || 1);

    svg.append('rect')
      .attr('x', sec.x0).attr('y', sec.y0)
      .attr('width', sw).attr('height', sh)
      .attr('fill', _avgFillKr(sAvg, 0.12))
      .attr('rx', 2)
      .on('mouseover', (e) => {
        tooltip.style.display = 'block';
        const pos = sLeaves.filter(d => (d.data.change_pct || 0) >= 0).length;
        tooltip.innerHTML =
          `<strong style="font-size:13px;color:#fff">${sec.data.name}</strong>
           <span style="color:#6e7681;font-size:11px;margin-left:4px">${sec.data.market}</span><br>
           <span style="color:${sAvg >= 0 ? '#4ade80' : '#f87171'};font-size:14px;font-weight:700">
             ${sAvg >= 0 ? '+' : ''}${sAvg.toFixed(2)}%
           </span>
           <span style="color:#8b949e;font-size:11px;margin-left:6px">업종 평균</span><br>
           <div style="font-size:11px;margin-top:4px">
             <span style="color:#4ade80">▲ ${pos}개</span>&nbsp;
             <span style="color:#f87171">▼ ${sLeaves.length - pos}개</span>
           </div>`;
      })
      .on('mousemove', (e) => {
        const pad = 12;
        let x = e.clientX + pad, y = e.clientY + pad;
        if (x + tooltip.offsetWidth  > window.innerWidth  - 8) x = e.clientX - tooltip.offsetWidth  - pad;
        if (y + tooltip.offsetHeight > window.innerHeight - 8) y = e.clientY - tooltip.offsetHeight - pad;
        tooltip.style.left = x + 'px'; tooltip.style.top = y + 'px';
      })
      .on('mouseout', () => { tooltip.style.display = 'none'; });

    if (sw > 50 && sh > 16) {
      const distFromParent = sec.y0 - sec.parent.y0;
      if (distFromParent >= 18) {
        svg.append('text')
          .attr('x', sec.x0 + 3).attr('y', sec.y0 + 12)
          .attr('fill', 'rgba(255,255,255,.5)').attr('font-size', '9px').attr('font-weight', '600')
          .attr('pointer-events', 'none')
          .text(sec.data.name.length > 10 ? sec.data.name.slice(0, 9) + '…' : sec.data.name);
      }
    }
  });

  // ── 종목 셀 (depth=3 / leaves) ───────────────────────────────────
  root.leaves().forEach(d => {
    const cw = d.x1 - d.x0, ch = d.y1 - d.y0;
    const clipId = 'krc_' + d.data.code;
    defs.append('clipPath').attr('id', clipId)
      .append('rect').attr('x', 1).attr('y', 1)
      .attr('width', Math.max(0, cw - 2)).attr('height', Math.max(0, ch - 2));

    const g = svg.append('g')
      .attr('transform', `translate(${d.x0},${d.y0})`)
      .attr('cursor', 'pointer')
      .on('click', () => navigateToChart(d.data.ticker))
      .on('mouseover', (e) => {
        e.stopPropagation();
        tooltip.style.display = 'block';
        const pct = d.data.change_pct || 0;
        tooltip.innerHTML =
          `<strong style="font-size:14px">${d.data.label}</strong>
           <span style="color:#8b949e;font-size:12px;margin-left:5px">${d.data.code}</span><br>
           <span style="color:#6e7681;font-size:11px">${d.data.market} · ${d.data.sector || '—'}</span><br>
           현재가: <strong>₩${Math.round(d.data.price).toLocaleString('ko-KR')}</strong>
           <strong style="margin-left:6px;color:${pct >= 0 ? '#4ade80' : '#f87171'}">
             ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%
           </strong>`;
      })
      .on('mousemove', (e) => {
        e.stopPropagation();
        const pad = 12;
        let x = e.clientX + pad, y = e.clientY + pad;
        if (x + tooltip.offsetWidth  > window.innerWidth  - 8) x = e.clientX - tooltip.offsetWidth  - pad;
        if (y + tooltip.offsetHeight > window.innerHeight - 8) y = e.clientY - tooltip.offsetHeight - pad;
        tooltip.style.left = x + 'px'; tooltip.style.top = y + 'px';
      })
      .on('mouseout', (e) => { e.stopPropagation(); tooltip.style.display = 'none'; });

    g.append('rect')
      .attr('width', cw).attr('height', ch)
      .attr('fill', _colorScale(d.data.change_pct || 0))
      .attr('stroke', '#0d1117').attr('stroke-width', 0.8);

    if (cw > 20 && ch > 12) {
      const fs = Math.max(7, Math.min(12, cw / 5));
      const showPct = ch >= 28 && cw >= 26;
      // 종목명 표시 (이름이 길면 앞 글자 자름)
      const label = d.data.label || d.data.code;
      const maxChars = Math.max(2, Math.floor(cw / (fs * 0.65)));
      const displayName = label.length > maxChars ? label.slice(0, maxChars - 1) + '…' : label;

      g.append('text')
        .attr('x', cw / 2).attr('y', showPct ? ch / 2 - 7 : ch / 2 + 1)
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
        .attr('fill', 'rgba(255,255,255,.95)')
        .attr('font-size', fs + 'px').attr('font-weight', '700')
        .attr('pointer-events', 'none')
        .attr('clip-path', 'url(#' + clipId + ')')
        .text(displayName);

      if (showPct) {
        const pct = d.data.change_pct || 0;
        g.append('text')
          .attr('x', cw / 2).attr('y', ch / 2 + 9)
          .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
          .attr('fill', 'rgba(255,255,255,.80)')
          .attr('font-size', Math.max(7, fs - 1) + 'px')
          .attr('pointer-events', 'none')
          .attr('clip-path', 'url(#' + clipId + ')')
          .text((pct >= 0 ? '+' : '') + pct.toFixed(2) + '%');
      }
    }
  });
}

function _avgFillKr(avg, alpha) {
  if (avg >=  0.5) return `rgba(22,163,74,${alpha})`;
  if (avg >=  0.1) return `rgba(22,163,74,${alpha * 0.55})`;
  if (avg <= -0.5) return `rgba(185,28,28,${alpha})`;
  if (avg <= -0.1) return `rgba(185,28,28,${alpha * 0.55})`;
  return `rgba(55,65,81,${alpha})`;
}
