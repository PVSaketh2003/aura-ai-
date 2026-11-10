#!/bin/sh
# Persistent state (ChromaDB, uploads, downloaded models) lives on the mounted disk at /var/data, never in the image.
set -e
if [ -d /var/data ] && [ -w /var/data ]; then
  mkdir -p /var/data/app /var/data/media /var/data/hf
  if [ ! -L /app/data ]; then
    [ -d /app/data ] && cp -rn /app/data/. /var/data/app/ 2>/dev/null || true
    rm -rf /app/data && ln -s /var/data/app /app/data
  fi
  export MEDIA_ROOT="${MEDIA_ROOT:-/var/data/media}"
fi
python manage.py migrate --noinput
exec "$@"
