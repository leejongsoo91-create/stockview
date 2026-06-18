#!/usr/bin/env python3
"""
S&P 500 주요 금융 데이터 수집 스크립트
─────────────────────────────────────────
라이브러리 : yfinance, pandas
출력 파일  : stocks_data.json
실행 방법  : python fetch_stocks.py
옵션       : python fetch_stocks.py --limit 10   (테스트용 10종목)
             python fetch_stocks.py --output out.json
"""

import argparse
import json
import logging
import math
import sys
import time
from datetime import datetime
from pathlib import Path

import pandas as pd
import yfinance as yf

# ── 로깅 설정 ────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("fetch_stocks.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

# ── 상수 ─────────────────────────────────────────────────────────────────────
WIKIPEDIA_URL   = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
DELAY_SEC       = 0.4   # 종목당 대기 시간 (Rate Limit 방지)
MAX_RETRIES     = 3     # 실패 시 최대 재시도 횟수
RETRY_BASE_SEC  = 5.0   # 재시도 대기 시간 기본값 (지수 백오프)


# ── 유틸리티 함수 ─────────────────────────────────────────────────────────────
def safe_float(value, default=None) -> float | None:
    """None·NaN·inf를 안전하게 float으로 변환"""
    try:
        if value is None:
            return default
        f = float(value)
        if math.isnan(f) or math.isinf(f):
            return default
        return round(f, 4)
    except (TypeError, ValueError):
        return default


def safe_int(value, default=None) -> int | None:
    """None·NaN을 안전하게 int으로 변환"""
    try:
        if value is None:
            return default
        f = float(value)
        if math.isnan(f) or math.isinf(f):
            return default
        return int(f)
    except (TypeError, ValueError):
        return default


def fmt_b(value_usd: int | None) -> float | None:
    """달러 → 십억 달러(B) 변환"""
    if value_usd is None:
        return None
    return round(value_usd / 1_000_000_000, 2)


# ── S&P 500 종목 리스트 수집 ──────────────────────────────────────────────────
def get_sp500_list() -> list[dict]:
    """
    Wikipedia에서 S&P 500 구성 종목을 파싱해 반환.

    반환 형식:
        [{"ticker": "AAPL", "name": "Apple Inc.", "sector": "Information Technology"}, ...]
    """
    log.info("S&P 500 종목 리스트 로딩 중 (Wikipedia)...")
    try:
        tables = pd.read_html(WIKIPEDIA_URL, header=0)
        df = tables[0]

        # 컬럼 표준화 (Wikipedia 테이블 구조에 따라 이름이 다를 수 있음)
        col_map = {
            "Symbol":       "ticker",
            "Security":     "name",
            "GICS Sector":  "sector",
        }
        df = df.rename(columns=col_map)

        # 필수 컬럼 확인
        for col in ("ticker", "name", "sector"):
            if col not in df.columns:
                raise ValueError(f"필수 컬럼 '{col}'을 찾을 수 없습니다. 컬럼 목록: {list(df.columns)}")

        # yfinance 형식: BRK.B → BRK-B
        df["ticker"] = df["ticker"].str.replace(".", "-", regex=False)

        records = df[["ticker", "name", "sector"]].to_dict(orient="records")
        log.info(f"S&P 500 파싱 완료: 총 {len(records)}개 종목")
        return records

    except Exception as e:
        log.error(f"S&P 500 리스트 파싱 실패: {e}")
        raise


