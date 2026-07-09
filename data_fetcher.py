"""
실시간 데이터 수집 모듈
  - 주가: Yahoo Finance API (requests 직접 호출, yfinance 의존성 없음)
  - S&P500 목록: Wikipedia HTML 파싱 (html.parser 내장 모듈 사용)
  - 뉴스: RSS 피드 파싱 (feedparser)
  - 감성 분석: VADER
"""

import calendar
import logging
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser

import feedparser
import requests
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

log = logging.getLogger(__name__)

YF_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
}

FMP_KEY      = "uF46pP4IocE5ToPciq8lniQ3gpREJEpo"
AV_KEY       = "BHLMLWDEUN9B98HW"
FINNHUB_KEY  = "d93qog9r01qj2ci8oaf0d93qog9r01qj2ci8oafg"

RSS_FEEDS = [
    # 기존 7개
    {"url": "https://finance.yahoo.com/news/rssindex",                             "source": "Yahoo Finance"},
    {"url": "https://www.cnbc.com/id/100003114/device/rss/rss.html",              "source": "CNBC"},
    {"url": "https://feeds.marketwatch.com/marketwatch/topstories/",              "source": "MarketWatch"},
    {"url": "https://seekingalpha.com/market_currents.xml",                       "source": "Seeking Alpha"},
    {"url": "https://www.fool.com/feeds/index.aspx",                              "source": "Motley Fool"},
    {"url": "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml",          "source": "NYT Business"},
    {"url": "https://www.ft.com/rss/home",                                        "source": "Financial Times"},
    # 추가 5개
    {"url": "https://www.thestreet.com/.rss/full",                                "source": "TheStreet"},
    {"url": "https://www.benzinga.com/feed",                                      "source": "Benzinga"},
    {"url": "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",                      "source": "WSJ Markets"},
    # Reddit 커뮤니티 3개 (User-Agent 필요)
    {"url": "https://www.reddit.com/r/stocks/top/.rss?t=day",                    "source": "Reddit r/stocks",   "reddit": True},
    {"url": "https://www.reddit.com/r/investing/top/.rss?t=day",                 "source": "Reddit r/investing","reddit": True},
    {"url": "https://www.reddit.com/r/wallstreetbets/top/.rss?t=day",            "source": "Reddit r/wsb",      "reddit": True},
    # 테크/앱 비즈니스 인사이트
    {"url": "https://www.appeconomyinsights.com/feed",                            "source": "App Economy Insights"},
]

REPORT_FEEDS = [
    {"url": "https://www.globenewswire.com/RssFeed/subjectcode/19-Earnings%20Releases%20%26%20Operating%20Results",
     "source": "Globe Newswire", "report_type": "Earnings"},
    {"url": "https://www.prnewswire.com/rss/news-releases-list.rss",
     "source": "PR Newswire",    "report_type": "Press Release"},
    {"url": "https://www.federalreserve.gov/feeds/press_all.xml",
     "source": "Federal Reserve","report_type": "Fed"},
]

# 더미 데이터에서 복사한 한글 종목명 매핑
NAME_KO: dict[str, str] = {
    # ── 기술 ──────────────────────────────────────────────────────────────────
    "AAPL": "애플", "MSFT": "마이크로소프트", "NVDA": "엔비디아",
    "GOOGL": "알파벳A", "GOOG": "알파벳C", "META": "메타", "TSLA": "테슬라",
    "AMD": "AMD", "INTC": "인텔", "AVGO": "브로드컴", "ORCL": "오라클",
    "CRM": "세일즈포스", "ADBE": "어도비", "QCOM": "퀄컴", "MU": "마이크론",
    "ACN": "액센츄어", "IBM": "IBM", "CSCO": "시스코", "TXN": "텍사스인스트루먼트",
    "AMAT": "어플라이드머티리얼즈", "LRCX": "램리서치", "KLAC": "KLA",
    "MRVL": "마블테크놀로지", "ANET": "아리스타네트웍스",
    "ADI": "아날로그디바이시스", "MCHP": "마이크로칩테크놀로지",
    "NXPI": "NXP세미컨덕터", "SWKS": "스카이웍스솔루션즈", "QRVO": "코르보",
    "ON": "온세미컨덕터", "STX": "씨게이트", "WDC": "웨스턴디지털",
    "HPQ": "HP", "HPE": "휴렛팩커드엔터프라이즈", "DELL": "델테크놀로지스",
    "FTNT": "포티넷", "AKAM": "아카마이", "CTSH": "코그니전트",
    "INTU": "인튜이트", "ANSS": "앤시스", "PTC": "PTC", "IT": "가트너",
    "BR": "브로드리지파이낸셜", "MSI": "모토로라솔루션즈",
    "KEYS": "키사이트테크놀로지", "TRMB": "트림블", "CDW": "CDW",
    "GEN": "젠디지털", "GDDY": "고대디", "SAIC": "SAIC",
    "LDOS": "레이도스", "BAH": "부즈알렌해밀턴", "TYL": "타일러테크놀로지스",
    "EPAM": "EPAM시스템즈", "MANH": "맨해튼어소시에이츠",
    "DDOG": "데이터독", "NET": "클라우드플레어", "CRWD": "크라우드스트라이크",
    "PANW": "팔로알토네트웍스", "NOW": "서비스나우", "WDAY": "워크데이",
    "SNOW": "스노우플레이크", "PLTR": "팔란티어", "TEAM": "아틀라시안",
    "ZM": "줌", "COIN": "코인베이스", "SHOP": "쇼피파이",
    # ── 금융 ──────────────────────────────────────────────────────────────────
    "JPM": "JP모건", "BAC": "뱅크오브아메리카", "GS": "골드만삭스",
    "MS": "모건스탠리", "V": "비자", "MA": "마스터카드", "WFC": "웰스파고",
    "BLK": "블랙록", "C": "씨티그룹", "AXP": "아메리칸익스프레스",
    "BRK-B": "버크셔해서웨이B", "BRK-A": "버크셔해서웨이A",
    "SPGI": "S&P글로벌", "MCO": "무디스", "ICE": "인터콘티넨털익스체인지",
    "CME": "CME그룹", "CB": "처브",
    "BK": "뉴욕멜론은행", "USB": "US뱅코프", "PNC": "PNC파이낸셜",
    "TFC": "트루이스트파이낸셜", "SCHW": "찰스슈왑",
    "COF": "캐피탈원", "DFS": "디스커버파이낸셜", "SYF": "싱크로니파이낸셜",
    "FITB": "피프스서드뱅코프", "HBAN": "헌팅턴뱅크셰어스",
    "RF": "리전스파이낸셜", "CFG": "시티즌스파이낸셜",
    "MTB": "M&T뱅크", "KEY": "키코프",
    "STT": "스테이트스트리트", "NTRS": "노던트러스트",
    "AFL": "애플락", "MET": "메트라이프", "PRU": "프루덴셜파이낸셜",
    "AIG": "AIG", "ALL": "올스테이트", "PGR": "프로그레시브",
    "HIG": "하트포드파이낸셜", "CINF": "신시내티파이낸셜",
    "AON": "에이온", "MMC": "마쉬맥레넌", "AJG": "아서제이갤러거",
    "BRO": "브라운&브라운", "WTW": "윌리스타워스왓슨",
    "NDAQ": "나스닥", "CBOE": "CBOE글로벌마켓",
    "IVZ": "인베스코", "BEN": "프랭클린리소시스", "TROW": "T.로우프라이스",
    "EFX": "에퀴팩스", "TRU": "트랜스유니온", "VRSK": "버리스크애널리틱스",
    "PAYC": "페이컴소프트웨어", "FIS": "피델리티인포메이션서비시스",
    "FISV": "피서브", "GPN": "글로벌페이먼츠",
    "PYPL": "페이팔", "SQ": "블록",
    # ── 헬스케어 ──────────────────────────────────────────────────────────────
    "JNJ": "존슨앤드존슨", "UNH": "유나이티드헬스", "PFE": "화이자",
    "ABBV": "애브비", "LLY": "일라이릴리", "MRK": "머크",
    "TMO": "써모피셔", "ABT": "애보트",
    "AMGN": "암젠", "GILD": "길리어드사이언시스", "REGN": "리제네론",
    "VRTX": "버텍스파마슈티컬즈", "BIIB": "바이오젠", "MRNA": "모더나",
    "ZTS": "조에티스", "EW": "에드워즈라이프사이언시스",
    "DXCM": "덱스콤", "GEHC": "GE헬스케어",
    "IDXX": "아이덱스래보라토리스", "ALGN": "얼라인테크놀로지",
    "HOLX": "홀로직", "PODD": "인슐레트", "BAX": "백스터인터내셔널",
    "HCA": "HCA헬스케어", "CNC": "센텐", "ELV": "엘레반스헬스",
    "MOH": "몰리나헬스케어", "DVA": "다비타",
    "LH": "래보라토리코프", "DGX": "퀘스트다이아그노스틱스",
    "CAH": "카디널헬스", "MCK": "맥케슨",
    "CVS": "CVS헬스", "CI": "시그나", "HUM": "휴마나",
    "ISRG": "인튜이티브서지컬", "MDT": "메드트로닉", "BSX": "보스턴사이언티픽",
    "SYK": "스트라이커", "ZBH": "짐머바이오멧", "BDX": "벡톤디킨슨",
    "DHR": "다나허", "A": "에질런트", "IQV": "IQVIA",
    "MTD": "메틀러톨레도", "WAT": "워터스", "RVTY": "레비티",
    "INCY": "인사이트", "ALNY": "알나일람파마슈티컬즈",
    "BMRN": "바이오마린파마슈티컬", "SRPT": "사렙타테라퓨틱스",
    "IONS": "아이오니스파마슈티컬즈", "NBIX": "뉴로크라인바이오사이언시스",
    # ── 에너지 ────────────────────────────────────────────────────────────────
    "XOM": "엑슨모빌", "CVX": "셰브론", "COP": "코노코필립스", "SLB": "슐룸베르거",
    "OXY": "옥시덴털페트롤리엄", "MPC": "마라톤페트롤리엄",
    "PSX": "필립스66", "VLO": "발레로에너지",
    "HES": "헤스", "DVN": "데본에너지", "FANG": "다이아몬드백에너지",
    "APA": "APA코퍼레이션", "MRO": "마라톤오일",
    "HAL": "핼리버튼", "BKR": "베이커휴즈",
    "OKE": "원오크", "KMI": "킨더모건", "WMB": "윌리엄스컴퍼니즈",
    "LNG": "체니에르에너지", "EQT": "EQT코퍼레이션",
    "AR": "안테로리소시스", "RRC": "레인지리소시스",
    # ── 산업재 ────────────────────────────────────────────────────────────────
    "BA": "보잉", "CAT": "캐터필러", "HON": "허니웰", "UPS": "UPS", "RTX": "RTX",
    "GE": "GE에어로스페이스", "GEV": "GE버노바", "MMM": "3M",
    "EMR": "에머슨일렉트릭", "ETN": "이튼", "PH": "파커하네핀",
    "DE": "존디어", "GD": "제너럴다이나믹스", "LMT": "록히드마틴",
    "NOC": "노스롭그루먼", "LHX": "L3해리스", "TDG": "트랜스다이제스트그룹",
    "TT": "트레인테크놀로지", "CARR": "캐리어글로벌", "OTIS": "오티스월드와이드",
    "UNP": "유니온퍼시픽", "CSX": "CSX코퍼레이션", "NSC": "노폭서던",
    "FDX": "페덱스", "XPO": "XPO", "JBHT": "J.B.헌트트랜스포트",
    "ODFL": "올드도미니언화물선", "EXPD": "익스피다이터스인터내셔널",
    "GWW": "W.W.그레인저", "FAST": "패스트널", "ROK": "록웰오토메이션",
    "AME": "아메텍", "PNR": "펜테어", "IR": "잉거솔랜드",
    "GNRC": "제너락홀딩스",
    "WM": "웨이스트매니지먼트", "RSG": "리퍼블릭서비시스", "CLH": "클린하버스",
    "AXON": "액손엔터프라이즈", "CBRE": "CBRE그룹", "JLL": "존스랭라살",
    "HEI": "HEICO", "CW": "커티스라이트", "HWM": "하웨트",
    "CHRW": "C.H.로빈슨월드와이드", "ROP": "로퍼테크놀로지스",
    "FLR": "플루어", "AECOM": "에이컴",
    # ── 경기소비재 ────────────────────────────────────────────────────────────
    "AMZN": "아마존", "HD": "홈디포", "COST": "코스트코", "NKE": "나이키",
    "MCD": "맥도날드", "SBUX": "스타벅스",
    "LOW": "로우스", "TGT": "타겟", "TJX": "TJX컴퍼니즈",
    "ROST": "로스스토어스", "BURL": "벌링턴스토어스",
    "AZO": "오토존", "ORLY": "오라일리오토모티브",
    "AAP": "어드밴스오토파츠", "AN": "오토네이션", "KMX": "카맥스",
    "CMG": "치폴레멕시칸그릴", "YUM": "얌브랜즈", "DRI": "다든레스토랑",
    "QSR": "레스토랑브랜즈인터내셔널", "DPZ": "도미노피자",
    "RL": "랄프로렌", "PVH": "PVH코프", "TPR": "테이퍼스트리",
    "VFC": "VF코퍼레이션", "HAS": "해즈브로", "MAT": "마텔",
    "POOL": "풀코퍼레이션", "APTV": "앱티브", "BWA": "보르그워너",
    "MHK": "모호크인더스트리즈", "WHR": "월풀",
    "PHM": "펄트그룹", "DHI": "DR호튼", "LEN": "레나", "TOL": "톨브라더스",
    "F": "포드모터", "GM": "제너럴모터스",
    "UBER": "우버", "LYFT": "리프트", "ABNB": "에어비앤비", "DASH": "도어대시",
    "BKNG": "부킹홀딩스", "EXPE": "익스피디아",
    "MAR": "메리어트인터내셔널", "HLT": "힐튼월드와이드",
    "CCL": "카니발", "RCL": "로열캐리비안그룹", "NCLH": "노르웨이지언크루즈라인",
    "ETSY": "엣시", "W": "웨이페어", "CHWY": "츄이",
    "BBY": "베스트바이", "DG": "달러제너럴", "DLTR": "달러트리",
    "FIVE": "파이브빌로우",
    # ── 필수소비재 ────────────────────────────────────────────────────────────
    "WMT": "월마트", "PG": "P&G", "KO": "코카콜라", "PEP": "펩시코",
    "CL": "콜게이트팜올리브", "EL": "에스티로더", "KMB": "킴벌리클라크",
    "GIS": "제너럴밀스", "K": "켈라노바", "HSY": "허쉬",
    "PM": "필립모리스", "MO": "알트리아", "BTI": "브리티시아메리칸토바코",
    "KHC": "크라프트하인즈", "STZ": "컨스텔레이션브랜즈",
    "MNST": "몬스터베버리지", "KDP": "큐리그닥터페퍼",
    "SYY": "시스코코퍼레이션", "USFD": "US푸즈",
    "DG": "달러제너럴",
    "CLX": "클로락스", "CHD": "처치앤드와이트",
    "SJM": "JM스머커", "CAG": "코나그라브랜즈",
    "HRL": "호멜푸즈", "CPB": "캠벨수프", "MKC": "맥코믹",
    "BJ": "BJ스홀세일클럽",
    # ── 통신서비스 ────────────────────────────────────────────────────────────
    "NFLX": "넷플릭스", "DIS": "월트디즈니", "T": "AT&T",
    "CMCSA": "컴캐스트", "CHTR": "차터커뮤니케이션", "VZ": "버라이즌",
    "TMUS": "T-모바일",
    "EA": "일렉트로닉아츠", "TTWO": "테이크투인터랙티브",
    "MTCH": "매치그룹", "LYV": "라이브네이션",
    "PARA": "파라마운트글로벌", "WBD": "워너브라더스디스커버리",
    "OMC": "옴니콤그룹", "IPG": "인터퍼블릭그룹",
    "SNAP": "스냅", "PINS": "핀터레스트",
    # ── 부동산 ────────────────────────────────────────────────────────────────
    "AMT": "아메리칸타워", "PLD": "프로로지스",
    "O": "리얼티인컴", "SPG": "사이먼프로퍼티",
    "EQR": "에퀴티레지던셜", "AVB": "어반티레지던셜", "VTR": "벤타스",
    "EQIX": "에퀴닉스", "DLR": "디지털리얼티",
    "WELL": "웰타워", "VICI": "VICI프로퍼티스",
    "PSA": "퍼블릭스토리지", "EXR": "엑스트라스페이스스토리지",
    "NNN": "내셔널리테일프로퍼티스",
    "BXP": "보스턴프로퍼티스", "VNO": "보나도리얼티",
    "KIM": "킴코리얼티", "REG": "레갠시센터스",
    "WY": "웨이어하우저",
    # ── 소재 ──────────────────────────────────────────────────────────────────
    "FCX": "프리포트맥모란", "NEM": "뉴몬트",
    "LIN": "린데", "APD": "에어프로덕츠",
    "SHW": "쉐어윈-윌리엄스", "ECL": "에코랩", "PPG": "PPG인더스트리즈",
    "ALB": "알베마를", "CF": "CF인더스트리즈",
    "MOS": "모자이크", "IFF": "IFF", "EMN": "이스트만케미컬",
    "NUE": "뉴코어", "STLD": "스틸다이나믹스", "RS": "릴라이언스스틸",
    "AA": "알코아", "X": "US스틸",
    "BLL": "볼코퍼레이션", "AMCR": "암코르", "PKG": "패키징코퍼레이션오브아메리카",
    "IP": "인터내셔널페이퍼", "AVY": "에이버리데니슨",
    # ── 유틸리티 ──────────────────────────────────────────────────────────────
    "NEE": "넥스트에라에너지", "DUK": "듀크에너지",
    "SO": "서던컴퍼니", "AEP": "아메리칸일렉트릭",
    "EXC": "엑셀론", "D": "도미니언에너지", "SRE": "셈프라",
    "PCG": "PG&E", "ED": "컨솔리데이티드에디슨",
    "EIX": "에디슨인터내셔널", "PPL": "PPL코퍼레이션",
    "XEL": "엑셀에너지", "WEC": "WEC에너지그룹",
    "CMS": "CMS에너지", "AES": "AES코퍼레이션",
    "AWK": "아메리칸워터웍스",
}

