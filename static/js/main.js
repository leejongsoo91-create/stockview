/* ═══════════════════════════════════════════════════════════════
   main.js — 뷰 전환, 홈 페이지, 티커 테이프, 공통 헬퍼
   ═══════════════════════════════════════════════════════════════ */

// ── 공통 헬퍼 ───────────────────────────────────────────────────────────────
function fmt$(n)  { return '$' + Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}); }
function fmtPct(n){ const s = n >= 0 ? '+' : ''; return s + n.toFixed(2) + '%'; }
function fmtVol(n){ if(n >= 1e9) return (n/1e9).toFixed(2)+'B'; if(n >= 1e6) return (n/1e6).toFixed(1)+'M'; return n.toLocaleString(); }
function fmtCap(n){ if(n >= 1000) return '$'+(n/1000).toFixed(2)+'T'; return '$'+n.toFixed(0)+'B'; }
function colorCls(n){ return n >= 0 ? 'up' : 'down'; }

// 국내 종목(005930.KS 등)은 가격이 원, 시가총액이 원 단위 — 달러 함수(fmt$/fmtCap)를 쓰면
// "$201,500.00", "$1838654600000.00T"처럼 나온다. 관심종목처럼 미국·국내가 섞이는 표에서 사용.
function isKrTicker(t) { return /\.(KS|KQ)$/.test(t || ''); }
function fmtKrw(v)     { return '₩' + Math.round(v).toLocaleString('ko-KR'); }
function fmtKrCap(v)   { return v >= 1e12 ? (v / 1e12).toFixed(1) + '조' : v >= 1e8 ? Math.round(v / 1e8) + '억' : '—'; }
function fmtPrice(v, ticker) { return isKrTicker(ticker) ? fmtKrw(v) : fmt$(v); }
// 변동액: 부호를 통화 기호 앞에 (+$1.20 / -₩18,000) — 기존 fmt$는 "$-6.56"으로 나왔음
function fmtChange(v, ticker) { return (v >= 0 ? '+' : '-') + fmtPrice(Math.abs(v), ticker); }

// ── 달러/원 환율 (포트폴리오 원화 환산용) ─────────────────────────────────────
// 홈 화면 "달러/원"과 같은 값(/api/indices의 USD/KRW, 서버가 30초마다 갱신)을 재사용한다.
// 받아오지 못하면 마지막으로 받은 값(localStorage)을 쓰고, 그것도 없으면 임시값 + 경고 표시.
const FX_KEY = 'stockview_fx_usdkrw';   // { rate, ts } — 새 키(기존 저장 데이터와 무관)
const FX_FALLBACK = 1350;
let _fx = null;   // { rate, ts, source: 'live' | 'saved' | 'fallback' }

function _setUsdKrwFromIndices(indices) {
  const r = (indices || []).find(x => x.name === 'USD/KRW');
  if (!r || !(r.value > 0)) return;
  _fx = { rate: r.value, ts: Date.now(), source: 'live' };
  try { localStorage.setItem(FX_KEY, JSON.stringify({ rate: r.value, ts: _fx.ts })); } catch {}
}

// 동기 조회 (이미 받아둔 값 → 저장된 값 → 임시값)
function usdKrw() {
  if (_fx) return _fx;
  try {
    const saved = JSON.parse(localStorage.getItem(FX_KEY));
    if (saved && saved.rate > 0) return (_fx = { ...saved, source: 'saved' });
  } catch {}
  return { rate: FX_FALLBACK, ts: 0, source: 'fallback' };
}

// 1분 이내 값이면 그대로, 아니면 서버에서 새로 받는다
async function fetchUsdKrw() {
  if (!_fx || _fx.source !== 'live' || Date.now() - _fx.ts > 60 * 1000) {
    try { _setUsdKrwFromIndices(await api('/api/indices')); } catch {}
  }
  return usdKrw();
}

// 원화 금액 표시 (부호 옵션: 손익처럼 +/-를 붙일 때)
function fmtKrwSigned(v, signed) { return (signed ? (v >= 0 ? '+' : '-') : (v < 0 ? '-' : '')) + fmtKrw(Math.abs(v)); }

// ── 한글 표시 변환표 ─────────────────────────────────────────────────────────
// 데이터 값(필터·정렬·localStorage 기준)은 영어 그대로 두고, 화면에 그릴 때만 한글로 바꾼다.
// 표에 없는 값은 원래 값을 그대로 보여준다. (KR 종목은 섹터가 이미 한글)
const SECTOR_KO = {
  'Basic Materials': '소재', 'Materials': '소재', 'Consumer Disc.': '경기소비재', 'Consumer Staples': '필수소비재',
  'Energy': '에너지', 'Finance': '금융', 'Healthcare': '헬스케어', 'Industrial': '산업재',
  'Real Estate': '부동산', 'Technology': '기술', 'Telecommunications': '통신', 'Communication': '통신',
  'Utilities': '유틸리티', 'Other': '기타', 'Index': '지수',
};
const INDUSTRY_KO = {
  'Accident &Health Insurance': '상해·건강보험', 'Advertising': '광고', 'Aerospace': '항공우주',
  'Agricultural Chemicals': '농업화학', 'Air Freight': '항공화물', 'Aluminum': '알루미늄', 'Apparel': '의류',
  'Apparel Retail': '의류 소매', 'Asset Mgmt': '자산운용', 'Auto & Home Supply Stores': '자동차·생활용품 소매',
  'Auto Dealers': '자동차 딜러', 'Auto Manufacturing': '자동차 제조', 'Auto Parts': '자동차 부품',
  'Automotive Aftermarket': '자동차 애프터마켓', 'Banks': '은행', 'Beverages': '음료', 'Biotech': '바이오',
  'Biotech/Pharma': '바이오·제약', 'Biotechnology: Commercial Physical & Biological Resarch': '바이오 연구서비스',
  'Biotechnology: In Vitro & In Vivo Diagnostic Substances': '진단 시약', 'Blank Checks': '스팩(SPAC)',
  'Books': '도서', 'Broadcasting': '방송', 'Building Materials': '건축자재', 'Building Products': '건축제품',
  'Building operators': '건물 운영', 'Business Services': '비즈니스 서비스', 'Cable/Media': '케이블·미디어',
  'Chemicals': '화학', 'Coal': '석탄', 'Comm Equipment': '통신장비', 'Comm. Services': '커뮤니케이션 서비스',
  'Commercial Banks': '상업은행', 'Computer peripheral equipment': '컴퓨터 주변기기',
  'Consumer Electronics/Appliances': '가전', 'Consumer Electronics/Video Chains': '가전·영상 유통',
  'Consumer Finance': '소비자 금융', 'Consumer Specialties': '소비자 전문용품', 'Consumer Svcs': '소비자 서비스',
  'Cosmetics': '화장품', 'Cybersecurity': '사이버보안', 'Defense Tech': '방산 기술',
  'Diversified Financial Services': '종합 금융서비스', 'Durable Goods': '내구재', 'E-Commerce': '전자상거래',
  'Electric Util.': '전력', 'Electrical': '전기장비', 'Electro Medical': '전자의료기기', 'Electronics': '전자',
  'Electronics Distribution': '전자부품 유통', 'Engineering': '엔지니어링', 'Entertainment': '엔터테인먼트',
  'Environmental Services': '환경 서비스', 'Finance': '금융', 'Finance Services': '금융 서비스',
  'Fluid Controls': '유체 제어', 'Food Distributors': '식품 유통', 'Food/Farming': '식품·농업',
  'Forest Products': '임산물', 'Garments and Clothing': '의류 제조', 'Gas Pipeline': '가스 파이프라인',
  'General Bldg Contractors - Nonresidential Bldgs': '비주거 건설', 'Grocery': '식료품 소매', 'Hardware': '하드웨어',
  'Health Services': '헬스 서비스', 'Heavy Equipment': '중장비', 'Home Furnishings': '가구·인테리어',
  'Home Improvement': '주택 개보수', 'Homebuilding': '주택건설', 'Hospitals': '병원', 'Hotels': '호텔',
  'IT Services': 'IT 서비스', 'Industrial Mach.': '산업기계', 'Integrated Freight & Logistics': '종합 물류',
  'Integrated Oil': '종합 석유', 'Investment Banking': '투자은행', 'Lab Instruments': '실험장비',
  'Life Insurance': '생명보험', 'Managed Health Care': '관리형 의료보험', 'Marine': '해운', 'Meat/Poultry/Fish': '육류·수산',
  'Med Devices': '의료기기', 'Medical Electronics': '의료전자', 'Medical Spec.': '전문 의료',
  'Medicinal Chemicals and Botanical Products': '의약 화학·생약', 'Metal Fab.': '금속가공', 'Mining': '광업',
  'Misc Corporate Leasing Services': '기업 리스', 'Misc Health and Biotechnology Services': '기타 헬스·바이오 서비스',
  'Miscellaneous manufacturing industries': '기타 제조', 'Motor Vehicles': '자동차', 'Movies/Entertainment': '영화·엔터',
  'Multi-Sector Companies': '복합기업', 'Natural Gas': '천연가스', 'Newspapers/Magazines': '신문·잡지',
  'Office Equipment/Supplies/Services': '사무용품·서비스', 'Oil & Gas': '석유·가스', 'Oil Machinery': '석유 장비',
  'Oil Refining/Marketing': '정유·판매', 'Oil Services': '석유 서비스', 'Ophthalmic Goods': '안과용품',
  'Ordnance And Accessories': '무기·탄약', 'Other': '기타', 'Other Metals and Minerals': '기타 금속·광물',
  'Other Pharmaceuticals': '기타 제약', 'P&C Insurance': '손해보험', 'Packaged Foods': '가공식품', 'Packaging': '포장재',
  'Paints/Coatings': '도료', 'Paper': '제지', 'Plastic Products': '플라스틱 제품', 'Pollution Control Equipment': '오염방지 장비',
  'Power Gen.': '발전', 'Precious Metals': '귀금속', 'Precision Instruments': '정밀기기', 'Prof. Services': '전문 서비스',
  'Professional and commerical equipment': '전문·상업용 장비', 'Publishing': '출판', 'REITs': '리츠', 'Railroads': '철도',
  'Real Estate': '부동산', 'Recreational Games/Products/Toys': '레저·게임·완구', 'Rental/Leasing Companies': '렌탈·리스',
  'Restaurants': '외식', 'Retail': '소매', 'Retail-Drug Stores and Proprietary Stores': '약국 소매',
  'Retail: Computer Software & Peripheral Equipment': '컴퓨터·SW 소매', 'Savings Banks': '저축은행',
  'Semiconductors': '반도체', 'Shoe Manufacturing': '신발 제조', 'Software': '소프트웨어', 'Spec. Industrial': '특수 산업재',
  'Specialty Chemicals': '특수화학', 'Specialty Foods': '특수식품', 'Specialty Insurance': '특수보험',
  'Specialty Retail': '전문 소매', 'Steel': '철강', 'Telecom Equip.': '통신장비', 'Textiles': '섬유', 'Tobacco': '담배',
  'Tools/Hardware': '공구', 'Transportation': '운송', 'Trucking': '트럭운송', 'Trusts': '신탁', 'Water': '수도',
  'Water Sewer Pipeline Comm & Power Line Construction': '인프라 건설', 'Wholesale Distributors': '도매',
};
const COUNTRY_KO = { 'USA': '미국', 'Korea': '한국', 'KR': '한국', 'US': '미국' };
const MOOD_KO    = { 'Bullish': '강세', 'Bearish': '약세', 'Neutral': '중립', 'Mixed': '혼조' };
function koSector(v)   { return SECTOR_KO[v]   || v; }
function koIndustry(v) { return INDUSTRY_KO[v] || v; }
function koCountry(v)  { return COUNTRY_KO[v]  || v; }
function koMood(v)     { return MOOD_KO[v]     || v; }

