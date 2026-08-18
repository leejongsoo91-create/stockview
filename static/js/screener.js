/* ═══════════════════════════════════════════════════════════════
   screener.js — 종목 스크리너 (필터 + 뷰탭 + 정렬 + 자동 새로고침)
   ═══════════════════════════════════════════════════════════════ */

let _scStocks       = [];
window._scStocks    = _scStocks;   // 히트맵 등 타 모듈에서 참조용
let _krStocks       = [];
window._krStocks    = _krStocks;   // 글로벌 검색 참조용
let _sortCol        = 'change_pct';
let _sortDir        = -1;   // -1: 내림차순, 1: 오름차순
let _sortCol2       = null; // Shift+클릭으로 지정하는 2차 정렬 컬럼 (1차 값이 같을 때만 적용)
let _sortDir2       = -1;
let _scRefreshTimer = null;
let _scLoading      = false;
let _scView         = 'overview';   // overview | fundamental | performance
let _scPage         = 1;
const _SC_PAGE_SIZE = 100;
let _scMarket       = 'us';        // 'us' | 'kr'
let _krMarket       = 'all';       // 'all' | 'KOSPI' | 'KOSDAQ'
let _scSignalMap    = {};          // 오늘의 신호 맵 (main.js loadDailySignalMap 재사용)
let _scSelected      = new Set();  // 체크박스로 선택한 티커 (일괄 워치리스트 추가용)

// ── 뷰별 컬럼 정의 (fixed: true = 항상 표시, 숨김 불가) ─────────────────────
const _VIEWS = {
  overview: [
    { key: null,          label: '',         cls: '',          fixed: true },
    { key: '_no',         label: 'No',       cls: 'sc-no',     fixed: true },
    { key: 'ticker',      label: 'Ticker',   cls: 'td-ticker', fixed: true },
    { key: 'name',        label: 'Name',     cls: 'td-name',   fixed: true },
    { key: 'signal',      label: 'Signal',   cls: '' },
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
    { key: 'signal',      label: 'Signal',    cls: '' },
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
    { key: 'signal',      label: 'Signal',   cls: '' },
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
    market:   _scMarket,   // 'us' | 'kr' — 프리셋을 저장한 시장. 적용 시 이 시장으로 자동 전환됨
    sector:   document.getElementById('filter-sector')?.value   || 'all',
    industry: document.getElementById('filter-industry')?.value || 'all',
    country:  document.getElementById('filter-country')?.value  || 'all',
    cap:      document.getElementById('filter-cap')?.value      || 'all',
    pe:       document.getElementById('filter-pe')?.value       || 'all',
    chg:      document.getElementById('filter-change')?.value    || 'all',
    w52:      document.getElementById('filter-52w')?.value      || 'all',
    search:   document.getElementById('filter-search')?.value   || '',
    normalOnly: document.getElementById('filter-normal-only')?.checked || false,
    signalOnly: document.getElementById('filter-signal-only')?.checked || false,
    watchlistOnly: document.getElementById('filter-watchlist-only')?.checked || false,
  };
}