# ── 단일 종목 데이터 수집 ─────────────────────────────────────────────────────
def fetch_one(ticker: str, wiki_name: str, wiki_sector: str) -> dict | None:
    """
    yfinance로 단일 종목의 주요 금융 데이터를 수집.

    수집 항목:
        티커, 회사명, 섹터, 주가, 등락률($·%), 시가총액(B$),
        P/E, EPS, 거래량, 52주 고/저

    실패 시 None 반환 (로그 기록 후 스킵).
    """
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            t    = yf.Ticker(ticker)
            info = t.info  # dict (약 100여 개 필드)

            # ── 빈 응답 감지 ──────────────────────────────────────────────────
            # quoteType 없으면 API가 의미있는 데이터를 반환하지 않은 것
            if not info or "quoteType" not in info:
                log.warning(f"  [{ticker}] 빈 응답 수신 → 스킵")
                return None

            # ── 현재가 (우선순위 폴백) ────────────────────────────────────────
            price = (
                safe_float(info.get("regularMarketPrice"))
                or safe_float(info.get("currentPrice"))
                or safe_float(info.get("previousClose"))
            )

            # ── 등락 금액 / 등락률 ────────────────────────────────────────────
            change     = safe_float(info.get("regularMarketChange"), 0.0)
            change_pct = safe_float(info.get("regularMarketChangePercent"), 0.0)

            # ── 시가총액: 달러 → 십억 달러(B$) ───────────────────────────────
            market_cap_b = fmt_b(safe_int(info.get("marketCap")))

            # ── P/E 비율: trailingPE → forwardPE 폴백 ────────────────────────
            pe = safe_float(info.get("trailingPE")) or safe_float(info.get("forwardPE"))

            # ── EPS ───────────────────────────────────────────────────────────
            eps = safe_float(info.get("trailingEps"))

            # ── 거래량 ────────────────────────────────────────────────────────
            volume = (
                safe_int(info.get("regularMarketVolume"))
                or safe_int(info.get("volume"))
            )

            # ── 52주 고/저 ────────────────────────────────────────────────────
            week52_high = safe_float(info.get("fiftyTwoWeekHigh"))
            week52_low  = safe_float(info.get("fiftyTwoWeekLow"))

            return {
                "ticker":       ticker,
                "name":         info.get("longName") or info.get("shortName") or wiki_name,
                "sector":       info.get("sector")   or wiki_sector,
                "industry":     info.get("industry", ""),
                "price":        price,
                "change":       change,
                "change_pct":   change_pct,
                "volume":       volume,
                "market_cap":   market_cap_b,
                "pe":           pe,
                "eps":          eps,
                "week52_high":  week52_high,
                "week52_low":   week52_low,
                "currency":     info.get("currency", "USD"),
                "exchange":     info.get("exchange", ""),
                "fetched_at":   datetime.utcnow().isoformat() + "Z",
            }

        except Exception as e:
            wait = RETRY_BASE_SEC * attempt  # 지수 백오프: 5s, 10s, 15s
            log.warning(f"  [{ticker}] 시도 {attempt}/{MAX_RETRIES} 실패 ({e}) → {wait:.0f}초 대기 후 재시도")
            if attempt < MAX_RETRIES:
                time.sleep(wait)

    log.error(f"  [{ticker}] {MAX_RETRIES}회 재시도 후 최종 실패 → 스킵")
    return None


# ── 전체 종목 수집 ────────────────────────────────────────────────────────────
def fetch_all(sp500_list: list[dict]) -> tuple[list[dict], list[str]]:
    """
    S&P 500 전체 종목을 순차 조회.

    Returns:
        (성공 데이터 리스트, 실패 티커 리스트)
    """
    results  : list[dict] = []
    failures : list[str]  = []
    total = len(sp500_list)

    log.info(f"\n{'─'*60}")
    log.info(f"총 {total}개 종목 수집 시작 (예상 소요: ~{total * DELAY_SEC / 60:.0f}분)")
    log.info(f"{'─'*60}")

    for i, meta in enumerate(sp500_list, 1):
        ticker     = meta["ticker"]
        wiki_name  = meta["name"]
        wiki_sector = meta["sector"]

        log.info(f"[{i:3d}/{total}] {ticker:<8} 조회 중...")

        data = fetch_one(ticker, wiki_name, wiki_sector)

        if data:
            results.append(data)
            log.info(
                f"          ✅ 주가=${data['price']}  "
                f"등락={data['change_pct']:+.2f}%  "
                f"시총=${data['market_cap']}B  "
                f"P/E={data['pe']}"
            )
        else:
            failures.append(ticker)
            log.warning(f"          ❌ 데이터 없음")

        # Rate Limit 방지 대기
        time.sleep(DELAY_SEC)

    return results, failures