// 공포·탐욕 등급 (CSS 클래스는 영어 등급으로 만들고, 글자만 한글로)
const FG_KO = { 'Extreme Fear': '극단적 공포', 'Fear': '공포', 'Neutral': '중립', 'Greed': '탐욕', 'Extreme Greed': '극단적 탐욕' };
// 리포트 종류·실적 발표 시점·캔들 패턴 (데이터 값·CSS 클래스는 영어 그대로, 글자만 한글로)
const REPORT_TYPE_KO = { 'Earnings': '실적', 'Press Release': '보도자료', 'Fed': '연준' };
const EARN_TIME_KO   = { 'Before Open': '장 시작 전', 'After Close': '장 마감 후' };
const PATTERN_KO     = { 'Hammer': '망치형', 'Bullish Engulfing': '상승 장악형',
                         'Shooting Star': '유성형', 'Bearish Engulfing': '하락 장악형' };
function koReportType(v) { return REPORT_TYPE_KO[v] || v; }
function koEarnTime(v)   { return EARN_TIME_KO[v]   || v; }
function koPattern(v)    { return PATTERN_KO[v]     || v; }
function koFg(v) { if (!v) return v; const k = Object.keys(FG_KO).find(x => x.toLowerCase() === String(v).toLowerCase()); return k ? FG_KO[k] : v; }

// 지수·선물·환율 표시 이름 (데이터 키·차트 심볼은 영어 이름 그대로)
const INDEX_KO = {
  'NASDAQ': '나스닥', 'Dow Jones': '다우존스', 'Russell 2000': '러셀 2000', 'PHLX Semi': '필라델피아 반도체',
  'VIX': 'VIX(변동성)', 'WTI Crude': 'WTI 원유', 'Gold': '금', 'Bitcoin': '비트코인', '10Y Yield': '미 10년물 금리',
  'DXY': '달러인덱스', 'EUR/USD': '유로/달러', 'USD/JPY': '달러/엔', 'USD/KRW': '달러/원', 'KOSPI': '코스피', 'KOSDAQ': '코스닥',
  'US500': 'S&P 500 선물', 'US30': '다우 선물', 'US Tech 100': '나스닥100 선물',
};
function koIndex(v) { return INDEX_KO[v] || v; }

// 경제 일정 (서버 _ECO_EVENTS 이름: "CPI (Nov 2026)", "GDP Q3 2026 (Advance)" 형식)
const ECO_CAT_KO = { 'Fed Policy': '통화정책', 'Inflation': '물가', 'Employment': '고용', 'GDP': 'GDP', 'Consumer': '소비', 'Manufacturing': '제조업' };
const _ECO_EVENT_KO = {
  'CPI': '소비자물가지수(CPI)', 'PPI': '생산자물가지수(PPI)', 'PCE Price Index': 'PCE 물가지수',
  'Non-Farm Payrolls': '비농업 고용', 'Retail Sales': '소매판매', 'Consumer Confidence': '소비자신뢰지수',
  'ISM Manufacturing PMI': 'ISM 제조업 PMI', 'FOMC Rate Decision': 'FOMC 금리 결정',
};
const _MON_NUM = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };
function koEcoEvent(name) {
  const m = String(name || '').match(/^(.*?)(?:\s*\(([^)]*)\))?$/);
  let base = m[1], tail = m[2] || '';
  const gdp = base.match(/^GDP Q([1-4]) (\d{4})$/);
  base = gdp ? `GDP ${gdp[2]}년 ${gdp[1]}분기` : (_ECO_EVENT_KO[base] || base);
  const mt = tail.match(/^([A-Z][a-z]{2})(?: (\d{4}))?$/);
  if (mt && _MON_NUM[mt[1]]) tail = (mt[2] ? mt[2] + '년 ' : '') + _MON_NUM[mt[1]] + '월';
  else if (tail === 'Advance') tail = '속보치';
  return tail ? `${base} (${tail})` : base;
}

// api fetch 래퍼
async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

// ── localStorage 저장소 팩토리 (Watchlist / Portfolio 공용) ─────────────────────
// 메모/목표가 저장소: 티커 -> {memo, target}. WLN(watchlist.js) / PTN(portfolio.js)이 이걸로 생성됨.
function makeNotesStore(key) {
  return {
    _map: null,
    load() {
      if (this._map) return this._map;
      try { this._map = JSON.parse(localStorage.getItem(key) || '{}'); }
      catch { this._map = {}; }
      return this._map;
    },
    save() { localStorage.setItem(key, JSON.stringify(this._map)); },
    get(ticker) { return this.load()[ticker] || {}; },
    setMemo(ticker, memo) {
      const m = this.load();
      const cur = { ...(m[ticker] || {}) };
      if (memo) cur.memo = memo; else delete cur.memo;
      if (Object.keys(cur).length) m[ticker] = cur; else delete m[ticker];
      this.save();
    },
    setTarget(ticker, target) {
      const m = this.load();
      const cur = { ...(m[ticker] || {}) };
      const n = parseFloat(target);
      if (target !== '' && Number.isFinite(n)) cur.target = n; else delete cur.target;
      if (Object.keys(cur).length) m[ticker] = cur; else delete m[ticker];
      this.save();
    },
  };
}

// 그룹 저장소: 티커 -> 그룹명(없으면 미분류) + 종목 미배정 상태에서도 유지되는 그룹명 목록.
// WLG(watchlist.js) / PTG(portfolio.js)가 이걸로 생성됨.
function makeGroupStore(key, namesKey) {
  return {
    _map: null,
    _names: null,
    load() {
      if (this._map) return this._map;
      try { this._map = JSON.parse(localStorage.getItem(key) || '{}'); }
      catch { this._map = {}; }
      return this._map;
    },
    save() { localStorage.setItem(key, JSON.stringify(this._map)); },
    get(ticker) { return this.load()[ticker] || ''; },
    set(ticker, group) {
      const m = this.load();
      if (group) { m[ticker] = group; this.addGroupName(group); } else delete m[ticker];
      this.save();
    },
    remove(ticker) { this.set(ticker, ''); },
    loadNames() {
      if (this._names) return this._names;
      try { this._names = JSON.parse(localStorage.getItem(namesKey) || '[]'); }
      catch { this._names = []; }
      return this._names;
    },
    saveNames() { localStorage.setItem(namesKey, JSON.stringify(this._names)); },
    addGroupName(name) {
      const names = this.loadNames();
      if (!names.includes(name)) { names.push(name); this.saveNames(); }
    },
    // 저장된 그룹명 + 현재 종목에 실제 배정된 그룹명을 합쳐 정렬 반환
    allGroups(tickers) {
      const m = this.load();
      const set = new Set(this.loadNames());
      tickers.forEach(t => { if (m[t]) set.add(m[t]); });
      return [...set].sort();
    },
  };
}

// ── CSV 헬퍼 (Watchlist / Portfolio 내보내기·가져오기 공용) ─────────────────────
// 셀에 쉼표·따옴표·줄바꿈이 있으면 "..."로 감싸고 내부 "는 ""로 이스케이프
function _csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// 따옴표로 감싼 필드(내부 쉼표 포함) 인식하는 한 줄 파서
// CSV 가져오기: 머리글 이름 후보(한글·영어) 중 처음 찾은 열 번호, 없으면 -1
// (예전에 내보낸 영어 머리글 파일도 계속 읽히게)
function _csvColIndex(header, names) {
  for (const n of names) { const i = header.indexOf(n.toLowerCase()); if (i !== -1) return i; }
  return -1;
}

// 파일 이름용 오늘 날짜 (toISOString은 UTC라 한국 오전 9시 전에는 어제 날짜가 됐음)
function _localDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _csvSplitLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ── 다중종목 비교차트 (6번, Watchlist/Portfolio 공용) ───────────────────────────
const _cmpSel = { wl: new Set(), pt: new Set() };

function _cmpCheckboxHtml(scope, ticker) {
  const checked = _cmpSel[scope].has(ticker) ? ' checked' : '';
  return `<input type="checkbox" class="cmp-check" title="비교차트에 추가"${checked}
    onclick="event.stopPropagation(); _cmpToggle('${scope}','${ticker}',this)">`;
}

