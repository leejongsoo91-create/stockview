/* ═══════════════════════════════════════════════════════════════
   paper.js — 💹 모의투자 탭 (11-26)
   사이트 자체 가상계좌 + 한국투자증권 실시간 호가·체결(조회만). 증권사로 주문은 나가지 않는다.
   차트는 차트 탭의 차트를 그대로 옮겨 붙인다(켜 둔 이평선·지표·그림·봉 간격이 같음).
   ═══════════════════════════════════════════════════════════════ */

let _pp = { inited: false, active: false, ticker: null, code: null, name: '', session: null, side: 'buy', otype: 'limit',
            state: null, quote: null, book: null, trade: null, ticks: [], tab: 'pos', moved: null, hb: null, clock: null };

function _ppTick(p) { for (const [lim, t] of [[2000, 1], [5000, 5], [20000, 10], [50000, 50], [200000, 100], [500000, 500]]) if (p < lim) return t; return 1000; }
const _ppW = n => n == null ? '—' : Math.round(n).toLocaleString('ko-KR');
const _ppSigned = n => n == null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(Math.round(n)).toLocaleString('ko-KR');
const _ppCls = n => n > 0 ? 'up' : n < 0 ? 'down' : '';

async function _ppPost(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StockView': 'paper' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || r.status);
  return j;
}

// 탭 들어올 때·나갈 때 (main.js switchView에서 부름)
function paperOnView(name) {
  if (name === 'paper') _ppEnter();
  else if (_pp.active) _ppLeave();
}

async function _ppEnter() {
  _pp.active = true;
  if (!_pp.inited) _ppInit();
  _ppMoveChart(true);
  await _ppLoadState();
  if (!_pp.ticker) {
    let last = null; try { last = JSON.parse(localStorage.getItem('PPT') || 'null'); } catch {}
    _ppSelect(last && last.t ? last.t : '005930.KS', last && last.n ? last.n : '삼성전자');
  } else {
    _ppSelect(_pp.ticker, _pp.name);
  }
  clearInterval(_pp.hb); _pp.hb = setInterval(_ppWatch, 30000);
  clearInterval(_pp.clock); _pp.clock = setInterval(_ppClock, 15000);
}

function _ppLeave() {
  _pp.active = false;
  _ppMoveChart(false);
  clearInterval(_pp.hb); clearInterval(_pp.clock);
}

// 차트 탭의 차트 부분을 이 탭으로 옮겼다가 나갈 때 되돌린다
function _ppMoveChart(into) {
  const slot = document.getElementById('pp-chart-slot');
  if (into) {
    if (_pp.moved || !slot) return;
    if (!_chartInited) { initChart(); _chartInited = true; }
    const nodes = [document.querySelector('#view-chart .chart-toolbar'), document.querySelector('#view-chart .chart-main')].filter(Boolean);
    _pp.moved = nodes.map(n => { const mark = document.createComment('pp'); n.parentNode.insertBefore(mark, n); slot.appendChild(n); return [n, mark]; });
  } else if (_pp.moved) {
    _pp.moved.forEach(([n, mark]) => { mark.parentNode.insertBefore(n, mark); mark.remove(); });
    _pp.moved = null;
  }
  setTimeout(() => { if (typeof _resizeChartPanels === 'function') _resizeChartPanels(); window.dispatchEvent(new Event('resize')); }, 50);
}

