import json
import logging
import os
import threading
import queue
from flask import Flask, render_template, jsonify, request
from flask_socketio import SocketIO
from apscheduler.schedulers.background import BackgroundScheduler

from cache import Cache
import data_fetcher as df

PE_EPS_FILE = os.path.join(os.path.dirname(__file__), "pe_eps_cache.json")

def _load_pe_eps() -> dict:
    try:
        if os.path.exists(PE_EPS_FILE):
            with open(PE_EPS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {}

def _save_pe_eps(data: dict):
    try:
        with open(PE_EPS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except Exception as e:
        log.warning(f"PE/EPS 파일 저장 실패: {e}")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

app      = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading", logger=False, engineio_logger=False)
cache    = Cache()

# APScheduler 스레드에서 직접 emit하면 WebSocket 전송이 불안정하므로
# 전용 큐 + start_background_task 워커를 통해 emit한다
_emit_queue: queue.Queue = queue.Queue()

def _emit_worker():
    while True:
        event, data = _emit_queue.get()
        try:
            socketio.emit(event, data)
        except Exception as e:
            log.debug(f"emit 오류 ({event}): {e}")

# ── 미국 주식 더미 데이터 (59개 종목) ─────────────────────────────────────────
STOCKS = [
    # Technology (14)
    {"ticker":"AAPL",  "name":"Apple Inc.",               "name_ko":"애플",             "sector":"Technology",       "price": 175.50, "change":  1.25, "change_pct":  0.72, "volume": 52000000, "market_cap":2750, "pe": 28.5, "eps":  6.16, "week52_high":198.23, "week52_low":124.17},
    {"ticker":"MSFT",  "name":"Microsoft Corp.",           "name_ko":"마이크로소프트",   "sector":"Technology",       "price": 415.20, "change": -2.30, "change_pct": -0.55, "volume": 18000000, "market_cap":3080, "pe": 35.2, "eps": 11.80, "week52_high":430.82, "week52_low":309.45},
    {"ticker":"NVDA",  "name":"NVIDIA Corp.",              "name_ko":"엔비디아",         "sector":"Technology",       "price": 875.40, "change": 28.50, "change_pct":  3.37, "volume": 35000000, "market_cap":2160, "pe": 68.3, "eps": 12.81, "week52_high":974.00, "week52_low":373.18},
    {"ticker":"GOOGL", "name":"Alphabet Inc.",             "name_ko":"알파벳",           "sector":"Technology",       "price": 168.90, "change":  0.75, "change_pct":  0.45, "volume": 22000000, "market_cap":2090, "pe": 25.8, "eps":  6.55, "week52_high":193.31, "week52_low":120.21},
    {"ticker":"META",  "name":"Meta Platforms",            "name_ko":"메타",             "sector":"Technology",       "price": 515.30, "change": -8.20, "change_pct": -1.57, "volume": 14000000, "market_cap":1310, "pe": 26.4, "eps": 19.52, "week52_high":531.49, "week52_low":279.40},
    {"ticker":"TSLA",  "name":"Tesla Inc.",                "name_ko":"테슬라",           "sector":"Technology",       "price": 182.60, "change":  5.30, "change_pct":  2.99, "volume": 98000000, "market_cap": 580, "pe": 42.1, "eps":  4.34, "week52_high":299.29, "week52_low":138.80},
    {"ticker":"AMD",   "name":"Advanced Micro Devices",    "name_ko":"AMD",              "sector":"Technology",       "price": 162.30, "change":  4.10, "change_pct":  2.59, "volume": 45000000, "market_cap": 262, "pe":312.0, "eps":  0.52, "week52_high":227.30, "week52_low": 93.12},
    {"ticker":"INTC",  "name":"Intel Corp.",               "name_ko":"인텔",             "sector":"Technology",       "price":  35.20, "change": -0.80, "change_pct": -2.22, "volume": 55000000, "market_cap": 148, "pe":  8.5, "eps":  4.14, "week52_high": 51.28, "week52_low": 18.51},
    {"ticker":"AVGO",  "name":"Broadcom Inc.",             "name_ko":"브로드컴",         "sector":"Technology",       "price":1580.00, "change": 22.50, "change_pct":  1.44, "volume":  3500000, "market_cap": 736, "pe": 52.4, "eps": 30.15, "week52_high":1977.44,"week52_low":746.22},
    {"ticker":"ORCL",  "name":"Oracle Corp.",              "name_ko":"오라클",           "sector":"Technology",       "price": 128.50, "change":  1.20, "change_pct":  0.94, "volume":  8000000, "market_cap": 350, "pe": 33.2, "eps":  3.87, "week52_high":164.71, "week52_low": 99.26},
    {"ticker":"CRM",   "name":"Salesforce Inc.",           "name_ko":"세일즈포스",       "sector":"Technology",       "price": 265.40, "change":  3.80, "change_pct":  1.45, "volume":  5500000, "market_cap": 258, "pe": 45.8, "eps":  5.79, "week52_high":318.71, "week52_low":195.58},
    {"ticker":"ADBE",  "name":"Adobe Inc.",                "name_ko":"어도비",           "sector":"Technology",       "price": 520.30, "change": -6.40, "change_pct": -1.22, "volume":  3200000, "market_cap": 238, "pe": 46.2, "eps": 11.26, "week52_high":638.25, "week52_low":433.95},
    {"ticker":"QCOM",  "name":"Qualcomm Inc.",             "name_ko":"퀄컴",             "sector":"Technology",       "price": 168.40, "change":  2.30, "change_pct":  1.38, "volume": 10000000, "market_cap": 188, "pe": 23.5, "eps":  7.17, "week52_high":230.63, "week52_low":106.94},
    {"ticker":"MU",    "name":"Micron Technology",         "name_ko":"마이크론",         "sector":"Technology",       "price": 130.20, "change":  4.50, "change_pct":  3.58, "volume": 20000000, "market_cap": 144, "pe": 36.8, "eps":  3.54, "week52_high":157.54, "week52_low": 53.40},
    # Finance (10)
    {"ticker":"JPM",   "name":"JPMorgan Chase",            "name_ko":"JP모건",           "sector":"Finance",          "price": 198.40, "change":  2.10, "change_pct":  1.07, "volume": 12000000, "market_cap": 572, "pe": 11.8, "eps": 16.82, "week52_high":220.82, "week52_low":135.19},
    {"ticker":"BAC",   "name":"Bank of America",           "name_ko":"뱅크오브아메리카", "sector":"Finance",          "price":  38.50, "change":  0.45, "change_pct":  1.18, "volume": 42000000, "market_cap": 295, "pe": 12.5, "eps":  3.08, "week52_high": 44.44, "week52_low": 24.96},
    {"ticker":"GS",    "name":"Goldman Sachs",             "name_ko":"골드만삭스",       "sector":"Finance",          "price": 485.20, "change": -3.80, "change_pct": -0.78, "volume":  2800000, "market_cap": 164, "pe": 16.2, "eps": 29.95, "week52_high":532.88, "week52_low":288.56},
    {"ticker":"MS",    "name":"Morgan Stanley",            "name_ko":"모건스탠리",       "sector":"Finance",          "price": 102.30, "change":  1.20, "change_pct":  1.19, "volume": 11000000, "market_cap": 168, "pe": 18.4, "eps":  5.56, "week52_high":116.38, "week52_low": 69.54},
    {"ticker":"V",     "name":"Visa Inc.",                 "name_ko":"비자",             "sector":"Finance",          "price": 282.50, "change":  1.85, "change_pct":  0.66, "volume":  6800000, "market_cap": 580, "pe": 31.5, "eps":  8.97, "week52_high":290.96, "week52_low":213.83},
    {"ticker":"MA",    "name":"Mastercard Inc.",           "name_ko":"마스터카드",       "sector":"Finance",          "price": 482.30, "change":  3.20, "change_pct":  0.67, "volume":  3200000, "market_cap": 454, "pe": 36.8, "eps": 13.10, "week52_high":496.30, "week52_low":344.67},
    {"ticker":"WFC",   "name":"Wells Fargo",               "name_ko":"웰스파고",         "sector":"Finance",          "price":  58.30, "change":  0.90, "change_pct":  1.57, "volume": 22000000, "market_cap": 208, "pe": 12.1, "eps":  4.82, "week52_high": 67.18, "week52_low": 38.38},
    {"ticker":"BLK",   "name":"BlackRock Inc.",            "name_ko":"블랙록",           "sector":"Finance",          "price": 798.40, "change":  8.20, "change_pct":  1.04, "volume":  1100000, "market_cap": 119, "pe": 21.8, "eps": 36.62, "week52_high":845.69, "week52_low":632.35},
    {"ticker":"C",     "name":"Citigroup Inc.",            "name_ko":"씨티그룹",         "sector":"Finance",          "price":  62.40, "change": -0.60, "change_pct": -0.95, "volume": 18000000, "market_cap": 119, "pe":  9.8, "eps":  6.37, "week52_high": 73.87, "week52_low": 38.18},
    {"ticker":"AXP",   "name":"American Express",          "name_ko":"아메리칸익스프레스","sector":"Finance",         "price": 232.80, "change":  2.50, "change_pct":  1.09, "volume":  3500000, "market_cap": 168, "pe": 19.5, "eps": 11.94, "week52_high":242.51, "week52_low":142.06},
    # Healthcare (8)
    {"ticker":"JNJ",   "name":"Johnson & Johnson",         "name_ko":"존슨앤드존슨",     "sector":"Healthcare",       "price": 147.80, "change": -1.20, "change_pct": -0.81, "volume":  9500000, "market_cap": 356, "pe": 24.3, "eps":  6.08, "week52_high":175.97, "week52_low":143.13},
    {"ticker":"UNH",   "name":"UnitedHealth Group",        "name_ko":"유나이티드헬스",   "sector":"Healthcare",       "price": 492.50, "change":  5.80, "change_pct":  1.19, "volume":  3100000, "market_cap": 453, "pe": 21.5, "eps": 22.91, "week52_high":558.47, "week52_low":419.45},
    {"ticker":"PFE",   "name":"Pfizer Inc.",               "name_ko":"화이자",           "sector":"Healthcare",       "price":  28.30, "change": -0.40, "change_pct": -1.39, "volume": 35000000, "market_cap": 160, "pe": 45.6, "eps":  0.62, "week52_high": 43.01, "week52_low": 25.20},
    {"ticker":"ABBV",  "name":"AbbVie Inc.",               "name_ko":"애브비",           "sector":"Healthcare",       "price": 172.40, "change":  1.90, "change_pct":  1.11, "volume":  7200000, "market_cap": 304, "pe": 52.3, "eps":  3.30, "week52_high":182.04, "week52_low":120.57},
    {"ticker":"LLY",   "name":"Eli Lilly and Co.",         "name_ko":"일라이릴리",       "sector":"Healthcare",       "price": 820.50, "change": 15.30, "change_pct":  1.90, "volume":  3800000, "market_cap": 780, "pe":112.4, "eps":  7.30, "week52_high":862.64, "week52_low":423.82},
    {"ticker":"MRK",   "name":"Merck & Co.",               "name_ko":"머크",             "sector":"Healthcare",       "price": 128.60, "change":  0.80, "change_pct":  0.63, "volume":  8900000, "market_cap": 326, "pe": 19.2, "eps":  6.70, "week52_high":134.63, "week52_low": 97.02},
    {"ticker":"TMO",   "name":"Thermo Fisher Scientific",  "name_ko":"써모피셔",         "sector":"Healthcare",       "price": 565.30, "change": -4.20, "change_pct": -0.74, "volume":  1800000, "market_cap": 218, "pe": 31.5, "eps": 17.95, "week52_high":609.86, "week52_low":440.32},
    {"ticker":"ABT",   "name":"Abbott Laboratories",       "name_ko":"애보트",           "sector":"Healthcare",       "price": 108.40, "change":  1.10, "change_pct":  1.02, "volume":  5500000, "market_cap": 188, "pe": 31.8, "eps":  3.41, "week52_high":118.36, "week52_low": 88.47},
    # Energy (4)
    {"ticker":"XOM",   "name":"Exxon Mobil Corp.",         "name_ko":"엑슨모빌",         "sector":"Energy",           "price": 112.30, "change": -0.90, "change_pct": -0.80, "volume": 18000000, "market_cap": 453, "pe": 13.8, "eps":  8.14, "week52_high":123.75, "week52_low": 95.77},
    {"ticker":"CVX",   "name":"Chevron Corp.",             "name_ko":"셰브론",           "sector":"Energy",           "price": 155.20, "change":  1.40, "change_pct":  0.91, "volume": 11000000, "market_cap": 296, "pe": 15.2, "eps": 10.21, "week52_high":172.72, "week52_low":135.86},
    {"ticker":"COP",   "name":"ConocoPhillips",            "name_ko":"코노코필립스",     "sector":"Energy",           "price": 118.50, "change":  2.10, "change_pct":  1.80, "volume":  7500000, "market_cap": 147, "pe": 14.5, "eps":  8.17, "week52_high":135.94, "week52_low": 95.43},
    {"ticker":"SLB",   "name":"SLB (Schlumberger)",        "name_ko":"슐룸베르거",       "sector":"Energy",           "price":  48.20, "change": -0.50, "change_pct": -1.03, "volume": 14000000, "market_cap":  68, "pe": 15.8, "eps":  3.05, "week52_high": 59.32, "week52_low": 42.18},
    # Consumer Disc. (6)
    {"ticker":"AMZN",  "name":"Amazon.com Inc.",           "name_ko":"아마존",           "sector":"Consumer Disc.",   "price": 192.50, "change":  3.20, "change_pct":  1.69, "volume": 28000000, "market_cap":2020, "pe": 58.2, "eps":  3.31, "week52_high":201.20, "week52_low":101.26},
    {"ticker":"HD",    "name":"Home Depot Inc.",           "name_ko":"홈디포",           "sector":"Consumer Disc.",   "price": 342.80, "change": -4.20, "change_pct": -1.21, "volume":  4200000, "market_cap": 340, "pe": 22.5, "eps": 15.23, "week52_high":396.52, "week52_low":274.97},
    {"ticker":"COST",  "name":"Costco Wholesale",          "name_ko":"코스트코",         "sector":"Consumer Disc.",   "price": 858.30, "change":  8.50, "change_pct":  1.00, "volume":  2200000, "market_cap": 380, "pe": 52.8, "eps": 16.26, "week52_high":923.83, "week52_low":680.82},
    {"ticker":"NKE",   "name":"Nike Inc.",                 "name_ko":"나이키",           "sector":"Consumer Disc.",   "price":  95.40, "change": -1.80, "change_pct": -1.85, "volume": 10000000, "market_cap": 144, "pe": 27.4, "eps":  3.48, "week52_high":123.21, "week52_low": 70.75},
    {"ticker":"MCD",   "name":"McDonald's Corp.",          "name_ko":"맥도날드",         "sector":"Consumer Disc.",   "price": 285.60, "change":  1.20, "change_pct":  0.42, "volume":  4800000, "market_cap": 204, "pe": 24.8, "eps": 11.51, "week52_high":317.97, "week52_low":245.73},
    {"ticker":"SBUX",  "name":"Starbucks Corp.",           "name_ko":"스타벅스",         "sector":"Consumer Disc.",   "price":  78.30, "change": -2.10, "change_pct": -2.61, "volume":  9500000, "market_cap":  88, "pe": 23.5, "eps":  3.33, "week52_high":115.48, "week52_low": 71.61},
    # Consumer Staples (4)
    {"ticker":"WMT",   "name":"Walmart Inc.",              "name_ko":"월마트",           "sector":"Consumer Staples", "price":  68.40, "change":  0.55, "change_pct":  0.81, "volume": 15000000, "market_cap": 548, "pe": 36.1, "eps":  1.89, "week52_high": 74.46, "week52_low": 47.19},
    {"ticker":"PG",    "name":"Procter & Gamble",          "name_ko":"P&G",              "sector":"Consumer Staples", "price": 165.20, "change":  0.80, "change_pct":  0.49, "volume":  7200000, "market_cap": 391, "pe": 26.4, "eps":  6.26, "week52_high":173.31, "week52_low":131.96},
    {"ticker":"KO",    "name":"Coca-Cola Co.",             "name_ko":"코카콜라",         "sector":"Consumer Staples", "price":  62.40, "change":  0.30, "change_pct":  0.48, "volume": 13000000, "market_cap": 269, "pe": 26.5, "eps":  2.36, "week52_high": 66.87, "week52_low": 51.55},
    {"ticker":"PEP",   "name":"PepsiCo Inc.",              "name_ko":"펩시코",           "sector":"Consumer Staples", "price": 175.30, "change": -0.70, "change_pct": -0.40, "volume":  5800000, "market_cap": 240, "pe": 24.8, "eps":  7.07, "week52_high":196.88, "week52_low":155.83},
    # Industrial (5)
    {"ticker":"BA",    "name":"Boeing Co.",                "name_ko":"보잉",             "sector":"Industrial",       "price": 188.20, "change": -2.50, "change_pct": -1.31, "volume":  9800000, "market_cap": 115, "pe":   0.0,"eps":-19.45, "week52_high":267.54, "week52_low":159.70},
    {"ticker":"CAT",   "name":"Caterpillar Inc.",          "name_ko":"캐터필러",         "sector":"Industrial",       "price": 352.40, "change":  4.20, "change_pct":  1.21, "volume":  3500000, "market_cap": 175, "pe": 17.2, "eps": 20.49, "week52_high":388.63, "week52_low":208.37},
    {"ticker":"HON",   "name":"Honeywell Intl.",           "name_ko":"허니웰",           "sector":"Industrial",       "price": 196.30, "change":  1.80, "change_pct":  0.93, "volume":  4200000, "market_cap": 127, "pe": 23.4, "eps":  8.39, "week52_high":229.43, "week52_low":181.86},
    {"ticker":"UPS",   "name":"United Parcel Service",     "name_ko":"UPS",              "sector":"Industrial",       "price": 148.20, "change": -3.40, "change_pct": -2.24, "volume":  6800000, "market_cap": 126, "pe": 20.1, "eps":  7.37, "week52_high":193.02, "week52_low":130.66},
    {"ticker":"RTX",   "name":"RTX Corp.",                 "name_ko":"RTX",              "sector":"Industrial",       "price": 105.30, "change":  0.90, "change_pct":  0.86, "volume":  7200000, "market_cap": 140, "pe": 40.5, "eps":  2.60, "week52_high":106.48, "week52_low": 63.76},
    # Communication (3)
    {"ticker":"NFLX",  "name":"Netflix Inc.",              "name_ko":"넷플릭스",         "sector":"Communication",    "price": 628.50, "change": 12.30, "change_pct":  1.99, "volume":  4200000, "market_cap": 271, "pe": 48.2, "eps": 13.04, "week52_high":700.64, "week52_low":344.73},
    {"ticker":"DIS",   "name":"Walt Disney Co.",           "name_ko":"월트디즈니",       "sector":"Communication",    "price": 112.40, "change": -1.60, "change_pct": -1.40, "volume": 12000000, "market_cap": 205, "pe": 72.8, "eps":  1.54, "week52_high":123.74, "week52_low": 78.73},
    {"ticker":"T",     "name":"AT&T Inc.",                 "name_ko":"AT&T",             "sector":"Communication",    "price":  18.20, "change":  0.10, "change_pct":  0.55, "volume": 55000000, "market_cap": 130, "pe": 12.5, "eps":  1.46, "week52_high": 20.77, "week52_low": 14.46},
    # Real Estate (2)
    {"ticker":"AMT",   "name":"American Tower Corp.",      "name_ko":"아메리칸타워",     "sector":"Real Estate",      "price": 198.40, "change":  2.80, "change_pct":  1.43, "volume":  2400000, "market_cap":  93, "pe": 48.7, "eps":  4.07, "week52_high":242.72, "week52_low":154.58},
    {"ticker":"PLD",   "name":"Prologis Inc.",             "name_ko":"프로로지스",       "sector":"Real Estate",      "price": 128.30, "change": -1.10, "change_pct": -0.85, "volume":  5800000, "market_cap": 119, "pe": 37.2, "eps":  3.45, "week52_high":140.44, "week52_low":100.59},
    # Materials (2)
    {"ticker":"LIN",   "name":"Linde plc",                 "name_ko":"린데",             "sector":"Materials",        "price": 458.20, "change":  3.50, "change_pct":  0.77, "volume":  1800000, "market_cap": 218, "pe": 33.8, "eps": 13.56, "week52_high":479.24, "week52_low":352.72},
    {"ticker":"APD",   "name":"Air Products & Chemicals",  "name_ko":"에어프로덕츠",     "sector":"Materials",        "price": 265.40, "change": -2.20, "change_pct": -0.82, "volume":  1500000, "market_cap":  59, "pe": 23.6, "eps": 11.25, "week52_high":336.86, "week52_low":233.56},
    # Utilities (2)
    {"ticker":"NEE",   "name":"NextEra Energy",            "name_ko":"넥스트에라에너지", "sector":"Utilities",        "price":  68.30, "change":  0.40, "change_pct":  0.59, "volume":  9500000, "market_cap": 139, "pe": 21.4, "eps":  3.19, "week52_high": 85.76, "week52_low": 44.67},
    {"ticker":"DUK",   "name":"Duke Energy Corp.",         "name_ko":"듀크에너지",       "sector":"Utilities",        "price": 102.40, "change":  0.60, "change_pct":  0.59, "volume":  4200000, "market_cap":  66, "pe": 20.8, "eps":  4.92, "week52_high":108.38, "week52_low": 87.65},
]

# ── 지수 더미 데이터 ────────────────────────────────────────────────────────────
INDICES = [
    {"name":"S&P 500",      "value":  5248.32, "change":   18.54, "change_pct":  0.35},
    {"name":"NASDAQ",       "value": 16428.82, "change":  -45.23, "change_pct": -0.27},
    {"name":"Dow Jones",    "value": 39387.76, "change":  125.08, "change_pct":  0.32},
    {"name":"Russell 2000", "value":  2082.47, "change":    8.34, "change_pct":  0.40},
    {"name":"KOSPI",        "value":  2700.00, "change":   15.00, "change_pct":  0.56},
    {"name":"KOSDAQ",       "value":   870.00, "change":    3.50, "change_pct":  0.40},
    {"name":"US500",        "value":  5230.00, "change":   18.00, "change_pct":  0.34},
    {"name":"US30",         "value": 38950.00, "change":  120.00, "change_pct":  0.31},
    {"name":"US Tech 100",  "value": 18350.00, "change":  -55.00, "change_pct": -0.30},
    {"name":"WTI Crude",    "value":    82.45, "change":    0.87, "change_pct":  1.07},
    {"name":"Gold",         "value":  2325.80, "change":  -12.30, "change_pct": -0.53},
    {"name":"Bitcoin",      "value": 67500.00, "change":  850.00, "change_pct":  1.28},
    {"name":"10Y Yield",    "value":     4.42, "change":    0.03, "change_pct":  0.68},
    {"name":"DXY",          "value":   104.52, "change":   -0.18, "change_pct": -0.17},
    {"name":"EUR/USD",      "value":    1.082, "change":  -0.001, "change_pct": -0.11},
    {"name":"VIX",          "value":    13.52, "change":   -0.48, "change_pct": -3.43},
]

# ── 뉴스 더미 데이터 ────────────────────────────────────────────────────────────
NEWS = [
    {"id": 1, "title":"NVIDIA Surges After Reporting Record Q1 Revenue, Beats Estimates by Wide Margin",   "source":"Bloomberg",       "time":"10m ago",  "ticker":"NVDA", "sentiment":"positive"},
    {"id": 2, "title":"Fed Holds Rates Steady, Signals Just One Cut Possible This Year",                    "source":"Reuters",         "time":"35m ago",  "ticker":None,   "sentiment":"neutral"},
    {"id": 3, "title":"Apple Set to Unveil AI-Powered Features Across iPhone Lineup at WWDC",              "source":"WSJ",             "time":"1h ago",   "ticker":"AAPL", "sentiment":"positive"},
    {"id": 4, "title":"Tesla Faces Expanded Recall on Cybertruck Over Safety Concerns",                     "source":"CNBC",            "time":"2h ago",   "ticker":"TSLA", "sentiment":"negative"},
    {"id": 5, "title":"Eli Lilly's Obesity Drug Zepbound Shows Strong Demand, Raises Full-Year Outlook",   "source":"Financial Times", "time":"3h ago",   "ticker":"LLY",  "sentiment":"positive"},
    {"id": 6, "title":"Meta Confirms 2025 Launch Date for AR Glasses, Shares Jump 3%",                     "source":"TechCrunch",      "time":"4h ago",   "ticker":"META", "sentiment":"positive"},
    {"id": 7, "title":"JPMorgan Raises S&P 500 Year-End Target to 5,500 Amid Earnings Optimism",           "source":"Bloomberg",       "time":"5h ago",   "ticker":"JPM",  "sentiment":"positive"},
    {"id": 8, "title":"Starbucks CEO Steps Down Amid Slowing Sales and Customer Traffic Decline",           "source":"Reuters",         "time":"6h ago",   "ticker":"SBUX", "sentiment":"negative"},
    {"id": 9, "title":"US CPI Comes in Slightly Above Expectations, Weighing on Rate Cut Bets",             "source":"AP",              "time":"7h ago",   "ticker":None,   "sentiment":"negative"},
    {"id":10, "title":"Netflix Adds 9.3M Subscribers in Q1, Surpassing Wall Street Forecasts",             "source":"CNBC",            "time":"8h ago",   "ticker":"NFLX", "sentiment":"positive"},
    {"id":11, "title":"Intel Announces $8.5B in Federal Grants to Boost US Chip Manufacturing",            "source":"WSJ",             "time":"9h ago",   "ticker":"INTC", "sentiment":"positive"},
    {"id":12, "title":"Boeing Faces New FAA Investigation Over Quality Control at 737 MAX Plant",           "source":"Financial Times", "time":"10h ago",  "ticker":"BA",   "sentiment":"negative"},
]


# ── 백그라운드 갱신 함수 ─────────────────────────────────────────────────────

def _apply_market_caps(stocks: list[dict]) -> list[dict]:
    """캐시된 시가총액을 종목 목록에 반영"""
    market_caps: dict = cache.get("market_caps") or {}
    if not market_caps:
        return stocks
    return [{**s, "market_cap": market_caps.get(s["ticker"], s.get("market_cap"))} for s in stocks]


def refresh_stocks():
    """
    종목 가격 갱신.
    - Nasdaq 경로: Nasdaq API 재호출로 최신 가격·시총 일괄 갱신
    - S&P500 폴백 경로: Yahoo Finance 병렬 조회
    갱신 완료 시 WebSocket으로 클라이언트에 Push.
    """
    base = cache.get("stocks_base") or STOCKS
    if len(base) >= 1000:
        nasdaq = df.fetch_nasdaq_stocks(min_market_cap_b=0.3)
        if nasdaq:
            cache.set("stocks_base", nasdaq, ttl=3600)
            cache.set("stocks",      nasdaq, ttl=300)
            cache.set("market_caps",
                      {s["ticker"]: s["market_cap"] for s in nasdaq if s.get("market_cap")},
                      ttl=3600)
            _emit_queue.put(("stocks_update", {"count": len(nasdaq)}))
            return
    updated = df.refresh_prices_parallel(base)
    if updated:
        cache.set("stocks", _apply_market_caps(updated), ttl=300)
        _emit_queue.put(("stocks_update", {"count": len(updated)}))


def refresh_pe_eps():
    """FMP 무료 API로 PE/EPS 수집 (1일 1회).
    이미 있는 종목은 건너뛰고 누락 종목부터 시총 상위 순으로 처리.
    결과는 파일에 저장해 서버 재시작 후에도 유지.
    """
    try:
        stocks = cache.get("stocks") or []
        if len(stocks) < 100:   # 종목 로드 미완료 시 스킵
            log.warning(f"refresh_pe_eps 스킵: stocks {len(stocks)}개 (아직 로드 중)")
            return
        sorted_stocks = sorted(stocks, key=lambda x: x.get("market_cap", 0), reverse=True)
        all_tickers = [s["ticker"] for s in sorted_stocks]

        existing = _load_pe_eps()
        missing  = [t for t in all_tickers if t not in existing]
        refresh  = [t for t in all_tickers if t in existing]
        ordered  = (missing + refresh)[:200]   # 누락 먼저, 기존 갱신은 뒤에

        new_data = df.fetch_pe_eps_fmp(ordered)
        if new_data:
            existing.update(new_data)
            _save_pe_eps(existing)
            cache.set("pe_eps", existing, ttl=86400)
            log.info(f"PE/EPS 갱신: {len(new_data)}개 신규 / 누적 {len(existing)}개")
    except Exception as e:
        log.error(f"refresh_pe_eps 실패: {e}")


def refresh_extra_fields():
    """PE/EPS/52W 데이터 갱신 (6시간마다). stocks 캐시가 채워진 후 실행."""
    try:
        stocks = cache.get("stocks") or []
        if not stocks:
            return
        tickers = [s["ticker"] for s in stocks]
        extras  = df.fetch_extra_fields(tickers)
        if extras:
            cache.set("extra_fields", extras, ttl=6 * 3600)
            log.info(f"extra_fields 갱신: {len(extras)}개")
    except Exception as e:
        log.error(f"refresh_extra_fields 실패: {e}")


def refresh_market_caps():
    """시가총액 수집 (Yahoo Finance HTML, 6시간마다)"""
    base = cache.get("stocks_base") or STOCKS
    tickers = [s["ticker"] for s in base]
    market_caps = df.fetch_all_market_caps(tickers)
    if market_caps:
        cache.set("market_caps", market_caps, ttl=21600)  # 6시간
        # 현재 stocks 캐시에도 즉시 반영
        stocks = cache.get("stocks")
        if stocks:
            cache.set("stocks", _apply_market_caps(stocks), ttl=300)


def refresh_news():
    log.info("뉴스 갱신 시작...")
    try:
        news_data = df.fetch_news()
        if news_data:
            cache.set("news", news_data, ttl=600)
            log.info(f"뉴스 갱신 완료: {len(news_data)}건")
            _emit_queue.put(("news_update", {"count": len(news_data)}))
    except Exception as e:
        log.warning(f"뉴스 갱신 실패: {e}")


def refresh_av_news():
    """Alpha Vantage 뉴스 갱신 — 12시간 캐시 (하루 25회 한도 보호)"""
    log.info("AlphaVantage 뉴스 갱신 시작...")
    try:
        av_data = df.fetch_alphavantage_news()
        if av_data:
            cache.set("av_news", av_data, ttl=43200)
            log.info(f"AlphaVantage 뉴스 갱신 완료: {len(av_data)}건")
    except Exception as e:
        log.warning(f"AlphaVantage 뉴스 갱신 실패: {e}")


def refresh_finnhub_news():
    """Finnhub 일반 뉴스 갱신 — 10분 캐시"""
    log.info("Finnhub 뉴스 갱신 시작...")
    try:
        fh_data = df.fetch_finnhub_news()
        if fh_data:
            cache.set("finnhub_news", fh_data, ttl=600)
            log.info(f"Finnhub 뉴스 갱신 완료: {len(fh_data)}건")
    except Exception as e:
        log.warning(f"Finnhub 뉴스 갱신 실패: {e}")


def refresh_reports():
    log.info("리포트 갱신 시작...")
    try:
        data = df.fetch_reports()
        if data:
            cache.set("reports", data, ttl=900)
            log.info(f"리포트 갱신 완료: {len(data)}건")
    except Exception as e:
        log.warning(f"리포트 갱신 실패: {e}")


def refresh_earnings():
    """이번 주 + 다음 주 어닝스 캘린더 수집 (1시간 캐시)."""
    from datetime import date, timedelta
    try:
        today = date.today()
        # 이번 주 월~금
        mon = today - timedelta(days=today.weekday())
        this_week = [mon + timedelta(days=i) for i in range(5)]
        # 다음 주 월~금
        next_mon = mon + timedelta(weeks=1)
        next_week = [next_mon + timedelta(days=i) for i in range(5)]

        all_items: list[dict] = []
        for d in this_week + next_week:
            items = df.fetch_earnings_calendar(d.strftime("%Y-%m-%d"))
            all_items.extend(items)

        cache.set("earnings", all_items, ttl=3600)
        log.info(f"어닝스 캘린더 갱신: {len(all_items)}건")
    except Exception as e:
        log.warning(f"refresh_earnings 실패: {e}")


def refresh_indices():
    log.info("지수 갱신 시작...")
    try:
        idx = df.fetch_indices()
        if idx:
            cache.set("indices", idx, ttl=30)
            log.info(f"지수 갱신 완료: {len(idx)}개")
            _emit_queue.put(("indices_update", {"count": len(idx)}))
            log.info("indices_update 큐 등록")
    except Exception as e:
        log.warning(f"지수 갱신 실패: {e}")


def refresh_fear_greed():
    """CNN Fear & Greed Index 갱신 — 30분마다."""
    data = df.fetch_fear_greed()
    if data:
        cache.set("fear_greed", data, ttl=1800)
        log.info(f"Fear & Greed 갱신: {data['score']} ({data['rating']})")


def refresh_dynamic_indices():
    """Nasdaq100·Dow30(Wikipedia) + Russell2000(IWM CSV) 구성종목 갱신 — 주 1회."""
    log.info("지수 구성종목 동적 갱신 시작 (Nasdaq100·Dow30·Russell2000)...")

    n100 = df.fetch_nasdaq100_list()
    if n100:
        cache.set("nasdaq100_tickers", n100, ttl=7 * 86400)
        log.info(f"Nasdaq100 갱신 완료: {len(n100)}개")
    else:
        log.warning("Nasdaq100 갱신 실패 — 기존 캐시/정적 폴백 유지")

    d30 = df.fetch_dow30_list()
    if d30:
        cache.set("dow30_tickers", d30, ttl=7 * 86400)
        log.info(f"Dow30 갱신 완료: {len(d30)}개")
    else:
        log.warning("Dow30 갱신 실패 — 기존 캐시/정적 폴백 유지")

    r2000 = df.fetch_russell2000_iwm()
    if r2000:
        cache.set("russell2000_tickers", r2000, ttl=7 * 86400)
        log.info(f"Russell2000 갱신 완료: {len(r2000)}개")
    else:
        log.warning("Russell2000 IWM 실패 — 시총 근사값 폴백 유지")


def _load_sp500_tickers_background():
    """Wikipedia에서 실제 S&P 500 구성 종목 티커 Set을 캐시에 저장 (24시간)."""
    sp500 = df.fetch_sp500_list()
    if sp500:
        tickers = {s["ticker"] for s in sp500}
        cache.set("sp500_tickers", tickers, ttl=86400)
        log.info(f"S&P 500 구성종목 캐시 저장: {len(tickers)}개")
    else:
        log.warning("S&P 500 Wikipedia 파싱 실패 — sp500_tickers 미설정")


def _load_sp500_background():
    """
    서버 시작 후 백그라운드 종목 목록 로드 (우선순위):
    1) Nasdaq API (2500개+, 가격·시총 포함, 단 1회 요청) ← 우선
    2) Wikipedia S&P500 (503개) ← Nasdaq 실패 시 폴백
    3) 기존 60개 더미 ← 최후 폴백
    Nasdaq 성공 시 가격·시총이 이미 포함되므로 별도 갱신 불필요.
    Wikipedia S&P500 티커는 Nasdaq 성공 여부와 무관하게 별도 캐시에 저장.
    """
    # 1) Nasdaq API 시도
    nasdaq = df.fetch_nasdaq_stocks(min_market_cap_b=0.3)
    if nasdaq:
        cache.set("stocks_base", nasdaq, ttl=3600)
        cache.set("stocks",      nasdaq, ttl=300)
        cache.set("market_caps",
                  {s["ticker"]: s["market_cap"] for s in nasdaq if s.get("market_cap")},
                  ttl=3600)
        log.info(f"Nasdaq 종목 로드 완료: {len(nasdaq)}개 (S&P500+Russell2000 수준)")
        # Nasdaq 성공해도 S&P500 실제 구성종목은 Wikipedia에서 별도 로드
        threading.Thread(target=_load_sp500_tickers_background, daemon=True).start()
        return

    # 2) Wikipedia S&P500 폴백
    log.warning("Nasdaq API 실패 → Wikipedia S&P500 폴백")
    sp500 = df.fetch_sp500_list()
    if sp500:
        cache.set("stocks_base", sp500, ttl=86400)
        cache.set("stocks",      sp500, ttl=300)
        tickers = {s["ticker"] for s in sp500}
        cache.set("sp500_tickers", tickers, ttl=86400)
        log.info(f"S&P500 기본 목록 로드: {len(sp500)}개")
    else:
        log.warning("Wikipedia 파싱도 실패 → 기존 60개 유지")
    # 가격 갱신 (S&P500 경로에서만 필요)
    refresh_stocks()
    threading.Thread(target=refresh_market_caps, daemon=True).start()


def initial_load():
    """
    앱 시작 시 캐시 초기화.
    1) 60개 더미 데이터로 즉시 서빙 (사용자가 바로 페이지를 볼 수 있음)
    2) 백그라운드에서 S&P500 503개 목록 로드 + 실시간 가격 갱신
    """
    # 즉시 서빙용 60개 더미 초기화
    base60 = [{**s, "name_ko": df.NAME_KO.get(s["ticker"], s.get("name_ko", ""))} for s in STOCKS]
    cache.set("stocks_base", base60, ttl=86400)
    cache.set("stocks",      base60, ttl=300)
    cache.set("news",    NEWS,    ttl=600)
    cache.set("reports", [],     ttl=900)
    cache.set("indices", INDICES, ttl=30)

    # emit 큐 워커 시작 (socketio 관리 스레드에서 emit 처리)
    socketio.start_background_task(_emit_worker)

    # 백그라운드 갱신 스레드 시작
    threading.Thread(target=refresh_indices,        daemon=True).start()
    threading.Thread(target=refresh_news,           daemon=True).start()
    threading.Thread(target=refresh_reports,        daemon=True).start()
    threading.Thread(target=refresh_earnings,       daemon=True).start()
    threading.Thread(target=refresh_av_news,        daemon=True).start()
    threading.Thread(target=refresh_finnhub_news,   daemon=True).start()
    threading.Thread(target=_load_sp500_background, daemon=True).start()
    threading.Thread(target=refresh_dynamic_indices, daemon=True).start()
    threading.Thread(target=refresh_fear_greed,     daemon=True).start()
    # extra_fields는 stocks 로드 후 실행 — 약간 지연해서 시작
    def _delayed_extra():
        import time as _t; _t.sleep(30)
        refresh_extra_fields()
    threading.Thread(target=_delayed_extra, daemon=True).start()

    # PE/EPS는 파일 캐시 먼저 로드, stocks 로드 후 60초 지연해서 시작
    saved = _load_pe_eps()
    if saved:
        cache.set("pe_eps", saved, ttl=86400)
        log.info(f"PE/EPS 파일 캐시 로드: {len(saved)}개")
    def _delayed_pe_eps():
        import time as _t; _t.sleep(180)   # 전체 종목 로드 완료 대기 (60초에서 연장)
        refresh_pe_eps()
    threading.Thread(target=_delayed_pe_eps, daemon=True).start()


# ── 스케줄러 ─────────────────────────────────────────────────────────────────
_scheduler = BackgroundScheduler()
_scheduler.add_job(refresh_stocks,          "interval", minutes=5,  id="stocks")
_scheduler.add_job(refresh_indices,         "interval", seconds=30, id="idx")
_scheduler.add_job(refresh_news,            "interval", minutes=10, id="news")
_scheduler.add_job(refresh_reports,         "interval", minutes=15, id="reports")
_scheduler.add_job(refresh_earnings,        "interval", hours=1,    id="earnings")
_scheduler.add_job(refresh_market_caps,     "interval", hours=6,    id="market_caps")
_scheduler.add_job(refresh_extra_fields,    "interval", hours=6,    id="extra_fields")
_scheduler.add_job(refresh_pe_eps,          "interval", hours=24,   id="pe_eps")
_scheduler.add_job(refresh_av_news,         "interval", hours=12,   id="av_news")
_scheduler.add_job(refresh_finnhub_news,    "interval", minutes=10, id="finnhub_news")
_scheduler.add_job(refresh_dynamic_indices, "interval", weeks=1,    id="dyn_indices")
_scheduler.add_job(refresh_fear_greed,      "interval", minutes=30, id="fear_greed")


# ── Flask 라우트 ─────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/stocks")
def stocks():
    sector  = request.args.get("sector", "all")
    data    = cache.get("stocks") or STOCKS
    extras  = cache.get("extra_fields") or {}   # 52W
    pe_eps  = cache.get("pe_eps") or {}          # PE/EPS

    if extras or pe_eps:
        merged = []
        for s in data:
            tick = s["ticker"]
            row  = dict(s)
            if extras.get(tick):
                row.update(extras[tick])
            if pe_eps.get(tick):
                row.update(pe_eps[tick])
            merged.append(row)
        data = merged

    result = data if sector == "all" else [s for s in data if s["sector"] == sector]
    return jsonify(result)


@app.route("/api/indices")
def indices():
    return jsonify(cache.get("indices") or INDICES)


@app.route("/api/news")
def news():
    rss_news     = cache.get("news") or NEWS
    av_news      = cache.get("av_news") or []
    finnhub_news = cache.get("finnhub_news") or []
    # 중복 제거: 제목 기준
    seen   = {n["title"] for n in rss_news}
    extras = []
    for n in av_news + finnhub_news:
        if n["title"] not in seen:
            seen.add(n["title"])
            extras.append(n)
    merged = list(rss_news) + extras
    # 최신순 정렬
    merged.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
    for i, n in enumerate(merged, 1):
        n["id"] = i
    return jsonify(merged)


@app.route("/api/stock-news/<ticker>")
def stock_news(ticker: str):
    """종목별 뉴스 (Finnhub company-news, 30분 lazy 캐시)"""
    ticker = ticker.upper()
    key    = f"stock_news_{ticker}"
    cached = cache.get(key)
    if cached is not None:
        return jsonify(cached)
    data = df.fetch_finnhub_company_news(ticker)
    cache.set(key, data, ttl=1800)
    return jsonify(data)


@app.route("/api/reports")
def reports():
    return jsonify(cache.get("reports") or [])


@app.route("/api/earnings")
def earnings():
    from datetime import date, timedelta
    period = request.args.get("period", "week")  # today | week | next_week
    all_items = cache.get("earnings") or []

    today = date.today()
    mon   = today - timedelta(days=today.weekday())
    if period == "today":
        target_dates = {today.strftime("%Y-%m-%d")}
    elif period == "next_week":
        next_mon = mon + timedelta(weeks=1)
        target_dates = {(next_mon + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(5)}
    else:
        target_dates = {(mon + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(5)}

    result = [item for item in all_items if item["date"] in target_dates]
    return jsonify(result)


# ── 지수 구성 종목 ──────────────────────────────────────────────────────────────
_DOW30 = {
    "AAPL","AMGN","AXP","BA","CAT","CRM","CSCO","CVX","DIS","DOW",
    "GS","HD","HON","IBM","JNJ","JPM","KO","MCD","MMM","MRK",
    "MSFT","NKE","NVDA","PG","TRV","UBER","UNH","V","VZ","WMT",
}

_NASDAQ100 = {
    "AAPL","ABNB","ADBE","ADI","ADP","ADSK","AEP","AMGN","AMZN","ANSS",
    "ARM","ASML","AVGO","AZN","BIIB","BKNG","BKR","CCEP","CDNS","CDW",
    "CEG","CHTR","CMCSA","COST","CPRT","CRWD","CSCO","CSX","CTAS","CTSH",
    "DDOG","DXCM","EA","EXC","FANG","FAST","FTNT","GEHC","GILD","GOOG",
    "GOOGL","HON","IDXX","INTU","ISRG","KDP","KHC","KLAC","LRCX","LULU",
    "MAR","MCHP","MDLZ","META","MELI","MNST","MRNA","MRVL","MSFT","MU",
    "NFLX","NVDA","NXPI","ODFL","ON","ORLY","PANW","PAYX","PCAR","PDD",
    "PEP","PLTR","PYPL","QCOM","REGN","ROP","ROST","SBUX","SNPS","TCOM",
    "TEAM","TMUS","TSLA","TTD","TXN","VRSK","VRTX","WBD","WDAY","XEL",
    "ZS","AXON","MSTR","INTC","SIRI","NTES",
}


@app.route("/api/index-members")
def index_members():
    all_stocks = cache.get("stocks") or []
    by_cap = sorted(all_stocks, key=lambda x: x.get("market_cap") or 0, reverse=True)

    # S&P 500: Wikipedia 실제 구성종목 우선, 미로드 시 시총 상위 503개 폴백
    sp500_set = cache.get("sp500_tickers") or {s["ticker"] for s in by_cap[:503]}

    # Nasdaq 100: Wikipedia 동적 로드 우선, 미로드 시 정적 Set 폴백
    nasdaq100_set = cache.get("nasdaq100_tickers") or _NASDAQ100

    # Dow 30: Wikipedia 동적 로드 우선, 미로드 시 정적 Set 폴백
    dow30_set = cache.get("dow30_tickers") or _DOW30

    # Russell 2000: IWM CSV 동적 로드 우선, 미로드 시 시총 근사 폴백
    russell2000_set = cache.get("russell2000_tickers") or {
        s["ticker"] for s in by_cap[1000:] if s["ticker"] not in sp500_set
    }

    return jsonify({
        "dow30":       sorted(dow30_set),
        "nasdaq100":   sorted(nasdaq100_set),
        "sp500":       sorted(sp500_set),
        "russell2000": sorted(russell2000_set),
    })


@app.route("/api/brief")
def brief():
    import time as _time
    from collections import Counter

    period = request.args.get("period", "daily")
    now = _time.time()
    if period == "daily":
        cutoff = now - 86400
    elif period == "weekly":
        cutoff = now - 7 * 86400
    else:  # monthly
        cutoff = now - 30 * 86400

    all_news    = cache.get("news")    or []
    all_reports = cache.get("reports") or []

    news_in    = [n for n in all_news    if n.get("timestamp", 0) >= cutoff]
    reports_in = [r for r in all_reports if r.get("timestamp", 0) >= cutoff]
    combined   = news_in + reports_in

    # ─ Market Mood (감성 분포)
    sentiments   = [i.get("sentiment", "neutral") for i in combined]
    pos  = sentiments.count("positive")
    neg  = sentiments.count("negative")
    neut = sentiments.count("neutral")
    total = len(sentiments) or 1
    mood = {
        "positive": round(pos  / total * 100),
        "negative": round(neg  / total * 100),
        "neutral":  round(neut / total * 100),
        "label": "Bullish" if pos > neg * 1.5 else "Bearish" if neg > pos * 1.5 else "Mixed",
    }

    # ─ Top Stories: 중복 제거 + 소스 다양성 + 감성 강도 가중
    def _dedup_stories(items: list[dict], max_per_source: int = 2, top_n: int = 5) -> list[dict]:
        seen_words: list[set] = []
        source_count: dict[str, int] = {}
        result = []
        # 감성 강도(abs(score)) + 최신순 정렬
        sorted_items = sorted(
            items,
            key=lambda x: (abs(x.get("score", 0)), x.get("timestamp", 0)),
            reverse=True,
        )
        for item in sorted_items:
            if len(result) >= top_n:
                break
            src = item.get("source", "")
            if source_count.get(src, 0) >= max_per_source:
                continue
            # 핵심 단어 기반 중복 체크 (4글자 이상 영단어)
            words = {w.lower() for w in item.get("title", "").split() if len(w) >= 4}
            is_dup = any(len(words & prev) >= 3 for prev in seen_words)
            if is_dup:
                continue
            seen_words.append(words)
            source_count[src] = source_count.get(src, 0) + 1
            result.append(item)
        return result

    top_stories = _dedup_stories(news_in)

    # ─ Most Mentioned Stocks
    tickers = [i["ticker"] for i in combined if i.get("ticker")]
    top_tickers = [{"ticker": t, "count": c} for t, c in Counter(tickers).most_common(8)]

    # ─ Report Highlights: 중복 제거 + 소스 다양성
    report_highlights = _dedup_stories(reports_in, max_per_source=1, top_n=5)

    return jsonify({
        "period":          period,
        "total_items":     len(combined),
        "news_count":      len(news_in),
        "report_count":    len(reports_in),
        "mood":            mood,
        "top_stories":     top_stories,
        "top_tickers":     top_tickers,
        "report_highlights": report_highlights,
    })


VALID_PERIODS   = {"1mo", "3mo", "6mo", "1y", "2y"}
VALID_INTERVALS = {"1m", "5m", "15m", "30m", "60m", "1d"}

# interval별 캐시 TTL (초): 분봉일수록 짧게
_CHART_TTL = {
    "1m":  30,
    "5m":  60,
    "15m": 120,
    "30m": 300,
    "60m": 600,
    "1d":  300,
}

@app.route("/api/chart/<ticker>")
def chart(ticker):
    t        = ticker.upper()
    period   = request.args.get("period",   "1y")
    interval = request.args.get("interval", "1d")
    if period   not in VALID_PERIODS:   period   = "1y"
    if interval not in VALID_INTERVALS: interval = "1d"
    ttl  = _CHART_TTL.get(interval, 300)
    key  = f"chart_{t}_{interval}_{period}"
    cached = cache.get_fresh(key)
    if cached:
        return jsonify(cached)
    ohlcv = df.fetch_ohlcv(t, period=period, interval=interval)
    if ohlcv:
        cache.set(key, ohlcv, ttl=ttl)
        return jsonify(ohlcv)
    return jsonify(_generate_ohlcv_dummy(t))


@app.route("/api/stock/<ticker>")
def stock_detail(ticker):
    t    = ticker.upper()
    data = cache.get("stocks") or STOCKS
    stock = next((s for s in data if s["ticker"] == t), None)
    if not stock:
        return jsonify({"error": "Not found"}), 404
    return jsonify(stock)


@app.route("/api/fear-greed")
def fear_greed_api():
    data = cache.get("fear_greed")
    if data is None:
        data = df.fetch_fear_greed()
        if data:
            cache.set("fear_greed", data, ttl=1800)
    return jsonify(data or {})


@app.route("/api/heatmap-perf")
def heatmap_perf():
    period = request.args.get("period", "1w")
    if period not in ("1w", "1m"):
        period = "1w"
    key = f"heatmap_perf_{period}"
    cached = cache.get_fresh(key)
    if cached is not None:
        return jsonify(cached)
    stocks = cache.get("stocks") or STOCKS
    sorted_stocks = sorted(stocks, key=lambda x: x.get("market_cap") or 0, reverse=True)
    tickers = [s["ticker"] for s in sorted_stocks[:500]]
    perf = df.fetch_heatmap_perf(tickers, period=period)
    ttl = 3600 if period == "1w" else 7200
    cache.set(key, perf or {}, ttl=ttl)
    return jsonify(perf or {})


@app.route("/api/economic-calendar")
def economic_calendar():
    days = min(int(request.args.get("days", 21)), 60)
    return jsonify(df.fetch_economic_calendar(days_ahead=days))


@app.route("/api/cache/status")
def cache_status():
    return jsonify(cache.status())


# ── 더미 OHLCV 폴백 ──────────────────────────────────────────────────────────
import random, hashlib
from datetime import datetime, timedelta


def _generate_ohlcv_dummy(ticker: str, days: int = 180) -> list[dict]:
    stock = next((s for s in STOCKS if s["ticker"] == ticker), None)
    base_price = stock["price"] if stock else 100.0
    seed = int(hashlib.md5(ticker.encode()).hexdigest(), 16) % (10 ** 8)
    rng  = random.Random(seed)
    price = base_price * 0.82
    data  = []
    for i in range(days, 0, -1):
        date = (datetime.now() - timedelta(days=i)).strftime("%Y-%m-%d")
        op   = price
        cl   = round(op * (1 + rng.gauss(0.0005, 0.018)), 2)
        hi   = round(max(op, cl) * (1 + rng.uniform(0, 0.012)), 2)
        lo   = round(min(op, cl) * (1 - rng.uniform(0, 0.012)), 2)
        vol  = int((stock["volume"] if stock else 1000000) * rng.uniform(0.5, 1.5))
        data.append({"time": date, "open": round(op, 2), "high": hi, "low": lo,
                     "close": cl, "volume": vol})
        price = cl
    return data


if __name__ == "__main__":
    initial_load()
    _scheduler.start()
    socketio.run(app, debug=False, port=5001, allow_unsafe_werkzeug=True)