function _cmpToggle(scope, ticker, checkbox) {
  const set = _cmpSel[scope];
  if (checkbox.checked) {
    if (set.size >= 5) {
      alert('비교차트는 최대 5개 종목까지 선택할 수 있습니다.');
      checkbox.checked = false;
      return;
    }
    set.add(ticker);
  } else {
    set.delete(ticker);
  }
  _cmpUpdateBar(scope);
}

function _cmpUpdateBar(scope) {
  const bar = document.getElementById(`${scope}-cmp-bar`);
  if (!bar) return;
  const n = _cmpSel[scope].size;
  bar.style.display = n > 0 ? '' : 'none';
  const label = document.getElementById(`${scope}-cmp-count`);
  if (label) label.textContent = `${n}개 선택됨 (2~5개)`;
}

function _cmpClear(scope) {
  _cmpSel[scope].clear();
  const viewId = scope === 'wl' ? 'view-watchlist' : 'view-portfolio';
  document.querySelectorAll(`#${viewId} .cmp-check`).forEach(b => b.checked = false);
  _cmpUpdateBar(scope);
}

function _cmpOpenFromScope(scope) {
  const tickers = [..._cmpSel[scope]];
  if (tickers.length < 2) { alert('비교하려면 2개 이상 선택하세요.'); return; }
  openCompareChart(tickers);
}

const _CMP_COLORS = ['#58a6ff', '#3fb950', '#ff7b72', '#d2a522', '#bc8cff'];

async function openCompareChart(tickers) {
  const modal = document.getElementById('compare-modal');
  const area  = document.getElementById('cmp-chart-area');
  if (!modal || !area) return;
  modal.style.display = 'flex';
  area.innerHTML = '<div class="wl-loading">차트 불러오는 중...</div>';

  try {
    const seriesList = await Promise.all(tickers.map(t =>
      api(`/api/chart/${encodeURIComponent(t)}?interval=1d&period=6mo`)
        .then(rows => ({ ticker: t, rows: Array.isArray(rows) ? rows : [] }))
        .catch(() => ({ ticker: t, rows: [] }))
    ));
    const valid = seriesList.filter(s => s.rows.length >= 2);
    if (valid.length < 2) {
      area.innerHTML = '<div class="wl-loading">비교할 데이터가 부족합니다.</div>';
      return;
    }
    // 종목마다 거래일(휴장일)이 달라 공통 날짜만 교집합으로 정렬 비교
    const dateSets = valid.map(s => new Set(s.rows.map(r => r.time)));
    const commonDates = valid[0].rows.map(r => r.time)
      .filter(d => dateSets.every(set => set.has(d)))
      .sort();
    if (commonDates.length < 2) {
      area.innerHTML = '<div class="wl-loading">겹치는 거래일이 부족합니다(US·KR 혼합 비교 시 발생 가능).</div>';
      return;
    }
    const norm = valid.map(s => {
      const closeMap = {};
      s.rows.forEach(r => { closeMap[r.time] = r.close; });
      const base = closeMap[commonDates[0]];
      return commonDates.map(d => (closeMap[d] / base - 1) * 100);
    });
    _renderCompareSvg(valid.map(s => s.ticker), commonDates, norm);
  } catch (e) {
    area.innerHTML = '<div class="wl-loading">데이터 로드 실패. 잠시 후 다시 시도하세요.</div>';
  }
}

function closeCompareChart() {
  const modal = document.getElementById('compare-modal');
  if (modal) modal.style.display = 'none';
}

function _renderCompareSvg(tickers, dates, norm) {
  const area = document.getElementById('cmp-chart-area');
  if (!area) return;
  const W = area.clientWidth || 640;
  const H = 320;
  const PAD = { t: 20, r: 90, b: 30, l: 46 };
  const iW = W - PAD.l - PAD.r;
  const iH = H - PAD.t - PAD.b;

  const allVals = norm.flat().concat([0]);
  const minV = Math.min(...allVals);
  const maxV = Math.max(...allVals);
  const vRange = (maxV - minV) || 1;

  const xScale = i => PAD.l + (dates.length > 1 ? (i / (dates.length - 1)) * iW : 0);
  const yScale = v => PAD.t + iH - ((v - minV) / vRange) * iH;
  const zeroY  = yScale(0);

  const lines = tickers.map((t, ti) => {
    const color  = _CMP_COLORS[ti % _CMP_COLORS.length];
    const series = norm[ti];
    const pts    = series.map((v, i) => `${xScale(i)},${yScale(v)}`).join(' ');
    const lastV  = series[series.length - 1];
    return `
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8"/>
      <text x="${xScale(dates.length - 1) + 4}" y="${yScale(lastV) + 4}" font-size="11" fill="${color}" font-weight="600">${t} ${lastV >= 0 ? '+' : ''}${lastV.toFixed(1)}%</text>`;
  }).join('');

  const fmtDate = d => new Date(d).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });

  area.innerHTML = `<svg width="${W}" height="${H}" style="overflow:visible">
    <line x1="${PAD.l}" y1="${zeroY}" x2="${PAD.l + iW}" y2="${zeroY}" stroke="var(--border)" stroke-width="1" stroke-dasharray="3,3"/>
    <text x="${PAD.l - 4}" y="${zeroY + 4}" text-anchor="end" font-size="10" fill="var(--muted)">0%</text>
    ${lines}
    <text x="${PAD.l}" y="${H - 6}" text-anchor="start" font-size="10" fill="var(--muted)">${fmtDate(dates[0])}</text>
    <text x="${PAD.l + iW}" y="${H - 6}" text-anchor="end" font-size="10" fill="var(--muted)">${fmtDate(dates[dates.length - 1])}</text>
    <line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${PAD.t + iH}" stroke="var(--border)" stroke-width="1"/>
    <line x1="${PAD.l}" y1="${PAD.t + iH}" x2="${PAD.l + iW}" y2="${PAD.t + iH}" stroke="var(--border)" stroke-width="1"/>
  </svg>`;
}

// ── 오늘의 신호 맵 (Watchlist/Portfolio 공용) ──────────────────────────────────
// { ticker: {direction:'buy'|'sell', score, term} } — 하루에 1회, 날짜 바뀌면 재조회
let _dailySignalMap = null;
let _dailySignalMapDate = null;

async function loadDailySignalMap() {
  const today = new Date().toDateString();
  if (_dailySignalMap && _dailySignalMapDate === today) return _dailySignalMap;
  const map = {};
  try {
    const data = await api('/api/daily-signals');
    ['us', 'kr'].forEach(mkt => {
      const d = data[mkt] || {};
      (d.buy  || []).forEach(s => { map[s.ticker] = { ...s, direction: 'buy'  }; });
      (d.sell || []).forEach(s => { map[s.ticker] = { ...s, direction: 'sell' }; });
    });
  } catch {}
  _dailySignalMap = map;
  _dailySignalMapDate = today;
  return map;
}

// 신호 연속 유지일수 배지 — Brief/Watchlist/Portfolio 공용(main.js가 여러 탭 공유 유틸 위치)
function _heldBadgeHtml(s) {
  if (s.held_days == null) return '';
  if (s.is_new) return '<span class="brief-held-badge new">NEW</span>';
  return `<span class="brief-held-badge">${s.held_days}일째</span>`;
}

// 주봉 추세 배지 — 13주 이동평균 대비 상승/하락(신호가 있는 종목만 값 존재)
function _weeklyTrendBadgeHtml(s) {
  if (s.weekly_trend == null || s.weekly_trend === 0) return '';
  const up = s.weekly_trend > 0;
  return `<span class="wk-trend-badge ${up ? 'up' : 'down'}" title="주봉 13주 이동평균 대비 ${up ? '상승' : '하락'}">주봉${up ? '↑' : '↓'}</span>`;
}

function signalBadgeHtml(ticker, map) {
  const s = map[ticker];
  if (!s) return '<span class="sig-badge-none">—</span>';
  const cls   = s.direction === 'buy' ? 'buy' : 'sell';
  const label = s.direction === 'buy' ? '▲매수' : '▼매도';
  return `<span class="sig-badge ${cls}" title="${s.term} 신호 · 점수 ${s.score}">${label} <span class="sig-badge-term">${s.term}</span></span>${_heldBadgeHtml(s)}${_weeklyTrendBadgeHtml(s)}`;
}

// ── 뷰 전환 ─────────────────────────────────────────────────────────────────
let _heatmapInited   = false;
let _screenerInited  = false;
let _chartInited     = false;
let _newsInited      = false;
let _briefInited     = false;
let _watchlistInited = false;
let _portfolioInited = false;
let _earningsInited  = false;

function switchView(name) {
  _currentView = name;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelector(`.nav-btn[data-view="${name}"]`).classList.add('active');

  // 다른 탭으로 이동 시 각 탭 타이머 중지
  if (name !== 'screener' && typeof stopScreenerRefresh === 'function') {
    stopScreenerRefresh();
  }
  if (name !== 'chart'     && typeof stopChartTimers       === 'function') stopChartTimers();
  if (name !== 'portfolio' && typeof stopPortfolioRefresh  === 'function') stopPortfolioRefresh();

  // 첫 진입 시 각 탭 초기화 (스크리너는 매번 재로드)
  if (name === 'screener')                        { initScreener();  _screenerInited  = true; }
  if (name === 'heatmap'  && !_heatmapInited)     { initHeatmap();   _heatmapInited   = true; }
  if (name === 'chart'    && !_chartInited)       { initChart();     _chartInited     = true; }
  if (name === 'news'     && !_newsInited)        { initNews();      _newsInited      = true; }
  if (name === 'brief'    && !_briefInited)       { initBrief();     _briefInited     = true; }
  if (name === 'earnings' && !_earningsInited)   { initEarnings();  _earningsInited  = true; }
  // 워치리스트는 진입할 때마다 최신 데이터로 갱신
  if (name === 'watchlist')  { initWatchlist();  _watchlistInited  = true; }
  if (name === 'portfolio')  { initPortfolio(); _portfolioInited  = true; }
  _rtSubscribe();   // 탭을 바꾸면 보는 종목도 바로 알려준다
}

