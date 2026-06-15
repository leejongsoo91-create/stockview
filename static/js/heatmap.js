/* ═══════════════════════════════════════════════════════════════
   heatmap.js — D3 트리맵 히트맵 (sector → industry → stock)
   ═══════════════════════════════════════════════════════════════ */

let _hmStocks   = [];
let _hmTopN     = 500;
let _hmIndex    = 'all';
let _hmMembers  = {};

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

  // 리사이즈
  let _resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (document.getElementById('view-heatmap').classList.contains('active')) renderHeatmap();
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

  // 3) sector → industry → stock 3단계 그룹핑
  const sectorMap = d3.group(visible, d => d.sector || 'Other');
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
      tooltip.style.display = 'block';
      tooltip.innerHTML = `
        <strong style="font-size:14px">${d.data.ticker}</strong>
        <span style="color:#8b949e;margin-left:6px;font-size:12px">${d.data.name}</span><br>
        ${d.data.name_ko ? `<span style="color:#6e7681;font-size:11px">${d.data.name_ko}</span><br>` : ''}
        Price: <strong>${fmt$(d.data.price)}</strong>&nbsp;
        <strong class="${pct >= 0 ? 'up' : 'down'}">${fmtPct(pct)}</strong><br>
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
    .on('click', (event, d) => navigateToChart(d.data.ticker));

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
