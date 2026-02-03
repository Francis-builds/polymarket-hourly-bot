#!/bin/bash
# Auto-deploy script for polymarket-1h-bot
# Run this after pushing to main, or set up as webhook/cron

set -e
cd ~/polymarket-bot-1h

echo "Pulling latest from main..."
git fetch origin
git checkout main
git reset --hard origin/main

echo "Creating data directories..."
mkdir -p data-1h logs-1h

echo "Setting permissions..."
sudo chown -R 1001:1001 data-1h logs-1h 2>/dev/null || true

echo "Building container..."
docker compose build --no-cache

echo "Restarting bot..."
docker compose down
docker compose up -d

echo "Waiting for startup..."
sleep 5

echo "Recent logs:"
docker compose logs --tail 20

echo "Deploy complete!"
