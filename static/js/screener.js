/* ═══════════════════════════════════════════════════════════════
   screener.js — 종목 스크리너 (필터 + 뷰탭 + 정렬 + 자동 새로고침)
   ═══════════════════════════════════════════════════════════════ */

let _scStocks       = [];
let _sortCol        = 'change_pct';
let _sortDir        = -1;   // -1: 내림차순, 1: 오름차순
let _scRefreshTimer = null;
let _scLoading      = false;
let _scView         = 'overview';   // overview | fundamental | performance

// ── 뷰별 컬럼 정의 (fixed: true = 항상 표시, 숨김 불가) ─────────────────────
const _VIEWS = {
  overview: [
    { key: null,          label: '',         cls: '',          fixed: true },
    { key: '_no',         label: 'No',       cls: 'sc-no',     fixed: true },
    { key: 'ticker',      label: 'Ticker',   cls: 'td-ticker', fixed: true },
    { key: 'name',        label: 'Name',     cls: 'td-name',   fixed: true },
    { key: 'sector',      label: 'Sector',   cls: 'td-sector' },
    { key: 'price',       label: 'Price',    cls: 'num' },
    { key: 'change',      label: 'Change',   cls: 'num' },
    { key: 'change_pct',  label: 'Chg %',    cls: 'num' },
    { key: 'volume',      label: 'Volume',   cls: 'num' },
    { key: 'market_cap',  label: 'Mkt Cap',  cls: 'num' },
  ],
  fundamental: [
    { key: null,          label: '',          cls: '',            fixed: true },
    { key: '_no',         label: 'No',        cls: 'sc-no',       fixed: true },
    { key: 'ticker',      label: 'Ticker',    cls: 'td-ticker',   fixed: true },
    { key: 'name',        label: 'Name',      cls: 'td-name',     fixed: true },
    { key: 'sector',      label: 'Sector',    cls: 'td-sector' },
    { key: 'industry',    label: 'Industry',  cls: 'td-industry' },
    { key: 'country',     label: 'Country',   cls: 'td-country' },
    { key: 'market_cap',  label: 'Mkt Cap',   cls: 'num' },
    { key: 'pe',          label: 'P/E',       cls: 'num' },
    { key: 'eps',         label: 'EPS (TTM)', cls: 'num' },
    { key: 'week52_high', label: '52W High',  cls: 'num' },
    { key: 'week52_low',  label: '52W Low',   cls: 'num' },
  ],
  performance: [
    { key: null,          label: '',         cls: '',          fixed: true },
    { key: '_no',         label: 'No',       cls: 'sc-no',     fixed: true },
    { key: 'ticker',      label: 'Ticker',   cls: 'td-ticker', fixed: true },
    { key: 'name',        label: 'Name',     cls: 'td-name',   fixed: true },
    { key: 'price',       label: 'Price',    cls: 'num' },
    { key: 'change_pct',  label: 'Chg %',    cls: 'num' },
    { key: 'volume',      label: 'Volume',   cls: 'num' },
    { key: 'market_cap',  label: 'Mkt Cap',  cls: 'num' },
    { key: 'week52_high', label: '52W High', cls: 'num' },
    { key: 'week52_low',  label: '52W Low',  cls: 'num' },
    { key: '_52wpos',     label: '52W Pos',  cls: 'num' },
  ],
};

// ── 컬럼 숨김 상태 (뷰별 독립, localStorage 저장) ───────────────────────────
const _COL_STORAGE_KEY = 'sc_hidden_cols';
let _hiddenCols = { overview: new Set(), fundamental: new Set(), performance: new Set() };