async function _applyFilterValues(vals) {
  if (!vals) return;
  // 프리셋 저장 당시 시장과 현재 화면이 다르면 먼저 전환(데이터 로드까지 대기) —
  // sector 등 select의 option 목록 자체가 시장별로 다르게 채워지므로 순서가 중요함
  const targetMarket = vals.market || 'us'; // market 필드 없는 구버전 프리셋은 US로 간주
  if (targetMarket !== _scMarket) await _switchScMarket(targetMarket);

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('filter-sector',   vals.sector);
  set('filter-country',  vals.country);
  set('filter-cap',      vals.cap);
  set('filter-pe',       vals.pe);
  set('filter-change',   vals.chg);
  set('filter-52w',      vals.w52);
  set('filter-search',   vals.search);
  const normalOnlyEl = document.getElementById('filter-normal-only');
  if (normalOnlyEl) normalOnlyEl.checked = !!vals.normalOnly;
  const signalOnlyEl = document.getElementById('filter-signal-only');
  if (signalOnlyEl) signalOnlyEl.checked = !!vals.signalOnly;
  const watchlistOnlyEl = document.getElementById('filter-watchlist-only');
  if (watchlistOnlyEl) watchlistOnlyEl.checked = !!vals.watchlistOnly;

  if (targetMarket === 'kr') {
    renderKrScreener();
    return;
  }
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

// ── 일괄 선택 체크박스 (8번: 스크리너 다중선택 → 워치리스트 일괄추가) ──────────
function _scCheckboxHtml(ticker) {
  const checked = _scSelected.has(ticker) ? ' checked' : '';
  return `<input type="checkbox" class="sc-row-check" data-ticker="${ticker}"${checked}
    onclick="event.stopPropagation(); _scToggleSelect('${ticker}', this.checked)">`;
}

function _scToggleSelect(ticker, checked) {
  if (checked) _scSelected.add(ticker); else _scSelected.delete(ticker);
  _scUpdateBulkBar();
}

function _scToggleSelectAllPage() {
  const boxes = document.querySelectorAll('#screener-body .sc-row-check');
  const allChecked = [...boxes].every(b => b.checked);
  boxes.forEach(b => {
    b.checked = !allChecked;
    if (!allChecked) _scSelected.add(b.dataset.ticker); else _scSelected.delete(b.dataset.ticker);
  });
  _scUpdateBulkBar();
}

function _scUpdateBulkBar() {
  const bar = document.getElementById('sc-bulk-bar');
  if (!bar) return;
  const n = _scSelected.size;
  bar.style.display = n > 0 ? '' : 'none';
  const label = document.getElementById('sc-bulk-count');
  if (label) label.textContent = `${n}개 선택됨`;
}

function _scClearSelection() {
  _scSelected.clear();
  document.querySelectorAll('.sc-row-check').forEach(b => b.checked = false);
  _scUpdateBulkBar();
}

function _scBulkAddToWatchlist() {
  if (_scSelected.size === 0) return;
  let added = 0;
  _scSelected.forEach(ticker => {
    if (!WL.has(ticker)) { WL.add(ticker); added++; }
  });
  alert(`${added}개 종목을 관심종목에 추가했습니다.${_scSelected.size - added > 0 ? ` (이미 있던 ${_scSelected.size - added}개 제외)` : ''}`);
  updateWLCount();
  _scClearSelection();
  renderScreener();
}

// ── 데이터 로드 ──────────────────────────────────────────────────────────────
async function loadScreenerData(showSpinner = false) {
  if (_scLoading) return;
  _scLoading = true;

  const btn = document.getElementById('sc-refresh-btn');
  if (btn) btn.classList.add('spinning');

  if (showSpinner && _scStocks.length === 0) {
    document.getElementById('screener-body').innerHTML =
      `<tr><td colspan="12" class="sc-loading-row">
        <span class="sc-spinner"></span> 데이터 불러오는 중...
      </td></tr>`;
  }

  try {
    const [stocks, sigMap] = await Promise.all([api('/api/stocks'), loadDailySignalMap()]);
    _scStocks = stocks;
    _scSignalMap = sigMap;
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

// ── 시장(US/KR) 전환 ─────────────────────────────────────────────────────────
// 탭 버튼 클릭과 프리셋 적용(_applyFilterValues) 양쪽에서 공유하는 전환 로직.
// 데이터 로드가 끝나야 렌더/필터를 적용할 수 있어 async로 대기 가능하게 함.
async function _switchScMarket(target) {
  document.querySelectorAll('.sc-market-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.market === target);
  });
  _scMarket = target;
  _scPage = 1;
  if (target === 'kr') {
    _showKrMktBar();
    await loadKrScreener(true);
  } else {
    _hideKrMktBar();
    _showUsMode();
    await loadScreenerData(true);
  }
}

// ── 스크리너 탭 진입 ─────────────────────────────────────────────────────────
function initScreener() {
  // 마켓 탭 이벤트 (최초 1회만 등록)
  if (!initScreener._marketBound) {
    initScreener._marketBound = true;
    document.querySelectorAll('.sc-market-btn').forEach(btn => {
      btn.addEventListener('click', () => _switchScMarket(btn.dataset.market));
    });
    document.querySelectorAll('.sc-kr-mkt-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sc-kr-mkt-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _krMarket = btn.dataset.krmkt;
        _scPage = 1;
        renderKrScreener();
      });
    });
  }

  bindScreenerEvents();
  if (_scMarket === 'kr') {
    loadKrScreener(false);
  } else if (!_scStocks.length) {
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
    if (!view || !view.classList.contains('active')) return;
    if (_scMarket === 'kr') loadKrScreener(false);
    else loadScreenerData(false);
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

// ── SPAC 워런트/유닛/우선주 등 비정상 종목 판별 ──────────────────────────────
// 시총 데이터가 없는 종목(대부분 SPAC 워런트·유닛·권리락) + 종목명에 명시된 우선주/워런트
// "Units"는 제외 목록에서 뺌 — Energy Transfer(ET), MPLX 같은 MLP 대형주가
// "Common Units"라는 정상 표현을 쓰기 때문에 오탐 발생 (실제로 확인됨)
const _ABNORMAL_NAME_RE = /\b(Warrants?|Rights?|Preferred)\b/i;
function _isAbnormalListing(s) {
  if (!s.market_cap) return true;
  return _ABNORMAL_NAME_RE.test(s.name || '');
}

// ── 52W 위치 % 계산 ──────────────────────────────────────────────────────────
function _calc52wPos(s) {
  if (!s.price || !s.week52_high || !s.week52_low) return null;
  const range = s.week52_high - s.week52_low;
  if (range <= 0) return null;
  return Math.round(((s.price - s.week52_low) / range) * 100);
}

// ── 필터 + 정렬 적용 ────────────────────────────────────────────────────────
function _getFilteredStocks() {
  const sector   = document.getElementById('filter-sector').value;
  const industry = document.getElementById('filter-industry')?.value || 'all';
  const country  = document.getElementById('filter-country')?.value || 'all';
  const change   = document.getElementById('filter-change').value;
  const cap      = document.getElementById('filter-cap').value;
  const pe       = document.getElementById('filter-pe')?.value || 'all';
  const w52      = document.getElementById('filter-52w')?.value || 'all';
  const search   = document.getElementById('filter-search').value.trim().toLowerCase();
  const normalOnly = document.getElementById('filter-normal-only')?.checked || false;
  const signalOnly = document.getElementById('filter-signal-only')?.checked || false;
  const watchlistOnly = document.getElementById('filter-watchlist-only')?.checked || false;

  let list = _scStocks.filter(s => {
    if (sector   !== 'all' && s.sector   !== sector)   return false;
    if (industry !== 'all' && s.industry !== industry) return false;
    if (country  !== 'all' && s.country  !== country)  return false;
    if (search && !s.ticker.toLowerCase().includes(search) && !s.name.toLowerCase().includes(search)) return false;
    if (normalOnly && _isAbnormalListing(s)) return false;
    if (signalOnly && !_scSignalMap[s.ticker]) return false;
    if (watchlistOnly && typeof WL !== 'undefined' && !WL.has(s.ticker)) return false;

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

  // 정렬 (1차 + Shift+클릭으로 지정한 2차)
  const _cmpCol = (a, b, col, dir) => {
    let av = a[col], bv = b[col];
    if (col === '_52wpos') { av = _calc52wPos(a); bv = _calc52wPos(b); }
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  };
  list.sort((a, b) => {
    const primary = _cmpCol(a, b, _sortCol, _sortDir);
    if (primary !== 0 || !_sortCol2) return primary;
    return _cmpCol(a, b, _sortCol2, _sortDir2);
  });

  return list;
}

// ── 테이블 헤더 렌더링 ───────────────────────────────────────────────────────
function _renderHead() {
  const cols = _VIEWS[_scView].filter(c => c.fixed || !c.key || !_hiddenCols[_scView].has(c.key));
  const thead = document.getElementById('screener-head');
  thead.innerHTML = '<tr>' + cols.map(c => {
    if (!c.key) return `<th class="sc-check-cell" title="현재 페이지 전체 선택/해제"><input type="checkbox" onclick="_scToggleSelectAllPage()"></th>`;
    let active = c.key === _sortCol ? ' sort-active ' + (_sortDir === 1 ? 'asc' : 'desc') : '';
    if (c.key === _sortCol2) active += ' sort-active-2 ' + (_sortDir2 === 1 ? 'asc' : 'desc');
    const skip = ['_no'].includes(c.key) ? '' : ` data-col="${c.key}"`;
    const title = c.key && c.key !== '_no' ? ' title="Shift+클릭: 2차 정렬"' : '';
    return `<th class="${c.cls}${active}"${skip}${title}>${c.label}</th>`;
  }).join('') + '</tr>';

  // 정렬 이벤트 재바인딩 (Shift+클릭 = 2차 정렬)
  thead.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', e => {
      const col = th.dataset.col;
      if (e.shiftKey) {
        if (col === _sortCol) return; // 1차 정렬 컬럼과 같으면 무시
        _sortDir2 = _sortCol2 === col ? _sortDir2 * -1 : -1;
        _sortCol2 = col;
      } else {
        _sortDir = _sortCol === col ? _sortDir * -1 : -1;
        _sortCol = col;
        _sortCol2 = null; // 새 1차 정렬 지정 시 2차 정렬 초기화
      }
      renderScreener();
    });
  });
}