TICKER_SET = set(NAME_KO.keys())

# Wikipedia GICS 섹터명 → 앱 내부 섹터명 매핑
_SECTOR_MAP: dict[str, str] = {
    "Information Technology":  "Technology",
    "Financials":              "Finance",
    "Health Care":             "Healthcare",
    "Consumer Discretionary":  "Consumer Disc.",
    "Consumer Staples":        "Consumer Staples",
    "Industrials":             "Industrial",
    "Communication Services":  "Communication",
    "Energy":                  "Energy",
    "Real Estate":             "Real Estate",
    "Materials":               "Materials",
    "Utilities":               "Utilities",
}

_vader = SentimentIntensityAnalyzer()


# ── Wikipedia 파싱 공통 ───────────────────────────────────────────────────────

class _WikiIndexParser(HTMLParser):
    """Wikipedia 페이지의 모든 wikitable을 수집 (중첩 테이블 안전 처리)."""

    def __init__(self):
        super().__init__()
        self._depth = 0
        self._in_wiki = False
        self._in_row = False
        self._in_cell = False
        self.tables: list[list[list[str]]] = []
        self._cur_table: list[list[str]] = []
        self._cur_row: list[str] = []
        self._cur_cell = ""

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._depth += 1
            if self._depth == 1 and "wikitable" in dict(attrs).get("class", ""):
                self._in_wiki = True
                self._cur_table = []
            return
        if self._in_wiki and self._depth == 1:
            if tag == "tr":
                self._in_row = True
                self._cur_row = []
            elif tag in ("td", "th") and self._in_row:
                self._in_cell = True
                self._cur_cell = ""

    def handle_endtag(self, tag):
        if tag == "table":
            if self._depth == 1 and self._in_wiki:
                self._in_wiki = False
                if self._cur_table:
                    self.tables.append(self._cur_table[:])
                self._cur_table = []
            self._depth = max(0, self._depth - 1)
            return
        if self._in_wiki and self._depth == 1:
            if tag == "tr" and self._in_row:
                if self._cur_row:
                    self._cur_table.append(self._cur_row[:])
                self._in_row = False
                self._cur_row = []
            elif tag in ("td", "th") and self._in_row:
                self._cur_row.append(self._cur_cell.strip())
                self._in_cell = False

    def handle_data(self, data):
        if self._in_cell:
            self._cur_cell += data


def _wiki_find_ticker_col(table: list[list[str]], keywords: tuple[str, ...] = ("ticker", "symbol")) -> int:
    """헤더 행에서 티커 컬럼 인덱스 반환. 없으면 -1."""
    if not table:
        return -1
    for i, cell in enumerate(table[0]):
        if any(kw in cell.strip().lower() for kw in keywords):
            return i
    return -1


# ── Wikipedia S&P 500 파싱 ────────────────────────────────────────────────────

class _WikiTableParser(HTMLParser):
    """Wikipedia 첫 번째 wikitable만 파싱하는 간이 파서"""

    def __init__(self):
        super().__init__()
        self._in_table = False
        self._done = False
        self._table_count = 0
        self._in_row = False
        self._in_cell = False
        self.rows: list[list[str]] = []
        self._cur_row: list[str] = []
        self._cur_cell = ""

    def handle_starttag(self, tag, attrs):
        if self._done:
            return
        ad = dict(attrs)
        if tag == "table" and "wikitable" in ad.get("class", ""):
            self._table_count += 1
            if self._table_count == 1:
                self._in_table = True
        if self._in_table:
            if tag == "tr":
                self._in_row = True
                self._cur_row = []
            elif tag in ("td", "th") and self._in_row:
                self._in_cell = True
                self._cur_cell = ""

    def handle_endtag(self, tag):
        if self._done:
            return
        if self._in_table and tag == "table":
            self._in_table = False
            self._done = True
        if self._in_table and tag == "tr" and self._in_row:
            if self._cur_row:
                self.rows.append(self._cur_row)
            self._in_row = False
        if self._in_row and tag in ("td", "th"):
            self._cur_row.append(self._cur_cell.strip())
            self._in_cell = False

    def handle_data(self, data):
        if self._in_cell:
            self._cur_cell += data


