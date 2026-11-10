#!/usr/bin/env python
"""One-time setup: let Aura send email AS your Gmail account through the official Gmail API (HTTPS).

Why: Render's free plan blocks SMTP ports, but HTTPS is open. The Gmail API sends genuinely from the account you
approve (e.g. pvsaketh1@gmail.com), with permission ONLY to send mail (scope gmail.send — Aura can't read your inbox).

Before running (in Google Cloud Console, signed in as the Gmail account):
  1. Create a project -> APIs & Services -> Library -> enable "Gmail API".
  2. OAuth consent screen -> External -> add your Gmail as a test user -> then "Publish app" (In production), otherwise
     Google expires the approval after 7 days. Unverified personal apps are fine; you'll see a warning you can accept.
  3. Credentials -> Create credentials -> OAuth client ID -> Application type "Desktop app" -> Download JSON.

Run (from the project folder):
    cd backend && .venv/bin/python ../scripts/gmail_authorize.py --client-secret ~/Downloads/client_secret_XXXX.json --render

  --render     store the credentials on the Render service "aura-backend" (uses your `render login`), set
               EMAIL_PROVIDER=gmail_api and redeploy. Nothing secret is printed.
  --env        instead write them to backend/.env for local use.
  --test-to    send a test email to this address afterwards (via the local code path).
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import secrets
import sys
import threading
import urllib.parse
import webbrowser
from pathlib import Path

import httpx

SCOPES = "https://www.googleapis.com/auth/gmail.send openid email"
ROOT = Path(__file__).resolve().parents[1]


def authorise(client: dict) -> tuple[str, str]:
    """Loopback OAuth flow with PKCE. Returns (refresh_token, email)."""
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    got: dict = {}

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            got.update({k: v[0] for k, v in q.items()})
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers()
            ok = "code" in got and got.get("state") == state
            self.wfile.write(("<h2>Aura: approved. You can close this tab.</h2>" if ok else
                              "<h2>Aura: not approved.</h2>").encode())

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    redirect = f"http://127.0.0.1:{srv.server_port}"
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": client["client_id"], "redirect_uri": redirect, "response_type": "code", "scope": SCOPES,
        "access_type": "offline", "prompt": "consent", "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256"})
    print("Opening Google's consent screen in your browser. Sign in as the Gmail account Aura should send from,")
    print("and approve 'Send email on your behalf'. If the browser doesn't open, visit:\n  " + url)
    webbrowser.open(url)
    t = threading.Thread(target=srv.handle_request, daemon=True)
    t.start(); t.join(timeout=600)
    srv.server_close()
    if got.get("state") != state or "code" not in got:
        sys.exit(f"Not approved ({got.get('error', 'no response')}).")
    r = httpx.post("https://oauth2.googleapis.com/token", timeout=20, data={
        "client_id": client["client_id"], "client_secret": client["client_secret"], "code": got["code"],
        "code_verifier": verifier, "grant_type": "authorization_code", "redirect_uri": redirect})
    if r.status_code >= 300:
        sys.exit(f"Token exchange failed (HTTP {r.status_code}).")
    tok = r.json()
    if "refresh_token" not in tok:
        sys.exit("Google returned no refresh token. Remove Aura at myaccount.google.com/permissions and run again.")
    payload = tok.get("id_token", "..").split(".")[1]
    email = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))).get("email", "")
    return tok["refresh_token"], email


def store_on_render(values: dict) -> None:
    import yaml
    cfg = yaml.safe_load((Path.home() / ".render" / "cli.yaml").read_text())
    h = {"Authorization": f"Bearer {cfg['api']['key']}", "Accept": "application/json"}
    svcs = httpx.get("https://api.render.com/v1/services?limit=50", headers=h, timeout=20).json()
    sid = next(x["service"]["id"] for x in svcs if x["service"]["name"] == "aura-backend")
    for k, v in values.items():
        r = httpx.put(f"https://api.render.com/v1/services/{sid}/env-vars/{k}", headers=h, json={"value": v}, timeout=20)
        print(f"  {k}: {'stored' if r.status_code < 300 else f'FAILED (HTTP {r.status_code})'}")
    r = httpx.post(f"https://api.render.com/v1/services/{sid}/deploys", headers=h, json={"clearCache": "do_not_clear"}, timeout=20)
    print("  redeploy:", "started" if r.status_code < 300 else f"FAILED (HTTP {r.status_code})")


def store_in_env(values: dict) -> None:
    env = ROOT / "backend" / ".env"
    lines = env.read_text().splitlines() if env.exists() else []
    lines = [l for l in lines if l.split("=", 1)[0] not in values]
    lines += [f"{k}={v}" for k, v in values.items()]
    env.write_text("\n".join(lines) + "\n")
    print(f"  written to {env} (keys: {', '.join(values)})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--client-secret", required=True, help="OAuth client JSON downloaded from Google Cloud (Desktop app)")
    ap.add_argument("--render", action="store_true")
    ap.add_argument("--env", action="store_true")
    ap.add_argument("--from-name", default="Aura")
    ap.add_argument("--test-to", default="")
    a = ap.parse_args()
    data = json.loads(Path(a.client_secret).expanduser().read_text())
    client = data.get("installed") or data.get("web") or data
    refresh, email = authorise(client)
    print(f"Approved for: {email or '(email not returned)'}  (permission: send email only)")
    values = {"EMAIL_PROVIDER": "gmail_api", "EMAIL_FROM": f"{a.from_name} <{email}>" if email else "",
              "GMAIL_CLIENT_ID": client["client_id"], "GMAIL_CLIENT_SECRET": client["client_secret"],
              "GMAIL_REFRESH_TOKEN": refresh}
    values = {k: v for k, v in values.items() if v}
    if a.render:
        store_on_render(values)
    if a.env or not a.render:
        store_in_env(values)
    if a.test_to:
        import os
        sys.path.insert(0, str(ROOT / "backend"))
        os.environ.update({"DJANGO_SETTINGS_MODULE": "config.settings", **values})
        import django
        django.setup()
        from apps.authentication.email_otp import _deliver
        _deliver(a.test_to, "Aura test email", "If you can read this, Aura can send email from " + (email or "your Gmail") + ".")
        print("  test email sent to", a.test_to)
    print("Done.")


if __name__ == "__main__":
    main()
