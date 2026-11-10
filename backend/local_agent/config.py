import json
from dataclasses import dataclass, field
from pathlib import Path

CONFIG_PATH = Path.home() / "Library" / "Application Support" / "Aura" / "agent.json"
VERSION = "1.0.0"


@dataclass
class Root:
    name: str
    path: Path


@dataclass
class AgentConfig:
    server: str
    token: str
    roots: list[Root]
    max_file_bytes: int
    disabled: set[str] = field(default_factory=set)

    @property
    def active_roots(self) -> list[Root]:
        return [r for r in self.roots if r.name not in self.disabled]


def load_config(path: Path = CONFIG_PATH) -> AgentConfig:
    if not path.exists():
        raise SystemExit(f"No agent config at {path}. Run: python manage.py pair_local_agent")
    if path.stat().st_mode & 0o077:
        raise SystemExit(f"{path} must not be readable by other users (chmod 600).")
    raw = json.loads(path.read_text())
    roots = [Root(r["name"], Path(r["path"]).expanduser().resolve()) for r in raw.get("roots", [])]
    return AgentConfig(raw["server"].rstrip("/"), raw["token"], roots, int(raw.get("max_file_mb", 150)) * 1024 * 1024)


def add_root(name: str, path: str, cfg_path: Path = CONFIG_PATH) -> None:
    """Authorizing a new folder is a local, explicit action (never remote)."""
    p = Path(path).expanduser().resolve(strict=True)
    if not p.is_dir():
        raise SystemExit(f"{p} is not a directory")
    if p == Path("/") or p == Path.home() or str(p).startswith(("/System", "/private", "/etc", "/usr", "/bin", "/sbin")):
        raise SystemExit("Refusing to authorize system folders or your entire home directory.")
    raw = json.loads(cfg_path.read_text())
    raw["roots"] = [r for r in raw.get("roots", []) if r["name"] != name] + [{"name": name, "path": str(p)}]
    cfg_path.write_text(json.dumps(raw, indent=2))
