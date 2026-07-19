/* ═══════════════════════════════════════════════════════════════
   main.js — 뷰 전환, 홈 페이지, 티커 테이프, 공통 헬퍼
   ═══════════════════════════════════════════════════════════════ */

// ── 공통 헬퍼 ───────────────────────────────────────────────────────────────
function fmt$(n)  { return '$' + Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}); }
function fmtPct(n){ const s = n >= 0 ? '+' : ''; return s + n.toFixed(2) + '%'; }
function fmtVol(n){ if(n >= 1e9) return (n/1e9).toFixed(2)+'B'; if(n >= 1e6) return (n/1e6).toFixed(1)+'M'; return n.toLocaleString(); }
function fmtCap(n){ if(n >= 1000) return '$'+(n/1000).toFixed(2)+'T'; return '$'+n.toFixed(0)+'B'; }
function colorCls(n){ return n >= 0 ? 'up' : 'down'; }

// api fetch 래퍼
async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

// ── 오늘의 신호 맵 (Watchlist/Portfolio 공용) ──────────────────────────────────
// { ticker: {direction:'buy'|'sell', score, term} } — 세션 중 1회만 조회
let _dailySignalMap = null;

async function loadDailySignalMap() {
  if (_dailySignalMap) return _dailySignalMap;
  const map = {};
  try {
    const data = await api('/api/daily-signals');
    ['us', 'kr'].forEach(mkt => {
      const d = data[mkt] || {};
      (d.buy  || []).forEach(s => { map[s.ticker] = { ...s, direction: 'buy'  }; });
      (d.sell || []).forEach(s => { map[s.ticker] = { ...s, direction: 'sell' }; });
    });
  } catch {}
  _dailySignalMap = map;
  return map;
}

function signalBadgeHtml(ticker, map) {
  const s = map[ticker];
  if (!s) return '<span class="sig-badge-none">—</span>';
  const cls   = s.direction === 'buy' ? 'buy' : 'sell';
  const label = s.direction === 'buy' ? '▲매수' : '▼매도';
  return `<span class="sig-badge ${cls}" title="${s.term} 신호 · 점수 ${s.score}">${label} <span class="sig-badge-term">${s.term}</span></span>`;
}

// ── 뷰 전환 ─────────────────────────────────────────────────────────────────
let _heatmapInited   = false;
let _screenerInited  = false;
let _chartInited     = false;
let _newsInited      = false;
let _briefInited     = false;
let _watchlistInited = false;
let _portfolioInited = false;
let _earningsInited  = false;

function switchView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelector(`.nav-btn[data-view="${name}"]`).classList.add('active');

  // 다른 탭으로 이동 시 각 탭 타이머 중지
  if (name !== 'screener' && typeof stopScreenerRefresh === 'function') {
    stopScreenerRefresh();
  }
  if (name !== 'chart'     && typeof stopChartTimers       === 'function') stopChartTimers();
  if (name !== 'portfolio' && typeof stopPortfolioRefresh  === 'function') stopPortfolioRefresh();

  // 첫 진입 시 각 탭 초기화 (스크리너는 매번 재로드)
  if (name === 'screener')                        { initScreener();  _screenerInited  = true; }
  if (name === 'heatmap'  && !_heatmapInited)     { initHeatmap();   _heatmapInited   = true; }
  if (name === 'chart'    && !_chartInited)       { initChart();     _chartInited     = true; }
  if (name === 'news'     && !_newsInited)        { initNews();      _newsInited      = true; }
  if (name === 'brief'    && !_briefInited)       { initBrief();     _briefInited     = true; }
  if (name === 'earnings' && !_earningsInited)   { initEarnings();  _earningsInited  = true; }
  // 워치리스트는 진입할 때마다 최신 데이터로 갱신
  if (name === 'watchlist')  { initWatchlist();  _watchlistInited  = true; }
  if (name === 'portfolio')  { initPortfolio(); _portfolioInited  = true; }
}

// 차트 탭으로 이동 + 종목 로드 (다른 탭에서 호출)
function navigateToChart(ticker) {
  switchView('chart');
  if (!_chartInited) { initChart(); _chartInited = true; }
  loadChart(ticker);
}

// ── 시장 상태 배지 ───────────────────────────────────────────────────────────
function renderMarketStatus() {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et    = new Date(etStr);
  const day   = et.getDay();
  const mins  = et.getHours() * 60 + et.getMinutes();
  const timeStr = et.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) + ' ET';

  let statusKey, label;
  if (day === 0 || day === 6) {
    statusKey = 'closed'; label = 'MARKET CLOSED';
  } else if (mins >= 9 * 60 + 30 && mins < 16 * 60) {
    statusKey = 'open';   label = 'MARKET OPEN';
  } else if (mins >= 4 * 60 && mins < 9 * 60 + 30) {
    statusKey = 'pre';    label = 'PRE-MARKET';
  } else if (mins >= 16 * 60 && mins < 20 * 60) {
    statusKey = 'after';  label = 'AFTER HOURS';
  } else {
    statusKey = 'closed'; label = 'MARKET CLOSED';
  }

  const el = document.getElementById('market-status');
  if (el) el.innerHTML = `<span class="market-status-badge mkt-${statusKey}"><span class="mkt-dot"></span>${label}</span>`;
  const timeEl = document.getElementById('home-et-time');
  if (timeEl) timeEl.textContent = timeStr;
}

