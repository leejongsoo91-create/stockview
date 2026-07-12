/* ═══════════════════════════════════════════════════════════════
   watchlist.js — 관심종목 워치리스트 (localStorage 기반)
   ═══════════════════════════════════════════════════════════════ */

const LS_KEY = 'stockview_watchlist'; // localStorage 저장 키

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
  >${active ? '★' : '☆'}</button>`;
}

// ★ 클릭 핸들러 (모든 탭 공용)
function toggleStar(ticker, btn) {
  const added = WL.toggle(ticker);
  btn.textContent = added ? '★' : '☆';
  btn.classList.toggle('active', added);
  btn.title = added ? '관심종목 제거' : '관심종목 추가';

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
function initWatchlist() {
  renderWatchlist();
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

  container.innerHTML = `
    <div class="wl-header-row">
      <span class="wl-total">${stocks.length}개 종목</span>
      <button class="wl-clear-btn" onclick="clearWatchlist()">전체 삭제</button>
    </div>
    <div class="table-wrap">
      <table class="wl-table">
        <thead>
          <tr>
            <th></th>
            <th>Ticker</th>
            <th>Name</th>
            <th>Sector</th>
            <th>Signal</th>
            <th class="num">Price</th>
            <th class="num">Change</th>
            <th class="num">Chg %</th>
            <th class="num">Mkt Cap</th>
            <th class="num">52W High</th>
            <th class="num">52W Low</th>
          </tr>
        </thead>
        <tbody>
          ${stocks.map(s => {
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
                <td onclick="event.stopPropagation()">
                  ${starBtn(s.ticker)}
                </td>
                <td class="td-ticker">${s.ticker}</td>
                <td class="td-name">
                  ${s.name}
                  ${s.name_ko ? `<span class="td-name-ko">(${s.name_ko})</span>` : ''}
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
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function clearWatchlist() {
  if (!confirm(`관심종목 ${WL.count()}개를 모두 삭제하시겠습니까?`)) return;
  WL._tickers = [];
  WL.save();
  // 모든 ★ 버튼 초기화
  document.querySelectorAll('.star-btn.active').forEach(b => {
    b.textContent = '☆';
    b.classList.remove('active');
  });
  updateWLCount();
  renderWatchlist();
}