// 차트 탭으로 이동 + 종목 로드 (다른 탭에서 호출)
function navigateToChart(ticker) {
  switchView('chart');
  if (!_chartInited) { initChart(); _chartInited = true; }
  loadChart(ticker);
}

// ── 시장 상태 배지 ───────────────────────────────────────────────────────────
function renderMarketStatus() {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et    = new Date(etStr);
  const day   = et.getDay();
  const mins  = et.getHours() * 60 + et.getMinutes();
  const timeStr = '뉴욕 ' + et.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: true });

  let statusKey, label;
  if (day === 0 || day === 6) {
    statusKey = 'closed'; label = '장 마감';
  } else if (mins >= 9 * 60 + 30 && mins < 16 * 60) {
    statusKey = 'open';   label = '정규장';
  } else if (mins >= 4 * 60 && mins < 9 * 60 + 30) {
    statusKey = 'pre';    label = '프리마켓';
  } else if (mins >= 16 * 60 && mins < 20 * 60) {
    statusKey = 'after';  label = '애프터마켓';
  } else {
    statusKey = 'closed'; label = '장 마감';
  }

  const el = document.getElementById('market-status');
  if (el) el.innerHTML = `<span class="market-status-badge mkt-${statusKey}"><span class="mkt-dot"></span>${label}</span>`;
  const timeEl = document.getElementById('home-et-time');
  if (timeEl) timeEl.textContent = timeStr;
}

// ── 섹터 퍼포먼스 가로 칩 스트립 ────────────────────────────────────────────
let _homeStocks   = [];
let _sectorPeriod = '1d';


// 11-06: S&P 500 섹터 ETF(SPDR 11개) 등락률로 변경 — /api/sector-etf. 예전 우리 종목 단순평균은
// 작은 종목이 왜곡했고(통신 +6.40% vs 실제 -0.85%) 1주·1개월은 75초 걸렸음. 칩을 누르면 해당 ETF 차트.
function renderSectorPerf(items) {
  const el = document.getElementById('sector-perf-grid');
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = '<span class="sec-chip-empty">섹터 데이터를 불러오지 못했습니다</span>';
    return;
  }
  el.innerHTML = items.map(({ etf, name, pct }) => {
    const cls  = pct >= 0 ? 'up' : 'down';
    const sign = pct >= 0 ? '+' : '';
    return `<div class="sec-chip ${cls}" onclick="navigateToChart('${etf}')" title="${name} 섹터 ETF ${etf} — 눌러서 차트 보기">
      <span class="sec-chip-name">${name}</span>
      <span class="sec-chip-pct">${sign}${pct.toFixed(2)}%</span>
    </div>`;
  }).join('');
}

// silent: 자동 갱신용 — "Loading…" 표시·에러 문구 없이 기존 칩을 유지한 채 교체 (5분마다 깜빡임 방지)
async function loadSectorPerf(period, silent = false) {
  _sectorPeriod = period;
  document.querySelectorAll('.sp-period-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.period === period);
  });
  const el = document.getElementById('sector-perf-grid');
  if (el && !silent && !el.children.length) el.innerHTML = '<span class="sec-chip-empty">불러오는 중…</span>';
  try {
    const items = await api(`/api/sector-etf?period=${period}`);
    if (_sectorPeriod !== period) return;   // 응답 대기 중 다른 기간 버튼을 눌렀으면 덮어쓰지 않음
    renderSectorPerf(items);
  } catch {
    if (el && !silent) el.innerHTML = '<span class="sec-chip-empty">데이터를 불러오지 못했습니다</span>';
  }
}

// ── Volume Leaders ───────────────────────────────────────────────────────────
function renderVolumeLeaders(stocks) {
  const top = [...stocks]
    .filter(s => s.volume > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 10);
  const el = document.getElementById('volume-body');
  if (!el) return;
  el.innerHTML = top.map(s => `
    <tr onclick="navigateToChart('${s.ticker}')">
      <td onclick="event.stopPropagation()" style="width:28px">${starBtn(s.ticker)}</td>
      <td class="m-ticker">${s.ticker}</td>
      <td class="m-name">${s.name}<br><span style="font-size:11px;color:#6e7681">${fmtVol(s.volume)}</span></td>
      <td class="m-pct ${colorCls(s.change_pct)}">${fmtPct(s.change_pct)}</td>
    </tr>`).join('');
}

function renderMarketStatBar(stocks) {
  const el = document.getElementById('market-stat-bar');
  if (!el || !stocks || !stocks.length) return;
  let up = 0, down = 0, flat = 0;
  stocks.forEach(s => {
    const p = parseFloat(s.change_pct) || 0;
    if (p > 0) up++;
    else if (p < 0) down++;
    else flat++;
  });
  // 미국 전 종목 중 오늘 오른·내린·변동 없는 종목 수 (종목마다 1개로 셈 — 시총 가중 지수와 다를 수 있음)
  el.title = '종목검색의 미국 전체 종목 중 오늘 오른 종목·내린 종목·변동 없는 종목 수';
  el.innerHTML =
    `<span class="msb-label">미국 ${stocks.length.toLocaleString()}종목</span>` +
    `<span class="msb-up">상승 ${up.toLocaleString()}</span>` +
    `<span class="msb-sep">·</span>` +
    `<span class="msb-down">하락 ${down.toLocaleString()}</span>` +
    `<span class="msb-sep">·</span>` +
    `<span class="msb-flat">보합 ${flat.toLocaleString()}</span>`;
}

// ── 홈 Fear & Greed 위젯 ────────────────────────────────────────────────────
function _fgRatingClass(rating) {
  if (!rating) return '';
  return 'fg-' + rating.toLowerCase().replace(/\s+/g, '-');
}

function _scoreToRating(score) {
  if (score <= 25) return 'Extreme Fear';
  if (score <= 44) return 'Fear';
  if (score <= 55) return 'Neutral';
  if (score <= 75) return 'Greed';
  return 'Extreme Greed';
}

function renderHomeFearGreed(fg) {
  if (!fg || fg.score == null) return;
  const { score, rating, prev_close, prev_1w, prev_1m, prev_1y } = fg;

  const deg  = (score / 100 * 180) - 90;
  const rCls = _fgRatingClass(rating);

  // 바늘
  requestAnimationFrame(() => {
    const n = document.getElementById('home-fg-needle');
    if (n) n.style.transform = `translateX(-50%) rotate(${deg}deg)`;
  });

  // 점수 + 등급
  const scoreEl  = document.getElementById('home-fg-score');
  const ratingEl = document.getElementById('home-fg-rating');
  if (scoreEl)  { scoreEl.textContent = score;  scoreEl.className  = 'fg-score-big '    + rCls; }
  if (ratingEl) { ratingEl.textContent = koFg(rating); ratingEl.className = 'fg-rating-label ' + rCls; }

  // 과거 비교
  const histEl = document.getElementById('home-fg-history');
  if (histEl) {
    const rows = [
      ['어제',     prev_close],
      ['1주 전',   prev_1w],
      ['1개월 전', prev_1m],
      ['1년 전',   prev_1y],
    ];
    histEl.innerHTML = rows.map(([label, val]) => {
      const r = _scoreToRating(val);
      return `<div class="fg-hist-row">
        <span class="fg-hist-label">${label}</span>
        <span class="fg-hist-val ${_fgRatingClass(r)}">${val}</span>
        <span class="fg-hist-rating">${koFg(r)}</span>
      </div>`;
    }).join('');
  }
}

// ── 경제 캘린더 ──────────────────────────────────────────────────────────────
const _CAT_ICON = {
  'Fed Policy':    '🏦',
  'Inflation':     '📊',
  'Employment':    '👷',
  'GDP':           '📈',
  'Consumer':      '🛒',
  'Manufacturing': '🏭',
};
const _IMP_DOT = {
  high:   '<span class="eco-dot eco-high"  title="중요도 높음"></span>',
  medium: '<span class="eco-dot eco-med"   title="중요도 보통"></span>',
  low:    '<span class="eco-dot eco-low"   title="중요도 낮음"></span>',
};

function renderEconomicCalendar(events, elId = 'eco-cal-body') {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!events || !events.length) {
    el.innerHTML = '<span style="color:var(--muted);font-size:13px">향후 3주 안에 예정된 일정이 없습니다.</span>';
    return;
  }

  // 날짜별 그룹화
  const groups = {};
  events.forEach(ev => {
    if (!groups[ev.date]) groups[ev.date] = [];
    groups[ev.date].push(ev);
  });

  const fmtDate = d => {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
  };

  el.innerHTML = Object.entries(groups).map(([date, evs]) => {
    const first = evs[0];
    const dayLabel = first.is_today ? '🔴 오늘' : first.is_tomorrow ? '🟡 내일' : fmtDate(date);
    const rowClass = first.is_today ? 'eco-today' : first.is_tomorrow ? 'eco-tomorrow' : '';
    const rows = evs.map(ev => {
      const icon = _CAT_ICON[ev.category] || '📌';
      const dot  = _IMP_DOT[ev.importance] || _IMP_DOT.low;
      return `<div class="eco-row ${rowClass}">
        <span class="eco-day">${dayLabel}</span>
        <span class="eco-dot-wrap">${dot}</span>
        <span class="eco-icon">${icon}</span>
        <span class="eco-event">${koEcoEvent(ev.event)}</span>
        <span class="eco-cat">${ECO_CAT_KO[ev.category] || ev.category}</span>
      </div>`;
    }).join('');
    return rows;
  }).join('');
}

async function loadEconomicCalendar(elId = 'eco-cal-body') {
  try {
    const events = await api('/api/economic-calendar?days=21');
    renderEconomicCalendar(events, elId);
  } catch {
    const el = document.getElementById(elId);
    if (el) el.innerHTML = '<span style="color:var(--muted);font-size:13px">경제 일정을 불러오지 못했습니다.</span>';
  }
}