// ── 섹터 퍼포먼스 가로 칩 스트립 ────────────────────────────────────────────
let _homeStocks   = [];
let _sectorPeriod = '1d';

function _sectorItemsFrom1D(stocks) {
  const map = {};
  for (const s of stocks) {
    if (!s.sector || s.sector === 'Other' || s.change_pct == null) continue;
    if (!map[s.sector]) map[s.sector] = { sum: 0, n: 0 };
    map[s.sector].sum += s.change_pct;
    map[s.sector].n++;
  }
  return Object.entries(map)
    .map(([name, v]) => ({ name, avg: +(v.sum / v.n).toFixed(2) }))
    .sort((a, b) => b.avg - a.avg);
}

function _sectorItemsFromPerf(perfMap, stocks) {
  const map = {};
  for (const s of stocks) {
    if (!s.sector || s.sector === 'Other') continue;
    const pct = perfMap[s.ticker];
    if (pct == null) continue;
    if (!map[s.sector]) map[s.sector] = { sum: 0, n: 0 };
    map[s.sector].sum += pct;
    map[s.sector].n++;
  }
  return Object.entries(map)
    .map(([name, v]) => ({ name, avg: +(v.sum / v.n).toFixed(2) }))
    .sort((a, b) => b.avg - a.avg);
}

function renderSectorPerf(items) {
  const el = document.getElementById('sector-perf-grid');
  if (!el) return;
  el.innerHTML = items.map(({ name, avg }) => {
    const cls  = avg >= 0 ? 'up' : 'down';
    const sign = avg >= 0 ? '+' : '';
    return `<div class="sec-chip ${cls}">
      <span class="sec-chip-name">${name}</span>
      <span class="sec-chip-pct">${sign}${avg}%</span>
    </div>`;
  }).join('');
}

async function loadSectorPerf(period) {
  _sectorPeriod = period;
  document.querySelectorAll('.sp-period-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.period === period);
  });
  if (period === '1d') {
    renderSectorPerf(_sectorItemsFrom1D(_homeStocks));
  } else {
    const el = document.getElementById('sector-perf-grid');
    if (el) el.innerHTML = '<span style="color:var(--muted);font-size:12px">Loading…</span>';
    try {
      const perfMap = await api(`/api/heatmap-perf?period=${period}`);
      renderSectorPerf(_sectorItemsFromPerf(perfMap, _homeStocks));
    } catch {
      if (el) el.innerHTML = '<span style="color:#f85149;font-size:12px">Error loading data</span>';
    }
  }
}

// ── Volume Leaders ───────────────────────────────────────────────────────────
function renderVolumeLeaders(stocks) {
  const top = [...stocks]
    .filter(s => s.volume > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 10);
  const el = document.getElementById('volume-body');
  if (!el) return;
  el.innerHTML = top.map(s => `
    <tr onclick="navigateToChart('${s.ticker}')">
      <td onclick="event.stopPropagation()" style="width:28px">${starBtn(s.ticker)}</td>
      <td class="m-ticker">${s.ticker}</td>
      <td class="m-name">${s.name}<br><span style="font-size:11px;color:#6e7681">${fmtVol(s.volume)}</span></td>
      <td class="m-pct ${colorCls(s.change_pct)}">${fmtPct(s.change_pct)}</td>
    </tr>`).join('');
}

function renderMarketStatBar(stocks) {
  const el = document.getElementById('market-stat-bar');
  if (!el || !stocks || !stocks.length) return;
  let up = 0, down = 0, flat = 0;
  stocks.forEach(s => {
    const p = parseFloat(s.change_pct) || 0;
    if (p > 0) up++;
    else if (p < 0) down++;
    else flat++;
  });
  el.innerHTML =
    `<span class="msb-up">▲ ${up.toLocaleString()}</span>` +
    `<span class="msb-down">▼ ${down.toLocaleString()}</span>` +
    `<span class="msb-flat">— ${flat.toLocaleString()}</span>`;
}

// ── 홈 Fear & Greed 위젯 ────────────────────────────────────────────────────
function _fgRatingClass(rating) {
  if (!rating) return '';
  return 'fg-' + rating.toLowerCase().replace(/\s+/g, '-');
}

function _scoreToRating(score) {
  if (score <= 25) return 'Extreme Fear';
  if (score <= 44) return 'Fear';
  if (score <= 55) return 'Neutral';
  if (score <= 75) return 'Greed';
  return 'Extreme Greed';
}

