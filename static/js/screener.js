/* ═══════════════════════════════════════════════════════════════
   screener.js — 종목 스크리너 (필터 + 뷰탭 + 정렬 + 자동 새로고침)
   ═══════════════════════════════════════════════════════════════ */

let _scStocks       = [];
window._scStocks    = _scStocks;   // 히트맵 등 타 모듈에서 참조용
let _krStocks       = [];
window._krStocks    = _krStocks;   // 글로벌 검색 참조용
let _sortCol        = 'change_pct';
let _sortDir        = -1;   // -1: 내림차순, 1: 오름차순
let _scRefreshTimer = null;
let _scLoading      = false;
let _scView         = 'overview';   // overview | fundamental | performance
let _scPage         = 1;
const _SC_PAGE_SIZE = 100;
let _scMarket       = 'us';        // 'us' | 'kr'

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
const _COL_STORAGE_KEY  = 'sc_hidden_cols';
const _PRESET_STORAGE_KEY = 'sc_presets';
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

// ── 필터 프리셋 저장/불러오기 ─────────────────────────────────────────────────
function _getPresets() {
  try { return JSON.parse(localStorage.getItem(_PRESET_STORAGE_KEY)) || []; } catch { return []; }
}
function _savePresets(list) {
  localStorage.setItem(_PRESET_STORAGE_KEY, JSON.stringify(list));
}

function _currentFilterValues() {
  return {
    sector:   document.getElementById('filter-sector')?.value   || 'all',
    industry: document.getElementById('filter-industry')?.value || 'all',
    country:  document.getElementById('filter-country')?.value  || 'all',
    cap:      document.getElementById('filter-cap')?.value      || 'all',
    pe:       document.getElementById('filter-pe')?.value       || 'all',
    chg:      document.getElementById('filter-change')?.value    || 'all',
    w52:      document.getElementById('filter-52w')?.value      || 'all',
    search:   document.getElementById('filter-search')?.value   || '',
  };
}

function _applyFilterValues(vals) {
  if (!vals) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('filter-sector',   vals.sector);
  set('filter-country',  vals.country);
  set('filter-cap',      vals.cap);
  set('filter-pe',       vals.pe);
  set('filter-change',   vals.chg);
  set('filter-52w',      vals.w52);
  set('filter-search',   vals.search);
  // industry: 섹터 변경 후 동적 목록이 채워진 뒤 적용
  const secEl = document.getElementById('filter-sector');
  if (secEl && vals.sector !== 'all') {
    secEl.dispatchEvent(new Event('change'));
    setTimeout(() => { set('filter-industry', vals.industry); renderScreener(true); }, 50);
  } else {
    set('filter-industry', vals.industry);
    renderScreener(true);
  }
}

function _renderPresetSelect() {
  const sel = document.getElementById('sc-preset-select');
  if (!sel) return;
  const presets = _getPresets();
  sel.innerHTML = '<option value="">필터 프리셋…</option>' +
    presets.map((p, i) => `<option value="${i}">${p.name}</option>`).join('');
}

function saveScPreset() {
  const name = prompt('프리셋 이름을 입력하세요:');
  if (!name || !name.trim()) return;
  const list = _getPresets();
  if (list.length >= 10) { alert('최대 10개까지 저장할 수 있습니다.'); return; }
  list.push({ name: name.trim(), filters: _currentFilterValues() });
  _savePresets(list);
  _renderPresetSelect();
  const sel = document.getElementById('sc-preset-select');
  if (sel) sel.value = list.length - 1;
}