def fetch_nasdaq_stocks(min_market_cap_b: float = 0.3) -> list[dict]:
    """
    Nasdaq 스크리너 API로 미국 상장 전체 종목 조회 (단 1회 요청).

    min_market_cap_b: 최소 시가총액 (십억달러). 기본 0.3B = Russell 2000 최소 수준
    반환: STOCKS 형식 딕셔너리 리스트 (가격·시총·섹터 포함)
    실패 시 빈 리스트 반환.
    """
    url = (
        "https://api.nasdaq.com/api/screener/stocks"
        "?tableonly=true&limit=5000&offset=0&download=true"
    )
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
    }
    try:
        r = requests.get(url, headers=headers, timeout=20)
        r.raise_for_status()
        rows = r.json()["data"]["rows"]
    except Exception as e:
        log.warning(f"fetch_nasdaq_stocks 실패: {e}")
        return []

    # Nasdaq 섹터명 → 앱 섹터명 매핑
    _NASDAQ_SECTOR: dict[str, str] = {
        "Technology":              "Technology",
        "Finance":                 "Finance",
        "Health Care":             "Healthcare",
        "Consumer Discretionary":  "Consumer Disc.",
        "Consumer Staples":        "Consumer Staples",
        "Industrials":             "Industrial",
        "Communication Services":  "Communication",
        "Energy":                  "Energy",
        "Real Estate":             "Real Estate",
        "Materials":               "Materials",
        "Utilities":               "Utilities",
        "Basic Industries":        "Materials",
        "Capital Goods":           "Industrial",
        "Consumer Non-Durables":   "Consumer Staples",
        "Consumer Durables":       "Consumer Disc.",
        "Consumer Services":       "Consumer Disc.",
        "Transportation":          "Industrial",
        "Public Utilities":        "Utilities",
        "Miscellaneous":           "Industrial",
    }

    # 업종명 단축 매핑 (Nasdaq API 실제 반환값 기준)
    _INDUSTRY_SHORT: dict[str, str] = {
        # Technology
        "Semiconductors":                                                    "Semiconductors",
        "Computer Software: Prepackaged Software":                           "Software",
        "Computer Software: Programming Data Processing":                    "Software",
        "EDP Services":                                                      "IT Services",
        "Business Services":                                                 "Business Services",
        "Computer Manufacturing":                                            "Hardware",
        "Computer Communications Equipment":                                 "Comm Equipment",
        "Telecommunications Equipment":                                      "Telecom Equip.",
        "Radio And Television Broadcasting And Communications Equipment":     "Comm Equipment",
        "Electronic Components":                                             "Electronics",
        "Electrical Products":                                               "Electrical",
        "Military/Government/Technical":                                     "Defense Tech",
        "Industrial Specialties":                                            "Spec. Industrial",
        # Healthcare
        "Biotechnology: Pharmaceutical Preparations":                        "Biotech/Pharma",
        "Biotechnology: Biological Products (No Diagnostic Substances)":     "Biotech",
        "Biotechnology: Laboratory Analytical Instruments":                  "Lab Instruments",
        "Biotechnology: Electromedical & Electrotherapeutic Apparatus":      "Electro Medical",
        "Medical/Dental Instruments":                                        "Med Devices",
        "Medical Specialities":                                              "Medical Spec.",
        "Medical/Nursing Services":                                          "Health Services",
        "Hospital/Nursing Management":                                       "Hospitals",
        # Finance
        "Major Banks":                                                       "Banks",
        "Banks":                                                             "Banks",
        "Savings Institutions":                                              "Savings Banks",
        "Investment Managers":                                               "Asset Mgmt",
        "Investment Bankers/Brokers/Service":                                "Investment Banking",
        "Finance: Consumer Services":                                        "Consumer Finance",
        "Finance Companies":                                                 "Finance",
        "Finance/Investors Services":                                        "Finance Services",
        "Property-Casualty Insurers":                                        "P&C Insurance",
        "Life Insurance":                                                    "Life Insurance",
        "Specialty Insurers":                                                "Specialty Insurance",
        "Trusts Except Educational Religious and Charitable":                "Trusts",
        # Real Estate
        "Real Estate Investment Trusts":                                     "REITs",
        "Real Estate":                                                       "Real Estate",
        # Energy
        "Oil & Gas Production":                                              "Oil & Gas",
        "Integrated oil Companies":                                          "Integrated Oil",
        "Oilfield Services/Equipment":                                       "Oil Services",
        "Oil and Gas Field Machinery":                                       "Oil Machinery",
        "Oil/Gas Transmission":                                              "Gas Pipeline",
        "Coal Mining":                                                       "Coal",
        # Consumer Disc.
        "Restaurants":                                                       "Restaurants",
        "Hotels/Resorts":                                                    "Hotels",
        "Department/Specialty Retail Stores":                                "Retail",
        "Other Specialty Stores":                                            "Specialty Retail",
        "Clothing/Shoe/Accessory Stores":                                    "Apparel Retail",
        "Retail-Auto Dealers and Gas Stations":                              "Auto Dealers",
        "RETAIL: Building Materials":                                        "Home Improvement",
        "Other Consumer Services":                                           "Consumer Svcs",
        "Services-Misc. Amusement & Recreation":                             "Entertainment",
        "Homebuilding":                                                      "Homebuilding",
        "Home Furnishings":                                                  "Home Furnishings",
        "Catalog/Specialty Distribution":                                    "E-Commerce",
        "Auto Parts:O.E.M.":                                                 "Auto Parts",
        "Apparel":                                                           "Apparel",
        # Consumer Staples
        "Packaged Foods":                                                    "Packaged Foods",
        "Food Chains":                                                       "Grocery",
        "Farming/Seeds/Milling":                                             "Food/Farming",
        "Beverages (Production/Distribution)":                               "Beverages",
        "Package Goods/Cosmetics":                                           "Cosmetics",
        # Industrial
        "Industrial Machinery/Components":                                   "Industrial Mach.",
        "Aerospace":                                                         "Aerospace",
        "Construction/Ag Equipment/Trucks":                                  "Heavy Equipment",
        "Metal Fabrications":                                                "Metal Fab.",
        "Containers/Packaging":                                              "Packaging",
        "Trucking Freight/Courier Services":                                 "Trucking",
        "Air Freight/Delivery Services":                                     "Air Freight",
        "Marine Transportation":                                             "Marine",
        "Transportation Services":                                           "Transportation",
        "Engineering & Construction":                                        "Engineering",
        "Professional Services":                                             "Prof. Services",
        "Diversified Commercial Services":                                   "Comm. Services",
        "Staffing":                                                          "Staffing",
        # Communication
        "Broadcasting":                                                      "Broadcasting",
        "Cable & Other Pay Television Services":                             "Cable/Media",
        # Utilities
        "Electric Utilities: Central":                                       "Electric Util.",
        "Natural Gas Distribution":                                          "Natural Gas",
        "Power Generation":                                                  "Power Gen.",
        "Water Supply":                                                      "Water",
        # Materials
        "Major Chemicals":                                                   "Chemicals",
        "Steel/Iron Ore":                                                    "Steel",
        "Metal Mining":                                                      "Mining",
        "Mining & Quarrying of Nonmetallic Minerals (No Fuels)":             "Mining",
    }

    def _clean_industry(raw: str) -> str:
        if not raw:
            return ""
        return _INDUSTRY_SHORT.get(raw.strip(), raw.strip())

    # Nasdaq API 오분류 종목 수동 오버라이드 (sector, industry)
    _TICKER_OVERRIDE: dict[str, tuple[str, str]] = {
        # Technology → Industrial (Nasdaq이 잘못 분류)
        "GE":   ("Industrial",  "Aerospace"),
        "EMR":  ("Industrial",  "Industrial Mach."),
        "OTIS": ("Industrial",  "Industrial Mach."),
        "ROK":  ("Industrial",  "Industrial Mach."),
        "ETN":  ("Industrial",  "Electrical"),
        # Healthcare → Industrial (3M)
        "MMM":  ("Industrial",  "Industrial Mach."),
        # Technology → Utilities (NextEra Energy)
        "NEE":  ("Utilities",   "Electric Util."),
        "AEP":  ("Utilities",   "Electric Util."),
        "DUK":  ("Utilities",   "Electric Util."),
        "SO":   ("Utilities",   "Electric Util."),
        # 업종 정밀 수정 (섹터는 Technology가 맞음)
        "QCOM": ("Technology",  "Semiconductors"),
        "PANW": ("Technology",  "Cybersecurity"),
        "FTNT": ("Technology",  "Cybersecurity"),
        "CRWD": ("Technology",  "Cybersecurity"),
        "ZS":   ("Technology",  "Cybersecurity"),
        "SNYK": ("Technology",  "Cybersecurity"),
    }

    result = []
    for s in rows:
        if s.get("country") != "United States":
            continue

        # 시가총액 파싱
        mc_str = s.get("marketCap") or "0"
        try:
            mc_b = round(float(mc_str) / 1_000_000_000, 2)
        except (ValueError, TypeError):
            mc_b = 0.0
        if mc_b < min_market_cap_b:
            continue

        # 가격 파싱
        price_str = (s.get("lastsale") or "").replace("$", "").replace(",", "")
        try:
            price = round(float(price_str), 2)
        except (ValueError, TypeError):
            price = None
        if not price:
            continue

        # 등락률 파싱
        pct_str = (s.get("pctchange") or "0").replace("%", "")
        try:
            change_pct = round(float(pct_str), 2)
        except (ValueError, TypeError):
            change_pct = 0.0

        change_str = (s.get("netchange") or "0")
        try:
            change = round(float(change_str), 2)
        except (ValueError, TypeError):
            change = 0.0

        # 거래량 파싱
        vol_str = (s.get("volume") or "0").replace(",", "")
        try:
            volume = int(float(vol_str))
        except (ValueError, TypeError):
            volume = 0

        ticker  = (s.get("symbol") or "").strip().replace("^", "")
        name    = (s.get("name") or "").strip()
        sector_raw   = (s.get("sector")   or "")
        industry_raw = (s.get("industry") or "")
        sector   = _NASDAQ_SECTOR.get(sector_raw, sector_raw or "Other")
        industry = _clean_industry(industry_raw) or sector

        # 오분류 종목 오버라이드 적용
        if ticker in _TICKER_OVERRIDE:
            sector, industry = _TICKER_OVERRIDE[ticker]

        country_raw = (s.get("country") or "United States")
        country = "USA" if country_raw == "United States" else country_raw

        result.append({
            "ticker":      ticker,
            "name":        name,
            "name_ko":     NAME_KO.get(ticker, ""),
            "sector":      sector,
            "industry":    industry,
            "country":     country,
            "price":       price,
            "change":      change,
            "change_pct":  change_pct,
            "volume":      volume,
            "market_cap":  mc_b,
            "pe":          None,
            "eps":         None,
            "week52_high": None,
            "week52_low":  None,
        })

    result.sort(key=lambda x: x["market_cap"] or 0, reverse=True)
    result = result[:5000]
    log.info(f"Nasdaq stocks 로드 완료: {len(result)}개 (시총 상위 5000개, ${min_market_cap_b}B 이상 필터)")
    return result


def fetch_extra_fields(tickers: list[str], max_workers: int = 40) -> dict[str, dict]:
    """Yahoo Finance v8 chart API로 52W 고저 수집 (병렬 처리).

    PE/EPS는 Yahoo Finance 인증 정책 변경으로 현재 수집 불가.
    반환: {ticker: {"week52_high", "week52_low"}}
    """
    exc_count = 0

    def _fetch_one(ticker: str) -> tuple[str, dict] | None:
        nonlocal exc_count
        url = (
            f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
            "?interval=1d&range=1d"
        )
        try:
            r = requests.get(url, headers=YF_HEADERS, timeout=8)
            r.raise_for_status()
            meta = r.json()["chart"]["result"][0]["meta"]
            def _to_float(v):
                try:
                    f = float(v)
                    return None if (math.isnan(f) or math.isinf(f)) else f
                except (TypeError, ValueError):
                    return None
            hi = _to_float(meta.get("fiftyTwoWeekHigh"))
            lo = _to_float(meta.get("fiftyTwoWeekLow"))
            if hi or lo:
                return ticker, {
                    "week52_high": round(hi, 2) if hi else None,
                    "week52_low":  round(lo, 2) if lo else None,
                }
        except Exception:
            exc_count += 1
        return None

    result: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {ex.submit(_fetch_one, t): t for t in tickers}
        for fut in as_completed(futures):
            res = fut.result()
            if res:
                result[res[0]] = res[1]

    exc_note = f", 예외 {exc_count}건" if exc_count else ""
    log.info(f"fetch_extra_fields 완료: {len(result)}/{len(tickers)}개 (52W 데이터{exc_note})")
    return result


def fetch_sp500_list() -> list[dict]:
    """
    Wikipedia에서 S&P 500 구성 종목을 파싱해 기본 종목 딕셔너리 목록으로 반환.
    실패 시 빈 리스트 반환 (호출자가 폴백 처리).

    반환 필드: ticker, name, name_ko, sector, price(None), change(0), change_pct(0),
               volume(0), market_cap(None), pe(None), eps(None),
               week52_high(None), week52_low(None)
    """
    WIKI_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    try:
        r = requests.get(WIKI_URL, headers=headers, timeout=15)
        r.raise_for_status()
        parser = _WikiTableParser()
        parser.feed(r.text)

        result = []
        for row in parser.rows:
            if len(row) < 3 or row[0] == "Symbol":
                continue
            ticker  = row[0].replace(".", "-").strip()
            name    = row[1].strip()
            sector_raw = row[2].strip()
            sector  = _SECTOR_MAP.get(sector_raw, sector_raw)
            result.append({
                "ticker":      ticker,
                "name":        name,
                "name_ko":     NAME_KO.get(ticker, ""),
                "sector":      sector,
                "price":       None,
                "change":      0.0,
                "change_pct":  0.0,
                "volume":      0,
                "market_cap":  None,
                "pe":          None,
                "eps":         None,
                "week52_high": None,
                "week52_low":  None,
            })
        log.info(f"Wikipedia S&P500 파싱 완료: {len(result)}개 종목")
        return result
    except Exception as e:
        log.warning(f"fetch_sp500_list 실패: {e}")
        return []