function renderHomeFearGreed(fg) {
  if (!fg || fg.score == null) return;
  const { score, rating, prev_close, prev_1w, prev_1m, prev_1y } = fg;

  const deg  = (score / 100 * 180) - 90;
  const rCls = _fgRatingClass(rating);

  // 바늘
  requestAnimationFrame(() => {
    const n = document.getElementById('home-fg-needle');
    if (n) n.style.transform = `translateX(-50%) rotate(${deg}deg)`;
  });

  // 점수 + 등급
  const scoreEl  = document.getElementById('home-fg-score');
  const ratingEl = document.getElementById('home-fg-rating');
  if (scoreEl)  { scoreEl.textContent = score;  scoreEl.className  = 'fg-score-big '    + rCls; }
  if (ratingEl) { ratingEl.textContent = rating; ratingEl.className = 'fg-rating-label ' + rCls; }

  // 과거 비교
  const histEl = document.getElementById('home-fg-history');
  if (histEl) {
    const rows = [
      ['Yesterday',  prev_close],
      ['Last Week',  prev_1w],
      ['Last Month', prev_1m],
      ['Last Year',  prev_1y],
    ];
    histEl.innerHTML = rows.map(([label, val]) => {
      const r = _scoreToRating(val);
      return `<div class="fg-hist-row">
        <span class="fg-hist-label">${label}</span>
        <span class="fg-hist-val ${_fgRatingClass(r)}">${val}</span>
        <span class="fg-hist-rating">${r}</span>
      </div>`;
    }).join('');
  }
}

// ── 경제 캘린더 ──────────────────────────────────────────────────────────────
const _CAT_ICON = {
  'Fed Policy':    '🏦',
  'Inflation':     '📊',
  'Employment':    '👷',
  'GDP':           '📈',
  'Consumer':      '🛒',
  'Manufacturing': '🏭',
};
const _IMP_DOT = {
  high:   '<span class="eco-dot eco-high"  title="High impact"></span>',
  medium: '<span class="eco-dot eco-med"   title="Medium impact"></span>',
  low:    '<span class="eco-dot eco-low"   title="Low impact"></span>',
};

