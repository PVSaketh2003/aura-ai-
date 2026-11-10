"""macOS privacy (TCC) checks. Documents/Downloads/Desktop require the user's consent for this Python binary;
the agent never tries to change privacy settings itself — it reports what is needed."""
import os
import sys

from local_agent.config import AgentConfig


def check_roots(cfg: AgentConfig) -> list[dict]:
    out = []
    for r in cfg.roots:
        entry = {"name": r.name, "path": str(r.path), "accessible": False, "error": ""}
        try:
            os.listdir(r.path)
            entry["accessible"] = True
        except PermissionError:
            entry["error"] = (f"macOS blocked access. Open System Settings → Privacy & Security → Files and Folders "
                              f"(or Full Disk Access) and allow {sys.executable}")
        except FileNotFoundError:
            entry["error"] = "Folder does not exist."
        out.append(entry)
    return out