// ── 테이블 바디 렌더링 ───────────────────────────────────────────────────────
function renderScreener(resetPage = false) {
  if (resetPage) _scPage = 1;
  _renderHead();
  const list  = _getFilteredStocks();
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
  const total = _getFilteredStocks().length;
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
    <td onclick="event.stopPropagation()" class="sc-check-cell">${_scCheckboxHtml(s.ticker)}${starBtn(s.ticker)}</td>
    <td class="sc-no">${no}</td>
    <td class="td-ticker">${s.ticker}</td>
    <td class="td-name">${s.name}${s.name_ko ? `<span class="td-name-ko">(${s.name_ko})</span>` : ''}</td>
    ${_hd('signal',     `<td>${signalBadgeHtml(s.ticker, _scSignalMap)}</td>`)}
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
    <td onclick="event.stopPropagation()" class="sc-check-cell">${_scCheckboxHtml(s.ticker)}${starBtn(s.ticker)}</td>
    <td class="sc-no">${no}</td>
    <td class="td-ticker">${s.ticker}</td>
    <td class="td-name">${s.name}${s.name_ko ? `<span class="td-name-ko">(${s.name_ko})</span>` : ''}</td>
    ${_hd('signal',     `<td>${signalBadgeHtml(s.ticker, _scSignalMap)}</td>`)}
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
    <td onclick="event.stopPropagation()" class="sc-check-cell">${_scCheckboxHtml(s.ticker)}${starBtn(s.ticker)}</td>
    <td class="sc-no">${no}</td>
    <td class="td-ticker">${s.ticker}</td>
    <td class="td-name">${s.name}${s.name_ko ? `<span class="td-name-ko">(${s.name_ko})</span>` : ''}</td>
    ${_hd('signal',     `<td>${signalBadgeHtml(s.ticker, _scSignalMap)}</td>`)}
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
  if (bindScreenerEvents._bound) return;
  bindScreenerEvents._bound = true;
  _loadHiddenCols();
  _bindColSettingsEvents();

  // 필터 변경 (US/KR 모드에 따라 분기)
  ['filter-sector','filter-industry','filter-country','filter-change',
   'filter-cap','filter-pe','filter-52w','filter-normal-only','filter-signal-only','filter-watchlist-only'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
      if (_scMarket === 'kr') renderKrScreener();
      else renderScreener(true);
    });
  });

  // 섹터 변경 → US 모드에서만 업종 필터 재구성
  document.getElementById('filter-sector').addEventListener('change', () => {
    if (_scMarket === 'kr') return;
    const sector = document.getElementById('filter-sector').value;
    const sel = document.getElementById('filter-industry');
    if (!sel) return;
    const subset = sector === 'all' ? _scStocks : _scStocks.filter(s => s.sector === sector);
    const industries = [...new Set(subset.map(s => s.industry).filter(Boolean))].sort();
    sel.innerHTML = '<option value="all">All Industries</option>' +
      industries.map(i => `<option value="${i}">${i}</option>`).join('');
    renderScreener();
  });

  document.getElementById('filter-search').addEventListener('input', () => {
    if (_scMarket === 'kr') renderKrScreener();
    else renderScreener(true);
  });

  // 새로고침 버튼 — 현재 시장에 맞는 함수 호출
  const btn = document.getElementById('sc-refresh-btn');
  if (btn) btn.addEventListener('click', () => {
    (_scMarket === 'kr' ? loadKrScreener : loadScreenerData)(false);
  });

  // CSV 내보내기 버튼 — 현재 시장에 맞는 함수 1개만 호출(단일 리스너로 통합, 중복 다운로드 방지)
  const exportBtn = document.getElementById('sc-export-btn');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    (_scMarket === 'kr' ? exportKrCSV : exportScreenerCSV)();
  });

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
  const list = _getFilteredStocks();
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