function renderEconomicCalendar(events) {
  const el = document.getElementById('eco-cal-body');
  if (!el) return;
  if (!events || !events.length) {
    el.innerHTML = '<span style="color:var(--muted);font-size:13px">No upcoming events in the next 3 weeks.</span>';
    return;
  }

  // 날짜별 그룹화
  const groups = {};
  events.forEach(ev => {
    if (!groups[ev.date]) groups[ev.date] = [];
    groups[ev.date].push(ev);
  });

  const fmtDate = d => {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  el.innerHTML = Object.entries(groups).map(([date, evs]) => {
    const first = evs[0];
    const dayLabel = first.is_today ? '🔴 Today' : first.is_tomorrow ? '🟡 Tomorrow' : fmtDate(date);
    const rowClass = first.is_today ? 'eco-today' : first.is_tomorrow ? 'eco-tomorrow' : '';
    const rows = evs.map(ev => {
      const icon = _CAT_ICON[ev.category] || '📌';
      const dot  = _IMP_DOT[ev.importance] || _IMP_DOT.low;
      return `<div class="eco-row ${rowClass}">
        <span class="eco-day">${dayLabel}</span>
        <span class="eco-dot-wrap">${dot}</span>
        <span class="eco-icon">${icon}</span>
        <span class="eco-event">${ev.event}</span>
        <span class="eco-cat">${ev.category}</span>
      </div>`;
    }).join('');
    return rows;
  }).join('');
}

async function loadEconomicCalendar() {
  try {
    const events = await api('/api/economic-calendar?days=21');
    renderEconomicCalendar(events);
  } catch {
    const el = document.getElementById('eco-cal-body');
    if (el) el.innerHTML = '<span style="color:var(--muted);font-size:13px">Failed to load calendar.</span>';
  }
}

// ── 홈 초기화 ────────────────────────────────────────────────────────────────
async function loadHome() {
  const [indices, stocks, news, fg] = await Promise.all([
    api('/api/indices'),
    api('/api/stocks'),
    api('/api/news'),
    api('/api/fear-greed').catch(() => ({})),
  ]);
  _homeStocks = stocks;
  renderMarketStatus();
  buildTickerTape(indices, stocks);
  renderIndices(indices);
  renderHomeFearGreed(fg);
  renderMovers(stocks);
  renderSectorPerf(_sectorItemsFrom1D(stocks));
  renderVolumeLeaders(stocks);
  renderHomeNews(news);
  renderMarketStatBar(stocks);
  loadEconomicCalendar();
  renderHomeWatchlistSummary();
  renderHomePortfolioSummary();
  // 섹터 기간 버튼 이벤트 (최초 1회 바인딩)
  document.querySelectorAll('.sp-period-btn').forEach(b => {
    b.addEventListener('click', () => loadSectorPerf(b.dataset.period));
  });
  return true;
}

// ── 티커 테이프 ──────────────────────────────────────────────────────────────
function buildTickerTape(indices, stocks) {
  const tape = document.getElementById('ticker-inner');
  const items = [
    ...indices.map(i => ({ label: i.name, value: i.value.toLocaleString('en-US', {minimumFractionDigits:2}), pct: i.change_pct })),
    ...['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','JPM','LLY','NFLX'].map(t => {
      const s = stocks.find(x => x.ticker === t);
      if (!s) return null;
      return { label: s.ticker, value: fmt$(s.price), pct: s.change_pct };
    }).filter(Boolean),
  ];
  const html = items.map(i =>
    `<span class="tape-item">
       <span class="tape-name">${i.label}</span>
       <span class="tape-val">${i.value}</span>
       <span class="tape-pct ${i.pct >= 0 ? 'up' : 'down'}">${fmtPct(i.pct)}</span>
     </span>`
  ).join('');
  tape.innerHTML = html + html; // 끊김 없는 루프를 위해 복제
}

// 지수 이름 → Yahoo Finance 심볼 매핑
const _INDEX_SYMBOL = {
  'S&P 500':      '^GSPC',
  'NASDAQ':       '^IXIC',
  'Dow Jones':    '^DJI',
  'Russell 2000': '^RUT',
  'VIX':          '^VIX',
  'WTI Crude':    'CL=F',
  'Gold':         'GC=F',
  'Bitcoin':      'BTC-USD',
  '10Y Yield':    '^TNX',
  'DXY':          'DX-Y.NYB',
  'EUR/USD':      'EURUSD=X',
  'GBP/USD':      'GBPUSD=X',
  'USD/JPY':      'JPY=X',
  'USD/KRW':      'KRW=X',
  'KOSPI':        '^KS11',
  'KOSDAQ':       '^KQ11',
  'US500':        'ES=F',
  'US30':         'YM=F',
  'US Tech 100':  'NQ=F',
};

// Overview 3그룹 정의
const _INDEX_GROUPS = [
  { label: '📈 Major Indices', names: ['S&P 500','NASDAQ','Dow Jones','Russell 2000','KOSPI','KOSDAQ'] },
  { label: '🛢️ Futures',       names: ['US500','US30','US Tech 100','WTI Crude','Gold','Bitcoin'] },
  { label: '🏦 Bonds & FX',    names: ['10Y Yield','DXY','EUR/USD','GBP/USD','USD/JPY','USD/KRW','VIX'] },
];

// ── 지수 Overview 3그룹 렌더링 ────────────────────────────────────────────────
function renderIndices(indices) {
  const el = document.getElementById('indices-overview');
  if (!el) return;

  const byName = {};
  for (const i of indices) byName[i.name] = i;

  el.innerHTML = _INDEX_GROUPS.map(group => {
    const rows = group.names.map(name => {
      const i = byName[name];
      if (!i) return '';
      const cls = colorCls(i.change_pct);
      const sym = _INDEX_SYMBOL[name];
      const click = sym ? `onclick="navigateToChart('${sym}')"` : '';

      // 값 포맷
      let valStr;
      if (name === 'Bitcoin')            valStr = '$' + Math.round(i.value).toLocaleString('en-US');
      else if (name === 'EUR/USD' || name === 'GBP/USD') valStr = i.value.toFixed(4);
      else if (name === 'USD/JPY' || name === 'USD/KRW') valStr = i.value.toFixed(2);
      else if (name === '10Y Yield' || name === 'VIX') valStr = i.value.toFixed(2);
      else if (name === 'DXY')           valStr = i.value.toFixed(2);
      else                               valStr = i.value.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});

      // 변화량 포맷
      const sign = i.change >= 0 ? '+' : '';
      let chgStr;
      if (name === 'Bitcoin') chgStr = sign + '$' + Math.abs(i.change).toLocaleString('en-US', {maximumFractionDigits:0});
      else if (name === 'EUR/USD' || name === 'GBP/USD') chgStr = sign + i.change.toFixed(4);
      else chgStr = sign + i.change.toFixed(2);

      return `<div class="ov-row" ${click}>
        <span class="ov-name">${name}</span>
        <span class="ov-value">${valStr}</span>
        <span class="ov-chg ${cls}">${chgStr} (${fmtPct(i.change_pct)})</span>
      </div>`;
    }).join('');

    return `<div class="ov-group">
      <div class="ov-group-title">${group.label}</div>
      ${rows}
    </div>`;
  }).join('');
}

// ── Top Gainers / Losers ──────────────────────────────────────────────────────
function renderMovers(stocks) {
  const sorted = [...stocks].sort((a, b) => b.change_pct - a.change_pct);
  const gainers = sorted.slice(0, 10);
  const losers  = sorted.slice(-10).reverse();

  function rows(list) {
    return list.map(s => `
      <tr onclick="navigateToChart('${s.ticker}')">
        <td onclick="event.stopPropagation()" style="width:28px">${starBtn(s.ticker)}</td>
        <td class="m-ticker">${s.ticker}</td>
        <td class="m-name">${s.name}<br><span style="font-size:11px;color:#6e7681">${s.name_ko || ''}</span></td>
        <td class="m-price">$${s.price != null ? Number(s.price).toFixed(2) : '—'}</td>
        <td class="m-pct ${colorCls(s.change_pct)}">${fmtPct(s.change_pct)}</td>
      </tr>`).join('');
  }
  document.getElementById('gainers-body').innerHTML = rows(gainers);
  document.getElementById('losers-body').innerHTML  = rows(losers);
}