def fetch_nasdaq100_list() -> set[str]:
    """Wikipedia에서 Nasdaq-100 구성 종목 티커 Set 반환. 실패 시 빈 set."""
    url = "https://en.wikipedia.org/wiki/Nasdaq-100"
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    try:
        r = requests.get(url, headers=headers, timeout=15)
        r.raise_for_status()
        parser = _WikiIndexParser()
        parser.feed(r.text)
        for table in parser.tables:
            col = _wiki_find_ticker_col(table)
            if col < 0:
                continue
            tickers = {
                row[col].strip().replace(".", "-")
                for row in table[1:]
                if col < len(row) and row[col].strip() not in ("", "Ticker", "Symbol")
            }
            tickers = {t for t in tickers if 1 <= len(t) <= 6}
            if len(tickers) >= 90:
                log.info(f"Nasdaq-100 Wikipedia 파싱: {len(tickers)}개")
                return tickers
        log.warning("Nasdaq-100 파싱 실패: 적합한 테이블 없음")
        return set()
    except Exception as e:
        log.warning(f"fetch_nasdaq100_list 실패: {e}")
        return set()


def fetch_dow30_list() -> set[str]:
    """Wikipedia에서 Dow Jones 30 구성 종목 티커 Set 반환. 실패 시 빈 set."""
    url = "https://en.wikipedia.org/wiki/Dow_Jones_Industrial_Average"
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    try:
        r = requests.get(url, headers=headers, timeout=15)
        r.raise_for_status()
        parser = _WikiIndexParser()
        parser.feed(r.text)
        for table in parser.tables:
            col = _wiki_find_ticker_col(table, ("symbol", "ticker"))
            if col < 0:
                continue
            tickers = {
                row[col].strip().replace(".", "-")
                for row in table[1:]
                if col < len(row) and row[col].strip() not in ("", "Symbol", "Ticker")
            }
            tickers = {t for t in tickers if 1 <= len(t) <= 5}
            if 25 <= len(tickers) <= 35:
                log.info(f"Dow 30 Wikipedia 파싱: {len(tickers)}개")
                return tickers
        log.warning("Dow 30 파싱 실패: 적합한 테이블 없음")
        return set()
    except Exception as e:
        log.warning(f"fetch_dow30_list 실패: {e}")
        return set()


def fetch_russell2000_iwm() -> set[str]:
    """iShares IWM ETF CSV에서 Russell 2000 구성 종목 파싱. 실패 시 빈 set.

    iShares CSV 구조:
      - 상단 몇 줄: 펀드 메타데이터
      - 'Ticker' 헤더 행 이후: 실제 종목 데이터
    """
    sess = requests.Session()
    sess.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
    })
    # 쿠키 확보
    try:
        sess.get(
            "https://www.ishares.com/us/products/239726/ishares-russell-2000-etf",
            timeout=15,
        )
    except Exception:
        pass

    csv_url = (
        "https://www.ishares.com/us/products/239726/IWM"
        "/1467271812596.ajax?tab=all&fileType=csv"
    )
    try:
        r = sess.get(csv_url, timeout=30)
        r.raise_for_status()
    except Exception as e:
        log.warning(f"fetch_russell2000_iwm 다운로드 실패: {e}")
        return set()

    tickers: set[str] = set()
    ticker_col = -1
    asset_col  = -1

    for line in r.text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        parts = [p.strip().strip('"') for p in stripped.split(",")]

        # 헤더 행 탐색
        if ticker_col == -1:
            lower = [p.lower() for p in parts]
            if "ticker" in lower:
                ticker_col = lower.index("ticker")
                asset_col  = lower.index("asset class") if "asset class" in lower else -1
            continue

        # 데이터 행: Equity만 처리
        if ticker_col >= len(parts):
            continue
        if asset_col >= 0 and asset_col < len(parts):
            if "equity" not in parts[asset_col].lower():
                continue
        t = parts[ticker_col].replace(".", "-").upper()
        if t and 1 <= len(t) <= 5 and re.match(r'^[A-Z][A-Z0-9\-]*$', t):
            tickers.add(t)

    if len(tickers) >= 1500:
        log.info(f"Russell 2000 IWM CSV 파싱: {len(tickers)}개")
        return tickers

    log.warning(f"IWM CSV 결과 부족: {len(tickers)}개 (1500 미만) — 폴백 사용")
    return set()


# ── 국내주식 가격 배치 수집 ────────────────────────────────────────────────────
def _fetch_kr_price_one(stock: dict) -> tuple[dict, bool]:
    ticker = stock["ticker"]
    try:
        url = (
            f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
            f"?interval=1d&range=2d"
        )
        r = requests.get(url, headers=YF_HEADERS, timeout=8)
        r.raise_for_status()
        data  = r.json()
        res   = data["chart"]["result"][0]
        meta  = res["meta"]
        price = meta.get("regularMarketPrice") or meta.get("previousClose", 0) or 0
        prev  = meta.get("chartPreviousClose") or meta.get("previousClose", price) or price
        chg   = (price - prev) if price else 0
        chg_pct = round((chg / prev * 100), 2) if (prev and price) else 0.0
        # KRX 상하한가 ±30% 초과는 stale chartPreviousClose(거래정지 종목 등) 오류로 판단해 무시
        if abs(chg_pct) > 30:
            chg, chg_pct = 0, 0.0
        vol   = meta.get("regularMarketVolume", 0) or 0
        # v8 chart API는 KR 종목의 marketCap을 반환하지 않으므로 base 값 유지
        cap   = meta.get("marketCap", 0) or stock.get("market_cap", 0) or 0
        # 52W High/Low는 v8 meta에서 제공됨
        w52h  = meta.get("fiftyTwoWeekHigh",  0) or stock.get("week52_high", 0) or 0
        w52l  = meta.get("fiftyTwoWeekLow",   0) or stock.get("week52_low",  0) or 0
        # PER은 Naver base에서 유지, EPS는 price/PER로 계산
        per   = stock.get("pe", 0) or 0
        eps   = round(price / per, 0) if per > 0 and price > 0 else (stock.get("eps", 0) or 0)
        row   = dict(stock)
        row.update(price=price, change=round(chg, 0),
                   change_pct=chg_pct, volume=vol, market_cap=cap,
                   week52_high=w52h, week52_low=w52l, pe=per, eps=eps)
        return row, True
    except Exception:
        return dict(stock), False


def fetch_kr_prices(base_stocks: list[dict], max_workers: int = 25) -> list[dict]:
    """kr_stocks.json 기반 종목 목록에 Yahoo Finance 가격을 채워 반환."""
    result = []
    failed  = 0
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = {ex.submit(_fetch_kr_price_one, s): s for s in base_stocks}
        for fut in as_completed(futs):
            row, ok = fut.result()
            result.append(row)
            if not ok:
                failed += 1

    if failed:
        log.warning(f"fetch_kr_prices: {failed}/{len(base_stocks)}개 실패 (기존 base 값 유지)")
    return result


# ── 국내주식 수급 동향 ────────────────────────────────────────────────────────
def fetch_kr_investor(code: str) -> list[dict]:
    """
    네이버 금융 수급 동향: 외국인·기관 최근 5일 순매수(주) 반환.
    URL: https://finance.naver.com/item/frgn.naver?code={code}
    컬럼: 날짜 | 종가 | 전일비 | 등락률 | 거래량 | 외국인순매수 | 기관합계 | 외국인보유
    """
    try:
        url = f"https://finance.naver.com/item/frgn.naver?code={code}"
        resp = requests.get(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": f"https://finance.naver.com/item/main.naver?code={code}",
        }, timeout=8)
        resp.encoding = "euc-kr"
        html = resp.text

        rows = []
        for row_html in re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.DOTALL):
            cells = re.findall(r'<td[^>]*>(.*?)</td>', row_html, re.DOTALL)
            def clean(s):
                s = re.sub(r'<[^>]+>', '', s).strip()
                return s.replace(',', '').replace('+', '').replace('\xa0', '').replace('&nbsp;', '')
            texts = [clean(c) for c in cells]
            texts = [t for t in texts if t]
            if not texts or not re.match(r'\d{4}\.\d{2}\.\d{2}', texts[0]):
                continue
            def to_int(s):
                try:
                    return int(s.replace(',', '').replace('+', '')) if s else 0
                except ValueError:
                    return 0
            if len(texts) >= 7:
                foreign     = to_int(texts[5])
                institution = to_int(texts[6])
                rows.append({
                    "date":        texts[0],
                    "foreign":     foreign,
                    "institution": institution,
                    "individual":  -(foreign + institution),  # 시장 제로섬 근사값
                })
            if len(rows) >= 5:
                break

        return rows
    except Exception as e:
        log.warning(f"KR investor fetch failed ({code}): {e}")
        return []


# ── 국내주식 공시 피드 (KRX KIND) ─────────────────────────────────────────────
def fetch_kr_disclosures(page_size: int = 20) -> list[dict]:
    """
    KRX KIND 오늘 공시 목록 반환.
    POST https://kind.krx.co.kr/disclosure/todaydisclosure.do
    컬럼: 시간 | 회사명 | 공시제목 | 유형
    """
    url = "https://kind.krx.co.kr/disclosure/todaydisclosure.do"
    hdrs = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://kind.krx.co.kr/",
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    body = (
        f"method=searchTodayDisclosureSub&currentPageSize={page_size}"
        "&pageIndex=1&orderMode=0&orderStat=D"
        "&forward=todaydisclosure_sub&chose=S&todayFlag=Y&isuCd="
    )
    try:
        resp = requests.post(url, headers=hdrs, data=body.encode("euc-kr"), timeout=10)
        html = resp.content.decode("euc-kr", errors="replace")

        results = []
        for row_html in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.DOTALL):
            cells = re.findall(r"<td[^>]*>(.*?)</td>", row_html, re.DOTALL)
            def _cl(s):
                return re.sub(r"<[^>]+>", "", s).strip().replace("\xa0", "").replace("&nbsp;", "")
            texts = [_cl(c) for c in cells]
            texts = [t for t in texts if t]
            if not texts or not re.match(r"\d{2}:\d{2}", texts[0]):
                continue
            artcl_m = re.search(r"artclId=(\w+)", row_html)
            artcl_id = artcl_m.group(1) if artcl_m else ""
            link = (
                f"https://kind.krx.co.kr/common/disclsviewer.do?method=search&acptNo={artcl_id}"
                if artcl_id else "https://kind.krx.co.kr/"
            )
            results.append({
                "time":    texts[0] if len(texts) > 0 else "",
                "company": texts[1] if len(texts) > 1 else "",
                "title":   texts[2] if len(texts) > 2 else "",
                "type":    texts[3] if len(texts) > 3 else "",
                "link":    link,
            })
        return results
    except Exception as e:
        log.warning(f"KR disclosures fetch failed: {e}")
        return []


def fetch_fear_greed() -> dict | None:
    """CNN Fear & Greed Index 현재값 반환. 실패 시 None."""
    url = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"
    try:
        r = requests.get(url, headers=YF_HEADERS, timeout=10)
        r.raise_for_status()
        d = r.json().get("fear_and_greed", {})
        score = d.get("score")
        if score is None:
            return None
        return {
            "score":      round(float(score), 1),
            "rating":     d.get("rating", "").title(),
            "prev_close": round(float(d.get("previous_close") or 0), 1),
            "prev_1w":    round(float(d.get("previous_1_week") or 0), 1),
            "prev_1m":    round(float(d.get("previous_1_month") or 0), 1),
            "prev_1y":    round(float(d.get("previous_1_year") or 0), 1),
        }
    except Exception as e:
        log.warning(f"Fear & Greed fetch 실패: {e}")
        return None


# ── 시가총액 수집 (Yahoo Finance HTML 파싱) ───────────────────────────────────

_MC_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
    "Accept-Encoding": "gzip, deflate",
}
_MC_PAT = re.compile(r"Market Cap.*?(\d+\.?\d*[TBM])", re.DOTALL)


def _parse_cap_str(s: str) -> float | None:
    """'4.49T' / '809.16B' / '530M' → 십억달러(B) 단위로 변환"""
    try:
        s = s.strip().replace(",", "")
        if s.endswith("T"): return round(float(s[:-1]) * 1000, 2)
        if s.endswith("B"): return round(float(s[:-1]), 2)
        if s.endswith("M"): return round(float(s[:-1]) / 1000, 4)
    except (ValueError, TypeError):
        pass
    return None


def _fetch_mc_html(ticker: str) -> tuple[str, float | None]:
    """Yahoo Finance 페이지에서 시가총액 파싱"""
    try:
        r = requests.get(
            f"https://finance.yahoo.com/quote/{ticker}/",
            headers=_MC_HEADERS, timeout=12,
        )
        m = _MC_PAT.search(r.text)
        return ticker, _parse_cap_str(m.group(1)) if m else None
    except Exception as e:
        log.debug(f"_fetch_mc_html({ticker}): {e}")
        return ticker, None