function _loadHiddenCols() {
  try {
    const raw = localStorage.getItem(_COL_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    for (const v of ['overview', 'fundamental', 'performance']) {
      if (Array.isArray(parsed[v])) _hiddenCols[v] = new Set(parsed[v]);
    }
  } catch (e) {}
}

function _saveHiddenCols() {
  const obj = {};
  for (const v of ['overview', 'fundamental', 'performance']) obj[v] = [..._hiddenCols[v]];
  localStorage.setItem(_COL_STORAGE_KEY, JSON.stringify(obj));
}

// 숨김 컬럼이면 빈 문자열, 아니면 content 반환
function _hd(key, content) {
  return _hiddenCols[_scView].has(key) ? '' : content;
}

// ── 데이터 로드 ──────────────────────────────────────────────────────────────
async function loadScreenerData(showSpinner = false) {
  if (_scLoading) return;
  _scLoading = true;

  const btn = document.getElementById('sc-refresh-btn');
  if (btn) btn.classList.add('spinning');

  if (showSpinner && _scStocks.length === 0) {
    document.getElementById('screener-body').innerHTML =
      `<tr><td colspan="11" class="sc-loading-row">
        <span class="sc-spinner"></span> 데이터 불러오는 중...
      </td></tr>`;
  }

  try {
    _scStocks = await api('/api/stocks');
    _populateIndustryFilter();
    _populateCountryFilter();
    renderScreener();
    _updateScTimestamp();
  } catch (e) {
    console.warn('screener reload failed', e);
  } finally {
    _scLoading = false;
    if (btn) btn.classList.remove('spinning');
  }
}

function _updateScTimestamp() {
  const el = document.getElementById('sc-last-updated');
  if (el) el.textContent = new Date().toLocaleTimeString('ko-KR');
}

// ── 스크리너 탭 진입 ─────────────────────────────────────────────────────────
function initScreener() {
  if (!_scStocks.length) {
    bindScreenerEvents();
    loadScreenerData(true);
  } else {
    loadScreenerData(false);
  }
  if (typeof io === 'undefined') _startScAutoRefresh();
}

function stopScreenerRefresh() {
  if (_scRefreshTimer) { clearInterval(_scRefreshTimer); _scRefreshTimer = null; }
}

function _startScAutoRefresh() {
  stopScreenerRefresh();
  _scRefreshTimer = setInterval(() => {
    const view = document.getElementById('view-screener');
    if (view && view.classList.contains('active')) loadScreenerData(false);
  }, 30_000);
}

// ── 드롭다운 채우기 ──────────────────────────────────────────────────────────
function _populateIndustryFilter() {
  const sel = document.getElementById('filter-industry');
  if (!sel) return;
  const current = sel.value;
  const sector = document.getElementById('filter-sector').value;
  const subset = sector === 'all' ? _scStocks : _scStocks.filter(s => s.sector === sector);
  const industries = [...new Set(subset.map(s => s.industry).filter(Boolean))].sort();
  sel.innerHTML = '<option value="all">All Industries</option>' +
    industries.map(i => `<option value="${i}"${i === current ? ' selected' : ''}>${i}</option>`).join('');
}

function _populateCountryFilter() {
  const sel = document.getElementById('filter-country');
  if (!sel || sel.options.length > 2) return;  // 이미 채워진 경우 스킵
  const countries = [...new Set(_scStocks.map(s => s.country).filter(Boolean))].sort();
  sel.innerHTML = '<option value="all">All Countries</option>' +
    countries.map(c => `<option value="${c}">${c}</option>`).join('');
}

// ── 52W 위치 % 계산 ──────────────────────────────────────────────────────────
function _calc52wPos(s) {
  if (!s.price || !s.week52_high || !s.week52_low) return null;
  const range = s.week52_high - s.week52_low;
  if (range <= 0) return null;
  return Math.round(((s.price - s.week52_low) / range) * 100);
}

// ── 필터 + 정렬 적용 ────────────────────────────────────────────────────────
function getFilteredStocks() {
  const sector   = document.getElementById('filter-sector').value;
  const industry = document.getElementById('filter-industry')?.value || 'all';
  const country  = document.getElementById('filter-country')?.value || 'all';
  const change   = document.getElementById('filter-change').value;
  const cap      = document.getElementById('filter-cap').value;
  const pe       = document.getElementById('filter-pe')?.value || 'all';
  const w52      = document.getElementById('filter-52w')?.value || 'all';
  const search   = document.getElementById('filter-search').value.trim().toLowerCase();

  let list = _scStocks.filter(s => {
    if (sector   !== 'all' && s.sector   !== sector)   return false;
    if (industry !== 'all' && s.industry !== industry) return false;
    if (country  !== 'all' && s.country  !== country)  return false;
    if (search && !s.ticker.toLowerCase().includes(search) && !s.name.toLowerCase().includes(search)) return false;

    // Change %
    switch (change) {
      case 'up5':   if (s.change_pct <  5)  return false; break;
      case 'up2':   if (s.change_pct <  2)  return false; break;
      case 'up0':   if (s.change_pct <= 0)  return false; break;
      case 'down0': if (s.change_pct >= 0)  return false; break;
      case 'down2': if (s.change_pct > -2)  return false; break;
      case 'down5': if (s.change_pct > -5)  return false; break;
    }

    // Market Cap
    switch (cap) {
      case 'mega':  if (!s.market_cap || s.market_cap < 500)                          return false; break;
      case 'large': if (!s.market_cap || s.market_cap < 100 || s.market_cap >= 500)   return false; break;
      case 'mid':   if (!s.market_cap || s.market_cap < 10  || s.market_cap >= 100)   return false; break;
      case 'small': if (!s.market_cap || s.market_cap >= 10)                          return false; break;
    }

    // P/E
    switch (pe) {
      case 'has': if (!s.pe || s.pe <= 0)  return false; break;
      case 'u15': if (!s.pe || s.pe <= 0 || s.pe >= 15)  return false; break;
      case 'u20': if (!s.pe || s.pe <= 0 || s.pe >= 20)  return false; break;
      case 'u30': if (!s.pe || s.pe <= 0 || s.pe >= 30)  return false; break;
      case 'o30': if (!s.pe || s.pe <= 30) return false; break;
      case 'neg': if (!s.pe || s.pe >= 0)  return false; break;
    }

    // 52W Position
    if (w52 !== 'all') {
      const pos = _calc52wPos(s);
      if (pos === null) return false;
      if (w52 === 'near_high' && pos < 80)  return false;
      if (w52 === 'mid'       && (pos < 20 || pos > 80)) return false;
      if (w52 === 'near_low'  && pos > 20)  return false;
    }

    return true;
  });

  // 정렬
  list.sort((a, b) => {
    let av = a[_sortCol], bv = b[_sortCol];
    if (_sortCol === '_52wpos') { av = _calc52wPos(a); bv = _calc52wPos(b); }
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv) * _sortDir;
    return (av - bv) * _sortDir;
  });

  return list;
}