// ── 홈 뉴스 프리뷰 ───────────────────────────────────────────────────────────
function renderHomeNews(news) {
  const el = document.getElementById('home-news');
  const sentMap = { positive: { cls: 'np-pos', dot: '🟢' }, negative: { cls: 'np-neg', dot: '🔴' }, neutral: { cls: '', dot: '⚪' } };
  el.innerHTML = news.slice(0, 10).map(n => {
    const sm = sentMap[n.sentiment] || sentMap.neutral;
    const tickerBadge = n.ticker
      ? `<span class="news-ticker-badge" onclick="event.stopPropagation();navigateToChart('${n.ticker}')">${n.ticker}</span>`
      : '';
    return `
      <div class="news-preview-item" onclick="window.open('${n.url}','_blank')">
        <div class="np-title">${n.title}</div>
        <div class="np-meta">
          <span class="np-sent-dot">${sm.dot}</span>
          <span class="news-source">${n.source}</span>
          <span>${n.time}</span>
          ${tickerBadge}
        </div>
      </div>`;
  }).join('');
}

// ── 홈 — 내 워치리스트 / 포트폴리오 요약 (WL/PT 재사용) ─────────────────────────
function renderHomeWatchlistSummary() {
  const el = document.getElementById('home-watchlist-summary');
  if (!el || typeof WL === 'undefined') return;
  const tickers = WL.load();
  if (!tickers.length) {
    el.innerHTML = `<div class="home-my-empty">관심종목이 없습니다. <a href="javascript:void(0)" onclick="switchView('screener')">스크리너</a>에서 ☆를 눌러 추가하세요.</div>`;
    return;
  }
  const us = window._scStocks || [];
  const kr = window._krStocks || [];
  const rows = tickers
    .map(t => us.find(s => s.ticker === t) || kr.find(s => s.ticker === t))
    .filter(Boolean);
  if (!rows.length) {
    el.innerHTML = `<div class="home-my-empty">데이터 불러오는 중…</div>`;
    return;
  }
  rows.sort((a, b) => Math.abs(b.change_pct || 0) - Math.abs(a.change_pct || 0));
  const top = rows.slice(0, 5);
  el.innerHTML = `
    <div class="home-my-count">${tickers.length}개 종목 중 변동폭 상위 ${top.length}개</div>
    <table class="movers-table"><tbody>
      ${top.map(s => {
        const disp = s.code || s.ticker;
        const name = s.name_ko || s.name || '';
        const pct  = s.change_pct || 0;
        return `<tr onclick="navigateToChart('${s.ticker}')">
          <td class="m-ticker">${disp}</td>
          <td class="m-name">${name}</td>
          <td class="m-pct ${pct >= 0 ? 'up' : 'down'}">${fmtPct(pct)}</td>
        </tr>`;
      }).join('')}
    </tbody></table>`;
}

function renderHomePortfolioSummary() {
  const el = document.getElementById('home-portfolio-summary');
  if (!el || typeof PT === 'undefined') return;
  const data = PT.load();
  const tickers = Object.keys(data);
  if (!tickers.length) {
    el.innerHTML = `<div class="home-my-empty">포트폴리오가 없습니다. <a href="javascript:void(0)" onclick="switchView('portfolio')">포트폴리오</a> 탭에서 보유 종목을 추가하세요.</div>`;
    return;
  }
  const us = window._scStocks || [];
  const kr = window._krStocks || [];
  let totalCost = 0, totalValue = 0, found = 0;
  tickers.forEach(t => {
    const h = data[t];
    const s = us.find(x => x.ticker === t) || kr.find(x => x.ticker === t);
    if (!s || s.price == null) return;
    found++;
    totalCost  += h.qty * h.avgPrice;
    totalValue += h.qty * s.price;
  });
  if (!found) {
    el.innerHTML = `<div class="home-my-empty">데이터 불러오는 중…</div>`;
    return;
  }
  const pnl    = totalValue - totalCost;
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0;
  const cls    = pnl >= 0 ? 'up' : 'down';
  el.innerHTML = `
    <div class="home-my-count">${tickers.length}개 보유 종목</div>
    <div class="home-pf-value">${fmt$(totalValue)}</div>
    <div class="home-pf-pnl ${cls}">${pnl >= 0 ? '+' : '-'}${fmt$(Math.abs(pnl))} (${fmtPct(pnlPct)})</div>`;
}

// ── 뉴스 탭 ──────────────────────────────────────────────────────────────────
let _allNews        = [];
let _allReports     = [];
let _activeSubtab   = 'news';
let _activeSentiment = 'all';
let _activeSource    = 'all';
let _activeKeyword   = '';

