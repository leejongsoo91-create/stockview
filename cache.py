import time
from threading import Lock


class Cache:
    def __init__(self):
        self._data: dict = {}
        self._lock = Lock()

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