// ── 스팩/우선주 등 비정상 종목 판별 (KR) ─────────────────────────────────────
// 우선주는 "우"/"N우B"로 끝나는 한국 증시 표준 표기 (예: 삼성전자우, 현대차2우B)
const _KR_ABNORMAL_NAME_RE = /(스팩|우B?$)/;
function _isAbnormalKrListing(s) {
  return _KR_ABNORMAL_NAME_RE.test((s.name || '').trim());
}

async function loadKrScreener(showSpinner = false) {
  if (_scLoading) return;
  _scLoading = true;
  _showKrMktBar();
  const body = document.getElementById('screener-body');
  if (showSpinner && body) body.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--muted)">🇰🇷 국내주식 로딩 중…</td></tr>';
  try {
    const q = (document.getElementById('filter-search')?.value || '').trim();
    const url = '/api/kr-stocks' + (q ? `?q=${encodeURIComponent(q)}` : '');
    const [krStocks, sigMap] = await Promise.all([api(url), loadDailySignalMap()]);
    _krStocks = krStocks;
    _scSignalMap = sigMap;
    window._krStocks = _krStocks;
    _populateKrSectorFilter();
    renderKrScreener();
  } catch (e) {
    if (body) body.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--red)">데이터 로드 실패</td></tr>';
  } finally {
    _scLoading = false;
  }
}