function _escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _highlightKw(text, kw) {
  const esc = _escHtml(text);
  if (!kw) return esc;
  const kwEsc = _escHtml(kw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return esc.replace(new RegExp('(' + kwEsc + ')', 'gi'), '<mark class="kw-hl">$1</mark>');
}

function _populateSourceFilter(news) {
  const sel = document.getElementById('news-src-filter');
  if (!sel) return;
  const sources = [...new Set(news.map(n => n.source).filter(Boolean))].sort();
  const cur = sel.value;
  sel.innerHTML = '<option value="all">All Sources</option>' +
    sources.map(s => `<option value="${s}"${s === cur ? ' selected' : ''}>${s}</option>`).join('');
}

function initNews() {
  // 서브탭 전환
  document.querySelectorAll('.news-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.news-subtab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _activeSubtab = btn.dataset.subtab;
      document.getElementById('news-panel').style.display         = _activeSubtab === 'news'         ? '' : 'none';
      document.getElementById('reports-panel').style.display      = _activeSubtab === 'reports'      ? '' : 'none';
      document.getElementById('disclosures-panel').style.display  = _activeSubtab === 'disclosures'  ? '' : 'none';
      if (_activeSubtab === 'reports' && _allReports.length === 0) {
        loadReports();
      }
      if (_activeSubtab === 'disclosures') {
        loadDisclosures();
      }
    });
  });

  // News 필터 (감성 + 소스)
  api('/api/news').then(news => {
    _allNews = news;
    _populateSourceFilter(news);
    renderNews();
  });
  document.querySelectorAll('.news-tag').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.news-tag').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _activeSentiment = btn.dataset.sentiment;
      renderNews();
    });
  });
  document.getElementById('news-src-filter')?.addEventListener('change', e => {
    _activeSource = e.target.value;
    renderNews();
  });

  // 키워드 검색 (debounce 300ms)
  let _kwTimer = null;
  document.getElementById('news-kw-search')?.addEventListener('input', e => {
    clearTimeout(_kwTimer);
    _kwTimer = setTimeout(() => {
      _activeKeyword = e.target.value.trim().toLowerCase();
      renderNews();
    }, 300);
  });

  // Reports 타입 필터
  document.querySelectorAll('.report-tag').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.report-tag').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderReports(btn.dataset.rtype);
    });
  });

  // 공시 새로고침 버튼
  document.getElementById('disclosures-refresh-btn')?.addEventListener('click', () => {
    loadDisclosures(true);
  });

  // 공시 카테고리 필터
  document.querySelectorAll('#disclosures-panel .report-tag').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#disclosures-panel .report-tag').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderDisclosures(_allDisclosures, btn.dataset.dcat);
    });
  });
}

let _disclosuresLoaded = false;
let _allDisclosures = [];

function loadDisclosures(force = false) {
  if (_disclosuresLoaded && !force) return;
  const el = document.getElementById('disclosures-list');
  el.innerHTML = '<div style="color:var(--muted);padding:20px 0">Loading...</div>';
  api('/api/kr-disclosures').then(data => {
    _disclosuresLoaded = true;
    _allDisclosures = data;
    const active = document.querySelector('#disclosures-panel .report-tag.active');
    renderDisclosures(data, active ? active.dataset.dcat : 'all');
  }).catch(() => {
    el.innerHTML = '<div style="color:var(--muted);padding:20px 0">데이터를 불러올 수 없습니다.</div>';
  });
}

function renderDisclosures(items, dcat = 'all') {
  const el = document.getElementById('disclosures-list');
  const list = dcat === 'all' ? items : (items || []).filter(d => d.category === dcat);
  if (!list || !list.length) {
    el.innerHTML = '<div style="color:var(--muted);padding:20px 0">해당하는 공시가 없습니다.</div>';
    return;
  }
  el.innerHTML = list.map(d => `
    <div class="disclosure-card" onclick="window.open('${d.link}','_blank')">
      <span class="disclosure-time">${d.time}</span>
      <span class="disclosure-company">${d.company}</span>
      <span class="disclosure-title">${d.title}</span>
      <span class="disclosure-type">${d.type}</span>
    </div>`).join('');
}

function loadReports() {
  document.getElementById('reports-list').innerHTML = '<div style="color:var(--muted);padding:20px 0">Loading...</div>';
  api('/api/reports').then(data => {
    _allReports = data;
    renderReports('all');
  });
}

