/* ═══════════════════════════════════════════════════════════════
   earnings.js — Earnings Calendar 탭
   ═══════════════════════════════════════════════════════════════ */

let _earnPeriod  = 'week';
let _earnInited  = false;
let _earnData    = [];

async function initEarnings() {
  if (_earnInited) { renderEarnings(); return; }
  _earnInited = true;

  document.querySelectorAll('.earn-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.earn-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _earnPeriod = btn.dataset.period;
      loadEarnings();
    });
  });

  ['earn-filter-sector', 'earn-filter-cap'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', renderEarnings);
  });

  await Promise.all([loadEarnings(), _ensureScStocksLoaded()]);
}

// 업종 필터가 window._scStocks(스크리너 탭 방문 시에만 채워짐)에 의존하므로,
// 스크리너를 거치지 않고 Earnings에 바로 들어온 경우를 위해 직접 로드
async function _ensureScStocksLoaded() {
  if (window._scStocks && window._scStocks.length) return;
  try {
    window._scStocks = await api('/api/stocks');
    renderEarnings();
  } catch (e) {
    console.warn('earnings: sector data load failed', e);
  }
}

function _getEarnSector(symbol) {
  const s = (window._scStocks || []).find(x => x.ticker === symbol);
  return s ? s.sector : null;
}

async function loadEarnings() {
  const content = document.getElementById('earnings-content');
  content.innerHTML = '<div class="loading-msg">Loading...</div>';
  try {
    _earnData = await api(`/api/earnings?period=${_earnPeriod}`);
    renderEarnings();
  } catch (e) {
    content.innerHTML = '<div class="loading-msg">데이터를 불러올 수 없습니다.</div>';
  }
}

function renderEarnings() {
  const content = document.getElementById('earnings-content');
  if (!_earnData || _earnData.length === 0) {
    content.innerHTML = '<div class="loading-msg">이번 기간 실적 발표 일정이 없습니다.</div>';
    return;
  }

  const sectorF = document.getElementById('earn-filter-sector')?.value || 'all';
  const capF    = document.getElementById('earn-filter-cap')?.value || 'all';
  let filtered = _earnData;
  if (sectorF !== 'all') filtered = filtered.filter(item => _getEarnSector(item.symbol) === sectorF);
  if (capF !== 'all') filtered = filtered.filter(item => {
    const cap = item.market_cap;
    if (!cap) return false;
    if (capF === 'mega')  return cap >= 500;
    if (capF === 'large') return cap >= 100 && cap < 500;
    if (capF === 'mid')   return cap >= 10  && cap < 100;
    if (capF === 'small') return cap < 10;
    return true;
  });

  if (!filtered.length) {
    content.innerHTML = '<div class="loading-msg">필터 조건에 맞는 실적 발표 일정이 없습니다.</div>';
    return;
  }

  // 날짜별로 그룹핑
  const byDate = {};
  filtered.forEach(item => {
    if (!byDate[item.date]) byDate[item.date] = [];
    byDate[item.date].push(item);
  });

  const dates = Object.keys(byDate).sort();

  let html = '';
  for (const date of dates) {
    const items = byDate[date];
    const dateLabel = _formatDate(date);
    html += `
      <div class="earn-date-group">
        <div class="earn-date-header">${dateLabel} <span class="earn-date-count">${items.length}개</span></div>
        <div class="earn-table-wrap">
          <table class="earn-table">
            <thead>
              <tr>
                <th>TICKER</th>
                <th>NAME</th>
                <th>TIME</th>
                <th class="num">EPS EST</th>
                <th class="num">LAST YEAR EPS</th>
                <th class="num">MKT CAP</th>
                <th>QUARTER</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(r => _earnRow(r)).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }
  content.innerHTML = html;

  // 티커 클릭 → 차트 이동
  content.querySelectorAll('.earn-ticker').forEach(el => {
    el.addEventListener('click', () => navigateToChart(el.dataset.ticker));
  });
}

function _earnRow(r) {
  const timeClass = r.time === 'Before Open' ? 'earn-time-before'
                  : r.time === 'After Close'  ? 'earn-time-after'
                  : '';
  const cap = r.market_cap ? fmtCap(r.market_cap) : '—';
  return `
    <tr>
      <td><span class="earn-ticker" data-ticker="${r.symbol}">${r.symbol}</span></td>
      <td class="earn-name">${r.name}</td>
      <td><span class="earn-time-badge ${timeClass}">${r.time}</span></td>
      <td class="num">${r.eps_forecast}</td>
      <td class="num">${r.last_year_eps}</td>
      <td class="num">${cap}</td>
      <td class="earn-quarter">${r.fiscal_quarter}</td>
    </tr>`;
}

function _formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
}