function deleteScPreset() {
  const sel = document.getElementById('sc-preset-select');
  if (!sel || sel.value === '') { alert('삭제할 프리셋을 먼저 선택하세요.'); return; }
  const idx = parseInt(sel.value);
  const list = _getPresets();
  if (!confirm(`"${list[idx]?.name}" 프리셋을 삭제할까요?`)) return;
  list.splice(idx, 1);
  _savePresets(list);
  _renderPresetSelect();
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
    window._scStocks = _scStocks;
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
  // 마켓 탭 이벤트 (최초 1회만 등록)
  if (!initScreener._marketBound) {
    initScreener._marketBound = true;
    document.querySelectorAll('.sc-market-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sc-market-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _scMarket = btn.dataset.market;
        _scPage = 1;
        if (_scMarket === 'kr') {
          loadKrScreener(true);
        } else {
          _showUsMode();
          loadScreenerData(true);
        }
      });
    });
  }

  if (_scMarket === 'kr') {
    loadKrScreener(false);
  } else if (!_scStocks.length) {
    bindScreenerEvents();
    loadScreenerData(true);
  } else {
    loadScreenerData(false);
  }
  if (typeof io === 'undefined') _startScAutoRefresh();
  _renderPresetSelect();
  const presetSel = document.getElementById('sc-preset-select');
  if (presetSel && !presetSel._bound) {
    presetSel._bound = true;
    presetSel.addEventListener('change', () => {
      if (presetSel.value === '') return;
      const list = _getPresets();
      const preset = list[parseInt(presetSel.value)];
      if (preset) _applyFilterValues(preset.filters);
    });
  }
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
function renderScreener(resetPage = false) {
  if (resetPage) _scPage = 1;
  _renderHead();
  const list  = getFilteredStocks();
  const total = list.length;
  const start = (_scPage - 1) * _SC_PAGE_SIZE;
  const page  = list.slice(start, start + _SC_PAGE_SIZE);

  document.getElementById('filter-count-label').textContent = `${total.toLocaleString()} results`;

  const body = document.getElementById('screener-body');
  if (_scView === 'overview') {
    body.innerHTML = page.map((s, idx) => _rowOverview(s, start + idx + 1)).join('');
  } else if (_scView === 'fundamental') {
    body.innerHTML = page.map((s, idx) => _rowFundamental(s, start + idx + 1)).join('');
  } else {
    body.innerHTML = page.map((s, idx) => _rowPerformance(s, start + idx + 1)).join('');
  }

  _renderPagination(total);
}

// ── 페이지네이션 렌더링 ───────────────────────────────────────────────────────
function _renderPagination(total) {
  const el = document.getElementById('sc-pagination');
  if (!el) return;

  const totalPages = Math.ceil(total / _SC_PAGE_SIZE);
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const start = (_scPage - 1) * _SC_PAGE_SIZE + 1;
  const end   = Math.min(_scPage * _SC_PAGE_SIZE, total);

  // 표시할 페이지 번호 범위 (현재 ±2)
  const range = [];
  for (let p = Math.max(1, _scPage - 2); p <= Math.min(totalPages, _scPage + 2); p++) range.push(p);

  const btnCls = p => `sc-page-btn${p === _scPage ? ' active' : ''}`;
  const nums = range.map(p =>
    `<button class="${btnCls(p)}" onclick="_goPage(${p})">${p}</button>`
  ).join('');

  el.innerHTML = `
    <span class="sc-page-info">${start.toLocaleString()}–${end.toLocaleString()} / ${total.toLocaleString()}</span>
    <div class="sc-page-btns">
      <button class="sc-page-btn" onclick="_goPage(1)" ${_scPage===1?'disabled':''}>«</button>
      <button class="sc-page-btn" onclick="_goPage(${_scPage-1})" ${_scPage===1?'disabled':''}>‹</button>
      ${nums}
      <button class="sc-page-btn" onclick="_goPage(${_scPage+1})" ${_scPage===totalPages?'disabled':''}>›</button>
      <button class="sc-page-btn" onclick="_goPage(${totalPages})" ${_scPage===totalPages?'disabled':''}>»</button>
    </div>`;
}