function _ppInit() {
  _pp.inited = true;
  const input = document.getElementById('pp-input'), dd = document.getElementById('pp-dd');
  let tm = null;
  input.addEventListener('input', () => {
    clearTimeout(tm);
    tm = setTimeout(() => {
      const q = input.value.trim();
      if (!q) { dd.hidden = true; return; }
      const res = searchStocks(window._krStocks || [], q, 8);
      dd.innerHTML = res.length ? res.map(s => `<button type="button" class="gs-item" data-t="${_escHtml(s.ticker)}" data-n="${_escHtml(s.name)}">
          <span class="gs-ticker">${_escHtml(s.code || '')}</span><span class="gs-name">${_escHtml(s.name)}</span>
          <span class="gs-pct ${_ppCls(s.change_pct)}">${(s.change_pct >= 0 ? '+' : '') + (+s.change_pct || 0).toFixed(2)}%</span></button>`).join('')
        : '<div class="gs-empty">결과 없음</div>';
      dd.hidden = false;
    }, 150);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const b = dd.querySelector('.gs-item'); if (b) b.click(); }
    if (e.key === 'Escape') dd.hidden = true;
  });
  dd.addEventListener('click', e => {
    const b = e.target.closest('.gs-item'); if (!b) return;
    input.value = ''; dd.hidden = true; _ppSelect(b.dataset.t, b.dataset.n);
  });
  document.addEventListener('click', e => { if (!e.target.closest('#pp-search')) dd.hidden = true; });
  if (!window._krStocks) api('/api/kr-stocks').then(d => { window._krStocks = d; }).catch(() => {});

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
    if (_pp.otype !== 'limit') _pp.otype = 'limit';
    _ppRenderOrder();
  });
  document.querySelectorAll('#pp-acct-tabs button').forEach(b => b.onclick = () => { _pp.tab = b.dataset.tab; _ppRenderAcct(); });
  document.getElementById('pp-acct-body').addEventListener('click', _ppAcctClick);
  document.getElementById('pp-reset-btn').onclick = () => _ppOpenReset(false);
  document.getElementById('pp-rounds-btn').onclick = _ppOpenRounds;
  document.getElementById('pp-reset-go').onclick = _ppDoReset;
  document.querySelectorAll('#pp-reset-presets button').forEach(b => b.onclick = () => { document.getElementById('pp-reset-amt').value = (+b.dataset.v).toLocaleString('ko-KR'); });
  document.querySelectorAll('.pp-modal [data-close]').forEach(b => b.onclick = () => b.closest('.pp-modal').hidden = true);
  document.querySelectorAll('.pp-modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.hidden = true; }));

  const sock = window._rtSocket;
  if (sock) {
    sock.on('paper_book', d => { if (_pp.active && d && d.code === _pp.code) { _pp.book = d; _ppRenderBook(); } });
    sock.on('paper_tick', d => {
      if (!_pp.active || !d || d.code !== _pp.code) return;
      const prev = _pp.trade || {};
      _pp.trade = d;
      if (d.vol && (d.acml_vol !== prev.acml_vol || d.hour !== prev.hour)) { _pp.ticks.unshift(d); _pp.ticks = _pp.ticks.slice(0, 40); }
      _ppRenderHead(); _ppRenderTicks(); _ppRenderBook();
    });
    sock.on('paper_acct', st => { if (st && st.round) { _pp.state = Object.assign(_pp.state || {}, st); _ppRenderAcct(); _ppRenderOrder(); } });
    sock.on('paper_fill', f => _ppToast(`${f.side === 'buy' ? '매수' : '매도'} 체결 · ${_escHtml(f.name || f.code)} ${f.qty.toLocaleString()}주 @ ${_ppW(f.price)}원`
      + (f.pnl != null ? ` · 손익 ${_ppSigned(f.pnl)}원` : ''), f.side));
    sock.on('connect', _ppWatch);
  }
}

function _ppWatch() {
  if (_pp.active && window._rtSocket && _pp.code) window._rtSocket.emit('paper_watch', { code: _pp.code, name: _pp.name, session: _pp.session });
}

async function _ppLoadState() {
  try { _pp.state = await api('/api/paper/state'); } catch { _pp.state = null; }
  const st = _pp.state;
  if (!st) return;
  if (!_pp.session || !(st.sessions || []).some(s => s.id === _pp.session)) _pp.session = st.default_session;
  _ppRenderSessions(); _ppRenderAcct(); _ppRenderOrder();
  if (!st.round) _ppOpenReset(true);
}

async function _ppSelect(ticker, name) {
  _pp.ticker = ticker; _pp.name = name || ticker; _pp.code = ticker.replace(/\.(KS|KQ)$/, '');
  _pp.book = null; _pp.trade = null; _pp.ticks = [];
  try { localStorage.setItem('PPT', JSON.stringify({ t: ticker, n: _pp.name })); } catch {}
  document.getElementById('pp-name').innerHTML = `${_escHtml(_pp.name)} <small>${_escHtml(_pp.code)} · ${ticker.endsWith('.KQ') ? '코스닥' : '코스피'}</small>`;
  _ppRenderHead(); _ppRenderBook(); _ppRenderTicks();
  if (typeof loadChart === 'function') loadChart(ticker);
  _ppWatch();
  try {
    const q = await api(`/api/paper/quote/${encodeURIComponent(_pp.code)}?session=${_pp.session || ''}&name=${encodeURIComponent(_pp.name)}`);
    if (_pp.code !== q.code) return;
    _pp.quote = q; _pp.book = q.book || null; _pp.trade = q.trade || null; _pp.ticks = q.ticks || [];
    if (q.error) _ppToast(q.error, 'err');
  } catch {}
  const pr = document.getElementById('pp-price');
  const last = (_pp.trade && _pp.trade.price) || (_pp.quote && _pp.quote.price && _pp.quote.price.price);
  if (last) pr.value = last.toLocaleString('ko-KR');
  _ppRenderHead(); _ppRenderBook(); _ppRenderTicks(); _ppRenderSessions(); _ppRenderOrder();
}