function _populateKrSectorFilter() {
  const sel = document.getElementById('filter-sector');
  if (!sel) return;
  const sectors = [...new Set(_krStocks.map(s => s.sector).filter(Boolean))].sort();
  sel.innerHTML =
    '<option value="all">전체 업종</option>' +
    sectors.map(s => `<option value="${s}">${s}</option>`).join('');
  const lbl = sel.closest('.filter-group')?.querySelector('label');
  if (lbl) lbl.textContent = '업종';
  // Industry, Country 숨기기
  ['filter-industry', 'filter-country'].forEach(id => {
    const el = document.getElementById(id)?.closest('.filter-group');
    if (el) el.style.display = 'none';
  });
}

function _restoreUsSectorFilter() {
  const sel = document.getElementById('filter-sector');
  if (!sel) return;
  sel.innerHTML = `
    <option value="all">All Sectors</option>
    <option value="Technology">Technology</option>
    <option value="Finance">Finance</option>
    <option value="Healthcare">Healthcare</option>
    <option value="Energy">Energy</option>
    <option value="Consumer Disc.">Consumer Disc.</option>
    <option value="Consumer Staples">Consumer Staples</option>
    <option value="Industrial">Industrial</option>
    <option value="Communication">Communication</option>
    <option value="Real Estate">Real Estate</option>
    <option value="Materials">Materials</option>
    <option value="Utilities">Utilities</option>`;
  const lbl = sel.closest('.filter-group')?.querySelector('label');
  if (lbl) lbl.textContent = 'Sector';
  ['filter-industry', 'filter-country'].forEach(id => {
    const el = document.getElementById(id)?.closest('.filter-group');
    if (el) el.style.display = '';
  });
}

function _getKrFiltered() {
  let list = [..._krStocks];
  // 시장 버튼 필터 (전체 / KOSPI / KOSDAQ)
  if (_krMarket !== 'all') {
    list = list.filter(s => s.market === _krMarket);
  }
  // 업종 필터
  const sec = document.getElementById('filter-sector')?.value || 'all';
  if (sec !== 'all') {
    list = list.filter(s => s.sector === sec);
  }
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
  // 신호 있는 종목만
  if (document.getElementById('filter-signal-only')?.checked) {
    list = list.filter(s => _scSignalMap[s.ticker]);
  }
  // 관심종목만
  if (document.getElementById('filter-watchlist-only')?.checked && typeof WL !== 'undefined') {
    list = list.filter(s => WL.has(s.ticker));
  }
  // 정상 종목만 (스팩/우선주 제외)
  if (document.getElementById('filter-normal-only')?.checked) {
    list = list.filter(s => !_isAbnormalKrListing(s));
  }
  // 정렬 — 가격 없는 종목은 항상 맨 뒤 (1차 + Shift+클릭 2차)
  const _krCmpCol = (a, b, col, dir) => {
    let av = a[col] ?? 0, bv = b[col] ?? 0;
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    return av < bv ? dir : av > bv ? -dir : 0;
  };
  list.sort((a, b) => {
    const aNoPx = !a.price, bNoPx = !b.price;
    if (aNoPx && bNoPx) return 0;
    if (aNoPx) return 1;
    if (bNoPx) return -1;
    const primary = _krCmpCol(a, b, _sortCol, _sortDir);
    if (primary !== 0 || !_sortCol2) return primary;
    return _krCmpCol(a, b, _sortCol2, _sortDir2);
  });
  return list;
}