def fetch_heatmap_perf(tickers: list[str], period: str = "1w", max_workers: int = 40) -> dict[str, float]:
    """히트맵 기간 수익률 수집. period: '1w'(5거래일) | '1m'(1개월)"""
    range_map = {"1w": "5d", "1m": "1mo"}
    yf_range = range_map.get(period, "5d")

    rate_limited = 0

    def _fetch_one(ticker: str):
        nonlocal rate_limited
        url = (
            f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
            f"?interval=1d&range={yf_range}"
        )
        try:
            r = requests.get(url, headers=YF_HEADERS, timeout=8)
            if r.status_code == 429:
                rate_limited += 1
                return None
            r.raise_for_status()
            res = r.json()["chart"]["result"][0]
            closes = res["indicators"]["quote"][0].get("close", [])
            closes = [c for c in closes if c is not None]
            if len(closes) < 2:
                return None
            perf = round((closes[-1] / closes[0] - 1) * 100, 2)
            return ticker, perf
        except Exception:
            return None

    result: dict[str, float] = {}
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {ex.submit(_fetch_one, t): t for t in tickers}
        for fut in as_completed(futures):
            res = fut.result()
            if res:
                result[res[0]] = res[1]

    rl_note = f", 429 차단 {rate_limited}건" if rate_limited else ""
    log.info(f"fetch_heatmap_perf({period}): {len(result)}/{len(tickers)}개 성공{rl_note}")
    return result


def fetch_all_market_caps(tickers: list[str], max_workers: int = 25) -> dict[str, float]:
    """
    S&P500 전체 시가총액 수집 (Yahoo Finance HTML 병렬 파싱).
    반환: {ticker: market_cap_billion, ...}   실패 종목은 포함하지 않음
    """
    total = len(tickers)
    log.info(f"시가총액 수집 시작: {total}개 / workers={max_workers}")
    t0 = time.time()

    results: dict[str, float] = {}
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        for ticker, cap in pool.map(_fetch_mc_html, tickers):
            if cap is not None:
                results[ticker] = cap

    elapsed = time.time() - t0
    log.info(f"시가총액 수집 완료: {len(results)}/{total}개 성공 / {elapsed:.1f}초")
    return results


# ── 병렬 가격 갱신 ────────────────────────────────────────────────────────────

def refresh_prices_parallel(base: list[dict], max_workers: int = 30) -> list[dict]:
    """
    base 목록의 모든 종목을 ThreadPoolExecutor로 병렬 가격 조회.
    실패한 종목은 기존 base 값을 그대로 유지.
    """
    total = len(base)
    log.info(f"병렬 가격 갱신 시작: {total}개 / workers={max_workers}")
    t0 = time.time()

    # ticker → base_item 인덱스 맵
    ticker_map: dict[str, dict] = {s["ticker"]: dict(s) for s in base}

    def _fetch(ticker: str) -> tuple[str, dict | None]:
        return ticker, fetch_quote(ticker)

    success = 0
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_fetch, t): t for t in ticker_map}
        for future in as_completed(futures):
            ticker, q = future.result()
            if q and q.get("price"):
                ticker_map[ticker].update(q)
                success += 1

    updated = [ticker_map[s["ticker"]] for s in base if s["ticker"] in ticker_map]
    elapsed = time.time() - t0
    log.info(f"병렬 가격 갱신 완료: {success}/{total}개 성공 / {elapsed:.1f}초")
    return updated


def _safe(val, default=None):
    try:
        if val is None:
            return default
        f = float(val)
        return default if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return default


def fetch_quote(ticker: str) -> dict | None:
    """Yahoo Finance v8 API로 단일 종목 현재가 조회"""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=1d"
    try:
        r = requests.get(url, headers=YF_HEADERS, timeout=10)
        r.raise_for_status()
        data = r.json()
        meta = data["chart"]["result"][0]["meta"]

        price = _safe(meta.get("regularMarketPrice")) or _safe(meta.get("previousClose"))
        prev  = (_safe(meta.get("previousClose"))
                 or _safe(meta.get("chartPreviousClose"))
                 or price)
        change = round(price - prev, 4) if price and prev else 0.0
        change_pct = round(change / prev * 100, 4) if prev else 0.0

        return {
            "price":      round(price, 2) if price else None,
            "change":     round(change, 2),
            "change_pct": round(change_pct, 2),
            "volume":     int(meta.get("regularMarketVolume") or 0),
        }
    except Exception as e:
        log.debug(f"fetch_quote({ticker}): {e}")
        return None


def fetch_quote_v7(ticker: str) -> dict | None:
    """Yahoo Finance v7 quoteSummary API로 상세 정보 조회"""
    url = (
        f"https://query1.finance.yahoo.com/v10/finance/quoteSummary/{ticker}"
        "?modules=summaryDetail,defaultKeyStatistics,price"
    )
    try:
        r = requests.get(url, headers=YF_HEADERS, timeout=10)
        r.raise_for_status()
        result = r.json()["quoteSummary"]["result"][0]
        price_m  = result.get("price", {})
        summary  = result.get("summaryDetail", {})
        stats    = result.get("defaultKeyStatistics", {})

        def rv(d, k):
            v = d.get(k, {})
            return v.get("raw") if isinstance(v, dict) else v

        price      = _safe(rv(price_m, "regularMarketPrice"))
        prev       = _safe(rv(price_m, "regularMarketPreviousClose")) or price
        change     = _safe(rv(price_m, "regularMarketChange"), 0.0)
        change_pct = _safe(rv(price_m, "regularMarketChangePercent"), 0.0)
        if change_pct and abs(change_pct) > 1:
            change_pct = round(change_pct, 2)
        else:
            change_pct = round(change_pct * 100, 2) if change_pct else 0.0

        market_cap_b = None
        mc = _safe(rv(price_m, "marketCap"))
        if mc:
            market_cap_b = round(mc / 1_000_000_000, 2)

        return {
            "price":        round(price, 2) if price else None,
            "change":       round(change, 2) if change else 0.0,
            "change_pct":   change_pct,
            "volume":       int(_safe(rv(price_m, "regularMarketVolume"), 0) or 0),
            "market_cap":   market_cap_b,
            "pe":           _safe(rv(summary, "trailingPE")),
            "eps":          _safe(rv(stats, "trailingEps")),
            "week52_high":  _safe(rv(summary, "fiftyTwoWeekHigh")),
            "week52_low":   _safe(rv(summary, "fiftyTwoWeekLow")),
            "name":         price_m.get("longName") or price_m.get("shortName", ""),
            "sector":       result.get("assetProfile", {}).get("sector", ""),
        }
    except Exception as e:
        log.debug(f"fetch_quote_v7({ticker}): {e}")
        return None


# interval → (yf_interval, yf_range) 매핑
# 일봉은 period 파라미터로 별도 조절
_INTERVAL_MAP: dict[str, tuple[str, str]] = {
    "1m":  ("1m",  "1d"),
    "5m":  ("5m",  "5d"),
    "15m": ("15m", "5d"),
    "30m": ("30m", "1mo"),
    "60m": ("60m", "3mo"),
    "1d":  ("1d",  "1y"),   # 일봉 기본값 (period 인수로 덮어씀)
}

# 일봉 period → yf range
_PERIOD_RANGE: dict[str, str] = {
    "1mo": "1mo", "3mo": "3mo", "6mo": "6mo", "1y": "1y", "2y": "2y",
}


def fetch_ohlcv(ticker: str, period: str = "1y", interval: str = "1d") -> list[dict]:
    """
    Yahoo Finance chart API로 OHLCV 데이터 조회.

    interval: '1m'|'5m'|'15m'|'30m'|'60m'|'1d'
    period:   일봉(1d)일 때만 사용: '1mo'|'3mo'|'6mo'|'1y'|'2y'
    반환 time 필드:
      - 일봉: 'YYYY-MM-DD' 문자열 (Lightweight Charts BusinessDay)
      - 분봉/시봉: UTC UNIX 초 정수 (Lightweight Charts UTCTimestamp)
    """
    intraday = interval != "1d"

    if intraday:
        yf_interval, yf_range = _INTERVAL_MAP.get(interval, ("5m", "5d"))
    else:
        yf_interval = "1d"
        yf_range    = _PERIOD_RANGE.get(period, "1y")

    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
        f"?interval={yf_interval}&range={yf_range}"
    )
    try:
        r = requests.get(url, headers=YF_HEADERS, timeout=15)
        r.raise_for_status()
        data    = r.json()
        result  = data["chart"]["result"][0]
        ts_list = result["timestamp"]
        ohlcv   = result["indicators"]["quote"][0]

        rows   = []
        opens  = ohlcv.get("open",   [])
        highs  = ohlcv.get("high",   [])
        lows   = ohlcv.get("low",    [])
        closes = ohlcv.get("close",  [])
        vols   = ohlcv.get("volume", [])

        for i, ts in enumerate(ts_list):
            o = _safe(opens[i]  if i < len(opens)  else None)
            h = _safe(highs[i]  if i < len(highs)  else None)
            l = _safe(lows[i]   if i < len(lows)   else None)
            c = _safe(closes[i] if i < len(closes) else None)
            v = int(vols[i] or 0) if i < len(vols) and vols[i] else 0
            if c is None:
                continue

            # 일봉: 날짜 문자열 / 분봉·시봉: UTC 타임스탬프(초)
            time_val = ts if intraday else datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")

            rows.append({
                "time":     time_val,
                "open":     round(o or c, 2),
                "high":     round(h or c, 2),
                "low":      round(l or c, 2),
                "close":    round(c, 2),
                "volume":   v,
            })
        return rows
    except Exception as e:
        log.warning(f"fetch_ohlcv({ticker}, {interval}, {period}): {e}")
        return []


def fetch_indices() -> list[dict]:
    """지수 10개를 ThreadPoolExecutor로 병렬 조회"""
    symbols_meta = [
        ("^GSPC",   "S&P 500"),
        ("^IXIC",   "NASDAQ"),
        ("^DJI",    "Dow Jones"),
        ("^RUT",    "Russell 2000"),
        ("^VIX",    "VIX"),
        ("CL=F",    "WTI Crude"),
        ("GC=F",    "Gold"),
        ("BTC-USD",  "Bitcoin"),
        ("^TNX",     "10Y Yield"),
        ("DX-Y.NYB", "DXY"),
        ("EURUSD=X", "EUR/USD"),
        ("GBPUSD=X", "GBP/USD"),
        ("JPY=X",    "USD/JPY"),
        ("KRW=X",    "USD/KRW"),
        ("^KS11",    "KOSPI"),
        ("^KQ11",    "KOSDAQ"),
        ("ES=F",     "US500"),
        ("YM=F",     "US30"),
        ("NQ=F",     "US Tech 100"),
    ]

    def _fetch_one(sym_label: tuple) -> tuple:
        sym, label = sym_label
        q = fetch_quote(sym)
        if q and q.get("price"):
            return label, {"name": label, "value": q["price"], "change": q["change"], "change_pct": q["change_pct"]}
        return label, _INDEX_FALLBACK.get(label, {"name": label, "value": 0, "change": 0, "change_pct": 0})

    results: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(_fetch_one, sm): sm for sm in symbols_meta}
        for future in as_completed(futures):
            label, data = future.result()
            results[label] = data

    return [results[label] for _, label in symbols_meta if label in results]


