#!/usr/bin/env bash
set -e  # exit immediately on any error

echo "==> Initializing git submodules..."
git submodule update --init --recursive

echo "==> Installing wrapper dependencies..."
npm install

echo "==> Installing dependencies for each service..."

# ─── Service install directories ─────────────────────────────────────────────
# Map each service to the subdirectory where its package.json or requirements.txt lives.
# Format: "service_name:install_dir"
service_dirs=(
  "instacrave:instacrave/backend"
  "birddrop:birddrop/backend"
  "lila:lila/server"
  "pollrabbit:pollrabbit"
  "cuber:cuber"
)
# ─── ADD NEW PROJECT HERE ────────────────────────────────────────────────────
# "newproject:newproject"
# ─────────────────────────────────────────────────────────────────────────────

for entry in "${service_dirs[@]}"; do
  svc="${entry%%:*}"
  dir="${entry##*:}"

  if [ ! -d "$dir" ]; then
    echo "  !! WARNING: folder '$dir' not found, skipping $svc"
    continue
  fi

  if [ -f "$dir/requirements.txt" ]; then
    echo "  -> pip install in $dir ($svc)"
    pip install -r "$dir/requirements.txt"
  elif [ -f "$dir/package.json" ]; then
    echo "  -> npm install in $dir ($svc)"
    (cd "$dir" && npm install --omit=dev)
  else
    echo "  !! WARNING: no package.json or requirements.txt in '$dir', skipping $svc"
  fi
done

echo "==> Starting PM2 with all services..."
npx pm2 start ecosystem.config.js --no-daemon &

echo "==> Waiting for services to boot (5s)..."
sleep 5

echo "==> Starting proxy on port ${PORT:-10000}..."
node proxy.js

