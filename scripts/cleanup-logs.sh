#!/bin/bash
# Cleanup logs older than 3 days
# Run via cron: 0 0 * * * /home/ubuntu/polymarket-bot-1h/scripts/cleanup-logs.sh

LOGS_DIR="${1:-/home/ubuntu/polymarket-bot-1h/logs-1h}"
DAYS_TO_KEEP=3

echo "$(date): Cleaning up logs older than ${DAYS_TO_KEEP} days in ${LOGS_DIR}"

if [ -d "$LOGS_DIR" ]; then
  find "$LOGS_DIR" -name "*.log" -type f -mtime +${DAYS_TO_KEEP} -delete
  echo "$(date): Cleanup complete"
else
  echo "$(date): Logs directory not found: ${LOGS_DIR}"
fi
