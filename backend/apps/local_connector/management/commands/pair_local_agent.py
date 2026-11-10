import json
import os
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from apps.core.models import audit
from apps.local_connector.models import LocalAgentDevice

CONFIG = Path.home() / "Library" / "Application Support" / "Aura" / "agent.json"


class Command(BaseCommand):
    help = "Pair this Mac's Local Agent with an Aura account and write its config (token never printed)."

    def add_arguments(self, p):
        p.add_argument("--username", required=False)
        p.add_argument("--server", default="http://127.0.0.1:8000")
        p.add_argument("--name", default=os.uname().nodename)

    def handle(self, *a, username=None, server=None, name=None, **kw):
        User = get_user_model()
        user = User.objects.filter(username=username).first() if username else User.objects.order_by("id").first()
        if not user:
            raise CommandError("No user found. Create your account in the web app first.")
        LocalAgentDevice.objects.filter(user=user, name=name).update(revoked=True)
        device, token = LocalAgentDevice.pair(user, name)
        existing = json.loads(CONFIG.read_text()) if CONFIG.exists() else {}
        CONFIG.parent.mkdir(parents=True, exist_ok=True)
        cfg = {"server": server.rstrip("/"), "token": token,
               "roots": existing.get("roots") or [{"name": n, "path": str(Path.home() / n)} for n in ("Documents", "Downloads", "Desktop")],
               "max_file_mb": existing.get("max_file_mb", 150)}
        fd = os.open(CONFIG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(cfg, f, indent=2)
        audit(user, "local_agent.paired", name)
        self.stdout.write(self.style.SUCCESS(f"Paired '{name}' with {user.username}. Config written to {CONFIG} (mode 600)."))
