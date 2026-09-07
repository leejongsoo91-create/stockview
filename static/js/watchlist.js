/* ═══════════════════════════════════════════════════════════════
   watchlist.js — 관심종목 워치리스트 (localStorage 기반)
   ═══════════════════════════════════════════════════════════════ */

const LS_KEY = 'stockview_watchlist'; // localStorage 저장 키
const WLG_KEY = 'stockview_watchlist_groups'; // 종목별 그룹 저장 키
const WLG_NAMES_KEY = 'stockview_watchlist_group_names'; // 생성된 그룹명 목록 (종목 미배정 상태에서도 유지)
const WLN_KEY = 'stockview_watchlist_notes'; // 종목별 메모/목표가 저장 키
let _wlGroupFilter = '전체'; // '전체' | '미분류' | 그룹명

// ── 관심종목 메모/목표가 저장소 (티커 -> {memo, target}) ────────────────────────
// 구현은 main.js의 makeNotesStore() 공용 팩토리 (Portfolio PTN과 동일 구조)
const WLN = makeNotesStore(WLN_KEY);

function _wlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// 목표가 도달 여부/거리 표시 — 목표가는 상승 목표로 간주(달성 = 현재가 ≥ 목표가)
function _wlTargetStatusHtml(price, target) {
  if (!target || !price) return '';
  if (price >= target) return `<span class="wl-target-hit">달성 ✓</span>`;
  const gap = ((target - price) / price) * 100;
  return `<span class="wl-target-gap">+${gap.toFixed(1)}% 남음</span>`;
}

// ── 관심종목 그룹 저장소 (티커 -> 그룹명, 없으면 미분류) ───────────────────────
// 구현은 main.js의 makeGroupStore() 공용 팩토리 (Portfolio PTG와 동일 구조)
const WLG = makeGroupStore(WLG_KEY, WLG_NAMES_KEY);

// ── 워치리스트 저장소 ─────────────────────────────────────────────────────────
const WL = {
  _tickers: null,

  load() {
    if (this._tickers) return this._tickers;
    try {
      this._tickers = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    } catch {
      this._tickers = [];
    }
    return this._tickers;
  },

  save() {
    localStorage.setItem(LS_KEY, JSON.stringify(this._tickers));
  },

  has(ticker) {
    return this.load().includes(ticker);
  },

  add(ticker) {
    if (!this.has(ticker)) {
      this.load().push(ticker);
      this.save();
    }
  },

  remove(ticker) {
    this._tickers = this.load().filter(t => t !== ticker);
    this.save();
    WLG.remove(ticker);
  },

  toggle(ticker) {
    if (this.has(ticker)) {
      this.remove(ticker);
      return false; // 제거됨
    } else {
      this.add(ticker);
      return true;  // 추가됨
    }
  },

  count() {
    return this.load().length;
  },
};

// ── ★ 버튼 HTML 생성 ─────────────────────────────────────────────────────────
function starBtn(ticker) {
  const active = WL.has(ticker);
  return `<button
    class="star-btn${active ? ' active' : ''}"
    data-ticker="${ticker}"
    onclick="event.stopPropagation(); toggleStar('${ticker}', this)"
    title="${active ? '관심종목 제거' : '관심종목 추가'}"
    aria-label="${active ? '관심종목 제거' : '관심종목 추가'}"
  >${active ? '★' : '☆'}</button>`;
}

// ★ 클릭 핸들러 (모든 탭 공용)
function toggleStar(ticker, btn) {
  const added = WL.toggle(ticker);
  const label = added ? '관심종목 제거' : '관심종목 추가';
  btn.textContent = added ? '★' : '☆';
  btn.classList.toggle('active', added);
  btn.title = label;
  btn.setAttribute('aria-label', label);

  // 워치리스트 탭이 열려 있으면 즉시 갱신
  const wlView = document.getElementById('view-watchlist');
  if (wlView && wlView.classList.contains('active')) {
    renderWatchlist();
  }

  // 다른 탭에서도 같은 티커의 ★ 버튼 동기화
  document.querySelectorAll(`.star-btn[data-ticker="${ticker}"]`).forEach(b => {
    if (b !== btn) {
      b.textContent = added ? '★' : '☆';
      b.classList.toggle('active', added);
      b.title = label;
      b.setAttribute('aria-label', label);
    }
  });

  // 헤더 카운트 업데이트
  updateWLCount();
}

