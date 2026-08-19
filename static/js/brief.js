/* ═══════════════════════════════════════════════════════════════
   brief.js — 일간/주간/월간 Market Brief 탭
   ═══════════════════════════════════════════════════════════════ */

let _briefPeriod = 'daily';
let _lastDailySignals = { us: null, kr: null };
const _hideWeakSell = { us: false, kr: false };

function initBrief() {
  document.querySelectorAll('.brief-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.brief-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _briefPeriod = btn.dataset.period;
      loadBrief();
    });
  });
  ['us', 'kr'].forEach(market => {
    const cb = document.getElementById(`brief-hide-weak-sell-${market}`);
    if (cb) cb.addEventListener('change', () => {
      _hideWeakSell[market] = cb.checked;
      renderDailySignals(market, _lastDailySignals[market]);
    });
  });
  document.querySelectorAll('[data-brief-subtab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-brief-subtab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const sub = btn.dataset.briefSubtab;
      document.getElementById('brief-overview-panel').style.display = sub === 'overview' ? '' : 'none';
      document.getElementById('brief-signal-panel').style.display   = sub === 'signals'  ? '' : 'none';
    });
  });
  loadBrief();
  loadBriefFearGreed();
  loadEconomicCalendar('brief-eco-cal-body');
  loadDailySignals();
  load52wMovers();
  loadEarningsSignals();
  loadVolumeSurges();
  loadCandlePatterns();
  _briefInited = true;
}

async function loadCandlePatterns() {
  try {
    const data = await api('/api/candle-patterns');
    _renderPatternList('brief-pattern-us-bullish', data.us?.bullish);
    _renderPatternList('brief-pattern-us-bearish', data.us?.bearish);
    _renderPatternList('brief-pattern-kr-bullish', data.kr?.bullish);
    _renderPatternList('brief-pattern-kr-bearish', data.kr?.bearish);
  } catch {}
}

function _renderPatternList(elId, items) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = '<div class="brief-empty">해당 패턴이 없습니다.</div>';
    return;
  }
  el.innerHTML = items.map(s => `
    <div class="brief-signal-item" onclick="navigateToChart('${s.ticker}')">
      <span class="brief-signal-term term-pattern">${s.pattern}</span>
      <span class="brief-signal-ticker">${s.ticker}</span>
      <span class="brief-signal-name">${s.name || ''}</span>
      ${_fmtSignalPct(s.change_pct)}
    </div>`).join('');
}

async function loadVolumeSurges() {
  try {
    const data = await api('/api/volume-surges');
    _renderVolumeList('brief-volume-us', data.us);
    _renderVolumeList('brief-volume-kr', data.kr);
  } catch {}
}

function _renderVolumeList(elId, items) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = '<div class="brief-empty">해당 종목이 없습니다.</div>';
    return;
  }
  el.innerHTML = items.map(s => `
    <div class="brief-signal-item" onclick="navigateToChart('${s.ticker}')">
      <span class="brief-signal-term term-vol">×${s.volume_ratio}</span>
      <span class="brief-signal-ticker">${s.ticker}</span>
      <span class="brief-signal-name">${s.name || ''}</span>
      ${_fmtSignalPct(s.change_pct)}
    </div>`).join('');
}

async function loadEarningsSignals() {
  try {
    const data = await api('/api/earnings-signals');
    renderEarningsSignals(data);
  } catch {}
}

function renderEarningsSignals(items) {
  const el = document.getElementById('brief-earnings-signals');
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = '<div class="brief-empty">해당하는 종목이 없습니다.</div>';
    return;
  }
  el.innerHTML = items.map(s => {
    const dirCls   = s.direction === 'buy' ? 'buy' : 'sell';
    const dirLabel = s.direction === 'buy' ? '▲매수' : '▼매도';
    return `
    <div class="brief-signal-item" onclick="navigateToChart('${s.ticker}')">
      <span class="brief-signal-date">${s.date} ${s.time}</span>
      <span class="brief-signal-term term-${s.term}">${s.term}</span>
      <span class="brief-signal-ticker">${s.ticker}</span>
      <span class="brief-signal-name">${s.name || ''}</span>
      <span class="brief-signal-dir ${dirCls}">${dirLabel}</span>
      ${_fmtSignalPct(s.change_pct)}
    </div>`;
  }).join('');
}

async function load52wMovers() {
  try {
    const data = await api('/api/52w-movers');
    render52wMovers('us', data.us);
    render52wMovers('kr', data.kr);
  } catch {}
}

function _render52wList(elId, items) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = '<div class="brief-empty">해당 종목이 없습니다.</div>';
    return;
  }
  el.innerHTML = items.map(s => `
    <div class="brief-signal-item" onclick="navigateToChart('${s.ticker}')">
      <span class="brief-signal-term term-52w">${s.pos}%</span>
      <span class="brief-signal-ticker">${s.ticker}</span>
      <span class="brief-signal-name">${s.name || ''}</span>
      ${_fmtSignalPct(s.change_pct)}
    </div>`).join('');
}