# ── JSON 저장 ─────────────────────────────────────────────────────────────────
def save_json(stocks: list[dict], failures: list[str], output_path: str):
    """수집 결과를 JSON 파일로 저장"""

    # 섹터별 통계 계산
    sector_counts: dict[str, int] = {}
    for s in stocks:
        sector = s.get("sector") or "Unknown"
        sector_counts[sector] = sector_counts.get(sector, 0) + 1

    payload = {
        "generated_at":   datetime.utcnow().isoformat() + "Z",
        "total_count":    len(stocks),
        "failed_count":   len(failures),
        "failed_tickers": failures,
        "sector_summary": dict(sorted(sector_counts.items())),
        "stocks":         stocks,
    }

    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    size_kb = path.stat().st_size / 1024
    log.info(f"저장 완료: {path.resolve()} ({size_kb:.1f} KB)")


# ── 요약 출력 ─────────────────────────────────────────────────────────────────
def print_summary(stocks: list[dict], failures: list[str], elapsed: float, output_path: str):
    """수집 완료 후 요약 정보 출력"""
    log.info(f"\n{'='*60}")
    log.info("  수집 완료 요약")
    log.info(f"{'='*60}")
    log.info(f"  성공: {len(stocks)}개 / 실패: {len(failures)}개")
    log.info(f"  소요: {elapsed:.0f}초 ({elapsed/60:.1f}분)")
    log.info(f"  출력: {Path(output_path).resolve()}")

    if failures:
        log.warning(f"\n  ⚠ 실패 종목 ({len(failures)}개):")
        log.warning(f"    {', '.join(failures)}")

    # 섹터별 종목 수
    sector_counts: dict[str, int] = {}
    for s in stocks:
        sec = s.get("sector") or "Unknown"
        sector_counts[sec] = sector_counts.get(sec, 0) + 1

    log.info(f"\n  섹터별 종목 수:")
    for sec, cnt in sorted(sector_counts.items()):
        log.info(f"    {sec:<40} {cnt:>3}개")

    log.info(f"{'='*60}")


# ── 진입점 ────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="S&P 500 주요 금융 데이터를 yfinance로 수집해 JSON으로 저장"
    )
    parser.add_argument(
        "--output", "-o",
        default="stocks_data.json",
        help="출력 JSON 파일 경로 (기본값: stocks_data.json)",
    )
    parser.add_argument(
        "--limit", "-l",
        type=int,
        default=0,
        help="수집할 종목 수 제한 (기본값: 0 = 전체). 테스트 시 예: --limit 10",
    )
    parser.add_argument(
        "--delay", "-d",
        type=float,
        default=DELAY_SEC,
        help=f"종목당 대기 시간(초) (기본값: {DELAY_SEC})",
    )
    args = parser.parse_args()

    global DELAY_SEC
    DELAY_SEC = args.delay

    log.info("=" * 60)
    log.info("  S&P 500 금융 데이터 수집 스크립트")
    log.info(f"  출력 파일  : {args.output}")
    log.info(f"  종목 제한  : {'전체' if args.limit == 0 else f'{args.limit}개'}")
    log.info(f"  대기 시간  : {DELAY_SEC}초/종목")
    log.info("=" * 60)

    # 1. S&P 500 리스트 수집
    sp500_list = get_sp500_list()

    # 테스트 모드: 지정한 수만큼만 처리
    if args.limit > 0:
        sp500_list = sp500_list[:args.limit]
        log.info(f"테스트 모드: 상위 {args.limit}개 종목만 처리")

    # 2. 데이터 수집
    t0 = time.time()
    stocks, failures = fetch_all(sp500_list)
    elapsed = time.time() - t0

    # 3. JSON 저장
    save_json(stocks, failures, args.output)

    # 4. 요약 출력
    print_summary(stocks, failures, elapsed, args.output)


if __name__ == "__main__":
    main()
