/* ═══════════════════════════════════════════════════════════════
   paper.js — 💹 모의투자 모드 (11-26)
   사이트 자체 가상계좌 + 한국투자증권 실시간 호가·체결(조회만). 증권사로 주문은 나가지 않는다.
   - 위쪽 [💹 모의투자 ON/OFF] 스위치(localStorage PPM). 켜 두면 국내 종목 차트 옆에 호가·주문창이 붙고,
     차트를 누르면 그 가격이 주문 가격에 들어간다. 휴대폰은 아래 [매수][매도] → 주문창이 아래에서 올라옴.
   - 시간대는 서버가 자동으로 고른다(통합 주문 session="auto") — 화면엔 '지금 장'만 보여 준다.
   - 💹 탭은 내 계좌(회차·리셋·보유·미체결·체결).
   ═══════════════════════════════════════════════════════════════ */

let _pp = { booted: false, on: false, view: null, ticker: null, code: null, name: '', side: 'buy', otype: 'limit',
            state: null, quote: null, book: null, trade: null, ticks: [], tab: 'pos', hb: null, clock: null,
            lines: [], lineSeries: null, askedStart: false };

function _ppTick(p) { for (const [lim, t] of [[2000, 1], [5000, 5], [20000, 10], [50000, 50], [200000, 100], [500000, 500]]) if (p < lim) return t; return 1000; }
const _ppW = n => n == null ? '—' : Math.round(n).toLocaleString('ko-KR');
const _ppSigned = n => n == null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(Math.round(n)).toLocaleString('ko-KR');
const _ppCls = n => n > 0 ? 'up' : n < 0 ? 'down' : '';
const _ppIsKr = t => /\.(KS|KQ)$/i.test(t || '');
const _ppMobile = () => window.innerWidth <= 760;

async function _ppPost(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StockView': 'paper' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || r.status);
  return j;
}

// ── 바깥(main.js·chart.js)에서 부르는 것 ─────────────────────────────
function paperOnView(name) {          // switchView에서
  _pp.view = name;
  if (!_pp.booted) return;
  if (name === 'paper') { _ppLoadState(); _ppStopFeed(); }
  else if (name === 'chart' && _pp.on) _ppStartFeed();
  else _ppStopFeed();
}

function paperOnChart(ticker) {       // loadChart에서 (종목이 바뀔 때마다)
  _pp.ticker = ticker;
  const kr = _ppIsKr(ticker);
  const code = kr ? ticker.replace(/\.(KS|KQ)$/i, '') : null;
  if (code !== _pp.code) { _pp.book = null; _pp.trade = null; _pp.ticks = []; _pp.quote = null; }
  _pp.code = code;
  const s = kr && (window._krStocks || []).find(x => x.ticker === ticker);
  _pp.name = s ? s.name : (code || ticker);
  if (!_pp.booted) return;
  _ppRenderDock();
  if (_pp.on && _pp.view === 'chart') _ppStartFeed(true);
}

// 차트를 눌렀을 때 (chart.js 클릭 처리에서) — 모의투자 모드면 그 가격을 주문 가격으로. 처리했으면 true
window._ppChartClick = function (price) {
  if (!_pp.on || !_pp.code || !price || !(price > 0)) return false;
  const t = _ppTick(price);
  const p = Math.max(t, Math.round(price / t) * t);
  document.getElementById('pp-price').value = p.toLocaleString('ko-KR');
  _pp.otype = 'limit';
  _ppRenderOrder();
  const box = document.querySelector('#pp-dock .pp-order');
  if (box) { box.classList.remove('pp-flash'); void box.offsetWidth; box.classList.add('pp-flash'); }
  if (_ppMobile()) _ppToast(`주문 가격 ${_ppW(p)}원 — 아래 [매수]·[매도]를 누르세요`);
  return true;
};

// ── 시작 ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => setTimeout(_ppBoot, 0));

