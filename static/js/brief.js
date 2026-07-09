/* ═══════════════════════════════════════════════════════════════
   brief.js — 일간/주간/월간 Market Brief 탭
   ═══════════════════════════════════════════════════════════════ */

let _briefPeriod = 'daily';

function initBrief() {
  document.querySelectorAll('.brief-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.brief-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _briefPeriod = btn.dataset.period;
      loadBrief();
    });
  });
  loadBrief();
  loadBriefFearGreed();
  loadDailySignals();
  _briefInited = true;
}

async function loadDailySignals() {
  try {
    const data = await api('/api/daily-signals');
    renderDailySignals('us', data.us);
    renderDailySignals('kr', data.kr);
  } catch {}
}

function _fmtSignalPct(pct, isKr) {
  const v = pct || 0;
  const cls = v >= 0 ? 'up' : 'down';
  return `<span class="brief-signal-pct ${cls}">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</span>`;
}

function _renderSignalList(elId, items) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = '<div class="brief-empty">오늘은 신호가 없습니다.</div>';
    return;
  }
  el.innerHTML = items.slice(0, 10).map(s => `
    <div class="brief-signal-item" onclick="navigateToChart('${s.ticker}')">
      <span class="brief-signal-term term-${s.term}">${s.term}</span>
      <span class="brief-signal-ticker">${s.ticker}</span>
      <span class="brief-signal-name">${s.name || ''}</span>
      ${_fmtSignalPct(s.change_pct)}
    </div>`).join('');
}

function renderDailySignals(market, data) {
  data = data || { buy: [], sell: [] };
  _renderSignalList(`brief-signals-${market}-buy`,  data.buy);
  _renderSignalList(`brief-signals-${market}-sell`, data.sell);
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
