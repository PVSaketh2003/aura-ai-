#!/bin/bash
# Run Aura as an always-on server on this Mac (per-user LaunchAgents: start at login, restart if they stop).
#   com.aura.backend   Daphne (production ASGI server) on 127.0.0.1:8000 — only reachable locally and via the tunnel
#   com.aura.awake     keeps the Mac from idle-sleeping while plugged in (the display may still sleep)
#   com.aura.tunnel    Cloudflare Tunnel → https://api.aura.pvsairamsaketh.in   (only if ~/.cloudflared/config.yml exists)
# Postgres, Redis and Ollama already run as Homebrew services.     Uninstall: scripts/mac-server/install.sh --remove
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LA="$HOME/Library/LaunchAgents"; LOGS="$HOME/Library/Logs/Aura"; mkdir -p "$LA" "$LOGS"
PATHS="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

unload() { launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true; }
if [ "${1:-}" = "--remove" ]; then
  for n in com.aura.backend com.aura.awake com.aura.tunnel; do unload $n; rm -f "$LA/$n.plist"; done; echo "removed"; exit 0
fi

agent() {  # name, keepalive(true/false), program args...
  local name=$1 keep=$2; shift 2
  local args=""; for a in "$@"; do args+="    <string>$a</string>"$'\n'; done
  cat > "$LA/$name.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$name</string>
  <key>ProgramArguments</key><array>
$args  </array>
  <key>WorkingDirectory</key><string>$ROOT/backend</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATHS</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><$keep/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/$name.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$name.log</string>
</dict></plist>
PLIST
  unload "$name"; launchctl bootstrap "gui/$(id -u)" "$LA/$name.plist"
  echo "✓ $name"
}

cd "$ROOT/backend"
.venv/bin/python manage.py migrate --noinput >/dev/null
.venv/bin/python manage.py collectstatic --noinput -v 0
agent com.aura.backend true "$ROOT/backend/.venv/bin/daphne" -b 127.0.0.1 -p 8000 --proxy-headers config.asgi:application
agent com.aura.awake true /usr/bin/caffeinate -s -i
if [ -f "$HOME/.cloudflared/config.yml" ]; then
  agent com.aura.tunnel true "$(command -v cloudflared)" tunnel --no-autoupdate run
else
  echo "… tunnel not configured yet (run: cloudflared tunnel login), skipped"
fi
echo "logs: $LOGS"