function render52wMovers(market, data) {
  data = data || { near_high: [], near_low: [] };
  _render52wList(`brief-52w-${market}-high`, data.near_high);
  _render52wList(`brief-52w-${market}-low`,  data.near_low);
}

async function loadDailySignals() {
  try {
    const data = await api('/api/daily-signals');
    _lastDailySignals.us = data.us;
    _lastDailySignals.kr = data.kr;
    renderDailySignals('us', data.us);
    renderDailySignals('kr', data.kr);
    _renderHeldTop();
    const inv = data.kr_investor_leaders || {};
    _renderInvestorList('brief-investor-buy',  inv.buy,  15);
    _renderInvestorList('brief-investor-sell', inv.sell, 15);
  } catch {}
}

// 11번: 국내 외국인 수급 상위 (foreign_net 단위: 주)
function _fmtForeignNet(n) {
  const v = n || 0;
  const abs = Math.abs(v);
  const label = abs >= 1e6 ? (abs / 1e6).toFixed(1) + 'M주' : abs >= 1e3 ? (abs / 1e3).toFixed(0) + 'K주' : abs + '주';
  return (v >= 0 ? '+' : '-') + label;
}

function _renderInvestorList(elId, items, limit = 15) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = '<div class="brief-empty">데이터가 없습니다.</div>';
    return;
  }
  el.innerHTML = items.slice(0, limit).map(s => `
    <div class="brief-signal-item" onclick="navigateToChart('${s.ticker}')">
      <span class="brief-signal-ticker">${s.ticker}</span>
      <span class="brief-signal-name">${s.name || ''}</span>
      <span class="brief-signal-pct ${s.foreign_net >= 0 ? 'up' : 'down'}">${_fmtForeignNet(s.foreign_net)}</span>
      ${_fmtSignalPct(s.change_pct)}
    </div>`).join('');
}

function _renderHeldTop() {
  const el = document.getElementById('brief-held-top');
  if (!el) return;
  const tag = (arr, flag, dir) => (arr || []).map(s => ({ ...s, _flag: flag, _dir: dir }));
  const all = [
    ...tag((_lastDailySignals.us || {}).buy,  '🇺🇸', 'buy'),
    ...tag((_lastDailySignals.us || {}).sell, '🇺🇸', 'sell'),
    ...tag((_lastDailySignals.kr || {}).buy,  '🇰🇷', 'buy'),
    ...tag((_lastDailySignals.kr || {}).sell, '🇰🇷', 'sell'),
  ].filter(s => s.held_days != null && !s.is_new);
  all.sort((a, b) => b.held_days - a.held_days);
  const top = all.slice(0, 10);
  if (!top.length) {
    el.innerHTML = '<div class="brief-empty">연속 유지 중인 신호가 없습니다.</div>';
    return;
  }
  el.innerHTML = top.map(s => `
    <div class="brief-signal-item" onclick="navigateToChart('${s.ticker}')">
      <span class="brief-signal-term term-${s.term}">${s.term}</span>
      <span class="brief-signal-ticker">${s._flag} ${s.ticker}</span>
      <span class="brief-signal-name">${s.name || ''}</span>
      <span class="brief-signal-dir ${s._dir}">${s._dir === 'buy' ? '▲매수' : '▼매도'}</span>
      <span class="brief-held-badge">${s.held_days}일째</span>
    </div>`).join('');
}

function _fmtSignalPct(pct, isKr) {
  const v = pct || 0;
  const cls = v >= 0 ? 'up' : 'down';
  return `<span class="brief-signal-pct ${cls}">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</span>`;
}

function _renderSignalList(elId, items, limit = 10) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = '<div class="brief-empty">오늘은 신호가 없습니다.</div>';
    return;
  }
  el.innerHTML = items.slice(0, limit).map(s => `
    <div class="brief-signal-item" onclick="navigateToChart('${s.ticker}')">
      <span class="brief-signal-term term-${s.term}">${s.term}</span>
      <span class="brief-signal-ticker">${s.ticker}</span>
      <span class="brief-signal-name">${s.name || ''}</span>
      ${_heldBadgeHtml(s)}
      ${_fmtSignalPct(s.change_pct)}
    </div>`).join('');
}

function renderDailySignals(market, data) {
  data = data || { buy: [], sell: [] };
  const sell = _hideWeakSell[market] ? (data.sell || []).filter(s => Math.abs(s.score) !== 2) : data.sell;
  _renderSignalList(`brief-signals-${market}-buy`,  data.buy, 10);
  _renderSignalList(`brief-signals-${market}-sell`, sell,     10);
  _renderSignalList(`brief-fullsignal-${market}-buy`,  data.buy,  20);
  _renderSignalList(`brief-fullsignal-${market}-sell`, data.sell, 20);
}

async function loadBriefFearGreed() {
  try {
    const data = await api('/api/fear-greed');
    renderBriefFearGreed(data);
  } catch {}
}

function _fgScoreToRating(score) {
  if (score <= 25) return 'Extreme Fear';
  if (score <= 44) return 'Fear';
  if (score <= 55) return 'Neutral';
  if (score <= 75) return 'Greed';
  return 'Extreme Greed';
}

