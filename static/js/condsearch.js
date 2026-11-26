// ── 🎯 조건검색 탭 (11-26) ──────────────────────────────────────────────────
// 사용자 조건검색식(키움식) 프리셋을 서버(condsearch.py)가 장중 5분마다 돌린 결과를 보여 준다.
// 시가급등예상은 08:30~09:00 2분마다. 종목을 누르면 차트 탭으로(모의투자 모드면 바로 주문).
let _csState = null, _csSel = null, _csTimer = null, _csHist = {};
const _CS_SEL_KEY = 'stockview_cs_sel';

function initCondSearch() {
  if (!_csSel) {
    try { _csSel = localStorage.getItem(_CS_SEL_KEY); } catch (e) { /* 저장소 막힘 */ }
  }
  _csLoad();
  stopCondSearch();
  _csTimer = setInterval(_csLoad, 30000);
}

function stopCondSearch() {
  if (_csTimer) { clearInterval(_csTimer); _csTimer = null; }
}

async function _csLoad() {
  try {
    const r = await fetch('/api/cond-search');
    _csState = await r.json();
  } catch (e) {
    document.getElementById('cs-body').innerHTML = '<p class="cs-empty">불러오지 못했어요. 잠시 뒤 다시 시도합니다.</p>';
    return;
  }
  const ids = _csState.presets.map(p => p.id);
  if (!ids.includes(_csSel)) _csSel = ids[0];
  _csRender();
  _csLoadHist(_csSel);
}

function _csSelect(id) {
  _csSel = id;
  try { localStorage.setItem(_CS_SEL_KEY, id); } catch (e) { /* 저장소 막힘 */ }
  _csRender();
  _csLoadHist(id);
}

function _csEsc(s) { return _escHtml(String(s ?? '')); }
function _csSign(v) { return v == null ? '' : (v > 0 ? 'up' : v < 0 ? 'down' : ''); }
function _csPct(v) { return v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }
function _csEok(v) { return v ? Math.round(v / 1e8).toLocaleString('ko-KR') + '억' : '—'; }

function _csStatusText(s) {
  if (s.off) return '이 서버에서는 조건검색이 꺼져 있고 집 서버 결과도 받지 못했어요 — 검색은 집 서버(STOCKVIEW_COND=1)에서만 돌아요';
  const ld = s.load || {};
  if (ld.state === '받는 중') return `📥 일봉 준비 중 ${ld.done}/${ld.total} — 끝나면 검색을 시작해요`;
  const sc = s.scan || {};
  const parts = [];
  if (sc.ts) parts.push('마지막 검색 ' + new Date(sc.ts * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) + (sc.secs != null ? ` (${sc.secs}초)` : ''));
  if (!s.loaded) parts.push('오늘 일봉 아직 없음 (평일 07:30에 받음)');
  if (sc.note) parts.push('⚠️ ' + sc.note);
  parts.push('장중 5분마다 자동 검색');
  if (s.from_home) parts.push('🏠 집 서버 결과');
  return parts.join(' · ');
}