// ── 홈 초기화 ────────────────────────────────────────────────────────────────
async function loadHome() {
  const [indices, stocks, news, fg] = await Promise.all([
    api('/api/indices'),
    api('/api/stocks'),
    api('/api/news'),
    api('/api/fear-greed').catch(() => ({})),
  ]);
  _homeStocks = stocks;
  renderMarketStatus();
  buildTickerTape(indices, stocks);
  renderIndices(indices);
  renderHomeFearGreed(fg);
  renderMovers(stocks);
  loadSectorPerf(_sectorPeriod, true);
  renderVolumeLeaders(stocks);
  renderHomeNews(news);
  renderMarketStatBar(stocks);
  loadEconomicCalendar();
  renderHomeWatchlistSummary();
  renderHomePortfolioSummary();
  // 섹터 기간 버튼 이벤트 (최초 1회 바인딩)
  document.querySelectorAll('.sp-period-btn').forEach(b => {
    b.addEventListener('click', () => loadSectorPerf(b.dataset.period));
  });
  return true;
}

// ── 티커 테이프 ──────────────────────────────────────────────────────────────
function buildTickerTape(indices, stocks) {
  _setUsdKrwFromIndices(indices);   // 포트폴리오 원화 환산용 환율도 같이 갱신
  const tape = document.getElementById('ticker-inner');
  const items = [
    ...indices.map(i => ({ label: koIndex(i.name), value: i.value.toLocaleString('en-US', {minimumFractionDigits:2}), pct: i.change_pct })),
    ...['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','JPM','LLY','NFLX'].map(t => {
      const s = stocks.find(x => x.ticker === t);
      if (!s) return null;
      return { label: s.ticker, value: fmt$(s.price), pct: s.change_pct };
    }).filter(Boolean),
  ];
  const html = items.map(i =>
    `<span class="tape-item">
       <span class="tape-name">${i.label}</span>
       <span class="tape-val">${i.value}</span>
       <span class="tape-pct ${i.pct >= 0 ? 'up' : 'down'}">${fmtPct(i.pct)}</span>
     </span>`
  ).join('');
  tape.innerHTML = html + html; // 끊김 없는 루프를 위해 복제
}

// 지수 이름 → Yahoo Finance 심볼 매핑
const _INDEX_SYMBOL = {
  'S&P 500':      '^GSPC',
  'NASDAQ':       '^IXIC',
  'Dow Jones':    '^DJI',
  'Russell 2000': '^RUT',
  'PHLX Semi':    '^SOX',
  'VIX':          '^VIX',
  'WTI Crude':    'CL=F',
  'Gold':         'GC=F',
  'Bitcoin':      'BTC-USD',
  '10Y Yield':    '^TNX',
  'DXY':          'DX-Y.NYB',
  'EUR/USD':      'EURUSD=X',
  'USD/JPY':      'JPY=X',
  'USD/KRW':      'KRW=X',
  'KOSPI':        '^KS11',
  'KOSDAQ':       '^KQ11',
  'US500':        'ES=F',
  'US30':         'YM=F',
  'US Tech 100':  'NQ=F',
};

// Overview 3그룹 정의
const _INDEX_GROUPS = [
  { label: '📈 주요 지수', names: ['S&P 500','NASDAQ','Dow Jones','Russell 2000','PHLX Semi','KOSPI','KOSDAQ'] },
  { label: '🛢️ 선물·원자재',  names: ['US500','US30','US Tech 100','WTI Crude','Gold','Bitcoin'] },
  { label: '🏦 금리·환율',    names: ['10Y Yield','DXY','EUR/USD','USD/JPY','USD/KRW','VIX'] },
];

// ── 지수 Overview 3그룹 렌더링 ────────────────────────────────────────────────
function renderIndices(indices) {
  const el = document.getElementById('indices-overview');
  if (!el) return;

  const byName = {};
  for (const i of indices) byName[i.name] = i;

  el.innerHTML = _INDEX_GROUPS.map(group => {
    const rows = group.names.map(name => {
      const i = byName[name];
      if (!i) return '';
      const cls = colorCls(i.change_pct);
      const sym = _INDEX_SYMBOL[name];
      const click = sym ? `onclick="navigateToChart('${sym}')"` : '';

      // 값 포맷
      let valStr;
      if (name === 'Bitcoin')            valStr = '$' + Math.round(i.value).toLocaleString('en-US');
      else if (name === 'EUR/USD') valStr = i.value.toFixed(4);
      else if (name === 'USD/JPY' || name === 'USD/KRW') valStr = i.value.toFixed(2);
      else if (name === '10Y Yield' || name === 'VIX') valStr = i.value.toFixed(2);
      else if (name === 'DXY')           valStr = i.value.toFixed(2);
      else                               valStr = i.value.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});

      // 변화량 포맷
      const sign = i.change >= 0 ? '+' : '';
      let chgStr;
      if (name === 'Bitcoin') chgStr = sign + '$' + Math.abs(i.change).toLocaleString('en-US', {maximumFractionDigits:0});
      else if (name === 'EUR/USD') chgStr = sign + i.change.toFixed(4);
      else chgStr = sign + i.change.toFixed(2);

      return `<div class="ov-row" ${click}>
        <span class="ov-name">${koIndex(name)}</span>
        <span class="ov-value">${valStr}</span>
        <span class="ov-chg ${cls}">${chgStr} (${fmtPct(i.change_pct)})</span>
      </div>`;
    }).join('');

    return `<div class="ov-group">
      <div class="ov-group-title">${group.label}</div>
      ${rows}
    </div>`;
  }).join('');
}

// ── Top Gainers / Losers ──────────────────────────────────────────────────────
function renderMovers(stocks) {
  // 11-06 홈에서 상승·하락 상위 표를 뺐음 — 표가 없으면 아무것도 안 함 (다시 넣으면 그대로 동작)
  if (!document.getElementById('gainers-body')) return;
  const sorted = [...stocks].sort((a, b) => b.change_pct - a.change_pct);
  const gainers = sorted.slice(0, 10);
  const losers  = sorted.slice(-10).reverse();

  function rows(list) {
    return list.map(s => `
      <tr onclick="navigateToChart('${s.ticker}')">
        <td onclick="event.stopPropagation()" style="width:28px">${starBtn(s.ticker)}</td>
        <td class="m-ticker">${s.ticker}</td>
        <td class="m-name">${s.name}<br><span style="font-size:11px;color:#6e7681">${s.name_ko || ''}</span></td>
        <td class="m-price">$${s.price != null ? Number(s.price).toFixed(2) : '—'}</td>
        <td class="m-pct ${colorCls(s.change_pct)}">${fmtPct(s.change_pct)}</td>
      </tr>`).join('');
  }
  document.getElementById('gainers-body').innerHTML = rows(gainers);
  document.getElementById('losers-body').innerHTML  = rows(losers);
}

// ── 홈 뉴스 프리뷰 ───────────────────────────────────────────────────────────
function renderHomeNews(news) {
  const el = document.getElementById('home-news');
  const sentMap = { positive: { cls: 'np-pos', dot: '🟢' }, negative: { cls: 'np-neg', dot: '🔴' }, neutral: { cls: '', dot: '⚪' } };
  el.innerHTML = news.slice(0, 10).map(n => {
    const sm = sentMap[n.sentiment] || sentMap.neutral;
    const tickerBadge = n.ticker
      ? `<span class="news-ticker-badge" onclick="event.stopPropagation();navigateToChart('${n.ticker}')">${n.ticker}</span>`
      : '';
    return `
      <div class="news-preview-item" onclick="window.open('${n.url}','_blank')">
        <div class="np-title">${n.title}</div>
        <div class="np-meta">
          <span class="np-sent-dot">${sm.dot}</span>
          <span class="news-source">${n.source}</span>
          <span>${n.time}</span>
          ${tickerBadge}
        </div>
      </div>`;
  }).join('');
}

// ── 홈 — 내 워치리스트 / 포트폴리오 요약 (WL/PT 재사용) ─────────────────────────
function renderHomeWatchlistSummary() {
  const el = document.getElementById('home-watchlist-summary');
  if (!el || typeof WL === 'undefined') return;
  const tickers = WL.load();
  if (!tickers.length) {
    el.innerHTML = `<div class="home-my-empty">관심종목이 없습니다. <a href="javascript:void(0)" onclick="switchView('screener')">종목검색</a>에서 ☆를 눌러 추가하세요.</div>`;
    return;
  }
  const us = window._scStocks || [];
  const kr = window._krStocks || [];
  const rows = tickers
    .map(t => us.find(s => s.ticker === t) || kr.find(s => s.ticker === t))
    .filter(Boolean);
  if (!rows.length) {
    el.innerHTML = `<div class="home-my-empty">데이터 불러오는 중…</div>`;
    return;
  }
  rows.sort((a, b) => Math.abs(b.change_pct || 0) - Math.abs(a.change_pct || 0));
  const top = rows.slice(0, 5);

  // 목표가 도달 종목 (상승 목표: 현재가 ≥ 목표가)
  const hit = typeof WLN === 'undefined' ? [] : rows.filter(s => {
    const tg = WLN.get(s.ticker).target;
    return tg && s.price != null && s.price >= tg;
  }).map(s => s.code || s.ticker);
  const hitHtml = hit.length
    ? `<div class="home-my-target">🎯 목표가 도달 ${hit.length}건 — ${hit.slice(0, 4).join(', ')}${hit.length > 4 ? ' 외' : ''}</div>`
    : '';

  el.innerHTML = `
    <div class="home-my-count">${tickers.length}개 종목 중 변동폭 상위 ${top.length}개</div>
    ${hitHtml}
    <table class="movers-table"><tbody>
      ${top.map(s => {
        const disp = s.code || s.ticker;
        const name = s.name_ko || s.name || '';
        const pct  = s.change_pct || 0;
        const tg   = typeof WLN !== 'undefined' ? WLN.get(s.ticker).target : null;
        const mark = (tg && s.price != null && s.price >= tg) ? ' <span class="home-my-hit">✓</span>' : '';
        return `<tr onclick="navigateToChart('${s.ticker}')">
          <td class="m-ticker">${disp}${mark}</td>
          <td class="m-name">${name}</td>
          <td class="m-pct ${pct >= 0 ? 'up' : 'down'}">${fmtPct(pct)}</td>
        </tr>`;
      }).join('')}
    </tbody></table>`;
}