function updateWLCount() {
  const cnt = WL.count();
  const badge = document.getElementById('wl-count');
  if (badge) {
    badge.textContent = cnt > 0 ? cnt : '';
    badge.style.display = cnt > 0 ? 'inline-block' : 'none';
  }
}

// ── 워치리스트 탭 초기화 ─────────────────────────────────────────────────────
let _wlRefreshTimer = null;

function initWatchlist() {
  renderWatchlist();
  // WebSocket으로 갱신하므로 polling 불필요 (WebSocket 미연결 시 폴백)
  if (typeof io === 'undefined') _startWlRefresh();
}

function stopWatchlistRefresh() {
  if (_wlRefreshTimer) { clearInterval(_wlRefreshTimer); _wlRefreshTimer = null; }
}

function _startWlRefresh() {
  stopWatchlistRefresh();
  _wlRefreshTimer = setInterval(() => {
    const view = document.getElementById('view-watchlist');
    if (view && view.classList.contains('active')) renderWatchlist();
  }, 30_000);
}

// ── 워치리스트 탭 렌더링 ─────────────────────────────────────────────────────
async function renderWatchlist() {
  const tickers = WL.load();
  const container = document.getElementById('wl-content');
  if (!container) return;

  if (tickers.length === 0) {
    container.innerHTML = `
      <div class="wl-empty">
        <div class="wl-empty-icon">☆</div>
        <div class="wl-empty-text">관심종목이 없습니다</div>
        <div class="wl-empty-sub">Screener나 Home 화면에서 ☆ 아이콘을 클릭해 추가하세요</div>
      </div>`;
    return;
  }

  // 로딩 표시
  container.innerHTML = `<div class="wl-loading">데이터 불러오는 중...</div>`;

  // 전체 종목에서 watchlist 종목 필터링
  let stocks = [];
  let sigMap = {};
  try {
    const [all, sm] = await Promise.all([api('/api/stocks'), loadDailySignalMap()]);
    sigMap = sm;
    const set = new Set(tickers);
    stocks = all.filter(s => set.has(s.ticker));

    // API에 없는 티커는 개별 조회
    const found = new Set(stocks.map(s => s.ticker));
    const missing = tickers.filter(t => !found.has(t));
    for (const t of missing) {
      try {
        const s = await api(`/api/stock/${t}`);
        if (s && !s.error) stocks.push(s);
      } catch {}
    }

    // 사용자가 추가한 순서 유지
    stocks.sort((a, b) => tickers.indexOf(a.ticker) - tickers.indexOf(b.ticker));
  } catch (e) {
    container.innerHTML = `<div class="wl-loading">데이터 로드 실패. 잠시 후 다시 시도하세요.</div>`;
    return;
  }

  // 그룹 필터 탭 구성
  const groups = WLG.allGroups(tickers);
  if (!groups.includes(_wlGroupFilter) && _wlGroupFilter !== '전체' && _wlGroupFilter !== '미분류') {
    _wlGroupFilter = '전체'; // 필터로 선택된 그룹이 더 이상 존재하지 않으면 초기화
  }
  const _wlGroupStocks = g => g === '전체' ? stocks
    : g === '미분류' ? stocks.filter(s => !WLG.get(s.ticker))
    : stocks.filter(s => WLG.get(s.ticker) === g);

  const tabsHtml = ['전체', ...groups, '미분류'].map(g => {
    const list = _wlGroupStocks(g);
    const cnt  = list.length;
    const pcts = list.map(s => s.change_pct).filter(v => v != null);
    const avg  = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
    const avgHtml = avg != null
      ? `<span class="wl-group-avg ${avg >= 0 ? 'up' : 'down'}">${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%</span>`
      : '';
    return `<button class="report-tag${g === _wlGroupFilter ? ' active' : ''}" onclick="_wlSelectGroupFilter('${g}')">${g} <span class="wl-group-count">${cnt}</span>${avgHtml}</button>`;
  }).join('') + `<button class="wl-group-add-btn" onclick="_wlAddGroupPrompt()" title="새 그룹 추가">+ 그룹</button>`;

  // 그룹 필터 적용
  const filtered = _wlGroupFilter === '전체' ? stocks
    : _wlGroupFilter === '미분류' ? stocks.filter(s => !WLG.get(s.ticker))
    : stocks.filter(s => WLG.get(s.ticker) === _wlGroupFilter);

  const groupOptionsHtml = (current) => ['', ...groups].map(g =>
    `<option value="${g}" ${g === current ? 'selected' : ''}>${g || '(없음)'}</option>`
  ).join('') + `<option value="__new__">+ 새 그룹...</option>`;

  container.innerHTML = `
    <div class="wl-header-row">
      <span class="wl-total">${filtered.length}개 종목</span>
      <button class="wl-csv-btn" onclick="exportWatchlistCSV()">⬇ CSV 내보내기</button>
      <label class="wl-csv-btn wl-csv-import-label">
        ⬆ CSV 가져오기
        <input type="file" accept=".csv" class="wl-csv-import-input"
               onchange="if(this.files[0]) importWatchlistCSV(this.files[0]); this.value='';">
      </label>
      <button class="wl-clear-btn" onclick="clearWatchlist()">전체 삭제</button>
      <button class="wl-csv-btn no-print" onclick="window.print()" title="인쇄용 리포트 보기">🖨 인쇄</button>
    </div>
    <div id="wl-cmp-bar" class="sc-bulk-bar no-print" style="display:${_cmpSel.wl.size > 0 ? '' : 'none'}">
      <span id="wl-cmp-count" class="sc-bulk-count">${_cmpSel.wl.size}개 선택됨 (2~5개)</span>
      <button class="sc-bulk-add-btn" onclick="_cmpOpenFromScope('wl')">📊 비교차트 보기</button>
      <button class="sc-bulk-clear-btn" onclick="_cmpClear('wl')">선택 해제</button>
    </div>
    <div class="news-filter-bar wl-group-tabs">${tabsHtml}</div>
    <div class="table-wrap">
      <table class="wl-table">
        <thead>
          <tr>
            <th></th>
            <th>Ticker</th>
            <th>Name</th>
            <th>Group</th>
            <th>Sector</th>
            <th>Signal</th>
            <th class="num">Price</th>
            <th class="num">Change</th>
            <th class="num">Chg %</th>
            <th class="num">Mkt Cap</th>
            <th class="num">52W High</th>
            <th class="num">52W Low</th>
            <th>메모</th>
            <th class="num">목표가</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(s => {
            const pct   = s.change_pct || 0;
            const cls   = pct >= 0 ? 'up' : 'down';
            const bgCls = pct >= 0 ? 'up-bg' : 'down-bg';
            const price = s.price ? fmt$(s.price) : '—';
            const chg   = s.change != null ? `${s.change >= 0 ? '+' : ''}${fmt$(s.change)}` : '—';
            const cap   = s.market_cap ? fmtCap(s.market_cap) : '—';
            const hi    = s.week52_high ? fmt$(s.week52_high) : '—';
            const lo    = s.week52_low  ? fmt$(s.week52_low)  : '—';
            return `
              <tr onclick="navigateToChart('${s.ticker}')">
                <td onclick="event.stopPropagation()" class="sc-check-cell">
                  ${_cmpCheckboxHtml('wl', s.ticker)}${starBtn(s.ticker)}
                </td>
                <td class="td-ticker">${s.ticker}</td>
                <td class="td-name">
                  ${s.name}
                  ${s.name_ko ? `<span class="td-name-ko">(${s.name_ko})</span>` : ''}
                </td>
                <td onclick="event.stopPropagation()">
                  <select class="wl-group-select" onchange="_wlOnGroupChange('${s.ticker}', this)">
                    ${groupOptionsHtml(WLG.get(s.ticker))}
                  </select>
                </td>
                <td class="td-sector">${s.sector || '—'}</td>
                <td>${signalBadgeHtml(s.ticker, sigMap)}</td>
                <td class="num">${price}</td>
                <td class="num ${cls}">${chg}</td>
                <td class="num">
                  <span class="chg-cell ${bgCls} ${cls}">${fmtPct(pct)}</span>
                </td>
                <td class="num">${cap}</td>
                <td class="num">${hi}</td>
                <td class="num">${lo}</td>
                <td onclick="event.stopPropagation()">
                  <input type="text" class="wl-memo-input" placeholder="메모"
                         value="${_wlEsc(WLN.get(s.ticker).memo)}"
                         onchange="WLN.setMemo('${s.ticker}', this.value.trim())">
                </td>
                <td class="num wl-target-cell" onclick="event.stopPropagation()">
                  <input type="number" step="0.01" class="wl-target-input" placeholder="목표가"
                         value="${WLN.get(s.ticker).target ?? ''}"
                         onchange="WLN.setTarget('${s.ticker}', this.value); renderWatchlist();">
                  ${_wlTargetStatusHtml(s.price, WLN.get(s.ticker).target)}
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── CSV 내보내기/가져오기 ─────────────────────────────────────────────────────
async function exportWatchlistCSV() {
  const tickers = WL.load();
  if (!tickers.length) return;

  let stocks = [];
  try {
    const all = await api('/api/stocks');
    const set = new Set(tickers);
    stocks = all.filter(s => set.has(s.ticker));
    const found = new Set(stocks.map(s => s.ticker));
    const missing = tickers.filter(t => !found.has(t));
    for (const t of missing) {
      try { const s = await api(`/api/stock/${t}`); if (s && !s.error) stocks.push(s); } catch {}
    }
  } catch { return; }

  const headers = ['Ticker', 'Name', 'Group', 'Sector', 'Price', 'Change%'];
  const rows = tickers.map(t => {
    const s = stocks.find(x => x.ticker === t) || {};
    return [
      t,
      `"${(s.name || '').replace(/"/g, '""')}"`,
      WLG.get(t) || '',
      s.sector || '',
      s.price != null ? s.price : '',
      s.change_pct != null ? s.change_pct : '',
    ].join(',');
  });

  const csv  = [headers.join(','), ...rows].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `watchlist_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function importWatchlistCSV(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text  = String(reader.result).replace(/^﻿/, '');
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (!lines.length) { alert('빈 파일입니다.'); return; }

      const header    = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
      const hasHeader = header.includes('ticker');
      const tIdx      = hasHeader ? header.indexOf('ticker') : 0;
      const groupIdx  = hasHeader ? header.indexOf('group') : -1;
      const startIdx  = hasHeader ? 1 : 0;

      let added = 0;
      for (let i = startIdx; i < lines.length; i++) {
        const cols   = lines[i].split(',');
        const ticker = (cols[tIdx] || '').trim().toUpperCase().replace(/^"|"$/g, '');
        if (!ticker) continue;
        if (!WL.has(ticker)) { WL.add(ticker); added++; }
        if (groupIdx !== -1) {
          const group = (cols[groupIdx] || '').trim().replace(/^"|"$/g, '');
          if (group) WLG.set(ticker, group);
        }
      }
      alert(`${added}개 종목을 관심종목에 추가했습니다.`);
      updateWLCount();
      renderWatchlist();
    } catch (e) {
      alert('CSV 파일을 읽는 중 오류가 발생했습니다.');
    }
  };
  reader.readAsText(file);
}

function _wlSelectGroupFilter(group) {
  _wlGroupFilter = group;
  renderWatchlist();
}

function _wlAddGroupPrompt() {
  const name = prompt('새 그룹 이름을 입력하세요 (예: 반도체, 배당주)');
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  WLG.addGroupName(trimmed);
  _wlGroupFilter = trimmed;
  renderWatchlist();
}

function _wlOnGroupChange(ticker, sel) {
  let value = sel.value;
  if (value === '__new__') {
    const name = prompt('새 그룹 이름을 입력하세요');
    if (!name || !name.trim()) { renderWatchlist(); return; }
    value = name.trim();
  }
  WLG.set(ticker, value);
  renderWatchlist();
}

function clearWatchlist() {
  if (!confirm(`관심종목 ${WL.count()}개를 모두 삭제하시겠습니까?`)) return;
  WL._tickers = [];
  WL.save();
  WLG._map = {};
  WLG.save();
  WLG._names = [];
  WLG.saveNames();
  _wlGroupFilter = '전체';
  // 모든 ★ 버튼 초기화
  document.querySelectorAll('.star-btn.active').forEach(b => {
    b.textContent = '☆';
    b.classList.remove('active');
  });
  updateWLCount();
  renderWatchlist();
}