function _ppBoot() {
  _pp.booted = true;
  let on = false; try { on = localStorage.getItem('PPM') === '1'; } catch {}
  document.querySelectorAll('[data-pp-mode]').forEach(b => b.addEventListener('click', () => _ppSetMode(!_pp.on)));

  document.querySelectorAll('#pp-side button').forEach(b => b.onclick = () => { _pp.side = b.dataset.side; _ppRenderOrder(); });
  document.querySelectorAll('#pp-otype button').forEach(b => b.onclick = () => { _pp.otype = b.dataset.ot; _ppRenderOrder(); });
  document.getElementById('pp-price-dn').onclick = () => _ppStep(-1);
  document.getElementById('pp-price-up').onclick = () => _ppStep(1);
  ['pp-price', 'pp-qty'].forEach(id => document.getElementById(id).addEventListener('input', _ppCalc));
  document.querySelectorAll('#pp-pcts button').forEach(b => b.onclick = () => _ppPct(+b.dataset.p));
  document.getElementById('pp-submit').onclick = _ppSubmit;
  document.getElementById('pp-book').addEventListener('click', e => {
    const r = e.target.closest('[data-p]'); if (!r) return;
    document.getElementById('pp-price').value = (+r.dataset.p).toLocaleString('ko-KR');
    _pp.otype = 'limit'; _ppRenderOrder();
  });
  document.getElementById('pp-here').addEventListener('click', _ppCancelClick);
  document.querySelectorAll('#pp-mbar [data-open]').forEach(b => b.onclick = () => { _pp.side = b.dataset.open; _ppRenderOrder(); _ppSheet(true); });
  document.getElementById('pp-sheet-close').onclick = () => _ppSheet(false);

  document.querySelectorAll('#pp-acct-tabs button').forEach(b => b.onclick = () => { _pp.tab = b.dataset.tab; _ppRenderAcct(); });
  document.getElementById('pp-acct-body').addEventListener('click', _ppAcctClick);
  document.getElementById('pp-reset-btn').onclick = () => _ppOpenReset(false);
  document.getElementById('pp-rounds-btn').onclick = _ppOpenRounds;
  document.getElementById('pp-reset-go').onclick = _ppDoReset;
  document.querySelectorAll('#pp-reset-presets button').forEach(b => b.onclick = () => { document.getElementById('pp-reset-amt').value = (+b.dataset.v).toLocaleString('ko-KR'); });
  document.querySelectorAll('.pp-modal [data-close]').forEach(b => b.onclick = () => b.closest('.pp-modal').hidden = true);
  document.querySelectorAll('.pp-modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.hidden = true; }));
  if (!window._krStocks) api('/api/kr-stocks').then(d => { window._krStocks = d; if (_pp.ticker) paperOnChart(_pp.ticker); }).catch(() => {});

  const sock = window._rtSocket;
  if (sock) {
    sock.on('paper_book', d => { if (_pp.on && d && d.code === _pp.code) { _pp.book = d; _ppRenderBook(); } });
    sock.on('paper_tick', d => {
      if (!_pp.on || !d || d.code !== _pp.code) return;
      const prev = _pp.trade || {};
      _pp.trade = d;
      if (d.vol && (d.acml_vol !== prev.acml_vol || d.hour !== prev.hour)) { _pp.ticks.unshift(d); _pp.ticks = _pp.ticks.slice(0, 40); }
      _ppRenderHead(); _ppRenderTicks(); _ppRenderBook(); _ppRenderHere();
    });
    sock.on('paper_acct', st => { if (st && st.round) { _pp.state = Object.assign(_pp.state || {}, st); _ppAfterState(); } });
    sock.on('paper_fill', f => { if (_pp.on || _pp.view === 'paper') _ppToast(`${f.side === 'buy' ? '매수' : '매도'} 체결 · ${_escHtml(f.name || f.code)} ${f.qty.toLocaleString()}주 @ ${_ppW(f.price)}원`
      + (f.pnl != null ? ` · 손익 ${_ppSigned(f.pnl)}원` : ''), f.side); });
    sock.on('connect', _ppWatch);
  }
  window.addEventListener('resize', () => { if (!_ppMobile()) _ppSheet(false); _ppRenderDock(); });
  _ppSetMode(on, true);
  if (_pp.view) paperOnView(_pp.view);
}

function _ppSetMode(on, silent) {
  // 차트 폭이 바뀌어도 보던 구간 그대로 (안 하면 오른쪽 최근 봉이 잘림)
  const range = typeof _lwChart !== 'undefined' && _lwChart ? _lwChart.timeScale().getVisibleLogicalRange() : null;
  _pp.on = !!on;
  try { localStorage.setItem('PPM', _pp.on ? '1' : '0'); } catch {}
  document.querySelectorAll('[data-pp-mode]').forEach(b => {
    b.setAttribute('aria-pressed', _pp.on ? 'true' : 'false');
    b.classList.toggle('on', _pp.on);
    const k = b.querySelector('b'); if (k) k.textContent = _pp.on ? 'ON' : 'OFF';
  });
  _ppRenderDock();
  if (_pp.on) {
    _ppLoadState();
    if (_pp.view === 'chart') _ppStartFeed(true);
    if (!silent) _ppToast(_pp.view === 'chart' ? '모의투자 모드 켜짐 — 차트 옆에서 바로 주문해요' : '모의투자 모드 켜짐 — 국내 종목 차트를 열면 주문창이 붙어요');
  } else {
    _ppStopFeed(); _ppSheet(false); _ppClearLines();
    if (!silent) _ppToast('모의투자 모드 꺼짐');
  }
  setTimeout(() => {
    if (typeof _resizeChartPanels === 'function') _resizeChartPanels();
    window.dispatchEvent(new Event('resize'));
    if (range && _lwChart) setTimeout(() => _lwChart.timeScale().setVisibleLogicalRange(range), 30);
  }, 60);
}

// 차트 탭 모양: 모드 ON이면 차트 옆에 주문 칸
function _ppRenderDock() {
  const layout = document.querySelector('#view-chart .chart-layout');
  const dock = document.getElementById('pp-dock'), mbar = document.getElementById('pp-mbar');
  if (!layout || !dock) return;
  layout.classList.toggle('pp-on', _pp.on);
  dock.hidden = !_pp.on;
  const kr = !!_pp.code;
  document.getElementById('pp-dock-us').hidden = kr || !_pp.ticker;
  document.getElementById('pp-dock-main').hidden = !kr;
  document.getElementById('pp-here').hidden = !kr;
  dock.querySelector('.pp-ticks-card').hidden = !kr;
  mbar.hidden = !(_pp.on && kr && _ppMobile());
  if (!_pp.on || !kr) _ppSheet(false);
  if (kr) { _ppRenderHead(); _ppRenderBook(); _ppRenderTicks(); _ppRenderOrder(); _ppRenderHere(); }
  else { document.getElementById('pp-price-now').innerHTML = _pp.ticker ? '<span class="pp-muted">국내 종목만 모의투자</span>' : ''; _ppRenderPhase(null); }
}

function _ppSheet(open) {
  const dock = document.getElementById('pp-dock');
  if (!dock) return;
  dock.classList.toggle('pp-sheet-open', !!open && _ppMobile());
  document.body.classList.toggle('pp-sheet-lock', !!open && _ppMobile());
}

// ── 시세 받기 ────────────────────────────────────────────────────────
function _ppStartFeed(reload) {
  if (!_pp.on || !_pp.code) { _ppStopFeed(); return; }
  if (reload || !_pp.quote || _pp.quote.code !== _pp.code) _ppLoadQuote();
  _ppWatch();
  clearInterval(_pp.hb); _pp.hb = setInterval(_ppWatch, 30000);
  clearInterval(_pp.clock); _pp.clock = setInterval(() => { _ppLoadQuote(true); _ppLoadState(); }, 30000);   // 지금 장(시간대) 바뀜 반영
  if (!_pp.state) _ppLoadState();
}

function _ppStopFeed() { clearInterval(_pp.hb); clearInterval(_pp.clock); _pp.hb = _pp.clock = null; }

function _ppWatch() {
  if (_pp.on && _pp.view === 'chart' && window._rtSocket && _pp.code) window._rtSocket.emit('paper_watch', { code: _pp.code, name: _pp.name });
}

async function _ppLoadQuote(quiet) {
  const code = _pp.code;
  if (!code) return;
  try {
    const q = await api(`/api/paper/quote/${encodeURIComponent(code)}?name=${encodeURIComponent(_pp.name)}`);
    if (_pp.code !== q.code) return;
    _pp.quote = q;
    if (!quiet || !_pp.book) _pp.book = q.book || _pp.book;
    if (!quiet || !_pp.trade) _pp.trade = q.trade || _pp.trade;
    if (!quiet) _pp.ticks = q.ticks || [];
    if (q.error && !quiet) _ppToast(q.error, 'err');
  } catch { return; }
  const pr = document.getElementById('pp-price');
  const last = (_pp.trade && _pp.trade.price) || (_pp.quote && _pp.quote.price && _pp.quote.price.price);
  if (!quiet && last) pr.value = last.toLocaleString('ko-KR');
  _ppRenderHead(); _ppRenderBook(); _ppRenderTicks(); _ppRenderOrder(); _ppRenderHere(); _ppLines();
}

async function _ppLoadState() {
  try { _pp.state = await api('/api/paper/state'); } catch { return; }
  _ppAfterState();
  if (!_pp.state.round && !_pp.askedStart && (_pp.on || _pp.view === 'paper')) { _pp.askedStart = true; _ppOpenReset(true); }
}

function _ppAfterState() {
  _ppRenderAcct(); _ppRenderOrder(); _ppRenderHere(); _ppLines();
}

// ── 그리기: 머리·지금 장·호가·체결 ─────────────────────────────────────
function _ppRenderPhase(ph) {
  const band = document.getElementById('pp-live'), note = document.getElementById('pp-phase-note');
  if (!band) return;
  if (!ph) { band.textContent = ''; band.className = 'pp-live off'; note.textContent = ''; return; }
  if (!ph.id) { band.textContent = '장 닫힘'; band.className = 'pp-live off'; note.textContent = ph.note ? `주문은 ${ph.note}` : ''; return; }
  band.textContent = `${ph.name} ~${ph.end}`; band.className = 'pp-live';
  note.textContent = ph.note || '';
}

function _ppRenderHead() {
  _ppRenderPhase(_pp.quote && _pp.quote.phase);
  const t = _pp.trade || {}, p = (_pp.quote && _pp.quote.price) || {};
  const price = t.price || p.price, chg = t.chg != null && t.venue !== 'OT' ? t.chg : p.chg, rate = t.rate != null && t.venue !== 'OT' ? t.rate : p.rate;
  const cls = _ppCls(chg);
  const html = price ? `<b class="${cls}">${_ppW(price)}</b>
    <span class="${cls}">${chg > 0 ? '▲' : chg < 0 ? '▼' : ''} ${_ppW(Math.abs(chg || 0))} (${rate > 0 ? '+' : ''}${(+rate || 0).toFixed(2)}%)</span>
    ${t.venue === 'OT' ? '<small class="pp-tag">시간외 단일가</small>' : t.venue === 'NX' ? '<small class="pp-tag">NXT</small>' : ''}` : '<span class="pp-muted">시세를 불러오는 중…</span>';
  document.getElementById('pp-price-now').innerHTML = html;
  const mp = document.getElementById('pp-mbar-price');
  if (mp) mp.innerHTML = price ? `<b class="${cls}">${_ppW(price)}</b> <small class="${cls}">${rate > 0 ? '+' : ''}${(+rate || 0).toFixed(2)}%</small>` : '';
}

function _ppRenderBook() {
  const el = document.getElementById('pp-book');
  const b = _pp.book;
  if (!b || (!(b.asks || []).length && !(b.bids || []).length)) { el.innerHTML = '<div class="pp-muted pp-pad">호가 없음</div>'; return; }
  const n = _ppMobile() ? 5 : 10;
  const asks = (b.asks || []).slice(0, n), bids = (b.bids || []).slice(0, n);
  const mx = Math.max(1, ...asks.map(x => x[1]), ...bids.map(x => x[1]));
  const prev = _pp.quote && _pp.quote.price && _pp.quote.price.prev_close;
  const last = _pp.trade && _pp.trade.price;
  const pc = p => prev ? _ppCls(p - prev) : '';
  const pct = p => prev ? `<small>${((p / prev - 1) * 100).toFixed(2)}%</small>` : '';
  const row = (p, q, side) => `<button type="button" class="pp-row ${side}${p === last ? ' last' : ''}" data-p="${p}" aria-label="${_ppW(p)}원 ${side === 'ask' ? '매도' : '매수'} 잔량 ${_ppW(q)}">
      <span class="pp-q">${side === 'ask' ? `<i style="width:${q / mx * 100}%"></i><em>${_ppW(q)}</em>` : ''}</span>
      <span class="pp-p ${pc(p)}">${_ppW(p)} ${pct(p)}</span>
      <span class="pp-q">${side === 'bid' ? `<i style="width:${q / mx * 100}%"></i><em>${_ppW(q)}</em>` : ''}</span></button>`;
  el.innerHTML = `<div class="pp-book-hd"><span>매도 잔량</span><span>가격</span><span>매수 잔량</span></div>
    ${asks.slice().reverse().map(x => row(x[0], x[1], 'ask')).join('')}${bids.map(x => row(x[0], x[1], 'bid')).join('')}
    <div class="pp-book-ft"><span class="down">${_ppW(b.total_ask)}</span><span>총 잔량${b.venue === 'OT' ? ' · 시간외' : b.venue === 'NX' ? ' · NXT' : ''}</span><span class="up">${_ppW(b.total_bid)}</span></div>`;
}

function _ppRenderTicks() {
  const el = document.getElementById('pp-ticks-body');
  const prev = _pp.quote && _pp.quote.price && _pp.quote.price.prev_close;
  const hm = h => h ? `${String(h).slice(0, 2)}:${String(h).slice(2, 4)}:${String(h).slice(4, 6)}` : '';
  el.innerHTML = _pp.ticks.length ? _pp.ticks.slice(0, 25).map(t => `<div class="pp-tick"><span>${hm(t.hour)}</span>
      <span class="${prev ? _ppCls(t.price - prev) : ''}">${_ppW(t.price)}</span><span class="${prev ? _ppCls(t.price - prev) : ''}">${prev ? _ppSigned(t.price - prev) : ''}</span>
      <span class="${t.side === '1' ? 'up' : t.side === '5' ? 'down' : ''}">${_ppW(t.vol)}</span></div>`).join('')
    : '<div class="pp-muted pp-pad">체결이 들어오면 여기에 보여요</div>';
  const s = _pp.trade && _pp.trade.strength;
  document.getElementById('pp-strength').textContent = s ? `체결강도 ${(+s).toFixed(1)}%` : '';
}

// ── 주문 ─────────────────────────────────────────────────────────────
function _ppKind() { const ph = _pp.quote && _pp.quote.phase; return ph && ph.id ? ph.kind : null; }

function _ppRenderOrder() {
  if (!_pp.booted) return;
  const buy = _pp.side === 'buy', kind = _ppKind(), st = _pp.state || {};
  document.querySelectorAll('#pp-side button').forEach(b => b.classList.toggle('on', b.dataset.side === _pp.side));
  if (kind === 'single' && _pp.otype === 'market') _pp.otype = 'limit';
  document.querySelectorAll('#pp-otype button').forEach(b => {
    b.classList.toggle('on', b.dataset.ot === _pp.otype);
    b.disabled = kind === 'single' && b.dataset.ot === 'market';
  });
  const pr = document.getElementById('pp-price');
  pr.disabled = _pp.otype === 'market';
  document.getElementById('pp-price-wrap').classList.toggle('dim', pr.disabled);
  const fx = document.getElementById('pp-fixed-note');
  fx.textContent = _pp.otype === 'market' && kind === 'close_prev' ? '시장가 = 전일 종가로 바로 체결' : _pp.otype === 'market' && kind === 'close_today' ? '시장가 = 오늘 종가로 바로 체결'
    : _pp.otype === 'market' && (kind === 'auc_open' || kind === 'auc_close') ? '시장가 = 동시호가 가격으로 한 번에 체결' : '';
  const pos = (st.positions || []).find(p => p.code === _pp.code);
  document.getElementById('pp-avail-k').textContent = buy ? '주문 가능 금액' : '매도 가능';
  document.getElementById('pp-avail').textContent = buy ? `${_ppW(st.orderable)}원` : `${_ppW(pos ? pos.sellable : 0)}주`;
  const btn = document.getElementById('pp-submit');
  btn.className = 'pp-submit ' + (buy ? 'buy' : 'sell');
  btn.disabled = !(st.round && kind && _pp.code);
  _ppCalc();
}

function _ppNum(id) { return +String(document.getElementById(id).value || '').replace(/[^0-9]/g, '') || 0; }

function _ppEstPrice() {
  const kind = _ppKind(), p = (_pp.quote && _pp.quote.price) || {};
  if (_pp.otype === 'limit') return _ppNum('pp-price');
  if (kind === 'close_prev') return p.prev_close || 0;
  if (kind === 'close_today') return p.price || 0;
  const b = _pp.book || {}, side = _pp.side === 'buy' ? (b.asks || []) : (b.bids || []);
  return (side[0] && side[0][0]) || (_pp.trade && _pp.trade.price) || p.price || 0;
}

function _ppCalc() {
  const st = _pp.state || {}, p = _ppEstPrice(), q = _ppNum('pp-qty'), amt = p * q;
  const fee = Math.floor(amt * (st.fee_rate || 0.00015)), tax = _pp.side === 'sell' ? Math.floor(amt * (st.tax_rate || 0.002)) : 0;
  document.getElementById('pp-amt').textContent = amt ? `${_ppW(amt)}원` : '—';
  document.getElementById('pp-fee').textContent = amt ? `${_ppW(fee + tax)}원` : '—';
  const btn = document.getElementById('pp-submit'), ph = _pp.quote && _pp.quote.phase;
  btn.textContent = !st.round ? '시작 금액을 먼저 정하세요' : ph && !ph.id ? '지금은 장이 닫혀 있어요'
    : `${_pp.side === 'buy' ? '매수' : '매도'} ${q ? q.toLocaleString() + '주' : ''}${p && q ? ' · ' + _ppW(p) + '원' : ''}${_pp.otype === 'market' ? ' (시장가)' : ''}`;
}

function _ppStep(dir) {
  const p = _ppNum('pp-price') || (_pp.trade && _pp.trade.price) || 0;
  if (!p) return;
  const t = _ppTick(dir < 0 ? p - 1 : p);
  const n = Math.max(t, (Math.round(p / t) + dir) * t);
  document.getElementById('pp-price').value = n.toLocaleString('ko-KR'); _ppCalc();
}

function _ppPct(pct) {
  const st = _pp.state || {};
  if (_pp.side === 'buy') {
    const p = _ppEstPrice(); if (!p) return;
    const q = Math.floor((st.orderable || 0) * pct / 100 / (p * (1 + (st.fee_rate || 0.00015))));
    document.getElementById('pp-qty').value = Math.max(0, q);
  } else {
    const pos = (st.positions || []).find(x => x.code === _pp.code);
    document.getElementById('pp-qty').value = pos ? Math.floor(pos.sellable * pct / 100) : 0;
  }
  _ppCalc();
}

async function _ppSubmit() {
  const q = _ppNum('pp-qty'), p = _ppNum('pp-price'), ph = (_pp.quote && _pp.quote.phase) || {};
  if (!q) { _ppToast('수량을 넣어 주세요', 'err'); return; }
  const priceTxt = _pp.otype === 'market' ? '시장가' : `${_ppW(p)}원`;
  if (!confirm(`[모의투자] ${_pp.name} ${q.toLocaleString()}주 ${priceTxt} ${_pp.side === 'buy' ? '매수' : '매도'}\n지금: ${ph.name || ''}${_pp.otype === 'limit' ? ' (안 되면 그날 장이 끝날 때까지 이어서 대기)' : ''}\n\n실제 돈이 아닌 가상 주문입니다. 주문할까요?`)) return;
  const btn = document.getElementById('pp-submit'); btn.disabled = true;
  try {
    const r = await _ppPost('/api/paper/order', { code: _pp.code, name: _pp.name, side: _pp.side, otype: _pp.otype, price: p, qty: q });
    _pp.state = Object.assign(_pp.state || {}, r.state);
    const o = r.order;
    _ppToast(o.status === 'filled' ? `체결 완료 · ${o.filled.toLocaleString()}주 평균 ${_ppW(o.avg_fill)}원` : o.filled ? `일부 체결 ${o.filled}/${o.qty}주 · 나머지 대기` : '주문 접수 · 체결 대기', o.side);
    if (_ppMobile() && o.status === 'filled') _ppSheet(false);
  } catch (e) { _ppToast(e.message, 'err'); }
  btn.disabled = false;
  _ppAfterState();
}

// 차트 옆: 이 종목 보유·미체결
function _ppRenderHere() {
  const el = document.getElementById('pp-here');
  if (!el || !_pp.code) return;
  const st = _pp.state || {};
  if (!st.round) { el.innerHTML = '<span class="pp-muted">시작 금액을 정하면 모의투자가 시작돼요</span>'; return; }
  const pos = (st.positions || []).find(p => p.code === _pp.code);
  const open = (st.orders || []).filter(o => o.status === 'open' && o.code === _pp.code);
  const last = (_pp.trade && _pp.trade.price) || (pos && pos.last);
  let h = '';
  if (pos) {
    const pnl = last ? (last - pos.avg) * pos.qty : pos.pnl, pct = last && pos.avg ? (last / pos.avg - 1) * 100 : pos.pct;
    h += `<div class="pp-here-pos"><b>보유 ${pos.qty.toLocaleString()}주</b><span>평균 ${_ppW(pos.avg)}</span>
      <span class="${_ppCls(pnl)}">${_ppSigned(pnl)}원 (${pct > 0 ? '+' : ''}${(+pct || 0).toFixed(2)}%)</span>
      <button type="button" class="pp-mini" data-sellall="${pos.sellable}">매도</button></div>`;
  }
  if (open.length) h += open.map(o => `<div class="pp-here-ord"><span class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? '매수' : '매도'} 대기</span>
      <span>${o.price ? _ppW(o.price) + '원' : '시장가'} · ${o.filled}/${o.qty}주</span><button type="button" class="pp-mini" data-cancel="${o.id}">취소</button></div>`).join('');
  h += `<div class="pp-here-acct"><span>총 자산 <b>${_ppW(st.equity)}</b></span><span class="${_ppCls(st.pnl)}">${_ppSigned(st.pnl)} (${st.pct > 0 ? '+' : ''}${st.pct}%)</span>
    <a href="#" data-goacct>내 계좌 →</a></div>`;
  el.innerHTML = h;
}

async function _ppCancelClick(e) {
  const go = e.target.closest('[data-goacct]');
  if (go) { e.preventDefault(); switchView('paper'); return; }
  const sa = e.target.closest('[data-sellall]');
  if (sa) { _pp.side = 'sell'; document.getElementById('pp-qty').value = sa.dataset.sellall; _ppRenderOrder(); if (_ppMobile()) _ppSheet(true); document.getElementById('pp-qty').focus(); return; }
  const c = e.target.closest('[data-cancel]');
  if (!c) return;
  try { const r = await _ppPost('/api/paper/cancel', { id: +c.dataset.cancel }); _pp.state = Object.assign(_pp.state || {}, r.state); _ppToast('주문을 취소했어요'); }
  catch (err) { _ppToast(err.message, 'err'); }
  _ppAfterState();
}

// 차트 위 선: 평균 단가(노랑 실선)·대기 주문(매수 빨강·매도 파랑 점선)
function _ppClearLines() {
  if (_pp.lineSeries) _pp.lines.forEach(l => { try { _pp.lineSeries.removePriceLine(l); } catch {} });
  _pp.lines = []; _pp.lineSeries = null;
}

function _ppLines() {
  _ppClearLines();
  if (!_pp.on || !_pp.code || typeof _candleSeries === 'undefined' || !_candleSeries) return;
  if (typeof _currentTicker !== 'undefined' && _currentTicker !== _pp.ticker) return;
  const st = _pp.state || {};
  const add = o => { try { _pp.lines.push(_candleSeries.createPriceLine(o)); } catch {} };
  _pp.lineSeries = _candleSeries;
  const pos = (st.positions || []).find(p => p.code === _pp.code);
  if (pos) add({ price: pos.avg, color: '#e3b341', lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: `평균 ${pos.qty}주` });
  (st.orders || []).filter(o => o.status === 'open' && o.code === _pp.code && o.price).forEach(o =>
    add({ price: o.price, color: o.side === 'buy' ? C_UP : C_DN, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: `${o.side === 'buy' ? '매수' : '매도'} 대기 ${o.qty - o.filled}주` }));
}

// ── 💹 탭: 내 계좌 ───────────────────────────────────────────────────
function _ppRenderAcct() {
  const st = _pp.state;
  const sum = document.getElementById('pp-acct-sum'), body = document.getElementById('pp-acct-body');
  if (!sum) return;
  if (!st || !st.round) { sum.innerHTML = '<b>내 모의계좌</b><span class="pp-muted">시작 금액을 정하면 시작돼요</span>'; body.innerHTML = ''; return; }
  document.getElementById('pp-round-label').textContent = `${st.round.no}회차 · 시작 ${_ppW(st.round.start_cash)}원`;
  sum.innerHTML = `<b>내 모의계좌 <small>${st.round.no}회차</small></b>
    <span>총 자산 <b>${_ppW(st.equity)}</b></span><span>평가 손익 <b class="${_ppCls(st.pnl)}">${_ppSigned(st.pnl)} (${st.pct > 0 ? '+' : ''}${st.pct}%)</b></span>
    <span>예수금 <b>${_ppW(st.cash)}</b></span><span>주식 평가 <b>${_ppW(st.stock_value)}</b></span>`;
  const open = (st.orders || []).filter(o => o.status === 'open');
  const cnt = { pos: (st.positions || []).length, open: open.length, fills: (st.fills || []).length };
  document.querySelectorAll('#pp-acct-tabs button').forEach(b => { b.classList.toggle('on', b.dataset.tab === _pp.tab); b.querySelector('small').textContent = cnt[b.dataset.tab] || ''; });
  const sname = id => id === 'auto' ? '통합 (자동)' : ((st.all_sessions || []).find(s => s.id === id) || {}).name || id;
  const tm = ts => new Date(ts * 1000).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (_pp.tab === 'pos') {
    body.innerHTML = cnt.pos ? `<table class="pp-tbl"><thead><tr><th>종목</th><th class="num">보유</th><th class="num">평균 단가</th><th class="num">현재가</th><th class="num">평가 금액</th><th class="num">손익</th><th class="num">수익률</th><th></th></tr></thead><tbody>
      ${st.positions.map(p => `<tr data-code="${p.code}" data-name="${_escHtml(p.name)}"><td><a href="#" data-pick>${_escHtml(p.name)}</a> <small>${p.code}</small></td><td class="num">${p.qty.toLocaleString()}</td>
        <td class="num">${_ppW(p.avg)}</td><td class="num">${_ppW(p.last)}</td><td class="num">${_ppW(p.value)}</td>
        <td class="num ${_ppCls(p.pnl)}">${_ppSigned(p.pnl)}</td><td class="num ${_ppCls(p.pct)}">${p.pct == null ? '—' : (p.pct > 0 ? '+' : '') + p.pct + '%'}</td>
        <td><button type="button" class="pp-mini" data-sell="${p.sellable}">차트에서 매도</button></td></tr>`).join('')}</tbody></table>` : '<div class="pp-muted pp-pad">보유 종목이 없어요 — 모의투자 모드를 켜고 국내 종목 차트에서 주문하세요</div>';
  } else if (_pp.tab === 'open') {
    body.innerHTML = open.length ? `<table class="pp-tbl"><thead><tr><th>시각</th><th>종목</th><th>구분</th><th class="num">가격</th><th class="num">체결/주문</th><th>방식</th><th></th></tr></thead><tbody>
      ${open.map(o => `<tr><td>${tm(o.ts)}</td><td>${_escHtml(o.name)}</td><td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? '매수' : '매도'}</td>
        <td class="num">${o.price ? _ppW(o.price) : '시장가'}</td><td class="num">${o.filled}/${o.qty}</td><td>${_escHtml(sname(o.session))}</td>
        <td><button type="button" class="pp-mini" data-cancel="${o.id}">취소</button></td></tr>`).join('')}</tbody></table>` : '<div class="pp-muted pp-pad">체결을 기다리는 주문이 없어요</div>';
  } else {
    body.innerHTML = cnt.fills ? `<table class="pp-tbl"><thead><tr><th>시각</th><th>종목</th><th>구분</th><th class="num">체결가</th><th class="num">수량</th><th class="num">수수료+세금</th><th class="num">실현 손익</th></tr></thead><tbody>
      ${st.fills.map(f => `<tr><td>${tm(f.ts)}</td><td>${_escHtml(f.name)}</td><td class="${f.side === 'buy' ? 'up' : 'down'}">${f.side === 'buy' ? '매수' : '매도'}</td>
        <td class="num">${_ppW(f.price)}</td><td class="num">${f.qty.toLocaleString()}</td><td class="num">${_ppW(f.fee + f.tax)}</td>
        <td class="num ${_ppCls(f.pnl)}">${f.pnl == null ? '' : _ppSigned(f.pnl)}</td></tr>`).join('')}</tbody></table>` : '<div class="pp-muted pp-pad">이번 회차 체결 내역이 없어요</div>';
  }
}