function renderHomePortfolioSummary() {
  const el = document.getElementById('home-portfolio-summary');
  if (!el || typeof PT === 'undefined') return;
  const data = PT.load();
  const tickers = Object.keys(data);
  if (!tickers.length) {
    el.innerHTML = `<div class="home-my-empty">포트폴리오가 없습니다. <a href="javascript:void(0)" onclick="switchView('portfolio')">포트폴리오</a> 탭에서 보유 종목을 추가하세요.</div>`;
    return;
  }
  const us = window._scStocks || [];
  const kr = window._krStocks || [];
  // 국내는 원화 그대로, 해외는 달러/원 환율로 원화 환산해 합산 (원·달러가 섞여 더해지던 문제)
  const rate = usdKrw().rate;
  let totalCost = 0, totalValue = 0, found = 0;
  tickers.forEach(t => {
    const h = data[t];
    const s = us.find(x => x.ticker === t) || kr.find(x => x.ticker === t);
    if (!s || s.price == null) return;
    found++;
    const fx = isKrTicker(t) ? 1 : rate;
    totalCost  += h.qty * h.avgPrice * (h.avgCur === 'KRW' ? 1 : fx);   // 원화로 입력한 미국 종목은 원화 그대로
    totalValue += h.qty * s.price * fx;
  });
  if (!found) {
    el.innerHTML = `<div class="home-my-empty">데이터 불러오는 중…</div>`;
    return;
  }
  const pnl    = totalValue - totalCost;
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0;
  const cls    = pnl >= 0 ? 'up' : 'down';

  // 목표가 도달 종목
  const hit = typeof PTN === 'undefined' ? [] : tickers.filter(t => {
    const tg = PTN.get(t).target;
    const s  = us.find(x => x.ticker === t) || kr.find(x => x.ticker === t);
    return tg && s && s.price != null && s.price >= tg;
  });
  const hitHtml = hit.length
    ? `<div class="home-my-target">🎯 목표가 도달 ${hit.length}건 — ${hit.slice(0, 4).join(', ')}${hit.length > 4 ? ' 외' : ''}</div>`
    : '';

  el.innerHTML = `
    <div class="home-my-count">${tickers.length}개 보유 종목</div>
    <div class="home-pf-value">${fmtKrw(totalValue)}</div>
    <div class="home-pf-pnl ${cls}">${fmtKrwSigned(pnl, true)} (${fmtPct(pnlPct)})</div>
    ${hitHtml}`;
}

// ── 뉴스 북마크 저장소 (url -> 뉴스 아이템) ──────────────────────────────────
const NB_KEY = 'stockview_news_bookmarks';
const NB = {
  _map: null,
  load() {
    if (this._map) return this._map;
    try { this._map = JSON.parse(localStorage.getItem(NB_KEY) || '{}'); }
    catch { this._map = {}; }
    return this._map;
  },
  save() { localStorage.setItem(NB_KEY, JSON.stringify(this._map)); },
  has(url) { return !!this.load()[url]; },
  toggle(item) {
    const m = this.load();
    if (m[item.url]) delete m[item.url];
    else m[item.url] = item;
    this.save();
    return !!m[item.url];
  },
};

// ── 뉴스 탭 ──────────────────────────────────────────────────────────────────
let _allNews        = [];
let _allReports     = [];
let _activeSubtab   = 'news';
let _activeSentiment = 'all';
let _activeSource    = 'all';
let _activeMarket    = 'all';
let _activeKeyword   = '';
let _showBookmarkedOnly = false;

function _toggleBookmarkFilter() {
  _showBookmarkedOnly = !_showBookmarkedOnly;
  const btn = document.getElementById('news-bookmark-toggle');
  if (btn) btn.classList.toggle('active', _showBookmarkedOnly);
  renderNews();
}

function _toggleNewsBookmark(url) {
  const item = _allNews.find(n => n.url === url) || NB.load()[url];
  if (!item) return;
  NB.toggle(item);
  renderNews();
}

function _escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _highlightKw(text, kw) {
  const esc = _escHtml(text);
  if (!kw) return esc;
  const kwEsc = _escHtml(kw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return esc.replace(new RegExp('(' + kwEsc + ')', 'gi'), '<mark class="kw-hl">$1</mark>');
}

function _populateSourceFilter(news) {
  const sel = document.getElementById('news-src-filter');
  if (!sel) return;
  const sources = [...new Set(news.map(n => n.source).filter(Boolean))].sort();
  const cur = sel.value;
  sel.innerHTML = '<option value="all">전체 출처</option>' +
    sources.map(s => `<option value="${s}"${s === cur ? ' selected' : ''}>${s}</option>`).join('');
}

function initNews() {
  // 서브탭 전환
  document.querySelectorAll('.news-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.news-subtab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _activeSubtab = btn.dataset.subtab;
      document.getElementById('news-panel').style.display         = _activeSubtab === 'news'         ? '' : 'none';
      document.getElementById('reports-panel').style.display      = _activeSubtab === 'reports'      ? '' : 'none';
      document.getElementById('disclosures-panel').style.display  = _activeSubtab === 'disclosures'  ? '' : 'none';
      if (_activeSubtab === 'reports' && _allReports.length === 0) {
        loadReports();
      }
      if (_activeSubtab === 'disclosures') {
        loadDisclosures();
      }
    });
  });

  // News 필터 (감성 + 소스)
  api('/api/news').then(news => {
    _allNews = news;
    _populateSourceFilter(news);
    renderNews();
  });
  document.querySelectorAll('.news-tag').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.news-tag').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _activeSentiment = btn.dataset.sentiment;
      renderNews();
    });
  });
  document.getElementById('news-src-filter')?.addEventListener('change', e => {
    _activeSource = e.target.value;
    renderNews();
  });
  document.querySelectorAll('.news-market-tag').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.news-market-tag').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _activeMarket = btn.dataset.market;
      renderNews();
    });
  });

  // 키워드 검색 (debounce 300ms)
  let _kwTimer = null;
  document.getElementById('news-kw-search')?.addEventListener('input', e => {
    clearTimeout(_kwTimer);
    _kwTimer = setTimeout(() => {
      _activeKeyword = e.target.value.trim().toLowerCase();
      renderNews();
    }, 300);
  });

  // Reports 타입 필터
  document.querySelectorAll('.report-tag').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.report-tag').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderReports(btn.dataset.rtype);
    });
  });

  // 공시 새로고침 버튼
  document.getElementById('disclosures-refresh-btn')?.addEventListener('click', () => {
    loadDisclosures(true);
  });

  // 공시 카테고리 필터
  document.querySelectorAll('#disclosures-panel .report-tag').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#disclosures-panel .report-tag').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderDisclosures(_allDisclosures, btn.dataset.dcat);
      _activeDcat = btn.dataset.dcat;
    });
  });
}

let _disclosuresLoaded = false;
let _allDisclosures = [];
let _activeDcat = 'all';
let _showDisclosuresBookmarkedOnly = false;

function _toggleDisclosuresBookmarkFilter() {
  _showDisclosuresBookmarkedOnly = !_showDisclosuresBookmarkedOnly;
  const btn = document.getElementById('disclosures-bookmark-toggle');
  if (btn) btn.classList.toggle('active', _showDisclosuresBookmarkedOnly);
  renderDisclosures(_allDisclosures, _activeDcat);
}

function _toggleDisclosureBookmark(link) {
  const item = _allDisclosures.find(d => d.link === link) || NB.load()[link];
  if (!item) return;
  NB.toggle({ ...item, url: link, is_disclosure: true });
  renderDisclosures(_allDisclosures, _activeDcat);
}

function loadDisclosures(force = false) {
  if (_disclosuresLoaded && !force) return;
  const el = document.getElementById('disclosures-list');
  el.innerHTML = '<div style="color:var(--muted);padding:20px 0">불러오는 중…</div>';
  api('/api/kr-disclosures').then(data => {
    _disclosuresLoaded = true;
    _allDisclosures = data;
    const active = document.querySelector('#disclosures-panel .report-tag.active');
    renderDisclosures(data, active ? active.dataset.dcat : 'all');
  }).catch(() => {
    el.innerHTML = '<div style="color:var(--muted);padding:20px 0">데이터를 불러올 수 없습니다.</div>';
  });
}

// 공시 회사명 → 종목 매칭 (5번: 정확히 일치하는 이름만 링크, 동명이인 오매칭 방지)
function _matchDisclosureStock(company) {
  const krStocks = window._krStocks || [];
  return krStocks.find(s => s.name === company) || null;
}

function renderDisclosures(items, dcat = 'all') {
  const el = document.getElementById('disclosures-list');
  // 북마크는 News·Reports와 NB 저장소를 공유 — is_disclosure 필드로 다른 항목과 구분
  let list = _showDisclosuresBookmarkedOnly
    ? Object.values(NB.load()).filter(item => item.is_disclosure)
    : (dcat === 'all' ? items : (items || []).filter(d => d.category === dcat));
  if (!list || !list.length) {
    const emptyMsg = _showDisclosuresBookmarkedOnly ? '북마크한 공시가 없습니다.' : '해당하는 공시가 없습니다.';
    el.innerHTML = `<div style="color:var(--muted);padding:20px 0">${emptyMsg}</div>`;
    return;
  }
  el.innerHTML = list.map(d => {
    const matched = _matchDisclosureStock(d.company);
    const companyHtml = matched
      ? `<span class="disclosure-company disclosure-company-link" title="차트에서 ${d.company} 보기"
          onclick="event.stopPropagation(); navigateToChart('${matched.ticker}')">${d.company}</span>`
      : `<span class="disclosure-company">${d.company}</span>`;
    const bookmarked = NB.has(d.link);
    return `
    <div class="disclosure-card" onclick="window.open('${d.link}','_blank')">
      <span class="disclosure-time">${d.time}</span>
      ${companyHtml}
      <span class="disclosure-title">${d.title}</span>
      <span class="disclosure-type">${d.type}</span>
      <button class="news-bookmark-btn${bookmarked ? ' active' : ''}"
              onclick="event.stopPropagation(); _toggleDisclosureBookmark('${d.link}')"
              title="${bookmarked ? '북마크 해제' : '북마크'}">${bookmarked ? '★' : '☆'}</button>
    </div>`;
  }).join('');
}