function _fgCls(rating) {
  return 'fg-' + (rating || '').toLowerCase().replace(/\s+/g, '-');
}

function renderBriefFearGreed(data) {
  if (!data || data.score == null) return;
  const { score, rating, prev_close, prev_1w, prev_1m, prev_1y } = data;

  // 바늘 회전
  const deg = (score / 100 * 180) - 90;
  requestAnimationFrame(() => {
    const n = document.getElementById('brief-fg-needle');
    if (n) n.style.transform = `translateX(-50%) rotate(${deg}deg)`;
  });

  // 점수 + 등급
  const scoreEl  = document.getElementById('brief-fg-score');
  const ratingEl = document.getElementById('brief-fg-rating');
  const rCls = _fgCls(rating);
  if (scoreEl)  { scoreEl.textContent = score;  scoreEl.className  = 'fg-score-big '    + rCls; }
  if (ratingEl) { ratingEl.textContent = rating; ratingEl.className = 'fg-rating-label ' + rCls; }

  // 과거 비교
  const histEl = document.getElementById('brief-fg-history');
  if (!histEl) return;
  const rows = [
    ['Yesterday',  prev_close],
    ['Last Week',  prev_1w],
    ['Last Month', prev_1m],
    ['Last Year',  prev_1y],
  ];
  histEl.innerHTML = rows.map(([label, val]) => {
    const r = _fgScoreToRating(val);
    return `<div class="fg-hist-row">
      <span class="fg-hist-label">${label}</span>
      <span class="fg-hist-val ${_fgCls(r)}">${val}</span>
      <span class="fg-hist-rating">${r}</span>
    </div>`;
  }).join('');
}

async function loadBrief() {
  const el = document.getElementById('brief-stories');
  if (el) el.innerHTML = '<div class="brief-loading">Loading...</div>';

  try {
    const data = await api('/api/brief?period=' + _briefPeriod);
    renderBrief(data);
  } catch (e) {
    if (el) el.innerHTML = '<div class="brief-loading">Failed to load.</div>';
  }
}

function renderBrief(data) {
  // ─ Mood bar
  const m = data.mood || {};
  document.getElementById('brief-mood-label').textContent = m.label || '—';
  document.getElementById('brief-bar-pos').style.width  = (m.positive || 0) + '%';
  document.getElementById('brief-bar-neut').style.width = (m.neutral  || 0) + '%';
  document.getElementById('brief-bar-neg').style.width  = (m.negative || 0) + '%';
  document.getElementById('brief-pct-pos').textContent  = (m.positive || 0) + '% Bullish';
  document.getElementById('brief-pct-neut').textContent = (m.neutral  || 0) + '% Neutral';
  document.getElementById('brief-pct-neg').textContent  = (m.negative || 0) + '% Bearish';
  document.getElementById('brief-item-count').textContent =
    `${data.total_items} items (${data.news_count} news, ${data.report_count} reports)`;
  document.getElementById('brief-updated').textContent =
    new Date().toLocaleTimeString('ko-KR');

  // ─ Most Mentioned Tickers
  const tickerWrap = document.getElementById('brief-tickers');
  if (!data.top_tickers || !data.top_tickers.length) {
    tickerWrap.innerHTML = '<span class="brief-empty">No data</span>';
  } else {
    tickerWrap.innerHTML = data.top_tickers.map(t =>
      `<span class="brief-ticker-tag" onclick="navigateToChart('${t.ticker}')">
         ${t.ticker} <span class="brief-ticker-count">${t.count}</span>
       </span>`
    ).join('');
  }

  // ─ Top Stories
  renderBriefStories('brief-stories', data.top_stories);

  // ─ Report Highlights
  renderBriefStories('brief-reports', data.report_highlights);
}

function renderBriefStories(elId, items) {
  const el = document.getElementById(elId);
  if (!items || !items.length) {
    el.innerHTML = '<div class="brief-empty">No items in this period.</div>';
    return;
  }
  const sentColor = s => s === 'positive' ? 'var(--up)' : s === 'negative' ? 'var(--down)' : 'var(--muted)';
  el.innerHTML = items.map(item => {
    const badge = item.report_type
      ? `<span class="brief-rtype-badge">${item.report_type}</span>` : '';
    const tickerBadge = item.ticker
      ? `<span class="brief-ticker-inline" onclick="event.stopPropagation();navigateToChart('${item.ticker}')">${item.ticker}</span>`
      : '';
    return `
      <div class="brief-story-item" onclick="window.open('${item.url}','_blank')">
        <span class="brief-sentiment-dot" style="background:${sentColor(item.sentiment)}"></span>
        <div class="brief-story-body">
          <div class="brief-story-title">${item.title}</div>
          <div class="brief-story-meta">
            ${badge}
            <span class="news-source">${item.source}</span>
            <span>${item.time}</span>
            ${tickerBadge}
          </div>
        </div>
      </div>`;
  }).join('');
}