async function _ppAcctClick(e) {
  const c = e.target.closest('[data-cancel]');
  if (c) {
    try { const r = await _ppPost('/api/paper/cancel', { id: +c.dataset.cancel }); _pp.state = Object.assign(_pp.state || {}, r.state); _ppToast('주문을 취소했어요'); }
    catch (err) { _ppToast(err.message, 'err'); }
    _ppAfterState(); return;
  }
  const tr = e.target.closest('tr[data-code]');
  if (!tr) return;
  e.preventDefault();
  const s = (window._krStocks || []).find(x => x.code === tr.dataset.code);
  const t = s ? s.ticker : tr.dataset.code + '.KS';
  const sell = e.target.closest('[data-sell]');
  if (!_pp.on) _ppSetMode(true, true);
  navigateToChart(t);
  if (sell) { _pp.side = 'sell'; document.getElementById('pp-qty').value = sell.dataset.sell; _ppRenderOrder(); if (_ppMobile()) _ppSheet(true); }
}

function _ppOpenReset(first) {
  const m = document.getElementById('pp-reset-modal');
  document.getElementById('pp-reset-title').textContent = first ? '모의투자 시작 — 시작 금액' : '리셋 — 새 회차 시작';
  document.getElementById('pp-reset-desc').textContent = first ? '가상 계좌에 넣을 금액을 정하세요. 언제든 리셋해서 다시 시작할 수 있어요.'
    : '지금 회차를 끝내고 결과를 회차 기록에 남긴 뒤, 아래 금액으로 새 회차를 시작해요. 미체결 주문은 취소돼요.';
  const st = _pp.state || {};
  document.getElementById('pp-reset-amt').value = _ppW((st.round && st.round.start_cash) || 10000000);
  m.hidden = false;
  document.getElementById('pp-reset-amt').focus();
}

