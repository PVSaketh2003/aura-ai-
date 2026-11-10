#!/bin/zsh
# Installs the Aura Local Mac Agent as a launchd user agent (starts at login, restarts if it exits).
set -euo pipefail
BACKEND="$(cd "$(dirname "$0")/../backend" && pwd)"
PY="$BACKEND/.venv/bin/python"
LABEL="com.aura.localagent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/Aura"; mkdir -p "$LOGDIR"

if [[ ! -f "$HOME/Library/Application Support/Aura/agent.json" ]]; then
  echo "Pairing this Mac with your Aura account…"
  (cd "$BACKEND" && "$PY" manage.py pair_local_agent)
fi

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>-m</string><string>local_agent</string></array>
  <key>WorkingDirectory</key><string>$BACKEND</string>
  <key>EnvironmentVariables</key><dict><key>PYTHONUNBUFFERED</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOGDIR/local-agent.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/local-agent.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Local Agent installed and running. Logs: $LOGDIR/local-agent.log"
echo "If folders show as blocked, allow $PY in System Settings → Privacy & Security → Files and Folders."