// ── KR 공통 포맷 헬퍼 ─────────────────────────────────────────────────────────
const _fmtKrw  = v => v ? '₩' + Math.round(v).toLocaleString('ko-KR') : '—';
const _fmtKrVol = v => v >= 1e8 ? (v/1e8).toFixed(1)+'억' : v >= 1e4 ? (v/1e4).toFixed(0)+'만' : v ? v.toLocaleString() : '—';
const _fmtKrCap = v => v >= 1e12 ? (v/1e12).toFixed(1)+'조' : v >= 1e8 ? (v/1e8).toFixed(0)+'억' : '—';
const _mktBadge = m => `<span class="sc-sector-badge badge-${m === 'KOSPI' ? 'technology' : 'finance'}">${m}</span>`;
function _calc52wPosKr(s) {
  const range = (s.week52_high || 0) - (s.week52_low || 0);
  if (!range || !s.price) return null;
  return Math.round(((s.price - s.week52_low) / range) * 100);
}

// ── KR 뷰 탭 초기화 ───────────────────────────────────────────────────────────
function _initKrViewTabs() {
  const row = document.querySelector('.sc-view-tabs-row');
  if (!row) return;
  row.style.display = '';
  // KR 뷰 탭 이벤트가 이미 등록된 경우 재등록 방지
  if (!_initKrViewTabs._bound) {
    _initKrViewTabs._bound = true;
    document.querySelectorAll('.sc-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (_scMarket !== 'kr') return;
        document.querySelectorAll('.sc-view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _scView = btn.dataset.scview;
        _scPage = 1;
        renderKrScreener();
      });
    });
  }
  // 현재 활성 탭 동기화
  document.querySelectorAll('.sc-view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.scview === _scView);
  });
}