function loadReports() {
  document.getElementById('reports-list').innerHTML = '<div style="color:var(--muted);padding:20px 0">불러오는 중…</div>';
  api('/api/reports').then(data => {
    _allReports = data;
    renderReports('all');
  });
}

let _showReportsBookmarkedOnly = false;
let _activeReportType = 'all';

function _toggleReportsBookmarkFilter() {
  _showReportsBookmarkedOnly = !_showReportsBookmarkedOnly;
  const btn = document.getElementById('reports-bookmark-toggle');
  if (btn) btn.classList.toggle('active', _showReportsBookmarkedOnly);
  renderReports(_activeReportType);
}

function _toggleReportBookmark(url) {
  const item = _allReports.find(r => r.url === url) || NB.load()[url];
  if (!item) return;
  NB.toggle(item);
  renderReports(_activeReportType);
}

function renderReports(rtype) {
  _activeReportType = rtype;
  // 북마크는 News와 같은 NB 저장소를 공유 — report_type 필드로 뉴스 항목과 구분
  const list = _showReportsBookmarkedOnly
    ? Object.values(NB.load()).filter(item => item.report_type != null)
    : (rtype === 'all' ? _allReports : _allReports.filter(r => r.report_type === rtype));
  const el = document.getElementById('reports-list');
  if (!list.length) {
    const emptyMsg = _showReportsBookmarkedOnly ? '북마크한 리포트가 없습니다.' : '리포트가 없습니다.';
    el.innerHTML = `<div style="color:var(--muted);padding:20px 0">${emptyMsg}</div>`;
    return;
  }
  const badgeClass = t => 'badge-' + t.replace(/\s+/g, '-');
  el.innerHTML = list.map(r => {
    const tickerBadge = r.ticker
      ? `<span class="news-ticker-badge" onclick="event.stopPropagation();navigateToChart('${r.ticker}')">${r.ticker}</span>`
      : '';
    const bookmarked = NB.has(r.url);
    return `
      <div class="report-card" onclick="window.open('${r.url}','_blank')">
        <span class="report-type-badge ${badgeClass(r.report_type)}">${koReportType(r.report_type)}</span>
        <div class="news-body">
          <div class="news-title">${r.title}</div>
          <div class="news-meta">
            <span class="news-source">${r.source}</span>
            <span>${r.time}</span>
            ${tickerBadge}
          </div>
        </div>
        <button class="news-bookmark-btn${bookmarked ? ' active' : ''}"
                onclick="event.stopPropagation(); _toggleReportBookmark('${r.url}')"
                title="${bookmarked ? '북마크 해제' : '북마크'}">${bookmarked ? '★' : '☆'}</button>
      </div>`;
  }).join('');
}
function renderNews() {
  // 북마크는 Reports·Disclosures와 NB 저장소를 공유 — report_type/is_disclosure 필드로 두 항목 모두 제외
  let list = _showBookmarkedOnly ? Object.values(NB.load()).filter(item => item.report_type == null && !item.is_disclosure)
    : (_activeSentiment === 'all' ? _allNews : _allNews.filter(n => n.sentiment === _activeSentiment));
  if (_activeSource !== 'all') list = list.filter(n => n.source === _activeSource);
  if (_activeMarket !== 'all') list = list.filter(n => n.market === _activeMarket);
  if (_activeKeyword) list = list.filter(n =>
    n.title.toLowerCase().includes(_activeKeyword) ||
    (n.source || '').toLowerCase().includes(_activeKeyword)
  );
  const el = document.getElementById('news-list');
  const kw = _activeKeyword;

  // 결과 수 표시
  const countEl = document.getElementById('news-kw-count');
  if (countEl) {
    countEl.textContent = kw ? `${list.length}건` : '';
    countEl.style.display = kw ? 'inline' : 'none';
  }

  if (!list.length) {
    const emptyMsg = _showBookmarkedOnly ? '북마크한 뉴스가 없습니다.'
      : kw ? `"<b>${_escHtml(kw)}</b>"에 해당하는 뉴스가 없습니다.` : '뉴스가 없습니다.';
    el.innerHTML = `<div style="color:var(--muted);padding:20px 0;text-align:center">${emptyMsg}</div>`;
    return;
  }

  el.innerHTML = list.map(n => {
    const tickerBadge = n.ticker
      ? `<span class="news-ticker-badge" onclick="event.stopPropagation();navigateToChart('${_escHtml(n.ticker)}')">${_escHtml(n.ticker)}</span>`
      : '';
    const titleHtml = _highlightKw(n.title, kw);
    const bookmarked = NB.has(n.url);
    return `
      <div class="news-card" onclick="window.open('${_escHtml(n.url)}','_blank')" style="cursor:pointer">
        <div class="news-sentiment-badge badge-${n.sentiment}"></div>
        <div class="news-body">
          <div class="news-title">${titleHtml}</div>
          <div class="news-meta">
            <span class="news-market-flag">${n.market === 'KR' ? '🇰🇷' : '🌐'}</span>
            <span class="news-source" data-src="${_escHtml(n.source)}">${_escHtml(n.source)}</span>
            <span>${_escHtml(n.time)}</span>
            ${tickerBadge}
          </div>
        </div>
        <button class="news-bookmark-btn${bookmarked ? ' active' : ''}"
                onclick="event.stopPropagation(); _toggleNewsBookmark('${_escHtml(n.url)}')"
                title="${bookmarked ? '북마크 해제' : '북마크'}">${bookmarked ? '★' : '☆'}</button>
      </div>`;
  }).join('');
}

let _currentView = 'home';

// ── 화면 종목 실시간 시세 (10초, 서버 rt_quotes) ─────────────────────────────
function _rtTickers() {
  const set = new Set();
  if (typeof WL !== 'undefined') WL.load().forEach(t => set.add(t));
  if (typeof PT !== 'undefined') PT.tickers().forEach(t => set.add(t));
  if (typeof _currentTicker !== 'undefined' && _currentTicker && !/^\^|=/.test(_currentTicker)) set.add(_currentTicker);
  return [...set].slice(0, 300);
}

function _rtSubscribe(socket) {
  try { (socket || window._rtSocket)?.emit('rt_subscribe', { tickers: _rtTickers() }); } catch {}
}

// 메모·목표가 입력 중이거나 드롭다운을 열어둔 상태 — 이때 표를 다시 그리면 입력이 날아간다
function _isTypingInTable() {
  const ae = document.activeElement;
  return !!(ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName) && ae.id !== 'global-search');
}

async function _rtApply(quotes) {
  if (!quotes || !Object.keys(quotes).length) return;
  const patch = s => { const q = s && quotes[s.ticker]; if (q) Object.assign(s, q); };
  (window._scStocks || []).forEach(patch);
  (window._krStocks || []).forEach(patch);
  if (typeof _wlCache !== 'undefined' && _wlCache) _wlCache.stocks.forEach(patch);
  if (typeof _ptCache !== 'undefined' && _ptCache) Object.values(_ptCache.priceMap).forEach(patch);

  if (_isTypingInTable()) return;   // 입력 중엔 값만 바꿔두고 다음 갱신 때 그린다

  // 표 가로 스크롤 위치 유지
  const keep = async (sel, fn) => {
    const wrap = document.querySelector(sel);
    const x = wrap ? wrap.scrollLeft : 0;
    await fn();
    const w2 = document.querySelector(sel);
    if (w2) w2.scrollLeft = x;
  };
  if (_currentView === 'watchlist' && typeof renderWatchlist === 'function')
    await keep('#wl-content .table-wrap', () => renderWatchlist({ cached: true }));
  if (_currentView === 'portfolio' && typeof renderPortfolio === 'function')
    await keep('#pt-content .table-wrap', () => renderPortfolio({ cached: true }));
  if (_currentView === 'home') { renderHomeWatchlistSummary(); renderHomePortfolioSummary(); }
}

// ── 타임스탬프 ────────────────────────────────────────────────────────────────
function updateTimestamp() {
  const el = document.getElementById('last-updated');
  if (el) el.textContent = '실시간 · ' + new Date().toLocaleTimeString('ko-KR');
}

// ── WebSocket 연결 + 이벤트 핸들러 ──────────────────────────────────────────
// 10번: 연결 끊김 시 Home/Screener(US)/Portfolio/Watchlist 갱신이 멈추지 않도록 폴백 폴링
let _fallbackPollTimer = null;

async function _refreshCurrentView() {
  try {
    const stocks = await api('/api/stocks');
    if (_currentView === 'home') {
      const indices = await api('/api/indices');
      _homeStocks = stocks;   // 기간 버튼 클릭 시에도 최신 시세 기준으로 계산되도록
      buildTickerTape(indices, stocks);
      renderMovers(stocks);
      loadSectorPerf(_sectorPeriod, true);   // 선택 중인 기간(1D/1W/1M) 유지
      renderVolumeLeaders(stocks);
      renderMarketStatBar(stocks);
    }
    // 스크리너가 US 시장으로 열려있으면 데이터 갱신 (KR 보는 중이면 건드리지 않음)
    if (_currentView === 'screener' && typeof _scMarket !== 'undefined' && _scMarket !== 'kr'
        && typeof loadScreenerData === 'function') {
      loadScreenerData(false);
    }
    // 포트폴리오가 열려있으면 갱신
    if (_currentView === 'portfolio' && typeof renderPortfolio === 'function' && !_isTypingInTable()) {
      renderPortfolio();
    }
    // 워치리스트가 열려있으면 갱신
    if (_currentView === 'watchlist' && typeof renderWatchlist === 'function' && !_isTypingInTable()) {
      renderWatchlist();
    }
    // 가격 알림 확인 — 차트 탭을 안 보고 있어도(다른 탭이거나 다른 티커여도) 동작
    if (typeof _checkAllAlerts === 'function') _checkAllAlerts(stocks);
    updateTimestamp();
  } catch {}
}