function renderReports(rtype) {
  const list = rtype === 'all' ? _allReports : _allReports.filter(r => r.report_type === rtype);
  const el = document.getElementById('reports-list');
  if (!list.length) {
    el.innerHTML = '<div style="color:var(--muted);padding:20px 0">No reports available.</div>';
    return;
  }
  const badgeClass = t => 'badge-' + t.replace(/\s+/g, '-');
  el.innerHTML = list.map(r => {
    const tickerBadge = r.ticker
      ? `<span class="news-ticker-badge" onclick="event.stopPropagation();navigateToChart('${r.ticker}')">${r.ticker}</span>`
      : '';
    return `
      <div class="report-card" onclick="window.open('${r.url}','_blank')">
        <span class="report-type-badge ${badgeClass(r.report_type)}">${r.report_type}</span>
        <div class="news-body">
          <div class="news-title">${r.title}</div>
          <div class="news-meta">
            <span class="news-source">${r.source}</span>
            <span>${r.time}</span>
            ${tickerBadge}
          </div>
        </div>
      </div>`;
  }).join('');
}
function renderNews() {
  let list = _activeSentiment === 'all' ? _allNews : _allNews.filter(n => n.sentiment === _activeSentiment);
  if (_activeSource !== 'all') list = list.filter(n => n.source === _activeSource);
  if (_activeKeyword) list = list.filter(n =>
    n.title.toLowerCase().includes(_activeKeyword) ||
    (n.source || '').toLowerCase().includes(_activeKeyword)
  );
  const el = document.getElementById('news-list');
  const kw = _activeKeyword;

  // 결과 수 표시
  const countEl = document.getElementById('news-kw-count');
  if (countEl) {
    countEl.textContent = kw ? `${list.length} results` : '';
    countEl.style.display = kw ? 'inline' : 'none';
  }

  if (!list.length) {
    el.innerHTML = `<div style="color:var(--muted);padding:20px 0;text-align:center">No news found${kw ? ` for "<b>${_escHtml(kw)}</b>"` : ''}.</div>`;
    return;
  }

  el.innerHTML = list.map(n => {
    const tickerBadge = n.ticker
      ? `<span class="news-ticker-badge" onclick="navigateToChart('${_escHtml(n.ticker)}')">${_escHtml(n.ticker)}</span>`
      : '';
    const titleHtml = _highlightKw(n.title, kw);
    return `
      <div class="news-card" onclick="window.open('${_escHtml(n.url)}','_blank')" style="cursor:pointer">
        <div class="news-sentiment-badge badge-${n.sentiment}"></div>
        <div class="news-body">
          <div class="news-title">${titleHtml}</div>
          <div class="news-meta">
            <span class="news-source" data-src="${_escHtml(n.source)}">${_escHtml(n.source)}</span>
            <span>${_escHtml(n.time)}</span>
            ${tickerBadge}
          </div>
        </div>
      </div>`;
  }).join('');
}

let _currentView = 'home';

// ── 타임스탬프 ────────────────────────────────────────────────────────────────
function updateTimestamp() {
  const el = document.getElementById('last-updated');
  if (el) el.textContent = 'Live · ' + new Date().toLocaleTimeString('ko-KR');
}

// ── WebSocket 연결 + 이벤트 핸들러 ──────────────────────────────────────────
function initSocketIO() {
  const socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    updateTimestamp();
  });

  socket.on('disconnect', () => {});

  // 종목 가격 갱신 Push
  socket.on('stocks_update', async () => {
    try {
      const stocks = await api('/api/stocks');
      if (_currentView === 'home') {
        const indices = await api('/api/indices');
        buildTickerTape(indices, stocks);
        renderMovers(stocks);
        renderSectorPerf(stocks);
        renderVolumeLeaders(stocks);
        renderMarketStatBar(stocks);
      }
      // 스크리너가 열려있으면 데이터 갱신
      if (_currentView === 'screener' && typeof loadScreenerData === 'function') {
        loadScreenerData(false);
      }
      // 포트폴리오가 열려있으면 갱신
      if (_currentView === 'portfolio' && typeof renderPortfolio === 'function') {
        renderPortfolio();
      }
      updateTimestamp();
    } catch {}
  });

  // 지수 갱신 Push
  socket.on('indices_update', async () => {
    try {
      const [indices, stocks] = await Promise.all([api('/api/indices'), api('/api/stocks')]);
      renderIndices(indices);
      if (_currentView === 'home') {
        buildTickerTape(indices, stocks);
      }
      updateTimestamp();
    } catch {}
  });

  // 뉴스 갱신 Push
  socket.on('news_update', async () => {
    try {
      const news = await api('/api/news');
      if (_currentView === 'home')  renderHomeNews(news);
      if (_currentView === 'news') { _allNews = news; _populateSourceFilter(news); renderNews(); }
      updateTimestamp();
    } catch {}
  });

  return socket;
}