function _goPage(p) {
  const total = getFilteredStocks().length;
  const totalPages = Math.ceil(total / _SC_PAGE_SIZE);
  _scPage = Math.max(1, Math.min(p, totalPages));
  renderScreener();
  document.getElementById('screener-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  return `<tr onclick="openStockModal('${s.ticker}')">
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

  return `<tr onclick="openStockModal('${s.ticker}')">
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

  return `<tr onclick="openStockModal('${s.ticker}')">
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
    if (el) el.addEventListener('change', () => renderScreener(true));
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

  document.getElementById('filter-search').addEventListener('input', () => renderScreener(true));

  // 새로고침 버튼
  const btn = document.getElementById('sc-refresh-btn');
  if (btn) btn.addEventListener('click', () => loadScreenerData(false));

  // CSV 내보내기 버튼
  const exportBtn = document.getElementById('sc-export-btn');
  if (exportBtn) exportBtn.addEventListener('click', exportScreenerCSV);

  // 뷰 탭 전환
  document.querySelectorAll('.sc-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sc-view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _scView = btn.dataset.scview;
      _scPage = 1;
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

// ── 종목 상세 모달 ────────────────────────────────────────────────────────────
function openStockModal(ticker) {
  const s = _scStocks.find(x => x.ticker === ticker);
  if (!s) return;

  const modal = document.getElementById('stock-modal');
  if (!modal) return;

  // 헤더
  const pct = s.change_pct ?? 0;
  const cls = pct >= 0 ? 'up' : 'down';
  document.getElementById('sm-ticker').textContent = s.ticker;
  document.getElementById('sm-name').textContent   = s.name + (s.name_ko ? ` (${s.name_ko})` : '');
  document.getElementById('sm-price').textContent  = s.price ? fmt$(s.price) : '—';
  const chgEl = document.getElementById('sm-change');
  chgEl.textContent = s.price ? `${pct >= 0 ? '+' : ''}${fmtPct(pct)}` : '—';
  chgEl.className   = 'sm-change ' + cls;

  // 통계 그리드
  const pos = _calc52wPos(s);
  const stats = [
    { label: 'Sector',    value: s.sector   || '—' },
    { label: 'Industry',  value: s.industry || '—' },
    { label: 'Country',   value: s.country  || '—' },
    { label: 'Mkt Cap',   value: s.market_cap ? fmtCap(s.market_cap) : '—' },
    { label: 'Volume',    value: s.volume     ? fmtVol(s.volume)      : '—' },
    { label: 'P/E',       value: s.pe  != null ? s.pe.toFixed(1)  : '—' },
    { label: 'EPS (TTM)', value: s.eps != null ? fmt$(s.eps)       : '—' },
    { label: '52W High',  value: s.week52_high ? fmt$(s.week52_high) : '—' },
    { label: '52W Low',   value: s.week52_low  ? fmt$(s.week52_low)  : '—' },
    { label: '52W Pos',   value: pos !== null ? pos + '%' : '—' },
  ];
  document.getElementById('sm-stats').innerHTML = stats.map(st =>
    `<div class="sm-stat"><span class="sm-stat-label">${st.label}</span><span class="sm-stat-value">${st.value}</span></div>`
  ).join('');

  // ★ 워치리스트 버튼
  document.getElementById('sm-star-wrap').innerHTML = starBtn(ticker);

  // 차트 버튼
  const chartBtn = document.getElementById('sm-chart-btn');
  chartBtn.onclick = () => { closeStockModal(); navigateToChart(ticker); };

  // 뉴스 버튼 — News 탭으로 이동 후 ticker 키워드 자동 설정
  const newsBtn = document.getElementById('sm-news-btn');
  if (newsBtn) {
    newsBtn.onclick = () => {
      closeStockModal();
      switchView('news');
      setTimeout(() => {
        const kwInput = document.getElementById('news-kw-search');
        if (kwInput) {
          kwInput.value = ticker;
          kwInput.dispatchEvent(new Event('input'));
        }
      }, 80);
    };
  }

  // ESC 키 닫기
  document.onkeydown = e => { if (e.key === 'Escape') closeStockModal(); };

  // 모달 표시
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // 뉴스 비동기 로드
  document.getElementById('sm-news').innerHTML = '<div class="sm-news-loading">Loading…</div>';
  api('/api/stock-news/' + ticker).then(items => {
    const news = (items || []).slice(0, 3);
    if (!news.length) {
      document.getElementById('sm-news').innerHTML = '<div class="sm-news-empty">No recent news.</div>';
      return;
    }
    document.getElementById('sm-news').innerHTML = news.map(n => {
      const dot = n.sentiment === 'positive' ? '🟢' : n.sentiment === 'negative' ? '🔴' : '⚪';
      return `<div class="sm-news-item" onclick="window.open('${n.url}','_blank')">
        <span class="sm-news-dot">${dot}</span>
        <div class="sm-news-body">
          <div class="sm-news-title">${n.title}</div>
          <div class="sm-news-meta">${n.source || ''} · ${n.time || ''}</div>
        </div>
      </div>`;
    }).join('');
  }).catch(() => {
    document.getElementById('sm-news').innerHTML = '<div class="sm-news-empty">Failed to load news.</div>';
  });
}

function closeStockModal(e) {
  if (e && e.target !== document.getElementById('stock-modal')) return;
  const modal = document.getElementById('stock-modal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
  document.onkeydown = null;
}

// ── CSV 내보내기 ──────────────────────────────────────────────────────────────
function exportScreenerCSV() {
  const list = getFilteredStocks();
  if (!list.length) return;

  const headers = ['No','Ticker','Name','Sector','Industry','Country',
    'Price','Change%','Volume','MarketCap(B)','PE','EPS','52W_High','52W_Low'];

  const rows = list.map((s, i) => [
    i + 1,
    s.ticker,
    `"${(s.name || '').replace(/"/g, '""')}"`,
    s.sector   || '',
    s.industry || '',
    s.country  || '',
    s.price       != null ? s.price       : '',
    s.change_pct  != null ? s.change_pct  : '',
    s.volume      != null ? s.volume      : '',
    s.market_cap  != null ? s.market_cap  : '',
    s.pe          != null ? s.pe          : '',
    s.eps         != null ? s.eps         : '',
    s.week52_high != null ? s.week52_high : '',
    s.week52_low  != null ? s.week52_low  : '',
  ].join(','));

  const csv  = [headers.join(','), ...rows].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `screener_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ══════════════════════════════════════════════════════════════════
// 국내주식 (KR) 스크리너
// ══════════════════════════════════════════════════════════════════

async function loadKrScreener(showSpinner = false) {
  if (_scLoading) return;
  _scLoading = true;
  const body = document.getElementById('screener-body');
  if (showSpinner && body) body.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--muted)">🇰🇷 국내주식 로딩 중…</td></tr>';
  try {
    const q = (document.getElementById('filter-search')?.value || '').trim();
    const url = '/api/kr-stocks' + (q ? `?q=${encodeURIComponent(q)}` : '');
    _krStocks = await api(url);
    window._krStocks = _krStocks;
    renderKrScreener();
  } catch (e) {
    if (body) body.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--red)">데이터 로드 실패</td></tr>';
  } finally {
    _scLoading = false;
  }
}

function _getKrFiltered() {
  let list = [..._krStocks];
  // 마켓 필터 (KOSPI/KOSDAQ) — sector 필터 재활용
  const sec = document.getElementById('filter-sector')?.value || 'all';
  if (sec === 'KOSPI' || sec === 'KOSDAQ') list = list.filter(s => s.market === sec);
  // 등락률 필터
  const chg = document.getElementById('filter-change')?.value || 'all';
  if (chg === 'up')    list = list.filter(s => (s.change_pct || 0) > 0);
  if (chg === 'down')  list = list.filter(s => (s.change_pct || 0) < 0);
  if (chg === 'up2')   list = list.filter(s => (s.change_pct || 0) >= 2);
  if (chg === 'up5')   list = list.filter(s => (s.change_pct || 0) >= 5);
  if (chg === 'down2') list = list.filter(s => (s.change_pct || 0) <= -2);
  if (chg === 'down5') list = list.filter(s => (s.change_pct || 0) <= -5);
  // 시가총액 필터 (KRW 단위: 100조=1e14, 10조=1e13, 1조=1e12)
  const cap = document.getElementById('filter-cap')?.value || 'all';
  switch (cap) {
    case 'mega':  list = list.filter(s => s.market_cap >= 1e14); break;
    case 'large': list = list.filter(s => s.market_cap >= 1e13 && s.market_cap < 1e14); break;
    case 'mid':   list = list.filter(s => s.market_cap >= 1e12 && s.market_cap < 1e13); break;
    case 'small': list = list.filter(s => s.market_cap > 0 && s.market_cap < 1e12); break;
  }
  // 검색
  const q = (document.getElementById('filter-search')?.value || '').trim().toLowerCase();
  if (q) list = list.filter(s =>
    s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
  // 정렬
  list.sort((a, b) => {
    let av = a[_sortCol] ?? 0, bv = b[_sortCol] ?? 0;
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    return av < bv ? _sortDir : av > bv ? -_sortDir : 0;
  });
  return list;
}

function renderKrScreener() {
  // 뷰탭 숨김 (KR 모드에선 단일 뷰)
  document.querySelector('.sc-view-tabs-row').style.display = 'none';

  const all    = _getKrFiltered();
  const total  = all.length;
  const start  = (_scPage - 1) * _SC_PAGE_SIZE;
  const paged  = all.slice(start, start + _SC_PAGE_SIZE);

  const head = document.getElementById('screener-head');
  const body = document.getElementById('screener-body');
  if (!head || !body) return;

  const cols = [
    { key: null,         label: '',          cls: '' },
    { key: '_no',        label: 'No',        cls: 'sc-no' },
    { key: 'code',       label: '종목코드',  cls: 'td-ticker' },
    { key: 'name',       label: '종목명',    cls: 'td-name' },
    { key: 'market',     label: '시장',      cls: '' },
    { key: 'price',      label: '현재가',    cls: 'num' },
    { key: 'change_pct', label: '등락률',    cls: 'num' },
    { key: 'volume',     label: '거래량',    cls: 'num' },
    { key: 'market_cap', label: '시가총액',  cls: 'num' },
  ];

  head.innerHTML = '<tr>' + cols.map(c => {
    if (!c.key) return '<th style="width:28px"></th>';
    const active = _sortCol === c.key;
    const arrow  = active ? (_sortDir === -1 ? ' ▼' : ' ▲') : '';
    return `<th class="sc-th${active ? ' sort-active' : ''}" data-col="${c.key}" style="cursor:pointer">${c.label}${arrow}</th>`;
  }).join('') + '</tr>';

  head.querySelectorAll('.sc-th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (_sortCol === col) _sortDir *= -1; else { _sortCol = col; _sortDir = -1; }
      renderKrScreener();
    });
  });

  const fmtKrw  = v => v ? '₩' + Math.round(v).toLocaleString('ko-KR') : '—';
  const fmtVol  = v => v >= 1e8 ? (v/1e8).toFixed(1)+'억' : v >= 1e4 ? (v/1e4).toFixed(0)+'만' : v ? v.toLocaleString() : '—';
  const fmtCap  = v => v >= 1e12 ? (v/1e12).toFixed(1)+'조' : v >= 1e8 ? (v/1e8).toFixed(0)+'억' : '—';
  const mktBadge = m => `<span class="sc-sector-badge badge-${m === 'KOSPI' ? 'technology' : 'finance'}">${m}</span>`;

  body.innerHTML = paged.map((s, i) => {
    const no  = start + i + 1;
    const cls = s.change_pct > 0 ? 'pos' : s.change_pct < 0 ? 'neg' : '';
    return `<tr style="cursor:pointer" onclick="navigateToChart('${s.ticker}')">
      <td onclick="event.stopPropagation()" style="width:28px">${starBtn(s.ticker)}</td>
      <td class="sc-no">${no}</td>
      <td class="td-ticker">${s.code}</td>
      <td class="td-name">${s.name}</td>
      <td>${mktBadge(s.market)}</td>
      <td class="num">${fmtKrw(s.price)}</td>
      <td class="num ${cls}">${s.change_pct != null ? (s.change_pct > 0 ? '+' : '') + s.change_pct.toFixed(2) + '%' : '—'}</td>
      <td class="num">${fmtVol(s.volume)}</td>
      <td class="num">${fmtCap(s.market_cap)}</td>
    </tr>`;
  }).join('');

  const countEl = document.getElementById('filter-count-label');
  if (countEl) countEl.textContent = `${total.toLocaleString()} results`;
  _renderPagination(total);
}

function _showUsMode() {
  const row = document.querySelector('.sc-view-tabs-row');
  if (row) row.style.display = '';
}