// ── 테이블 헤더 렌더링 ───────────────────────────────────────────────────────
function _renderHead() {
  const cols = _VIEWS[_scView].filter(c => c.fixed || !c.key || !_hiddenCols[_scView].has(c.key));
  const thead = document.getElementById('screener-head');
  thead.innerHTML = '<tr>' + cols.map(c => {
    if (!c.key) return `<th></th>`;
    const active = c.key === _sortCol ? ' sort-active ' + (_sortDir === 1 ? 'asc' : 'desc') : '';
    const skip = ['_no'].includes(c.key) ? '' : ` data-col="${c.key}"`;
    return `<th class="${c.cls}${active}"${skip}>${c.label}</th>`;
  }).join('') + '</tr>';

  // 정렬 이벤트 재바인딩
  thead.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      _sortDir = _sortCol === col ? _sortDir * -1 : -1;
      _sortCol = col;
      renderScreener();
    });
  });
}

// ── 테이블 바디 렌더링 ───────────────────────────────────────────────────────
function renderScreener() {
  _renderHead();
  const list = getFilteredStocks();
  document.getElementById('filter-count-label').textContent = `${list.length.toLocaleString()} results`;

  const body = document.getElementById('screener-body');

  if (_scView === 'overview') {
    body.innerHTML = list.map((s, idx) => _rowOverview(s, idx + 1)).join('');
  } else if (_scView === 'fundamental') {
    body.innerHTML = list.map((s, idx) => _rowFundamental(s, idx + 1)).join('');
  } else {
    body.innerHTML = list.map((s, idx) => _rowPerformance(s, idx + 1)).join('');
  }
}