function _csRender() {
  const s = _csState;
  document.getElementById('cs-status').textContent = _csStatusText(s);
  const chips = s.presets.map(p => {
    const r = s.results[p.id];
    const n = r ? r.hits.length : (s.last_day && s.last_day[p.id] ? s.last_day[p.id].hits.length : null);
    return `<button type="button" class="cs-chip${p.id === _csSel ? ' on' : ''}" onclick="_csSelect('${p.id}')">
      <span class="cs-kind cs-kind-${p.kind === '스윙' ? 'swing' : 'day'}">${p.kind}</span>
      <b>${_csEsc(p.alias)}</b>${n != null ? `<span class="cs-n">${n}</span>` : ''}</button>`;
  }).join('');
  document.getElementById('cs-presets').innerHTML = chips;

  const p = s.presets.find(x => x.id === _csSel);
  const r = s.results[p.id];
  let html = `<section class="cs-card">
    <div class="cs-desc"><span class="cs-tag">${_csEsc(p.tag)}</span> <b>${_csEsc(p.title)}</b></div>
    <div class="cs-meta">${_csEsc(p.name)} · ${_csEsc(p.window)}</div>`;
  if (r) {
    const f = r.funnel;
    html += `<div class="cs-funnel">${p.id === 'pre' ? '예상체결 순위' : '보통주'} ${f.universe.toLocaleString()} → 1차 ${f.stage1.toLocaleString()} → 2차 ${f.stage2.toLocaleString()} → <b>잡힘 ${f.final}</b> <span class="cs-muted">(${r.hm} 기준)</span></div>`;
    (r.notes || []).forEach(n => { html += `<div class="cs-note">ⓘ ${_csEsc(n)}</div>`; });
  }
  html += `<details class="cs-conds"><summary>조건식 보기</summary><code class="cs-expr">${_csEsc(p.expr)}</code><ol class="cs-cond-list">${
    p.conds.map(c => `<li><b>${c.key}</b> ${_csEsc(c.label)}</li>`).join('')}</ol></details></section>`;

  html += '<section class="cs-card">';
  if (r) {
    html += _csHitsTable(r.hits, p.id);
  } else if (s.last_day && s.last_day[p.id] && s.last_day[p.id].hits.length) {
    const ld = s.last_day[p.id];
    html += `<h3 class="cs-h3">${ld.day} 잡힌 종목 <span class="cs-muted">(지금은 검색 시간이 아니에요)</span></h3>` + _csLastTable(ld.hits);
  } else {
    html += `<p class="cs-empty">아직 오늘 검색 결과가 없어요. ${_csEsc(p.window)}에 자동으로 검색합니다.</p>`;
  }
  html += '</section><section class="cs-card" id="cs-hist"><p class="cs-muted">기록 불러오는 중…</p></section>';
  document.getElementById('cs-body').innerHTML = html;
  if (_csHist[_csSel]) _csRenderHist(_csSel);
}

function _csRow(code, inner, ticker) {
  return `<tr class="cs-row" onclick="_csOpen('${code}','${ticker || ''}')" title="차트로 열기">${inner}</tr>`;
}

function _csHitsTable(hits, pid) {
  if (!hits.length) return '<p class="cs-empty">지금 조건을 모두 만족하는 종목이 없어요.</p>';
  const extra = (pid === 'dayup' ? '<th>매도잔량비율</th>' : '') + (pid === 'gapup' ? '<th>어제 등락</th><th>시초가 (첫 체결)</th><th>갭</th>' : '');
  const strong = ['ddeok', 'ddeok2', 'dayup'].includes(pid);
  return `<div class="cs-scroll"><table class="cs-table"><thead><tr><th>종목</th><th>현재가</th><th>등락률</th><th>거래대금</th>
    <th>처음 잡힘</th><th>잡힌 뒤</th>${strong ? '<th>체결강도</th>' : ''}${extra}</tr></thead><tbody>${
    hits.map(h => {
      const since = h.first_price ? (h.price / h.first_price - 1) * 100 : null;
      return _csRow(h.code, `<td class="cs-name"><b>${_csEsc(h.name)}</b><small>${h.code}</small></td>
        <td>${Math.round(h.price).toLocaleString('ko-KR')}</td>
        <td class="${_csSign(h.chg)}">${_csPct(h.chg)}</td><td>${_csEok(h.value)}</td>
        <td>${h.first_hm}${h.scans > 1 ? ` <small class="cs-muted">×${h.scans}</small>` : ''}</td>
        <td class="${_csSign(since)}">${_csPct(since)}</td>
        ${strong ? `<td>${h.cttr != null ? h.cttr.toFixed(1) + '%' : '—'}</td>` : ''}
        ${pid === 'dayup' ? `<td>${h.ask_ratio != null ? h.ask_ratio + '%' : '—'}</td>` : ''}
        ${pid === 'gapup' ? `<td class="${_csSign(h.yday)}">${_csPct(h.yday)}</td><td>${h.open != null ? Math.round(h.open).toLocaleString('ko-KR') : '—'} <small class="cs-muted">${h.open_at || ''}</small></td><td class="${_csSign(h.open_gap)}">${_csPct(h.open_gap)}</td>` : ''}`, h.ticker);
    }).join('')}</tbody></table></div>`;
}