async function _ppDoReset() {
  const amt = _ppNum('pp-reset-amt');
  try {
    const r = await _ppPost('/api/paper/reset', { amount: amt });
    _pp.state = Object.assign(_pp.state || {}, r.state);
    document.getElementById('pp-reset-modal').hidden = true;
    _ppToast(`${r.state.round.no}회차 시작 · ${_ppW(amt)}원`);
    _pp.tab = 'pos'; _ppAfterState();
  } catch (e) { _ppToast(e.message, 'err'); }
}

async function _ppOpenRounds() {
  const m = document.getElementById('pp-rounds-modal'), body = document.getElementById('pp-rounds-body');
  m.hidden = false; body.innerHTML = '<div class="pp-muted pp-pad">불러오는 중…</div>';
  let rs = [];
  try { rs = await api('/api/paper/rounds'); } catch {}
  const d = ts => ts ? new Date(ts * 1000).toLocaleDateString('ko-KR', { year: '2-digit', month: 'numeric', day: 'numeric' }) : '';
  body.innerHTML = rs.length ? `<div class="pp-tbl-wrap"><table class="pp-tbl"><thead><tr><th>회차</th><th>기간</th><th class="num">시작</th><th class="num">최종</th><th class="num">수익률</th><th class="num">손익</th>
      <th class="num" title="매수·매도 체결 수">체결</th><th class="num" title="이익으로 끝난 매도 주문 비율">승률</th><th class="num" title="가장 높았던 자산에서 가장 많이 떨어진 비율">최대 낙폭</th><th class="num">수수료+세금</th></tr></thead><tbody>
    ${rs.map(r => `<tr class="${r.active ? 'pp-now' : ''}"><td><b>${r.no}</b>${r.active ? ' <small>진행 중</small>' : ''}</td><td>${d(r.started)} ~ ${r.active ? '' : d(r.ended)}</td>
      <td class="num">${_ppW(r.start_cash)}</td><td class="num">${_ppW(r.end_value)}</td><td class="num ${_ppCls(r.pct)}"><b>${r.pct > 0 ? '+' : ''}${r.pct}%</b></td>
      <td class="num ${_ppCls(r.pnl)}">${_ppSigned(r.pnl)}</td><td class="num">${r.trades}</td><td class="num">${r.win_rate == null ? '—' : r.win_rate + '% <small>(' + r.wins + '/' + r.sells + ')</small>'}</td>
      <td class="num down">${r.mdd ? r.mdd + '%' : '0%'}</td><td class="num">${_ppW(r.cost)}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="pp-muted pp-pad">아직 회차가 없어요</div>';
}

function _ppToast(msg, kind) {
  const box = document.getElementById('pp-toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = 'pp-toast ' + (kind || '');
  t.innerHTML = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}