_INDEX_FALLBACK = {
    "S&P 500":      {"name": "S&P 500",      "value": 5248.32,  "change":  18.54,  "change_pct":  0.35},
    "NASDAQ":       {"name": "NASDAQ",        "value": 16428.82, "change": -45.23,  "change_pct": -0.27},
    "Dow Jones":    {"name": "Dow Jones",     "value": 39387.76, "change": 125.08,  "change_pct":  0.32},
    "Russell 2000": {"name": "Russell 2000",  "value": 2082.47,  "change":   8.34,  "change_pct":  0.40},
    "VIX":          {"name": "VIX",           "value":   13.52,  "change":  -0.48,  "change_pct": -3.43},
    "WTI Crude":    {"name": "WTI Crude",     "value":   82.45,  "change":   0.87,  "change_pct":  1.07},
    "Gold":         {"name": "Gold",          "value": 2325.80,  "change": -12.30,  "change_pct": -0.53},
    "Bitcoin":      {"name": "Bitcoin",       "value": 67500.0,  "change": 850.0,   "change_pct":  1.28},
    "10Y Yield":    {"name": "10Y Yield",     "value":     4.42, "change":   0.03,  "change_pct":  0.68},
    "DXY":          {"name": "DXY",           "value":    99.57, "change":  -0.18,  "change_pct": -0.18},
    "EUR/USD":      {"name": "EUR/USD",       "value":    1.082, "change":  -0.001, "change_pct": -0.11},
    "GBP/USD":      {"name": "GBP/USD",       "value":    1.270, "change":   0.001, "change_pct":  0.08},
    "USD/JPY":      {"name": "USD/JPY",       "value":  148.50,  "change":  -0.32,  "change_pct": -0.22},
    "USD/KRW":      {"name": "USD/KRW",       "value": 1350.00,  "change":   2.50,  "change_pct":  0.19},
    "KOSPI":        {"name": "KOSPI",         "value": 2700.00,  "change":  15.00,  "change_pct":  0.56},
    "KOSDAQ":       {"name": "KOSDAQ",        "value":  870.00,  "change":   3.50,  "change_pct":  0.40},
    "US500":        {"name": "US500",         "value": 5230.00,  "change":  18.00,  "change_pct":  0.34},
    "US30":         {"name": "US30",          "value": 38950.00, "change": 120.00,  "change_pct":  0.31},
    "US Tech 100":  {"name": "US Tech 100",   "value": 18350.00, "change": -55.00,  "change_pct": -0.30},
}


_YF_HTML_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}

def fetch_pe_eps_fmp(tickers: list[str], daily_limit: int = 500) -> dict[str, dict]:
    """Yahoo Finance 종목 페이지 HTML 파싱으로 PE(TTM), EPS(TTM) 수집.

    - 일일 한도 없음 (공개 HTML 페이지)
    - data-field="trailingPE"가 두 번 등장: 첫 번째=PE, 두 번째=EPS
    - 반환: {ticker: {"pe": float|None, "eps": float|None}}
    """
    result: dict[str, dict] = {}
    batch = tickers[:daily_limit]

    for ticker in batch:
        try:
            r = requests.get(
                f"https://finance.yahoo.com/quote/{ticker}/",
                headers=_YF_HTML_HEADERS,
                timeout=10,
            )
            if r.status_code != 200:
                log.debug(f"fetch_pe_eps YF {ticker}: HTTP {r.status_code}")
                continue
            vals = re.findall(
                r'data-value="([^"]+)"[^>]*data-field="trailingPE"',
                r.text,
            )
            if not vals:
                continue
            try:
                pe = round(float(vals[0]), 1) if vals[0] not in ("", "N/A") else None
            except (ValueError, TypeError):
                pe = None
            eps = None
            if len(vals) >= 2:
                try:
                    eps = round(float(vals[1]), 2) if vals[1] not in ("", "N/A") else None
                except (ValueError, TypeError):
                    eps = None
            if pe is not None or eps is not None:
                result[ticker] = {"pe": pe, "eps": eps}
        except Exception as e:
            log.debug(f"fetch_pe_eps({ticker}): {e}")
        time.sleep(0.4)

    log.info(f"fetch_pe_eps 완료: {len(result)}/{len(batch)}개")
    return result


def extract_ticker(title: str) -> str | None:
    for cand in re.findall(r'\b[A-Z]{1,5}\b', title):
        if cand in TICKER_SET:
            return cand
    return None


def _to_timestamp(published_parsed) -> int:
    """feedparser published_parsed(UTC struct_time) → Unix 초"""
    if not published_parsed:
        return int(time.time())
    try:
        return int(calendar.timegm(published_parsed))
    except Exception:
        return int(time.time())


def _time_ago(published_parsed) -> str:
    if not published_parsed:
        return "최근"
    try:
        pub = datetime(*published_parsed[:6], tzinfo=timezone.utc)
        diff = int((datetime.now(timezone.utc) - pub).total_seconds())
        if diff < 3600:
            return f"{diff // 60}m ago"
        if diff < 86400:
            return f"{diff // 3600}h ago"
        return f"{diff // 86400}d ago"
    except Exception:
        return "최근"


def fetch_news() -> list[dict]:
    """RSS 피드 파싱 + VADER 감성 분석"""
    seen: set[str] = set()
    results: list[dict] = []

    _HEADERS = {"User-Agent": "StockView/1.0 (finviz-clone; educational project)"}
    _TIMEOUT = 8  # 소스당 최대 8초 대기

    def _fetch_feed(url: str) -> "feedparser.FeedParserDict":
        """requests로 타임아웃 적용 후 feedparser에 전달"""
        resp = requests.get(url, headers=_HEADERS, timeout=_TIMEOUT)
        resp.raise_for_status()
        return feedparser.parse(resp.text)

    for feed_info in RSS_FEEDS:
        try:
            if feed_info.get("reddit"):
                time.sleep(5)  # Reddit IP 단위 연속 요청 429 방지
            feed = _fetch_feed(feed_info["url"])

            for entry in feed.entries[:6]:
                title = entry.get("title", "").strip()
                if not title or title in seen:
                    continue
                seen.add(title)

                score = _vader.polarity_scores(title)["compound"]
                sentiment = (
                    "positive" if score >= 0.05
                    else "negative" if score <= -0.05
                    else "neutral"
                )

                results.append({
                    "id":        len(results) + 1,
                    "title":     title,
                    "source":    feed_info["source"],
                    "time":      _time_ago(entry.get("published_parsed")),
                    "timestamp": _to_timestamp(entry.get("published_parsed")),
                    "ticker":    extract_ticker(title),
                    "sentiment": sentiment,
                    "score":     round(score, 4),
                    "url":       entry.get("link", ""),
                })
        except Exception as e:
            log.warning(f"RSS({feed_info['source']}): {e}")

    return results[:100]