// ── 행 렌더링: Overview ──────────────────────────────────────────────────────
function _rowOverview(s, no) {
  const pct    = s.change_pct ?? 0;
  const cls    = pct >= 0 ? 'up' : 'down';
  const bgCls  = pct >= 0 ? 'up-bg' : 'down-bg';
  const price  = s.price;

  const priceCell = price
    ? `<span class="sc-price">${fmt$(price)}</span>`
    : `<span class="sc-price-loading">···</span>`;
  const chgCell = (s.change != null && price)
    ? `<span class="${cls}">${s.change >= 0 ? '+' : ''}${fmt$(s.change)}</span>`
    : '—';

  return `<tr onclick="navigateToChart('${s.ticker}')">
    <td onclick="event.stopPropagation()">${starBtn(s.ticker)}</td>
    <td class="sc-no">${no}</td>
    <td class="td-ticker">${s.ticker}</td>
    <td class="td-name">${s.name}${s.name_ko ? `<span class="td-name-ko">(${s.name_ko})</span>` : ''}</td>
    ${_hd('sector',     `<td class="td-sector"><span class="sc-sector-badge sc-sec-${_secKey(s.sector)}">${s.sector || '—'}</span></td>`)}
    ${_hd('price',      `<td class="num">${priceCell}</td>`)}
    ${_hd('change',     `<td class="num">${chgCell}</td>`)}
    ${_hd('change_pct', `<td class="num">${price ? `<span class="chg-cell ${bgCls} ${cls}">${fmtPct(pct)}</span>` : '—'}</td>`)}
    ${_hd('volume',     `<td class="num">${s.volume ? fmtVol(s.volume) : '—'}</td>`)}
    ${_hd('market_cap', `<td class="num">${s.market_cap ? fmtCap(s.market_cap) : '—'}</td>`)}
  </tr>`;
}

// ── 행 렌더링: Fundamental ────────────────────────────────────────────────────
function _rowFundamental(s, no) {
  const peStr  = s.pe != null ? (s.pe > 0
    ? `<span class="sc-pe ${s.pe < 20 ? 'sc-pe-low' : s.pe < 30 ? 'sc-pe-mid' : 'sc-pe-high'}">${s.pe.toFixed(1)}</span>`
    : `<span class="down">${s.pe.toFixed(1)}</span>`)
    : '—';
  const epsStr = s.eps != null
    ? (s.eps >= 0 ? fmt$(s.eps) : `<span class="down">${fmt$(s.eps)}</span>`)
    : '—';

  return `<tr onclick="navigateToChart('${s.ticker}')">
    <td onclick="event.stopPropagation()">${starBtn(s.ticker)}</td>
    <td class="sc-no">${no}</td>
    <td class="td-ticker">${s.ticker}</td>
    <td class="td-name">${s.name}${s.name_ko ? `<span class="td-name-ko">(${s.name_ko})</span>` : ''}</td>
    ${_hd('sector',     `<td class="td-sector"><span class="sc-sector-badge sc-sec-${_secKey(s.sector)}">${s.sector || '—'}</span></td>`)}
    ${_hd('industry',   `<td class="td-industry">${s.industry || '—'}</td>`)}
    ${_hd('country',    `<td class="td-country"><span class="sc-country">${s.country || '—'}</span></td>`)}
    ${_hd('market_cap', `<td class="num">${s.market_cap ? fmtCap(s.market_cap) : '—'}</td>`)}
    ${_hd('pe',         `<td class="num">${peStr}</td>`)}
    ${_hd('eps',        `<td class="num">${epsStr}</td>`)}
    ${_hd('week52_high',`<td class="num">${s.week52_high ? fmt$(s.week52_high) : '—'}</td>`)}
    ${_hd('week52_low', `<td class="num">${s.week52_low  ? fmt$(s.week52_low)  : '—'}</td>`)}
  </tr>`;
}

// ── 행 렌더링: Performance ────────────────────────────────────────────────────
function _rowPerformance(s, no) {
  const pct   = s.change_pct ?? 0;
  const cls   = pct >= 0 ? 'up' : 'down';
  const bgCls = pct >= 0 ? 'up-bg' : 'down-bg';
  const pos   = _calc52wPos(s);
  const posBar = pos !== null
    ? `<div class="sc-52w-bar"><div class="sc-52w-fill" style="width:${pos}%"></div><span class="sc-52w-val">${pos}%</span></div>`
    : '—';

  return `<tr onclick="navigateToChart('${s.ticker}')">
    <td onclick="event.stopPropagation()">${starBtn(s.ticker)}</td>
    <td class="sc-no">${no}</td>
    <td class="td-ticker">${s.ticker}</td>
    <td class="td-name">${s.name}${s.name_ko ? `<span class="td-name-ko">(${s.name_ko})</span>` : ''}</td>
    ${_hd('price',      `<td class="num">${s.price ? fmt$(s.price) : '—'}</td>`)}
    ${_hd('change_pct', `<td class="num">${s.price ? `<span class="chg-cell ${bgCls} ${cls}">${fmtPct(pct)}</span>` : '—'}</td>`)}
    ${_hd('volume',     `<td class="num">${s.volume ? fmtVol(s.volume) : '—'}</td>`)}
    ${_hd('market_cap', `<td class="num">${s.market_cap ? fmtCap(s.market_cap) : '—'}</td>`)}
    ${_hd('week52_high',`<td class="num">${s.week52_high ? fmt$(s.week52_high) : '—'}</td>`)}
    ${_hd('week52_low', `<td class="num">${s.week52_low  ? fmt$(s.week52_low)  : '—'}</td>`)}
    ${_hd('_52wpos',    `<td class="num">${posBar}</td>`)}
  </tr>`;
}