function initSocketIO() {
  const socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    const el = document.getElementById('last-updated');
    if (el) el.classList.remove('disconnected');
    updateTimestamp();
    if (_fallbackPollTimer) { clearInterval(_fallbackPollTimer); _fallbackPollTimer = null; }
  });

  socket.on('disconnect', () => {
    const el = document.getElementById('last-updated');
    if (el) { el.textContent = '⚠ 연결 끊김'; el.classList.add('disconnected'); }
    if (!_fallbackPollTimer) _fallbackPollTimer = setInterval(_refreshCurrentView, 30000);
  });

  // 종목 가격 갱신 Push
  socket.on('stocks_update', _refreshCurrentView);

  // 화면 종목 실시간 시세 (10초) — 지금 보는 종목을 서버에 알려주고, 받은 값만 바꿔 다시 그린다
  socket.on('connect', () => _rtSubscribe(socket));
  setInterval(() => _rtSubscribe(socket), 30000);   // 관심종목·포트폴리오·차트 종목 변경 반영
  window._rtSocket = socket;
  socket.on('rt_quotes', msg => _rtApply((msg || {}).quotes || {}));
  socket.on('rt_indices', msg => {
    const indices = (msg || {}).indices;
    if (indices && indices.length) { _setUsdKrwFromIndices(indices); renderIndices(indices); }
  });

  // 국내주식 가격 갱신 Push
  socket.on('kr_stocks_update', async () => {
    try {
      const krStocks = await api('/api/kr-stocks');
      if (_currentView === 'screener' && typeof _scMarket !== 'undefined' && _scMarket === 'kr'
          && typeof loadKrScreener === 'function') {
        loadKrScreener(false);
      }
      if (_currentView === 'watchlist' && typeof renderWatchlist === 'function' && !_isTypingInTable()) {
        renderWatchlist();
      }
      if (typeof _checkAllAlerts === 'function') _checkAllAlerts(krStocks);
      updateTimestamp();
    } catch {}
  });

  // 지수 갱신 Push
  socket.on('indices_update', async () => {
    try {
      const [indices, stocks] = await Promise.all([api('/api/indices'), api('/api/stocks')]);
      renderIndices(indices);
      if (_currentView === 'home') {
        buildTickerTape(indices, stocks);
      }
      updateTimestamp();
    } catch {}
  });

  // 뉴스 갱신 Push
  socket.on('news_update', async () => {
    try {
      const news = await api('/api/news');
      if (_currentView === 'home')  renderHomeNews(news);
      if (_currentView === 'news') { _allNews = news; _populateSourceFilter(news); renderNews(); }
      updateTimestamp();
    } catch {}
  });

  return socket;
}

// ── 진입점 ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // 탭 클릭
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _currentView = btn.dataset.view;
      switchView(btn.dataset.view);
    });
  });

  // 홈 초기 로드
  loadHome().then(updateTimestamp);

  // 시장 상태 배지 — 1분마다 갱신 (ET 시간 변동 반영)
  setInterval(renderMarketStatus, 60 * 1000);

  // WebSocket 연결 (Socket.IO CDN 로드된 후)
  if (typeof io !== 'undefined') {
    initSocketIO();
  } else {
    console.warn('[WS] Socket.IO 미로드 — polling 모드로 동작');
  }

  // 배지 초기화
  updateWLCount();
  if (typeof _updatePtCount === 'function') _updatePtCount();

  // URL hash로 탭 직접 진입 (예: #screener, #heatmap)
  const _hash = window.location.hash.slice(1);
  const _views = ['home','screener','heatmap','chart','news','brief','earnings','watchlist','portfolio'];
  if (_hash && _views.includes(_hash)) switchView(_hash);

  // 글로벌 검색 초기화
  initGlobalSearch();
  _preloadGlobalSearchData().then(() => {
    // 홈 위젯이 먼저 렌더된 경우(전역검색 데이터 로딩 전) 로딩 완료 후 다시 채움
    if (_currentView === 'home') {
      renderHomeWatchlistSummary();
      renderHomePortfolioSummary();
    }
  });

  // 테마 초기화
  initTheme();

  // 전역 키보드 단축키
  initGlobalKeyboardShortcuts();
});

// ── 전역 키보드 단축키 ────────────────────────────────────────────────────────
const _SHORTCUT_TABS = { '1':'home','2':'screener','3':'heatmap','4':'chart','5':'news','6':'brief','7':'earnings','8':'watchlist','9':'portfolio' };

function initGlobalKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

    if (e.key === '/' && !typing) {
      e.preventDefault();
      const gs = document.getElementById('global-search');
      if (gs) gs.focus();
      return;
    }
    if (e.key === 'Escape' && typing) {
      e.target.blur();
      return;
    }
    if (typing) return;

    if (_SHORTCUT_TABS[e.key]) {
      _currentView = _SHORTCUT_TABS[e.key];
      switchView(_SHORTCUT_TABS[e.key]);
    }
  });
}

// ── 라이트/다크 테마 ────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light') _applyTheme('light');
}

function toggleTheme() {
  const isLight = document.body.classList.contains('light-theme');
  _applyTheme(isLight ? 'dark' : 'light');
}

function _applyTheme(mode) {
  const isLight = mode === 'light';
  document.body.classList.toggle('light-theme', isLight);
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = isLight ? '🌕' : '🌙';
  localStorage.setItem('theme', mode);
}

// ── 글로벌 검색 ──────────────────────────────────────────────────────────────
function initGlobalSearch() {
  const input = document.getElementById('global-search');
  const drop  = document.getElementById('global-search-dropdown');
  if (!input || !drop) return;

  let _gsTimer = null;

  input.addEventListener('input', () => {
    clearTimeout(_gsTimer);
    const q = input.value.trim().toLowerCase();
    if (!q) { drop.innerHTML = ''; drop.style.display = 'none'; return; }
    _gsTimer = setTimeout(() => _gsSearch(q), 200);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { input.value = ''; drop.style.display = 'none'; }
    if (e.key === 'Enter') {
      const first = drop.querySelector('.gs-item');
      if (first) first.click();
    }
  });

  document.addEventListener('click', e => {
    if (!document.getElementById('global-search-wrap').contains(e.target))
      drop.style.display = 'none';
  });
}

// 스크리너 탭을 열지 않은 상태에서도 검색이 되도록 US/KR 종목 목록을 백그라운드로 미리 로드
async function _preloadGlobalSearchData() {
  try {
    if (!window._scStocks || window._scStocks.length === 0) {
      window._scStocks = await api('/api/stocks');
    }
  } catch (e) { console.warn('global search US preload failed', e); }
  try {
    if (!window._krStocks || window._krStocks.length === 0) {
      window._krStocks = await api('/api/kr-stocks');
    }
  } catch (e) { console.warn('global search KR preload failed', e); }
}

// 검색 결과 정렬: 정확 일치 > 시작 일치 > 부분 일치(이름 등) 순 — 짧은 티커가
// 다른 회사명에 우연히 포함돼(예: "BE" ⊂ "Alphabet") 시총 정렬에 밀려 안 보이는 문제 방지
function _gsRankOf(q, code) {
  const c = (code || '').toLowerCase();
  return c === q ? 0 : c.startsWith(q) ? 1 : 2;
}
function _gsTickerRank(q, getCode) {
  return (a, b) => _gsRankOf(q, getCode(a)) - _gsRankOf(q, getCode(b));
}

function _gsSearch(q) {
  const drop    = document.getElementById('global-search-dropdown');
  const usStocks = window._scStocks || [];
  const krStocks = window._krStocks || [];

  const matchUs = usStocks.filter(s =>
    s.ticker.toLowerCase().startsWith(q) ||
    s.ticker.toLowerCase().includes(q)   ||
    (s.name || '').toLowerCase().includes(q) ||
    (s.name_ko || '').includes(q)
  ).sort(_gsTickerRank(q, s => s.ticker)).slice(0, 4).map(s => ({ ...s, _isKr: false }));

  const matchKr = krStocks.filter(s =>
    s.code.toLowerCase().includes(q) ||
    s.name.toLowerCase().includes(q)
  ).sort(_gsTickerRank(q, s => s.code)).slice(0, 3).map(s => ({ ...s, ticker: s.ticker, name: s.name, _isKr: true }));

  const results = [...matchUs, ...matchKr].slice(0, 6);

  if (!results.length) {
    drop.innerHTML = `<div class="gs-empty">결과 없음</div>`;
    drop.style.display = 'block';
    return;
  }

  drop.innerHTML = results.map(s => {
    const pct    = s.change_pct ?? 0;
    const cls    = pct >= 0 ? 'up' : 'down';
    const badge  = s._isKr ? '<span class="gs-kr-badge">🇰🇷</span>' : '';
    const disp   = s._isKr ? s.code : s.ticker;
    const price  = s._isKr
      ? `₩${Math.round(s.price||0).toLocaleString('ko-KR')}`
      : '';
    return `<div class="gs-item" onclick="_gsSelect('${s.ticker}')">
      ${badge}<span class="gs-ticker">${disp}</span>
      <span class="gs-name">${(s._isKr ? s.name : (s.name_ko || s.name)) || ''}</span>
      <span class="gs-pct ${cls}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>
    </div>`;
  }).join('');
  drop.style.display = 'block';
}

function _gsSelect(ticker) {
  const input = document.getElementById('global-search');
  const drop  = document.getElementById('global-search-dropdown');
  if (input) input.value = '';
  if (drop)  drop.style.display = 'none';

  // KR 종목(.KS/.KQ)은 항상 차트로 이동
  const isKr = ticker.endsWith('.KS') || ticker.endsWith('.KQ');
  if (!isKr && typeof openStockModal === 'function' && window._scStocks && window._scStocks.length) {
    openStockModal(ticker);
  } else {
    navigateToChart(ticker);
  }
}
