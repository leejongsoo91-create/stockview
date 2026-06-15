"""
주식 스크리너 API — FastAPI + Pandas
─────────────────────────────────────────────
실행  : uvicorn screener_api:app --reload --port 8000
문서  : http://127.0.0.1:8000/docs   (Swagger UI 자동 생성)
데이터: stocks_data.json (fetch_stocks.py 로 생성)
"""

import json
import math
import logging
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Optional, Literal

import pandas as pd
from fastapi import FastAPI, Query, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ── 로깅 ──────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ── 설정 ──────────────────────────────────────────────────────────────────────
DATA_FILE      = Path("stocks_data.json")
DEFAULT_LIMIT  = 100
MAX_LIMIT      = 500

SORT_FIELDS = {
    "ticker", "name", "sector", "price", "change",
    "change_pct", "volume", "market_cap", "pe", "eps",
    "week52_high", "week52_low",
}


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Pydantic 모델 (응답 스키마 + 자동 문서화)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class StockItem(BaseModel):
    ticker:      str
    name:        str
    sector:      str
    industry:    str            = ""
    price:       float | None
    change:      float | None
    change_pct:  float | None   = Field(None, description="등락률 (%)")
    volume:      int   | None
    market_cap:  float | None   = Field(None, description="시가총액 (십억 달러)")
    pe:          float | None   = Field(None, description="P/E 비율")
    eps:         float | None
    week52_high: float | None
    week52_low:  float | None
    currency:    str            = "USD"
    fetched_at:  str            = ""


class ScreenerResponse(BaseModel):
    total:        int   = Field(..., description="필터 적용 후 전체 결과 수")
    returned:     int   = Field(..., description="이번 응답에 포함된 종목 수")
    offset:       int
    limit:        int
    sort_by:      str
    sort_order:   str
    filters_used: dict         = Field(..., description="적용된 필터 목록")
    data_age:     str          = Field(..., description="데이터 생성 시각 (UTC)")
    stocks:       list[StockItem]


class SectorsResponse(BaseModel):
    count:   int
    sectors: list[str]


class StatsResponse(BaseModel):
    total_stocks:       int
    avg_market_cap_b:   float | None
    avg_pe:             float | None
    avg_change_pct:     float | None
    gainers:            int
    losers:             int
    data_age:           str


class HealthResponse(BaseModel):
    status:      str
    data_file:   str
    stock_count: int
    data_age:    str
    server_time: str


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  데이터 로더 (앱 시작 시 1회 로드, /reload 엔드포인트로 재로드 가능)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class DataStore:
    """
    JSON 파일을 읽어 Pandas DataFrame으로 보관.
    재로드 시 인스턴스 데이터만 갱신하므로 앱 재시작 불필요.
    """

    def __init__(self):
        self.df: pd.DataFrame = pd.DataFrame()
        self.generated_at: str = ""
        self.load()

    def load(self):
        """stocks_data.json 읽기"""
        if not DATA_FILE.exists():
            log.warning(f"데이터 파일을 찾을 수 없음: {DATA_FILE.resolve()}")
            log.warning("fetch_stocks.py 를 먼저 실행해 stocks_data.json 을 생성하세요.")
            self.df = pd.DataFrame()
            self.generated_at = ""
            return

        try:
            raw = json.loads(DATA_FILE.read_text(encoding="utf-8"))
            stocks = raw.get("stocks", [])

            if not stocks:
                raise ValueError("stocks 배열이 비어 있습니다.")

            self.df = pd.DataFrame(stocks)
            self.generated_at = raw.get("generated_at", "")

            # 수치형 컬럼 강제 변환 (혹시 문자열로 들어온 경우 처리)
            numeric_cols = [
                "price", "change", "change_pct", "volume",
                "market_cap", "pe", "eps", "week52_high", "week52_low",
            ]
            for col in numeric_cols:
                if col in self.df.columns:
                    self.df[col] = pd.to_numeric(self.df[col], errors="coerce")

            # NaN → None (JSON 직렬화 호환)
            self.df = self.df.where(self.df.notna(), other=None)

            log.info(f"데이터 로드 완료: {len(self.df)}개 종목 | 생성 시각: {self.generated_at}")

        except Exception as e:
            log.error(f"데이터 로드 실패: {e}")
            raise


# 전역 DataStore 인스턴스
store = DataStore()