function renderKrScreener() {
  _initKrViewTabs();

  const all   = _getKrFiltered();
  const total = all.length;
  const start = (_scPage - 1) * _SC_PAGE_SIZE;
  const paged = all.slice(start, start + _SC_PAGE_SIZE);

  const head = document.getElementById('screener-head');
  const body = document.getElementById('screener-body');
  if (!head || !body) return;

  // 뷰별 컬럼 정의
  const colSets = {
    overview: [
      { key: null,         label: '',         cls: '' },
      { key: '_no',        label: 'No',       cls: 'sc-no' },
      { key: 'code',       label: '종목코드', cls: 'td-ticker' },
      { key: 'name',       label: '종목명',   cls: 'td-name' },
      { key: 'signal',     label: '신호',     cls: '' },
      { key: 'market',     label: '시장',     cls: '' },
      { key: 'sector',     label: '업종',     cls: 'td-name' },
      { key: 'price',      label: '현재가',   cls: 'num' },
      { key: 'change_pct', label: '등락률',   cls: 'num' },
      { key: 'volume',     label: '거래량',   cls: 'num' },
      { key: 'market_cap', label: '시가총액', cls: 'num' },
    ],
    fundamental: [
      { key: null,         label: '',         cls: '' },
      { key: '_no',        label: 'No',       cls: 'sc-no' },
      { key: 'code',       label: '종목코드', cls: 'td-ticker' },
      { key: 'name',       label: '종목명',   cls: 'td-name' },
      { key: 'signal',     label: '신호',     cls: '' },
      { key: 'market',     label: '시장',     cls: '' },
      { key: 'price',      label: '현재가',   cls: 'num' },
      { key: 'pe',         label: 'P/E',      cls: 'num' },
      { key: 'eps',        label: 'EPS',      cls: 'num' },
      { key: 'week52_high',label: '52W 고',   cls: 'num' },
      { key: 'week52_low', label: '52W 저',   cls: 'num' },
      { key: 'market_cap', label: '시가총액', cls: 'num' },
    ],
    performance: [
      { key: null,         label: '',         cls: '' },
      { key: '_no',        label: 'No',       cls: 'sc-no' },
      { key: 'code',       label: '종목코드', cls: 'td-ticker' },
      { key: 'name',       label: '종목명',   cls: 'td-name' },
      { key: 'signal',     label: '신호',     cls: '' },
      { key: 'market',     label: '시장',     cls: '' },
      { key: 'price',      label: '현재가',   cls: 'num' },
      { key: 'change_pct', label: '등락률',   cls: 'num' },
      { key: '_52w_pos',   label: '52W 위치', cls: 'num' },
      { key: 'volume',     label: '거래량',   cls: 'num' },
      { key: 'market_cap', label: '시가총액', cls: 'num' },
    ],
  };
  const cols = colSets[_scView] || colSets.overview;

  head.innerHTML = '<tr>' + cols.map(c => {
    if (!c.key) return `<th class="sc-check-cell" title="현재 페이지 전체 선택/해제"><input type="checkbox" onclick="_scToggleSelectAllPage()"></th>`;
    const active  = _sortCol === c.key;
    const active2 = _sortCol2 === c.key;
    const arrow   = active ? (_sortDir === -1 ? ' ▼' : ' ▲') : active2 ? (_sortDir2 === -1 ? ' ▽' : ' △') : '';
    const cls     = active ? ' sort-active' : active2 ? ' sort-active-2' : '';
    return `<th class="sc-th${cls}" data-col="${c.key}" style="cursor:pointer" title="Shift+클릭: 2차 정렬">${c.label}${arrow}</th>`;
  }).join('') + '</tr>';

  head.querySelectorAll('.sc-th').forEach(th => {
    th.addEventListener('click', e => {
      const col = th.dataset.col;
      if (e.shiftKey) {
        if (col === _sortCol) return;
        _sortDir2 = _sortCol2 === col ? _sortDir2 * -1 : -1;
        _sortCol2 = col;
      } else {
        if (_sortCol === col) _sortDir *= -1; else { _sortCol = col; _sortDir = -1; }
        _sortCol2 = null;
      }
      renderKrScreener();
    });
  });

  body.innerHTML = paged.map((s, i) => {
    const no   = start + i + 1;
    const cls  = (s.change_pct || 0) > 0 ? 'pos' : (s.change_pct || 0) < 0 ? 'neg' : '';
    const pos52 = _calc52wPosKr(s);
    const cells = cols.map(c => {
      if (!c.key) return `<td onclick="event.stopPropagation()" class="sc-check-cell">${_scCheckboxHtml(s.ticker)}${starBtn(s.ticker)}</td>`;
      switch (c.key) {
        case '_no':        return `<td class="sc-no">${no}</td>`;
        case 'code':       return `<td class="td-ticker">${s.code}</td>`;
        case 'name':       return `<td class="td-name">${s.name}</td>`;
        case 'signal':     return `<td>${signalBadgeHtml(s.ticker, _scSignalMap)}</td>`;
        case 'market':     return `<td>${_mktBadge(s.market)}</td>`;
        case 'sector':     return `<td class="td-name" style="font-size:11px;color:var(--muted)">${s.sector || '—'}</td>`;
        case 'price':      return `<td class="num">${_fmtKrw(s.price)}</td>`;
        case 'change_pct': return `<td class="num ${cls}">${s.price && s.change_pct != null ? (s.change_pct > 0 ? '+' : '') + s.change_pct.toFixed(2) + '%' : '—'}</td>`;
        case 'volume':     return `<td class="num">${_fmtKrVol(s.volume)}</td>`;
        case 'market_cap': return `<td class="num">${_fmtKrCap(s.market_cap)}</td>`;
        case 'pe':         return `<td class="num">${s.pe ? s.pe.toFixed(1) : '—'}</td>`;
        case 'eps':        return `<td class="num">${s.eps ? _fmtKrw(s.eps) : '—'}</td>`;
        case 'week52_high':return `<td class="num up">${s.week52_high ? _fmtKrw(s.week52_high) : '—'}</td>`;
        case 'week52_low': return `<td class="num down">${s.week52_low ? _fmtKrw(s.week52_low) : '—'}</td>`;
        case '_52w_pos':   return `<td class="num">${pos52 !== null ? pos52 + '%' : '—'}</td>`;
        default:           return `<td>—</td>`;
      }
    }).join('');
    return `<tr style="cursor:pointer" onclick="openKrStockModal('${s.ticker}')">${cells}</tr>`;
  }).join('');

  const countEl = document.getElementById('filter-count-label');
  if (countEl) countEl.textContent = `${total.toLocaleString()} results`;
  _renderPagination(total);
}

function _showKrMktBar() {
  const bar = document.getElementById('sc-kr-mkt-bar');
  if (bar) bar.style.display = '';
}

function _hideKrMktBar() {
  const bar = document.getElementById('sc-kr-mkt-bar');
  if (bar) bar.style.display = 'none';
  _krMarket = 'all';
  document.querySelectorAll('.sc-kr-mkt-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.krmkt === 'all');
  });
}

function _showUsMode() {
  const row = document.querySelector('.sc-view-tabs-row');
  if (row) row.style.display = '';
  _restoreUsSectorFilter();
  const newsBtn = document.getElementById('sm-news-btn');
  if (newsBtn) newsBtn.style.display = '';
}

