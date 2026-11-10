import hashlib
from pathlib import Path

import httpx


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def upload(server: str, token: str, request_id: str, path: Path) -> dict:
    digest = sha256(path)

    def stream():
        with open(path, "rb") as f:
            while chunk := f.read(1 << 20):
                yield chunk

    r = httpx.post(f"{server}/api/local-agent/upload/{request_id}/", content=stream(), timeout=300,
                   headers={"Authorization": f"Bearer {token}", "X-Content-Sha256": digest,
                            "X-Filename": path.name, "Content-Type": "application/pdf"})
    if r.status_code != 200:
        raise RuntimeError(f"Upload rejected ({r.status_code}): {r.text[:200]}")
    return {"sha256": digest, "size": path.stat().st_size}
