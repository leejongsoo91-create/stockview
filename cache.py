import time
from threading import Lock

# TTL의 이 배수만큼 재조회 없이 방치된 항목은 정리 대상.
# 스케줄러가 주기 갱신하는 캐시는 TTL 안에 계속 set()되므로 영향 없고,
# 한 번 조회되고 잊혀진 티커별 캐시(chart_*, stock_analysis_* 등)만 정리됨.
_STALE_EVICT_MULTIPLIER = 10
_CLEANUP_EVERY_N_SETS = 200


class Cache:
    def __init__(self):
        self._data: dict = {}
        self._lock = Lock()
        self._set_count = 0

    def get(self, key: str):
        with self._lock:
            item = self._data.get(key)
            if item and (time.time() - item["ts"]) < item["ttl"]:
                return item["value"]
            # stale-while-revalidate: 만료돼도 값이 있으면 반환
            if item:
                return item["value"]
        return None

    def get_fresh(self, key: str):
        """만료된 캐시는 None 반환 (stale 허용 안 함)"""
        with self._lock:
            item = self._data.get(key)
            if item and (time.time() - item["ts"]) < item["ttl"]:
                return item["value"]
        return None

    def set(self, key: str, value, ttl: int = 300):
        with self._lock:
            self._data[key] = {"value": value, "ts": time.time(), "ttl": ttl}
            self._set_count += 1
            if self._set_count % _CLEANUP_EVERY_N_SETS == 0:
                self._evict_stale_locked()

    def _evict_stale_locked(self):
        """호출자가 이미 락을 보유한 상태에서 방치된 항목 정리"""
        now = time.time()
        expired = [k for k, v in self._data.items()
                   if (now - v["ts"]) > v["ttl"] * _STALE_EVICT_MULTIPLIER]
        for k in expired:
            del self._data[k]

    def status(self) -> dict:
        with self._lock:
            now = time.time()
            return {
                k: {
                    "age_sec": round(now - v["ts"], 1),
                    "ttl": v["ttl"],
                    "fresh": (now - v["ts"]) < v["ttl"],
                    "size": len(v["value"]) if isinstance(v["value"], (list, dict, set)) else 1,
                }
                for k, v in self._data.items()
            }