function _ppClock() { _ppLoadState(); }

function _ppRenderSessions() {
  const st = _pp.state || {}, box = document.getElementById('pp-sessions');
  const op = st.sessions || [];
  const nx = _pp.quote ? _pp.quote.nxt : true;
  const band = document.getElementById('pp-live');
  if (!op.length) {
    const next = (st.all_sessions || []).map(s => `${s.name} ${s.start}~${s.end}`).join(' · ');
    box.innerHTML = `<span class="pp-closed">지금은 주문 시간이 아니에요</span><details class="pp-hours"><summary>거래 시간</summary>${_escHtml(next)}</details>`;
    band.textContent = '장 닫힘'; band.className = 'pp-live off';
    return;
  }
  band.textContent = `${op.map(s => s.name).join(' · ')} · ${st.feed || ''}`; band.className = 'pp-live';
  box.innerHTML = op.map(s => {
    const dis = s.id.startsWith('nxt') && nx === false;
    return `<button type="button" data-s="${s.id}" class="${s.id === _pp.session ? 'on' : ''}" ${dis ? 'disabled title="넥스트레이드에서 거래하지 않는 종목"' : ''}>${_escHtml(s.name)} <small>~${s.end}</small></button>`;
  }).join('');
  box.querySelectorAll('button').forEach(b => b.onclick = () => { _pp.session = b.dataset.s; _ppRenderSessions(); _ppRenderOrder(); _ppSelect(_pp.ticker, _pp.name); });
}

function _ppRenderHead() {
  const t = _pp.trade || {}, p = (_pp.quote && _pp.quote.price) || {};
  const price = t.price || p.price, chg = t.chg != null && t.venue !== 'OT' ? t.chg : p.chg, rate = t.rate != null && t.venue !== 'OT' ? t.rate : p.rate;
  const cls = _ppCls(chg);
  document.getElementById('pp-price-now').innerHTML = price ? `<b class="${cls}">${_ppW(price)}</b>
    <span class="${cls}">${chg > 0 ? '▲' : chg < 0 ? '▼' : ''} ${_ppW(Math.abs(chg || 0))} (${rate > 0 ? '+' : ''}${(rate || 0).toFixed(2)}%)</span>
    ${t.venue === 'OT' ? '<small class="pp-tag">시간외 단일가</small>' : t.venue === 'NX' ? '<small class="pp-tag">넥스트레이드</small>' : ''}` : '<span class="pp-muted">시세를 불러오는 중…</span>';
  const ohlc = [['시가', t.open || p.open], ['고가', t.high || p.high, 'up'], ['저가', t.low || p.low, 'down'], ['전일', p.prev_close], ['거래량', t.acml_vol || p.vol]];
  document.getElementById('pp-ohlc').innerHTML = ohlc.map(([k, v, c]) => `<span>${k} <b class="${c || ''}">${_ppW(v)}</b></span>`).join('');
}