def fetch_alphavantage_news() -> list[dict]:
    """Alpha Vantage News & Sentiment API — 하루 25회 한도로 12시간 캐시 운용"""
    url = (
        "https://www.alphavantage.co/query"
        f"?function=NEWS_SENTIMENT&limit=50&sort=LATEST&apikey={AV_KEY}"
    )
    try:
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        log.warning(f"AlphaVantage 뉴스 요청 실패: {e}")
        return []

    if "feed" not in data:
        log.warning(f"AlphaVantage 응답 이상: {list(data.keys())}")
        return []

    _LABEL_MAP = {
        "Bullish":          "positive",
        "Somewhat-Bullish": "positive",
        "Neutral":          "neutral",
        "Somewhat-Bearish": "negative",
        "Bearish":          "negative",
    }

    results = []
    for item in data["feed"]:
        title = item.get("title", "").strip()
        if not title:
            continue

        # AV가 직접 제공하는 티커 (관련도 가장 높은 것 선택)
        ticker = None
        ts_list = item.get("ticker_sentiment", [])
        if ts_list:
            best = max(ts_list, key=lambda x: float(x.get("relevance_score", 0)))
            raw = best.get("ticker", "")
            if raw and not raw.startswith("FOREX:") and not raw.startswith("CRYPTO:"):
                ticker = raw

        # 감성 레이블 변환
        av_label   = item.get("overall_sentiment_label", "Neutral")
        sentiment  = _LABEL_MAP.get(av_label, "neutral")
        av_score   = float(item.get("overall_sentiment_score", 0))

        # 시간 파싱 ("20240101T120000" → Unix timestamp)
        time_str = item.get("time_published", "")
        try:
            from datetime import datetime, timezone
            dt = datetime.strptime(time_str, "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
            ts = int(dt.timestamp())
        except Exception:
            # 파싱 실패 시 1970년(epoch 0) 대신 현재 시각으로 폴백 — 정렬 순서 왜곡 방지
            log.warning(f"AlphaVantage 시간 파싱 실패 (time_published={time_str!r}), 현재 시각으로 대체")
            ts = int(time.time())

        results.append({
            "id":        0,
            "title":     title,
            "source":    "Alpha Vantage",
            "time":      _time_ago(time.gmtime(ts)),
            "timestamp": ts,
            "ticker":    ticker,
            "sentiment": sentiment,
            "score":     round(av_score, 4),
            "url":       item.get("url", ""),
        })

    log.info(f"AlphaVantage 뉴스 수집 완료: {len(results)}건")
    return results


def _finnhub_item_to_dict(item: dict) -> dict:
    """Finnhub 뉴스 아이템 → 공통 포맷 변환"""
    ts    = int(item.get("datetime", 0))
    title = item.get("headline", "").strip()
    score = _vader.polarity_scores(title)["compound"]
    sentiment = (
        "positive" if score >= 0.05
        else "negative" if score <= -0.05
        else "neutral"
    )
    ticker = item.get("related", "") or None
    if ticker and ("," in ticker or len(ticker) > 6):
        ticker = None  # 복수 종목 또는 이상한 값 제거
    return {
        "id":        0,
        "title":     title,
        "source":    f"Finnhub/{item.get('source', '')}",
        "time":      _time_ago(__import__("time").gmtime(ts)) if ts else "최근",
        "timestamp": ts,
        "ticker":    ticker,
        "sentiment": sentiment,
        "score":     round(score, 4),
        "url":       item.get("url", ""),
    }


def fetch_finnhub_news() -> list[dict]:
    """Finnhub 일반 뉴스 (general category, 최신 50건)"""
    url = f"https://finnhub.io/api/v1/news?category=general&token={FINNHUB_KEY}"
    try:
        resp = requests.get(url, timeout=8)
        resp.raise_for_status()
        items = resp.json()
        results = [_finnhub_item_to_dict(i) for i in items[:50] if i.get("headline")]
        log.info(f"Finnhub 일반 뉴스 수집 완료: {len(results)}건")
        return results
    except Exception as e:
        log.warning(f"Finnhub 일반 뉴스 실패: {e}")
        return []


def fetch_finnhub_company_news(ticker: str) -> list[dict]:
    """Finnhub 종목별 뉴스 (최근 7일)"""
    import datetime
    today = datetime.date.today()
    frm   = (today - datetime.timedelta(days=7)).isoformat()
    to    = today.isoformat()
    url = (
        f"https://finnhub.io/api/v1/company-news"
        f"?symbol={ticker}&from={frm}&to={to}&token={FINNHUB_KEY}"
    )
    try:
        resp = requests.get(url, timeout=8)
        resp.raise_for_status()
        items = resp.json()
        results = [_finnhub_item_to_dict(i) for i in items[:20] if i.get("headline")]
        results.sort(key=lambda x: x["timestamp"], reverse=True)
        log.info(f"Finnhub {ticker} 종목 뉴스: {len(results)}건")
        return results
    except Exception as e:
        log.warning(f"Finnhub 종목 뉴스 실패 ({ticker}): {e}")
        return []


def fetch_reports() -> list[dict]:
    """공시·리포트 RSS 파싱 (Globe Newswire / PR Newswire / Federal Reserve)"""
    seen: set[str] = set()
    results: list[dict] = []

    for feed_info in REPORT_FEEDS:
        try:
            feed = feedparser.parse(feed_info["url"])
            for entry in feed.entries[:12]:
                title = entry.get("title", "").strip()
                if not title or title in seen:
                    continue
                seen.add(title)

                score = _vader.polarity_scores(title)["compound"]
                sentiment = (
                    "positive" if score >= 0.05
                    else "negative" if score <= -0.05
                    else "neutral"
                )

                results.append({
                    "id":          len(results) + 1,
                    "title":       title,
                    "source":      feed_info["source"],
                    "report_type": feed_info["report_type"],
                    "time":        _time_ago(entry.get("published_parsed")),
                    "timestamp":   _to_timestamp(entry.get("published_parsed")),
                    "ticker":      extract_ticker(title),
                    "sentiment":   sentiment,
                    "score":       round(score, 4),
                    "url":         entry.get("link", ""),
                })
        except Exception as e:
            log.warning(f"REPORT RSS({feed_info['source']}): {e}")

    return results[:50]


# ── 매일 매수/매도 신호 추천 (Brief) ───────────────────────────────────────────
# static/js/chart.js의 _calcSignals()와 동일한 로직(MACD+RSI+STO+MA50+주봉추세+
# BB%B+RSI다이버전스+KR전략B)을 서버에서 종목 일괄 계산용으로 포팅.
# 단일 파일 유지 원칙(CLAUDE.md)에 따라 별도 모듈로 분리하지 않음.

def _sig_ema(arr: list, period: int) -> list:
    k = 2 / (period + 1)
    r: list = [None] * len(arr)
    start = next((i for i, v in enumerate(arr) if v is not None), None)
    if start is None or start + period - 1 >= len(arr):
        return r
    r[start + period - 1] = sum(v for v in arr[start:start + period] if v is not None) / period
    for i in range(start + period, len(arr)):
        if arr[i] is None or r[i - 1] is None:
            continue
        r[i] = arr[i] * k + r[i - 1] * (1 - k)
    return r


def _sig_sma(arr: list, period: int) -> list:
    r: list = [None] * len(arr)
    for i in range(period - 1, len(arr)):
        sl = arr[i - period + 1:i + 1]
        if None not in sl:
            r[i] = sum(sl) / period
    return r


def _sig_macd(closes: list[float]):
    e12 = _sig_ema(closes, 12)
    e26 = _sig_ema(closes, 26)
    macd = [a - b if a is not None and b is not None else None for a, b in zip(e12, e26)]
    return macd, _sig_ema(macd, 9)


def _sig_rsi(closes: list[float], period: int = 14) -> list:
    n = len(closes)
    r: list = [None] * n
    if n < period + 1:
        return r
    avg_gain = avg_loss = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        if d > 0: avg_gain += d
        else: avg_loss += abs(d)
    avg_gain /= period
    avg_loss /= period
    r[period] = 100 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    for i in range(period + 1, n):
        d = closes[i] - closes[i - 1]
        gain = d if d > 0 else 0
        loss = abs(d) if d < 0 else 0
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        r[i] = 100 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    return r


def _sig_sto(ohlcv: list[dict], period: int = 14, smooth_d: int = 3):
    n = len(ohlcv)
    raw_k: list = [None] * n
    for i in range(period - 1, n):
        sl = ohlcv[i - period + 1:i + 1]
        hi = max(d["high"] for d in sl)
        lo = min(d["low"] for d in sl)
        raw_k[i] = 50 if hi == lo else (ohlcv[i]["close"] - lo) / (hi - lo) * 100
    return raw_k, _sig_sma(raw_k, smooth_d)


def _sig_bb(closes: list[float], period: int = 20, mult: float = 2.0) -> list:
    mid = _sig_sma(closes, period)
    pb: list = [None] * len(closes)
    for i in range(period - 1, len(closes)):
        sl = closes[i - period + 1:i + 1]
        if mid[i] is None:
            continue
        std = (sum((x - mid[i]) ** 2 for x in sl) / period) ** 0.5
        upper, lower = mid[i] + mult * std, mid[i] - mult * std
        bw = upper - lower
        pb[i] = (closes[i] - lower) / bw if bw > 0 else 0.5
    return pb


def _sig_rsi_divergence(closes: list[float], order: int = 5, min_gap: int = 5, max_gap: int = 60) -> list:
    n = len(closes)
    rsi = _sig_rsi(closes)
    div = [0] * n
    lows, highs = [], []
    for i in range(order, n - order):
        if rsi[i] is None:
            continue
        window = range(i - order, i + order + 1)
        if all(closes[j] >= closes[i] for j in window if j != i): lows.append(i)
        if all(closes[j] <= closes[i] for j in window if j != i): highs.append(i)
    for k in range(1, len(lows)):
        i1, i2 = lows[k - 1], lows[k]
        if not (min_gap <= i2 - i1 <= max_gap): continue
        if rsi[i1] is not None and rsi[i2] is not None and closes[i2] < closes[i1] and rsi[i2] > rsi[i1]:
            div[i2] = 1
    for k in range(1, len(highs)):
        i1, i2 = highs[k - 1], highs[k]
        if not (min_gap <= i2 - i1 <= max_gap): continue
        if rsi[i1] is not None and rsi[i2] is not None and closes[i2] > closes[i1] and rsi[i2] < rsi[i1]:
            div[i2] = -1
    return div


def _sig_resample_weekly(ohlcv: list[dict]) -> list[dict]:
    """일봉(time='YYYY-MM-DD') → 주봉(월요일 기준) 집계. ISO 날짜 문자열은 사전식 정렬이 시간 순서와 같음."""
    by_week: dict[str, dict] = {}
    for bar in ohlcv:
        d = datetime.strptime(bar["time"], "%Y-%m-%d")
        mon_key = (d - timedelta(days=d.weekday())).strftime("%Y-%m-%d")
        if mon_key not in by_week:
            by_week[mon_key] = {"time": mon_key, "high": bar["high"], "low": bar["low"], "close": bar["close"]}
        else:
            w = by_week[mon_key]
            w["high"]  = max(w["high"], bar["high"])
            w["low"]   = min(w["low"],  bar["low"])
            w["close"] = bar["close"]
    return [by_week[k] for k in sorted(by_week.keys())]


def _sig_weekly_trend(ohlcv: list[dict], ma_period: int = 13) -> list:
    weekly = _sig_resample_weekly(ohlcv)
    wc  = [w["close"] for w in weekly]
    wma = _sig_sma(wc, ma_period)
    wt_list = [(w["time"], 0 if wma[i] is None else (1 if wc[i] > wma[i] else -1))
               for i, w in enumerate(weekly)]
    result = [0] * len(ohlcv)
    j = 0
    for i, bar in enumerate(ohlcv):
        while j < len(wt_list) - 1 and wt_list[j + 1][0] <= bar["time"]:
            j += 1
        if j < len(wt_list) and wt_list[j][0] <= bar["time"]:
            result[i] = wt_list[j][1]
    return result


def _sig_candle_patterns(ohlcv: list[dict]) -> list:
    n = len(ohlcv)
    pat = [0] * n
    for i in range(1, n):
        o, h, l, c = ohlcv[i]["open"], ohlcv[i]["high"], ohlcv[i]["low"], ohlcv[i]["close"]
        po, pc = ohlcv[i - 1]["open"], ohlcv[i - 1]["close"]
        body, rng = abs(c - o), h - l
        if rng == 0 or body == 0:
            continue
        upper, lower = h - max(o, c), min(o, c) - l
        if   lower >= 2 * body and upper <= body * 0.3: pat[i] =  1  # Hammer
        elif upper >= 2 * body and lower <= body * 0.3: pat[i] = -1  # Shooting Star
        elif pc < po and c > o and o <= pc and c >= po: pat[i] =  1  # Bullish Engulfing
        elif pc > po and c < o and o >= pc and c <= po: pat[i] = -1  # Bearish Engulfing
    return pat


def _sig_base(ohlcv: list[dict]) -> list:
    """MACD 골든/데드크로스 + RSI 과매수·과매도 + STO 크로스 상태머신 합산 점수."""
    closes = [d["close"] for d in ohlcv]
    n = len(closes)
    sig = [0] * n

    macd, msig = _sig_macd(closes)
    state = 0
    for i in range(1, n):
        if macd[i] is None or msig[i] is None or macd[i-1] is None or msig[i-1] is None:
            pass
        elif macd[i-1] <= msig[i-1] and macd[i] > msig[i]:
            state = 1
        elif macd[i-1] >= msig[i-1] and macd[i] < msig[i]:
            state = -1 if macd[i] < 0 else 0
        sig[i] += state

    rsi = _sig_rsi(closes)
    state = 0
    for i in range(1, n):
        if rsi[i] is None or rsi[i-1] is None:
            pass
        elif rsi[i-1] < 30 and rsi[i] >= 30: state = 1
        elif rsi[i-1] >= 30 and rsi[i] < 30: state = -1
        elif rsi[i-1] > 70 and rsi[i] <= 70: state = -1
        elif rsi[i-1] <= 70 and rsi[i] > 70: state = 1
        sig[i] += state

    k, d = _sig_sto(ohlcv)
    state = 0
    for i in range(1, n):
        if k[i] is None or d[i] is None or k[i-1] is None or d[i-1] is None:
            pass
        else:
            cross_up   = k[i-1] <= d[i-1] and k[i] > d[i]
            cross_down = k[i-1] >= d[i-1] and k[i] < d[i]
            if cross_up and k[i-1] <= 30: state = 1
            if cross_down and k[i-1] >= 70: state = -1
        sig[i] += state

    return sig


def compute_today_signal(ohlcv: list[dict], is_kr: bool) -> int:
    """chart.js _calcSignals()와 동일 로직으로 최신 봉의 최종 신호 점수(-3~+3) 계산.
    데이터 부족(60봉 미만) 시 0 반환."""
    n = len(ohlcv)
    if n < 60:
        return 0
    closes = [d["close"] for d in ohlcv]

    sig = _sig_base(ohlcv)
    div = _sig_rsi_divergence(closes)
    combined = [sig[i] + div[i] for i in range(n)]

    ma50 = _sig_sma(closes, 50)
    for i in range(n):
        if ma50[i] is None: continue
        if closes[i] > ma50[i] and combined[i] < 0: combined[i] = 0
        if closes[i] < ma50[i] and combined[i] > 0: combined[i] = 0

    wtrend = _sig_weekly_trend(ohlcv)
    for i in range(n):
        if wtrend[i] == 1 and combined[i] < 0: combined[i] = 0
        if wtrend[i] == -1 and combined[i] > 0: combined[i] = 0

    pb = _sig_bb(closes)
    sell_thr = 0.85 if is_kr else 0.65
    final = list(combined)
    for i in range(n):
        if pb[i] is None: continue
        if final[i] >= 2 and pb[i] >= 0.35: final[i] = 0
        if final[i] <= -2 and pb[i] <= sell_thr: final[i] = 0

    if is_kr:
        pat = _sig_candle_patterns(ohlcv)
        for i in range(n):
            if final[i] <= -2:
                has_bearish = any(pat[j] < 0 for j in range(max(0, i - 2), i + 1))
                if not has_bearish: final[i] = 0

    return final[-1]


_SIG_TERM = {1: "단기", 2: "중기", 3: "장기"}


def compute_daily_signals(stocks: list[dict], is_kr: bool, max_workers: int = 20) -> list[dict]:
    """종목 리스트 각각 1년치 일봉을 받아 오늘자 신호를 계산, 0이 아닌 것만 반환."""
    def _one(stock: dict) -> dict | None:
        ticker = stock["ticker"]
        try:
            ohlcv = fetch_ohlcv(ticker, period="1y", interval="1d")
            score = compute_today_signal(ohlcv, is_kr)
            if not score:
                return None
            return {
                "ticker":     ticker,
                "name":       stock.get("name_ko") or stock.get("name") or ticker,
                "sector":     stock.get("sector"),
                "price":      stock.get("price"),
                "change_pct": stock.get("change_pct"),
                "market_cap": stock.get("market_cap") or 0,
                "score":      score,
                "term":       _SIG_TERM.get(abs(score), "단기"),
            }
        except Exception:
            return None

    result: list[dict] = []
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = [ex.submit(_one, s) for s in stocks]
        for fut in as_completed(futures):
            r = fut.result()
            if r:
                result.append(r)

    log.info(f"compute_daily_signals({'KR' if is_kr else 'US'}): {len(result)}/{len(stocks)}개 신호 발생")
    return result


def build_daily_recommendations(us_stocks: list[dict], kr_stocks: list[dict], top_n: int = 500) -> dict:
    """US/KR 각각 시총 상위 top_n 종목 대상 신호 계산 후 점수 내림차순 정렬(매도는 낮은 점수 우선)."""
    def _rank(stocks: list[dict], is_kr: bool) -> dict:
        pool = sorted(stocks, key=lambda s: s.get("market_cap") or 0, reverse=True)[:top_n]
        signals = compute_daily_signals(pool, is_kr)
        buy  = sorted((s for s in signals if s["score"] > 0),
                      key=lambda s: (-s["score"], -(s.get("market_cap") or 0)))
        sell = sorted((s for s in signals if s["score"] < 0),
                      key=lambda s: (s["score"], -(s.get("market_cap") or 0)))
        return {"buy": buy, "sell": sell}

    return {
        "us": _rank(us_stocks, False),
        "kr": _rank(kr_stocks, True),
        "generated_at": int(time.time()),
    }


# ── 어닝스 캘린더 ──────────────────────────────────────────────────────────────
_NASDAQ_HDR = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json, text/plain, */*",
}

def _parse_usd(s: str) -> float | None:
    try:
        return float(s.replace("$", "").replace(",", ""))
    except Exception:
        return None

def fetch_earnings_calendar(date_str: str) -> list[dict]:
    """Nasdaq 어닝스 캘린더 API — 특정 날짜 실적 발표 목록.
    date_str: 'YYYY-MM-DD'
    """
    url = f"https://api.nasdaq.com/api/calendar/earnings?date={date_str}"
    try:
        r = requests.get(url, headers=_NASDAQ_HDR, timeout=10)
        if r.status_code != 200:
            log.warning(f"earnings calendar {date_str}: HTTP {r.status_code}")
            return []
        rows = r.json().get("data", {}).get("rows") or []
        result = []
        for row in rows:
            sym = (row.get("symbol") or "").strip()
            if not sym:
                continue
            t = (row.get("time") or "").lower()
            time_label = (
                "Before Open" if "before" in t
                else "After Close" if "after" in t
                else "—"
            )
            result.append({
                "symbol":         sym,
                "name":           row.get("name", ""),
                "date":           date_str,
                "time":           time_label,
                "eps_forecast":   row.get("epsForecast") or "—",
                "last_year_eps":  row.get("lastYearEPS") or "—",
                "market_cap":     round(_parse_usd(row.get("marketCap", "")) / 1e9, 3) if _parse_usd(row.get("marketCap", "")) else None,
                "fiscal_quarter": row.get("fiscalQuarterEnding", ""),
            })
        result.sort(key=lambda x: x.get("market_cap") or 0, reverse=True)
        log.info(f"earnings {date_str}: {len(result)}개")
        return result
    except Exception as e:
        log.warning(f"fetch_earnings_calendar({date_str}): {e}")
        return []


# ── 경제 지표 캘린더 ──────────────────────────────────────────────────────────
# 2026년 주요 미국 경제 지표 발표 일정 (BLS/Fed 공식 일정 기준)
_ECO_EVENTS: list[tuple] = [
    # (날짜, 이벤트명, 중요도, 카테고리)
    # ── FOMC 금리 결정 ──────────────────────────────────────────────────
    ("2026-01-29", "FOMC Rate Decision",          "high",   "Fed Policy"),
    ("2026-03-18", "FOMC Rate Decision",          "high",   "Fed Policy"),
    ("2026-05-06", "FOMC Rate Decision",          "high",   "Fed Policy"),
    ("2026-06-17", "FOMC Rate Decision",          "high",   "Fed Policy"),
    ("2026-07-29", "FOMC Rate Decision",          "high",   "Fed Policy"),
    ("2026-09-16", "FOMC Rate Decision",          "high",   "Fed Policy"),
    ("2026-11-04", "FOMC Rate Decision",          "high",   "Fed Policy"),
    ("2026-12-16", "FOMC Rate Decision",          "high",   "Fed Policy"),
    # ── CPI ──────────────────────────────────────────────────────────────
    ("2026-01-15", "CPI (Dec 2025)",              "high",   "Inflation"),
    ("2026-02-12", "CPI (Jan 2026)",              "high",   "Inflation"),
    ("2026-03-12", "CPI (Feb 2026)",              "high",   "Inflation"),
    ("2026-04-10", "CPI (Mar 2026)",              "high",   "Inflation"),
    ("2026-05-14", "CPI (Apr 2026)",              "high",   "Inflation"),
    ("2026-06-11", "CPI (May 2026)",              "high",   "Inflation"),
    ("2026-07-15", "CPI (Jun 2026)",              "high",   "Inflation"),
    ("2026-08-12", "CPI (Jul 2026)",              "high",   "Inflation"),
    ("2026-09-10", "CPI (Aug 2026)",              "high",   "Inflation"),
    ("2026-10-14", "CPI (Sep 2026)",              "high",   "Inflation"),
    ("2026-11-12", "CPI (Oct 2026)",              "high",   "Inflation"),
    ("2026-12-10", "CPI (Nov 2026)",              "high",   "Inflation"),
    # ── Non-Farm Payrolls ─────────────────────────────────────────────────
    ("2026-01-09", "Non-Farm Payrolls (Dec 2025)","high",   "Employment"),
    ("2026-02-06", "Non-Farm Payrolls (Jan 2026)","high",   "Employment"),
    ("2026-03-06", "Non-Farm Payrolls (Feb 2026)","high",   "Employment"),
    ("2026-04-03", "Non-Farm Payrolls (Mar 2026)","high",   "Employment"),
    ("2026-05-08", "Non-Farm Payrolls (Apr 2026)","high",   "Employment"),
    ("2026-06-05", "Non-Farm Payrolls (May 2026)","high",   "Employment"),
    ("2026-07-02", "Non-Farm Payrolls (Jun 2026)","high",   "Employment"),
    ("2026-08-07", "Non-Farm Payrolls (Jul 2026)","high",   "Employment"),
    ("2026-09-04", "Non-Farm Payrolls (Aug 2026)","high",   "Employment"),
    ("2026-10-02", "Non-Farm Payrolls (Sep 2026)","high",   "Employment"),
    ("2026-11-06", "Non-Farm Payrolls (Oct 2026)","high",   "Employment"),
    ("2026-12-04", "Non-Farm Payrolls (Nov 2026)","high",   "Employment"),
    # ── PCE (Fed 선호 물가지표) ───────────────────────────────────────────
    ("2026-01-30", "PCE Price Index (Dec 2025)",  "high",   "Inflation"),
    ("2026-02-27", "PCE Price Index (Jan 2026)",  "high",   "Inflation"),
    ("2026-03-27", "PCE Price Index (Feb 2026)",  "high",   "Inflation"),
    ("2026-04-30", "PCE Price Index (Mar 2026)",  "high",   "Inflation"),
    ("2026-05-29", "PCE Price Index (Apr 2026)",  "high",   "Inflation"),
    ("2026-06-26", "PCE Price Index (May 2026)",  "high",   "Inflation"),
    ("2026-07-31", "PCE Price Index (Jun 2026)",  "high",   "Inflation"),
    ("2026-08-28", "PCE Price Index (Jul 2026)",  "high",   "Inflation"),
    ("2026-09-25", "PCE Price Index (Aug 2026)",  "high",   "Inflation"),
    ("2026-10-30", "PCE Price Index (Sep 2026)",  "high",   "Inflation"),
    ("2026-11-25", "PCE Price Index (Oct 2026)",  "high",   "Inflation"),
    ("2026-12-23", "PCE Price Index (Nov 2026)",  "high",   "Inflation"),
    # ── GDP ───────────────────────────────────────────────────────────────
    ("2026-01-29", "GDP Q4 2025 (Advance)",       "high",   "GDP"),
    ("2026-04-29", "GDP Q1 2026 (Advance)",       "high",   "GDP"),
    ("2026-07-29", "GDP Q2 2026 (Advance)",       "high",   "GDP"),
    ("2026-10-29", "GDP Q3 2026 (Advance)",       "high",   "GDP"),
    # ── PPI ───────────────────────────────────────────────────────────────
    ("2026-01-16", "PPI (Dec 2025)",              "medium", "Inflation"),
    ("2026-02-13", "PPI (Jan 2026)",              "medium", "Inflation"),
    ("2026-03-13", "PPI (Feb 2026)",              "medium", "Inflation"),
    ("2026-04-11", "PPI (Mar 2026)",              "medium", "Inflation"),
    ("2026-05-15", "PPI (Apr 2026)",              "medium", "Inflation"),
    ("2026-06-12", "PPI (May 2026)",              "medium", "Inflation"),
    ("2026-07-16", "PPI (Jun 2026)",              "medium", "Inflation"),
    ("2026-08-13", "PPI (Jul 2026)",              "medium", "Inflation"),
    ("2026-09-11", "PPI (Aug 2026)",              "medium", "Inflation"),
    ("2026-10-15", "PPI (Sep 2026)",              "medium", "Inflation"),
    ("2026-11-13", "PPI (Oct 2026)",              "medium", "Inflation"),
    ("2026-12-11", "PPI (Nov 2026)",              "medium", "Inflation"),
    # ── Retail Sales ──────────────────────────────────────────────────────
    ("2026-01-16", "Retail Sales (Dec 2025)",     "medium", "Consumer"),
    ("2026-02-13", "Retail Sales (Jan 2026)",     "medium", "Consumer"),
    ("2026-03-17", "Retail Sales (Feb 2026)",     "medium", "Consumer"),
    ("2026-04-15", "Retail Sales (Mar 2026)",     "medium", "Consumer"),
    ("2026-05-15", "Retail Sales (Apr 2026)",     "medium", "Consumer"),
    ("2026-06-17", "Retail Sales (May 2026)",     "medium", "Consumer"),
    ("2026-07-17", "Retail Sales (Jun 2026)",     "medium", "Consumer"),
    ("2026-08-14", "Retail Sales (Jul 2026)",     "medium", "Consumer"),
    ("2026-09-16", "Retail Sales (Aug 2026)",     "medium", "Consumer"),
    ("2026-10-14", "Retail Sales (Sep 2026)",     "medium", "Consumer"),
    ("2026-11-13", "Retail Sales (Oct 2026)",     "medium", "Consumer"),
    ("2026-12-12", "Retail Sales (Nov 2026)",     "medium", "Consumer"),
    # ── ISM Manufacturing ─────────────────────────────────────────────────
    ("2026-02-02", "ISM Manufacturing PMI (Jan)", "medium", "Manufacturing"),
    ("2026-03-02", "ISM Manufacturing PMI (Feb)", "medium", "Manufacturing"),
    ("2026-04-01", "ISM Manufacturing PMI (Mar)", "medium", "Manufacturing"),
    ("2026-05-01", "ISM Manufacturing PMI (Apr)", "medium", "Manufacturing"),
    ("2026-06-01", "ISM Manufacturing PMI (May)", "medium", "Manufacturing"),
    ("2026-07-01", "ISM Manufacturing PMI (Jun)", "medium", "Manufacturing"),
    ("2026-08-03", "ISM Manufacturing PMI (Jul)", "medium", "Manufacturing"),
    ("2026-09-01", "ISM Manufacturing PMI (Aug)", "medium", "Manufacturing"),
    ("2026-10-01", "ISM Manufacturing PMI (Sep)", "medium", "Manufacturing"),
    ("2026-11-02", "ISM Manufacturing PMI (Oct)", "medium", "Manufacturing"),
    ("2026-12-01", "ISM Manufacturing PMI (Nov)", "medium", "Manufacturing"),
    # ── Consumer Confidence ───────────────────────────────────────────────
    ("2026-01-27", "Consumer Confidence (Jan)",   "medium", "Consumer"),
    ("2026-02-24", "Consumer Confidence (Feb)",   "medium", "Consumer"),
    ("2026-03-31", "Consumer Confidence (Mar)",   "medium", "Consumer"),
    ("2026-04-28", "Consumer Confidence (Apr)",   "medium", "Consumer"),
    ("2026-05-26", "Consumer Confidence (May)",   "medium", "Consumer"),
    ("2026-06-30", "Consumer Confidence (Jun)",   "medium", "Consumer"),
    ("2026-07-28", "Consumer Confidence (Jul)",   "medium", "Consumer"),
    ("2026-08-25", "Consumer Confidence (Aug)",   "medium", "Consumer"),
    ("2026-09-29", "Consumer Confidence (Sep)",   "medium", "Consumer"),
    ("2026-10-27", "Consumer Confidence (Oct)",   "medium", "Consumer"),
    ("2026-11-24", "Consumer Confidence (Nov)",   "medium", "Consumer"),
    ("2026-12-22", "Consumer Confidence (Dec)",   "medium", "Consumer"),
]


def fetch_economic_calendar(days_ahead: int = 21) -> list[dict]:
    """향후 days_ahead일 이내의 주요 경제 지표 발표 일정 반환."""
    from datetime import date, timedelta
    today = date.today()
    cutoff = today + timedelta(days=days_ahead)
    today_str = today.isoformat()

    result = []
    for date_str, event, importance, category in _ECO_EVENTS:
        if date_str < today_str:
            continue
        event_date = date.fromisoformat(date_str)
        if event_date > cutoff:
            continue
        delta = (event_date - today).days
        result.append({
            "date":       date_str,
            "event":      event,
            "importance": importance,
            "category":   category,
            "is_today":   delta == 0,
            "is_tomorrow": delta == 1,
            "days_until": delta,
        })

    result.sort(key=lambda x: x["date"])
    return result