def get_store() -> DataStore:
    """FastAPI Depends용 DataStore 제공자"""
    if store.df.empty:
        raise HTTPException(
            status_code=503,
            detail=(
                "데이터가 로드되지 않았습니다. "
                "fetch_stocks.py 를 실행해 stocks_data.json 을 생성한 후 "
                "POST /reload 를 호출하세요."
            ),
        )
    return store


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  FastAPI 앱 정의
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app = FastAPI(
    title="Stock Screener API",
    description=(
        "S&P 500 주요 종목 데이터를 필터·정렬·페이지네이션으로 조회하는 API.\n\n"
        "**데이터 출처**: `fetch_stocks.py` 로 생성된 `stocks_data.json`"
    ),
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# CORS (프론트엔드 개발 서버에서 직접 호출 가능하도록)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  헬퍼 함수
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _safe_avg(series: pd.Series) -> float | None:
    """None/NaN 제외 평균. 값이 없으면 None 반환."""
    clean = series.dropna()
    return round(float(clean.mean()), 4) if not clean.empty else None


def _row_to_stock(row: dict) -> StockItem:
    """DataFrame 행(dict)을 StockItem 으로 변환"""
    def _f(v):
        """float 변환 — NaN·None → None"""
        if v is None:
            return None
        try:
            f = float(v)
            return None if math.isnan(f) or math.isinf(f) else f
        except (TypeError, ValueError):
            return None

    def _i(v):
        """int 변환 — NaN·None → None"""
        f = _f(v)
        return int(f) if f is not None else None

    return StockItem(
        ticker      = str(row.get("ticker", "")),
        name        = str(row.get("name", "")),
        sector      = str(row.get("sector", "")),
        industry    = str(row.get("industry", "")),
        price       = _f(row.get("price")),
        change      = _f(row.get("change")),
        change_pct  = _f(row.get("change_pct")),
        volume      = _i(row.get("volume")),
        market_cap  = _f(row.get("market_cap")),
        pe          = _f(row.get("pe")),
        eps         = _f(row.get("eps")),
        week52_high = _f(row.get("week52_high")),
        week52_low  = _f(row.get("week52_low")),
        currency    = str(row.get("currency", "USD")),
        fetched_at  = str(row.get("fetched_at", "")),
    )


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  엔드포인트
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# ── GET /api/screener ────────────────────────────────────────────────────────
@app.get(
    "/api/screener",
    response_model=ScreenerResponse,
    summary="종목 스크리너",
    tags=["Screener"],
)
def screener(
    # ── 핵심 필터 3종 ────────────────────────────────────────────────────────
    sector: Optional[str] = Query(
        None,
        description="섹터 이름 (부분 일치, 대소문자 무시). 예: `Technology`, `Health`",
        example="Technology",
    ),
    min_market_cap: Optional[float] = Query(
        None,
        ge=0,
        description="최소 시가총액 (십억 달러 기준). 예: `100` → 1,000억$ 이상",
        example=100.0,
    ),
    max_pe: Optional[float] = Query(
        None,
        ge=0,
        description="최대 P/E 비율. P/E가 None이거나 음수인 종목은 결과에서 제외됩니다.",
        example=30.0,
    ),
    # ── 추가 필터 ─────────────────────────────────────────────────────────────
    min_price: Optional[float] = Query(None, ge=0, description="최소 주가 ($)"),
    max_price: Optional[float] = Query(None, ge=0, description="최대 주가 ($)"),
    min_change_pct: Optional[float] = Query(None, description="최소 등락률 (%). 예: `2.0` → +2% 이상"),
    max_change_pct: Optional[float] = Query(None, description="최대 등락률 (%). 예: `-1.0` → -1% 이하"),
    search: Optional[str] = Query(None, description="티커 또는 회사명 부분 검색 (대소문자 무시)"),
    # ── 정렬 ──────────────────────────────────────────────────────────────────
    sort_by: str = Query(
        "market_cap",
        description=f"정렬 기준 필드. 가능한 값: {', '.join(sorted(SORT_FIELDS))}",
        example="market_cap",
    ),
    sort_order: Literal["asc", "desc"] = Query(
        "desc",
        description="정렬 방향: `asc` (오름차순) / `desc` (내림차순)",
    ),
    # ── 페이지네이션 ──────────────────────────────────────────────────────────
    limit: int = Query(
        DEFAULT_LIMIT,
        ge=1,
        le=MAX_LIMIT,
        description=f"한 번에 반환할 최대 종목 수 (1–{MAX_LIMIT})",
    ),
    offset: int = Query(0, ge=0, description="건너뛸 결과 수 (페이지네이션)"),
    # ── 의존성 ────────────────────────────────────────────────────────────────
    ds: DataStore = Depends(get_store),
):
    """
    ## 주식 스크리너 엔드포인트

    `stocks_data.json` 데이터를 파라미터 조건으로 필터링해 반환합니다.

    ### 필터 파라미터
    | 파라미터 | 설명 | 예시 |
    |---|---|---|
    | `sector` | 섹터 이름 (부분 일치) | `Technology` |
    | `min_market_cap` | 최소 시총 (십억$) | `100` |
    | `max_pe` | 최대 P/E | `25` |
    | `min_price` | 최소 주가 | `50` |
    | `max_price` | 최대 주가 | `200` |
    | `min_change_pct` | 최소 등락률 (%) | `1.0` |
    | `search` | 티커·회사명 검색 | `apple` |

    ### 정렬
    `sort_by` + `sort_order` 조합으로 정렬. 기본: 시가총액 내림차순.

    ### 페이지네이션
    `limit` + `offset` 으로 페이지 단위 조회 가능.
    """

    # sort_by 유효성 검증
    if sort_by not in SORT_FIELDS:
        raise HTTPException(
            status_code=422,
            detail=f"sort_by='{sort_by}' 는 유효하지 않습니다. 가능한 값: {sorted(SORT_FIELDS)}",
        )

    df = ds.df.copy()

    # ── 필터 적용 ─────────────────────────────────────────────────────────────
    filters_used: dict = {}

    # 1) 섹터 필터 (대소문자 무시, 부분 일치)
    if sector:
        mask = df["sector"].str.contains(sector, case=False, na=False)
        df = df[mask]
        filters_used["sector"] = sector

    # 2) 최소 시가총액 필터
    if min_market_cap is not None:
        df = df[df["market_cap"].notna() & (df["market_cap"] >= min_market_cap)]
        filters_used["min_market_cap"] = min_market_cap

    # 3) 최대 P/E 필터
    #    P/E가 None이거나 0 이하인 종목(적자 기업)은 조건을 충족하지 못하므로 제외
    if max_pe is not None:
        df = df[df["pe"].notna() & (df["pe"] > 0) & (df["pe"] <= max_pe)]
        filters_used["max_pe"] = max_pe

    # 4) 주가 범위 필터
    if min_price is not None:
        df = df[df["price"].notna() & (df["price"] >= min_price)]
        filters_used["min_price"] = min_price
    if max_price is not None:
        df = df[df["price"].notna() & (df["price"] <= max_price)]
        filters_used["max_price"] = max_price

    # 5) 등락률 범위 필터
    if min_change_pct is not None:
        df = df[df["change_pct"].notna() & (df["change_pct"] >= min_change_pct)]
        filters_used["min_change_pct"] = min_change_pct
    if max_change_pct is not None:
        df = df[df["change_pct"].notna() & (df["change_pct"] <= max_change_pct)]
        filters_used["max_change_pct"] = max_change_pct

    # 6) 텍스트 검색 (티커 또는 회사명 부분 일치)
    if search:
        q = search.lower()
        mask = (
            df["ticker"].str.lower().str.contains(q, na=False)
            | df["name"].str.lower().str.contains(q, na=False)
        )
        df = df[mask]
        filters_used["search"] = search

    total_after_filter = len(df)

    # ── 정렬 ──────────────────────────────────────────────────────────────────
    if sort_by in df.columns:
        ascending = (sort_order == "asc")
        # 숫자형 컬럼: NaN을 마지막으로 보냄
        df = df.sort_values(by=sort_by, ascending=ascending, na_position="last")

    # ── 페이지네이션 ──────────────────────────────────────────────────────────
    page_df = df.iloc[offset : offset + limit]

    # ── 결과 직렬화 ───────────────────────────────────────────────────────────
    stocks_out = [_row_to_stock(row) for row in page_df.to_dict(orient="records")]

    log.info(
        f"[screener] 필터={filters_used} | 전체결과={total_after_filter} | "
        f"반환={len(stocks_out)} | offset={offset} | sort={sort_by} {sort_order}"
    )

    return ScreenerResponse(
        total        = total_after_filter,
        returned     = len(stocks_out),
        offset       = offset,
        limit        = limit,
        sort_by      = sort_by,
        sort_order   = sort_order,
        filters_used = filters_used,
        data_age     = ds.generated_at,
        stocks       = stocks_out,
    )


# ── GET /api/sectors ─────────────────────────────────────────────────────────
@app.get(
    "/api/sectors",
    response_model=SectorsResponse,
    summary="고유 섹터 목록",
    tags=["Screener"],
)
def get_sectors(ds: DataStore = Depends(get_store)):
    """데이터에 존재하는 고유 섹터 목록을 알파벳순으로 반환합니다."""
    sectors = sorted(ds.df["sector"].dropna().unique().tolist())
    return SectorsResponse(count=len(sectors), sectors=sectors)


# ── GET /api/screener/stats ──────────────────────────────────────────────────
@app.get(
    "/api/screener/stats",
    response_model=StatsResponse,
    summary="전체 종목 통계",
    tags=["Screener"],
)
def get_stats(ds: DataStore = Depends(get_store)):
    """전체 데이터의 요약 통계(평균 시총·PER·등락률, 상승/하락 종목 수)를 반환합니다."""
    df = ds.df
    gainers = int((df["change_pct"].dropna() > 0).sum())
    losers  = int((df["change_pct"].dropna() < 0).sum())

    return StatsResponse(
        total_stocks     = len(df),
        avg_market_cap_b = _safe_avg(df["market_cap"]),
        avg_pe           = _safe_avg(df["pe"][df["pe"] > 0]),
        avg_change_pct   = _safe_avg(df["change_pct"]),
        gainers          = gainers,
        losers           = losers,
        data_age         = ds.generated_at,
    )


# ── GET /api/screener/{ticker} ───────────────────────────────────────────────
@app.get(
    "/api/screener/{ticker}",
    response_model=StockItem,
    summary="단일 종목 상세 조회",
    tags=["Screener"],
)
def get_one(ticker: str, ds: DataStore = Depends(get_store)):
    """티커 심볼로 단일 종목의 상세 데이터를 반환합니다. (대소문자 무시)"""
    row = ds.df[ds.df["ticker"].str.upper() == ticker.upper()]
    if row.empty:
        raise HTTPException(status_code=404, detail=f"종목을 찾을 수 없습니다: {ticker.upper()}")
    return _row_to_stock(row.iloc[0].to_dict())


# ── POST /reload ──────────────────────────────────────────────────────────────
@app.post(
    "/reload",
    summary="데이터 재로드",
    tags=["Admin"],
)
def reload_data():
    """
    서버 재시작 없이 `stocks_data.json` 을 다시 읽어 메모리를 갱신합니다.
    `fetch_stocks.py` 로 최신 데이터를 내려받은 직후 호출하세요.
    """
    try:
        store.load()
        return {
            "status":      "ok",
            "stock_count": len(store.df),
            "data_age":    store.generated_at,
            "reloaded_at": datetime.utcnow().isoformat() + "Z",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"재로드 실패: {e}")


# ── GET /health ───────────────────────────────────────────────────────────────
@app.get(
    "/health",
    response_model=HealthResponse,
    summary="서버 상태 확인",
    tags=["Admin"],
)
def health():
    """서버 및 데이터 로드 상태를 확인합니다."""
    return HealthResponse(
        status      = "ok" if not store.df.empty else "no_data",
        data_file   = str(DATA_FILE.resolve()),
        stock_count = len(store.df),
        data_age    = store.generated_at,
        server_time = datetime.utcnow().isoformat() + "Z",
    )


# ── 루트 ──────────────────────────────────────────────────────────────────────
@app.get("/", include_in_schema=False)
def root():
    return {
        "app":     "Stock Screener API",
        "version": "1.0.0",
        "docs":    "/docs",
        "endpoints": {
            "screener":   "GET  /api/screener",
            "sectors":    "GET  /api/sectors",
            "stats":      "GET  /api/screener/stats",
            "one_stock":  "GET  /api/screener/{ticker}",
            "reload":     "POST /reload",
            "health":     "GET  /health",
        },
    }