function _ppRenderBook() {
  const el = document.getElementById('pp-book');
  const b = _pp.book;
  if (!b || (!(b.asks || []).length && !(b.bids || []).length)) { el.innerHTML = '<div class="pp-muted pp-pad">호가 없음</div>'; return; }
  const asks = (b.asks || []).slice(0, 10), bids = (b.bids || []).slice(0, 10);
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

function _ppSessKind() { const s = ((_pp.state || {}).all_sessions || []).find(x => x.id === _pp.session); return s ? s.kind : null; }

function _ppRenderOrder() {
  const buy = _pp.side === 'buy', kind = _ppSessKind(), st = _pp.state || {};
  document.querySelectorAll('#pp-side button').forEach(b => b.classList.toggle('on', b.dataset.side === _pp.side));
  const fixed = kind === 'close_prev' || kind === 'close_today';
  if (kind === 'single' && _pp.otype === 'market') _pp.otype = 'limit';
  document.querySelectorAll('#pp-otype button').forEach(b => {
    b.classList.toggle('on', b.dataset.ot === _pp.otype && !fixed);
    b.disabled = fixed || (kind === 'single' && b.dataset.ot === 'market');
  });
  const pr = document.getElementById('pp-price');
  pr.disabled = _pp.otype === 'market' || fixed;
  document.getElementById('pp-price-wrap').classList.toggle('dim', pr.disabled);
  if (fixed) { const p = (_pp.quote || {}).price || {}; pr.value = _ppW(kind === 'close_prev' ? p.prev_close : p.price); }
  document.getElementById('pp-fixed-note').textContent = fixed ? (kind === 'close_prev' ? '전일 종가로 바로 체결' : '오늘 종가로 바로 체결')
    : kind === 'single' ? '10분마다 한 가격으로 체결 · 종가 ±10% 안' : kind === 'auc_open' ? '9시 시가로 한 번에 체결' : kind === 'auc_close' ? '15시 30분 종가로 한 번에 체결' : '';
  const pos = (st.positions || []).find(p => p.code === _pp.code);
  document.getElementById('pp-avail-k').textContent = buy ? '주문 가능 금액' : '매도 가능';
  document.getElementById('pp-avail').textContent = buy ? `${_ppW(st.orderable)}원` : `${_ppW(pos ? pos.sellable : 0)}주`;
  const btn = document.getElementById('pp-submit');
  btn.className = 'pp-submit ' + (buy ? 'buy' : 'sell');
  const can = (st.sessions || []).length && _pp.session && st.round;
  btn.disabled = !can;
  _ppCalc();
}

function _ppNum(id) { return +String(document.getElementById(id).value || '').replace(/[^0-9]/g, '') || 0; }

function _ppEstPrice() {
  if (_pp.otype === 'limit' || _ppSessKind() === 'close_prev' || _ppSessKind() === 'close_today') return _ppNum('pp-price');
  const b = _pp.book || {}, side = _pp.side === 'buy' ? (b.asks || []) : (b.bids || []);
  return (side[0] && side[0][0]) || (_pp.trade && _pp.trade.price) || 0;
}

function _ppCalc() {
  const st = _pp.state || {}, p = _ppEstPrice(), q = _ppNum('pp-qty'), amt = p * q;
  const fee = Math.floor(amt * (st.fee_rate || 0.00015)), tax = _pp.side === 'sell' ? Math.floor(amt * (st.tax_rate || 0.002)) : 0;
  document.getElementById('pp-amt').textContent = amt ? `${_ppW(amt)}원` : '—';
  document.getElementById('pp-fee').textContent = amt ? `${_ppW(fee + tax)}원` : '—';
  const btn = document.getElementById('pp-submit');
  const s = ((st.sessions || []).find(x => x.id === _pp.session) || {}).name;
  btn.textContent = !st.round ? '시작 금액을 먼저 정하세요' : !(st.sessions || []).length ? '지금은 주문 시간이 아님'
    : `${_pp.side === 'buy' ? '매수' : '매도'} ${q ? q.toLocaleString() + '주' : ''}${p && q ? ' · ' + _ppW(p) + '원' : ''}${_pp.otype === 'market' ? ' (시장가)' : ''}`;
  btn.title = s ? `${s}에 주문` : '';
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
  const q = _ppNum('pp-qty'), p = _ppNum('pp-price'), kind = _ppSessKind();
  if (!q) { _ppToast('수량을 넣어 주세요', 'err'); return; }
  const sname = (((_pp.state || {}).sessions || []).find(x => x.id === _pp.session) || {}).name || '';
  const priceTxt = _pp.otype === 'market' && kind !== 'close_prev' && kind !== 'close_today' ? '시장가' : `${_ppW(p)}원`;
  if (!confirm(`[모의투자] ${_pp.name} ${q.toLocaleString()}주 ${priceTxt} ${_pp.side === 'buy' ? '매수' : '매도'}\n${sname}\n\n실제 돈이 아닌 가상 주문입니다. 주문할까요?`)) return;
  const btn = document.getElementById('pp-submit'); btn.disabled = true;
  try {
    const r = await _ppPost('/api/paper/order', { code: _pp.code, name: _pp.name, side: _pp.side, otype: _pp.otype, price: p, qty: q, session: _pp.session });
    _pp.state = Object.assign(_pp.state || {}, r.state);
    const o = r.order;
    _ppToast(o.status === 'filled' ? `체결 완료 · ${o.filled.toLocaleString()}주 평균 ${_ppW(o.avg_fill)}원` : o.filled ? `일부 체결 ${o.filled}/${o.qty}주 · 나머지 대기` : '주문 접수 · 체결 대기', o.side);
    _pp.tab = o.status === 'open' ? 'open' : 'pos';
  } catch (e) { _ppToast(e.message, 'err'); }
  btn.disabled = false;
  _ppRenderAcct(); _ppRenderOrder();
}

function _ppRenderAcct() {
  const st = _pp.state;
  const sum = document.getElementById('pp-acct-sum'), body = document.getElementById('pp-acct-body');
  if (!st || !st.round) { sum.innerHTML = '<b>내 모의계좌</b><span class="pp-muted">시작 금액을 정하면 시작돼요</span>'; body.innerHTML = ''; return; }
  document.getElementById('pp-round-label').textContent = `${st.round.no}회차 · 시작 ${_ppW(st.round.start_cash)}원`;
  sum.innerHTML = `<b>내 모의계좌 <small>${st.round.no}회차</small></b>
    <span>총 자산 <b>${_ppW(st.equity)}</b></span><span>평가 손익 <b class="${_ppCls(st.pnl)}">${_ppSigned(st.pnl)} (${st.pct > 0 ? '+' : ''}${st.pct}%)</b></span>
    <span>예수금 <b>${_ppW(st.cash)}</b></span><span>주식 평가 <b>${_ppW(st.stock_value)}</b></span>`;
  const open = (st.orders || []).filter(o => o.status === 'open');
  const cnt = { pos: (st.positions || []).length, open: open.length, fills: (st.fills || []).length };
  document.querySelectorAll('#pp-acct-tabs button').forEach(b => { b.classList.toggle('on', b.dataset.tab === _pp.tab); b.querySelector('small').textContent = cnt[b.dataset.tab] || ''; });
  const sname = id => ((st.all_sessions || []).find(s => s.id === id) || {}).name || id;
  const tm = ts => new Date(ts * 1000).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (_pp.tab === 'pos') {
    body.innerHTML = cnt.pos ? `<table class="pp-tbl"><thead><tr><th>종목</th><th class="num">보유</th><th class="num">평균 단가</th><th class="num">현재가</th><th class="num">평가 금액</th><th class="num">손익</th><th class="num">수익률</th><th></th></tr></thead><tbody>
      ${st.positions.map(p => `<tr data-code="${p.code}" data-name="${_escHtml(p.name)}"><td><a href="#" data-pick>${_escHtml(p.name)}</a> <small>${p.code}</small></td><td class="num">${p.qty.toLocaleString()}</td>
        <td class="num">${_ppW(p.avg)}</td><td class="num">${_ppW(p.last)}</td><td class="num">${_ppW(p.value)}</td>
        <td class="num ${_ppCls(p.pnl)}">${_ppSigned(p.pnl)}</td><td class="num ${_ppCls(p.pct)}">${p.pct == null ? '—' : (p.pct > 0 ? '+' : '') + p.pct + '%'}</td>
        <td><button type="button" class="pp-mini" data-sell="${p.sellable}">매도</button></td></tr>`).join('')}</tbody></table>` : '<div class="pp-muted pp-pad">보유 종목이 없어요</div>';
  } else if (_pp.tab === 'open') {
    body.innerHTML = open.length ? `<table class="pp-tbl"><thead><tr><th>시각</th><th>종목</th><th>구분</th><th class="num">가격</th><th class="num">체결/주문</th><th>세션</th><th></th></tr></thead><tbody>
      ${open.map(o => `<tr><td>${tm(o.ts)}</td><td>${_escHtml(o.name)}</td><td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? '매수' : '매도'}</td>
        <td class="num">${o.price ? _ppW(o.price) : '시장가'}</td><td class="num">${o.filled}/${o.qty}</td><td>${_escHtml(sname(o.session))}</td>
        <td><button type="button" class="pp-mini" data-cancel="${o.id}">취소</button></td></tr>`).join('')}</tbody></table>` : '<div class="pp-muted pp-pad">체결을 기다리는 주문이 없어요</div>';
  } else {
    const ordersById = {}; (st.orders || []).forEach(o => ordersById[o.id] = o);
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
    _ppRenderAcct(); _ppRenderOrder(); return;
  }
  const tr = e.target.closest('tr[data-code]');
  if (!tr) return;
  e.preventDefault();
  const st = (window._krStocks || []).find(s => s.code === tr.dataset.code);
  const t = st ? st.ticker : tr.dataset.code + '.KS';
  const sell = e.target.closest('[data-sell]');
  if (t !== _pp.ticker) await _ppSelect(t, tr.dataset.name);
  if (sell) { _pp.side = 'sell'; document.getElementById('pp-qty').value = sell.dataset.sell; _ppRenderOrder(); document.getElementById('pp-qty').focus(); }
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
    _pp.tab = 'pos'; _ppRenderAcct(); _ppRenderOrder();
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
  const t = document.createElement('div');
  t.className = 'pp-toast ' + (kind || '');
  t.innerHTML = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}