// ── 진입점 ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // 탭 클릭
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _currentView = btn.dataset.view;
      switchView(btn.dataset.view);
    });
  });

  // 홈 초기 로드
  loadHome().then(updateTimestamp);

  // 시장 상태 배지 — 1분마다 갱신 (ET 시간 변동 반영)
  setInterval(renderMarketStatus, 60 * 1000);

  // WebSocket 연결 (Socket.IO CDN 로드된 후)
  if (typeof io !== 'undefined') {
    initSocketIO();
  } else {
    console.warn('[WS] Socket.IO 미로드 — polling 모드로 동작');
  }

  // 배지 초기화
  updateWLCount();
  if (typeof _updatePtCount === 'function') _updatePtCount();

  // URL hash로 탭 직접 진입 (예: #screener, #heatmap)
  const _hash = window.location.hash.slice(1);
  const _views = ['home','screener','heatmap','chart','news','brief','earnings','watchlist','portfolio'];
  if (_hash && _views.includes(_hash)) switchView(_hash);

  // 글로벌 검색 초기화
  initGlobalSearch();
  _preloadGlobalSearchData().then(() => {
    // 홈 위젯이 먼저 렌더된 경우(전역검색 데이터 로딩 전) 로딩 완료 후 다시 채움
    if (_currentView === 'home') {
      renderHomeWatchlistSummary();
      renderHomePortfolioSummary();
    }
  });

  // 테마 초기화
  initTheme();
});

// ── 라이트/다크 테마 ────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light') _applyTheme('light');
}

function toggleTheme() {
  const isLight = document.body.classList.contains('light-theme');
  _applyTheme(isLight ? 'dark' : 'light');
}

function _applyTheme(mode) {
  const isLight = mode === 'light';
  document.body.classList.toggle('light-theme', isLight);
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = isLight ? '🌕' : '🌙';
  localStorage.setItem('theme', mode);
}

// ── 글로벌 검색 ──────────────────────────────────────────────────────────────
function initGlobalSearch() {
  const input = document.getElementById('global-search');
  const drop  = document.getElementById('global-search-dropdown');
  if (!input || !drop) return;

  let _gsTimer = null;

  input.addEventListener('input', () => {
    clearTimeout(_gsTimer);
    const q = input.value.trim().toLowerCase();
    if (!q) { drop.innerHTML = ''; drop.style.display = 'none'; return; }
    _gsTimer = setTimeout(() => _gsSearch(q), 200);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { input.value = ''; drop.style.display = 'none'; }
    if (e.key === 'Enter') {
      const first = drop.querySelector('.gs-item');
      if (first) first.click();
    }
  });

  document.addEventListener('click', e => {
    if (!document.getElementById('global-search-wrap').contains(e.target))
      drop.style.display = 'none';
  });
}

// 스크리너 탭을 열지 않은 상태에서도 검색이 되도록 US/KR 종목 목록을 백그라운드로 미리 로드
async function _preloadGlobalSearchData() {
  try {
    if (!window._scStocks || window._scStocks.length === 0) {
      window._scStocks = await api('/api/stocks');
    }
  } catch (e) { console.warn('global search US preload failed', e); }
  try {
    if (!window._krStocks || window._krStocks.length === 0) {
      window._krStocks = await api('/api/kr-stocks');
    }
  } catch (e) { console.warn('global search KR preload failed', e); }
}

function _gsSearch(q) {
  const drop    = document.getElementById('global-search-dropdown');
  const usStocks = window._scStocks || [];
  const krStocks = window._krStocks || [];

  const matchUs = usStocks.filter(s =>
    s.ticker.toLowerCase().startsWith(q) ||
    s.ticker.toLowerCase().includes(q)   ||
    (s.name || '').toLowerCase().includes(q)
  ).slice(0, 4).map(s => ({ ...s, _isKr: false }));

  const matchKr = krStocks.filter(s =>
    s.code.toLowerCase().includes(q) ||
    s.name.toLowerCase().includes(q)
  ).slice(0, 3).map(s => ({ ...s, ticker: s.ticker, name: s.name, _isKr: true }));

  const results = [...matchUs, ...matchKr].slice(0, 6);

  if (!results.length) {
    drop.innerHTML = `<div class="gs-empty">결과 없음</div>`;
    drop.style.display = 'block';
    return;
  }

  drop.innerHTML = results.map(s => {
    const pct    = s.change_pct ?? 0;
    const cls    = pct >= 0 ? 'up' : 'down';
    const badge  = s._isKr ? '<span class="gs-kr-badge">🇰🇷</span>' : '';
    const disp   = s._isKr ? s.code : s.ticker;
    const price  = s._isKr
      ? `₩${Math.round(s.price||0).toLocaleString('ko-KR')}`
      : '';
    return `<div class="gs-item" onclick="_gsSelect('${s.ticker}')">
      ${badge}<span class="gs-ticker">${disp}</span>
      <span class="gs-name">${s.name || ''}</span>
      <span class="gs-pct ${cls}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>
    </div>`;
  }).join('');
  drop.style.display = 'block';
}

function _gsSelect(ticker) {
  const input = document.getElementById('global-search');
  const drop  = document.getElementById('global-search-dropdown');
  if (input) input.value = '';
  if (drop)  drop.style.display = 'none';

  // KR 종목(.KS/.KQ)은 항상 차트로 이동
  const isKr = ticker.endsWith('.KS') || ticker.endsWith('.KQ');
  if (!isKr && typeof openStockModal === 'function' && window._scStocks && window._scStocks.length) {
    openStockModal(ticker);
  } else {
    navigateToChart(ticker);
  }
}
