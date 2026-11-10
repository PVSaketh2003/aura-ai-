"""Path authorization. Every path is resolved (symlinks included) and must stay inside an authorized root."""
from __future__ import annotations

import os
from pathlib import Path

from local_agent.config import AgentConfig, Root

ALLOWED_EXT = {".pdf"}
SKIP_DIRS = {".git", "node_modules", ".Trash", "Library", "__pycache__", ".venv", "venv", ".cache"}


class AccessDenied(Exception):
    pass


def root_for(cfg: AgentConfig, real: Path) -> Root | None:
    for r in cfg.active_roots:
        if real == r.path or real.is_relative_to(r.path):
            return r
    return None


def resolve(cfg: AgentConfig, path: str, *, must_be_file: bool = False, must_be_dir: bool = False) -> tuple[Path, Root]:
    if not isinstance(path, str) or not path or "\x00" in path or len(path) > 2048:
        raise AccessDenied("Invalid path.")
    p = Path(path).expanduser()
    if not p.is_absolute():
        # relative paths are interpreted against the root named by their first component, e.g. "Documents/x.pdf"
        first, *rest = p.parts
        match = next((r for r in cfg.active_roots if r.name.lower() == first.lower()), None)
        if not match:
            raise AccessDenied(f"'{first}' is not an authorized folder.")
        p = match.path.joinpath(*rest)
    try:
        real = p.resolve(strict=True)
    except (FileNotFoundError, RuntimeError):
        raise AccessDenied("That file or folder does not exist.")
    root = root_for(cfg, real)
    if root is None:
        raise AccessDenied("Access outside authorized folders is not allowed.")
    if any(part.startswith(".") for part in real.relative_to(root.path).parts):
        raise AccessDenied("Hidden files and folders are not accessible.")
    if must_be_file:
        if not real.is_file():
            raise AccessDenied("Not a file.")
        if real.suffix.lower() not in ALLOWED_EXT:
            raise AccessDenied(f"File type {real.suffix or '(none)'} is not allowed; only PDF files can be read.")
        size = real.stat().st_size
        if size > cfg.max_file_bytes:
            raise AccessDenied(f"File is {size / 1e6:.0f} MB, over the {cfg.max_file_bytes / 1e6:.0f} MB limit.")
        with open(real, "rb") as f:
            if not f.read(1024).lstrip().startswith(b"%PDF-"):
                raise AccessDenied("File does not look like a valid PDF.")
    if must_be_dir and not real.is_dir():
        raise AccessDenied("Not a folder.")
    return real, root


def describe(cfg: AgentConfig, real: Path, root: Root) -> dict:
    st = real.stat()
    return {"path": str(real), "display": f"{root.name}/{real.relative_to(root.path)}" if real != root.path else root.name,
            "name": real.name, "root": root.name, "size": st.st_size, "modified": int(st.st_mtime),
            "is_dir": real.is_dir()}


def walk(root: Path, max_depth: int = 8):
    base = len(root.parts)
    for dirpath, dirnames, filenames in os.walk(root, onerror=lambda e: None):
        depth = len(Path(dirpath).parts) - base
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS and depth < max_depth
                       and not d.endswith((".app", ".photoslibrary", ".bundle"))]
        yield Path(dirpath), dirnames, filenames