// ── KR 종목 모달 (4-67) ──────────────────────────────────────────────────────
function openKrStockModal(ticker) {
  const s = _krStocks.find(x => x.ticker === ticker);
  if (!s) { navigateToChart(ticker); return; }

  const modal = document.getElementById('stock-modal');
  if (!modal) { navigateToChart(ticker); return; }

  const pct = s.change_pct ?? 0;
  const cls = pct >= 0 ? 'up' : 'down';
  document.getElementById('sm-ticker').textContent = s.code;
  document.getElementById('sm-name').textContent   = s.name;
  document.getElementById('sm-price').textContent  = s.price ? _fmtKrw(s.price) : '—';
  const chgEl = document.getElementById('sm-change');
  chgEl.textContent = s.price ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '—';
  chgEl.className   = 'sm-change ' + cls;

  const pos = _calc52wPosKr(s);
  const stats = [
    { label: '업종',     value: s.sector || '—' },
    { label: '시장',     value: s.market || '—' },
    { label: '시가총액', value: s.market_cap ? _fmtKrCap(s.market_cap) : '—' },
    { label: '거래량',   value: s.volume ? _fmtKrVol(s.volume) : '—' },
    { label: 'P/E',      value: s.pe ? s.pe.toFixed(1) : '—' },
    { label: 'EPS',      value: s.eps ? _fmtKrw(s.eps) : '—' },
    { label: '52W 고',   value: s.week52_high ? _fmtKrw(s.week52_high) : '—' },
    { label: '52W 저',   value: s.week52_low  ? _fmtKrw(s.week52_low)  : '—' },
    { label: '52W 위치', value: pos !== null ? pos + '%' : '—' },
  ];
  document.getElementById('sm-stats').innerHTML = stats.map(st =>
    `<div class="sm-stat"><span class="sm-stat-label">${st.label}</span><span class="sm-stat-value">${st.value}</span></div>`
  ).join('');

  document.getElementById('sm-star-wrap').innerHTML = starBtn(ticker);

  const chartBtn = document.getElementById('sm-chart-btn');
  chartBtn.onclick = () => { closeStockModal(); navigateToChart(ticker); };

  const newsBtn = document.getElementById('sm-news-btn');
  if (newsBtn) newsBtn.style.display = 'none';

  document.onkeydown = e => { if (e.key === 'Escape') closeStockModal(); };
  modal.style.display   = 'flex';
  document.body.style.overflow = 'hidden';

  // KR 뉴스 로드
  const newsEl = document.getElementById('sm-news');
  newsEl.innerHTML = '<div class="sm-news-loading">뉴스 로딩 중…</div>';
  api(`/api/kr-news/${s.code}`).then(items => {
    const news = (items || []).slice(0, 4);
    if (!news.length) { newsEl.innerHTML = '<div class="sm-news-empty">최근 뉴스가 없습니다.</div>'; return; }
    newsEl.innerHTML = news.map(n =>
      `<div class="sm-news-item" onclick="window.open('${n.url}','_blank')">
        <span class="sm-news-dot">📰</span>
        <div class="sm-news-body">
          <div class="sm-news-title">${n.title}</div>
          <div class="sm-news-meta">${n.source || ''} · ${n.time || ''}</div>
        </div>
      </div>`
    ).join('');
  }).catch(() => {
    newsEl.innerHTML = '<div class="sm-news-empty">뉴스를 불러올 수 없습니다.</div>';
  });
}

// ── KR CSV 내보내기 (4-68) ───────────────────────────────────────────────────
function exportKrCSV() {
  const list = _getKrFiltered();
  if (!list.length) return;

  const headers = ['No','종목코드','종목명','시장','업종','현재가(₩)','등락률(%)','거래량','시가총액(억)','P/E','EPS(₩)','52W고','52W저'];
  const rows = list.map((s, i) => [
    i + 1,
    s.code,
    `"${(s.name || '').replace(/"/g, '""')}"`,
    s.market   || '',
    `"${(s.sector || '').replace(/"/g, '""')}"`,
    s.price       != null ? Math.round(s.price)      : '',
    s.change_pct  != null ? s.change_pct.toFixed(2)  : '',
    s.volume      != null ? s.volume                  : '',
    s.market_cap  != null ? Math.round(s.market_cap / 1e8) : '',
    s.pe          != null ? s.pe.toFixed(1)           : '',
    s.eps         != null ? Math.round(s.eps)         : '',
    s.week52_high != null ? Math.round(s.week52_high) : '',
    s.week52_low  != null ? Math.round(s.week52_low)  : '',
  ].join(','));

  const csv  = [headers.join(','), ...rows].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `kr_screener_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