function _csLastTable(hits) {
  return `<div class="cs-scroll"><table class="cs-table"><thead><tr><th>종목</th><th>처음 잡힘</th><th>그때 가격</th><th>마지막 잡힘</th></tr></thead><tbody>${
    hits.map(h => _csRow(h.code, `<td class="cs-name"><b>${_csEsc(h.name)}</b><small>${h.code}</small></td>
      <td>${h.first_hm}</td><td>${Math.round(h.first_price).toLocaleString('ko-KR')}</td><td>${h.last_hm}</td>`, h.ticker)).join('')
  }</tbody></table></div>`;
}

async function _csLoadHist(id) {
  try {
    const r = await fetch('/api/cond-search/history?days=20&preset=' + encodeURIComponent(id));
    _csHist[id] = await r.json();
  } catch (e) { return; }
  if (id === _csSel) _csRenderHist(id);
}

function _csAvg(xs) {
  const v = xs.filter(x => x != null);
  return v.length ? { avg: v.reduce((a, b) => a + b, 0) / v.length, win: v.filter(x => x > 0).length / v.length * 100, n: v.length } : null;
}

function _csRenderHist(id) {
  const el = document.getElementById('cs-hist');
  if (!el) return;
  const rows = _csHist[id] || [];
  if (!rows.length) {
    el.innerHTML = '<h3 class="cs-h3">📒 잡힌 기록</h3><p class="cs-muted">아직 기록이 없어요. 잡힌 종목은 자동으로 쌓이고, 다음 날 아침부터 당일 종가·1·3·5거래일 뒤 수익이 채워져요.</p>';
    return;
  }
  const stats = ['close', 'r1', 'r3', 'r5'].map(k => [k, _csAvg(rows.map(r => r[k]))]);
  const lbl = { close: '당일 종가', r1: '1일 뒤', r3: '3일 뒤', r5: '5일 뒤' };
  const sum = stats.map(([k, s]) => `<div class="cs-stat"><span>${lbl[k]}</span>${s
    ? `<b class="${_csSign(s.avg)}">${_csPct(s.avg)}</b><small>승률 ${s.win.toFixed(0)}% · ${s.n}건</small>` : '<b>—</b><small>아직 없음</small>'}</div>`).join('');
  el.innerHTML = `<h3 class="cs-h3">📒 잡힌 기록 <span class="cs-muted">(최근 20거래일 · 처음 잡힌 가격 기준, 수수료·세금 전)</span></h3>
    <div class="cs-stats">${sum}</div>
    <div class="cs-scroll"><table class="cs-table"><thead><tr><th>날짜</th><th>종목</th><th>잡힌 시각</th><th>그때 가격</th><th>당일 종가</th><th>1일</th><th>3일</th><th>5일</th></tr></thead><tbody>${
    rows.map(r => _csRow(r.code, `<td>${r.day.slice(5)}</td><td class="cs-name"><b>${_csEsc(r.name)}</b><small>${r.code}</small></td>
      <td>${r.first_hm}</td><td>${Math.round(r.first_price).toLocaleString('ko-KR')}</td>
      ${['close', 'r1', 'r3', 'r5'].map(k => `<td class="${_csSign(r[k])}">${_csPct(r[k])}</td>`).join('')}`, r.ticker)).join('')
  }</tbody></table></div>`;
}

function _csOpen(code, ticker) {
  navigateToChart(ticker || resolveTickerInput(code, 'kr') || code + '.KS');
}