// ── 섹터 → CSS 키 변환 ────────────────────────────────────────────────────────
function _secKey(sector) {
  if (!sector) return 'other';
  const map = {
    'Technology': 'tech', 'Finance': 'fin', 'Healthcare': 'health',
    'Energy': 'energy', 'Consumer Disc.': 'consd', 'Consumer Staples': 'conss',
    'Industrial': 'ind', 'Communication': 'comm', 'Real Estate': 're',
    'Materials': 'mat', 'Utilities': 'util',
  };
  return map[sector] || 'other';
}

// ── 컬럼 설정 패널 ───────────────────────────────────────────────────────────
function _buildColPanel() {
  const panel = document.getElementById('sc-col-panel');
  if (!panel) return;
  const cols = _VIEWS[_scView].filter(c => c.key && !c.fixed);
  panel.innerHTML = cols.map(c => {
    const checked = !_hiddenCols[_scView].has(c.key) ? 'checked' : '';
    return `<label class="sc-col-chk">
      <input type="checkbox" value="${c.key}" ${checked}>${c.label}
    </label>`;
  }).join('');
  panel.querySelectorAll('input[type=checkbox]').forEach(chk => {
    chk.addEventListener('change', () => {
      if (chk.checked) _hiddenCols[_scView].delete(chk.value);
      else             _hiddenCols[_scView].add(chk.value);
      _saveHiddenCols();
      renderScreener();
    });
  });
}

function _bindColSettingsEvents() {
  const btn   = document.getElementById('sc-col-btn');
  const panel = document.getElementById('sc-col-panel');
  if (!btn || !panel) return;

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = panel.classList.toggle('open');
    if (isOpen) _buildColPanel();
  });

  document.addEventListener('click', e => {
    if (!panel.contains(e.target) && e.target !== btn) {
      panel.classList.remove('open');
    }
  });
}

// ── 이벤트 바인딩 ────────────────────────────────────────────────────────────
function bindScreenerEvents() {
  _loadHiddenCols();
  _bindColSettingsEvents();

  // 필터 변경
  ['filter-sector','filter-industry','filter-country','filter-change',
   'filter-cap','filter-pe','filter-52w'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', renderScreener);
  });

  // 섹터 변경 → 업종 필터 재구성
  document.getElementById('filter-sector').addEventListener('change', () => {
    const sector = document.getElementById('filter-sector').value;
    const sel = document.getElementById('filter-industry');
    if (!sel) return;
    const subset = sector === 'all' ? _scStocks : _scStocks.filter(s => s.sector === sector);
    const industries = [...new Set(subset.map(s => s.industry).filter(Boolean))].sort();
    sel.innerHTML = '<option value="all">All Industries</option>' +
      industries.map(i => `<option value="${i}">${i}</option>`).join('');
    renderScreener();
  });

  document.getElementById('filter-search').addEventListener('input', renderScreener);

  // 새로고침 버튼
  const btn = document.getElementById('sc-refresh-btn');
  if (btn) btn.addEventListener('click', () => loadScreenerData(false));

  // 뷰 탭 전환
  document.querySelectorAll('.sc-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sc-view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _scView = btn.dataset.scview;
      // 기본 정렬 컬럼 설정
      if (_scView === 'fundamental') _sortCol = 'market_cap';
      else if (_scView === 'performance') _sortCol = 'change_pct';
      else _sortCol = 'change_pct';
      _sortDir = -1;
      // 패널이 열려있으면 현재 뷰로 체크박스 갱신
      const panel = document.getElementById('sc-col-panel');
      if (panel && panel.classList.contains('open')) _buildColPanel();
      renderScreener();
    });
  });
}
