#!/usr/bin/env bash
# PostToolUse hook — fires after every tool call.
# Reminds Claude to log decisions mid-session while reasoning is still explicit.
# Uses a cooldown file to fire at most once per 45 minutes.

PROJECT_ID="skalrn_purpl_brain"
BRAIN_API_URL="${BRAIN_API_URL:-http://localhost:3001}"
COOLDOWN_MINUTES=45
COOLDOWN_FILE="/tmp/purpl-brain-mid-session-${PROJECT_ID}"
LOOKBACK_MINUTES=$COOLDOWN_MINUTES

# Skip if brain API is not running
if ! curl -sf "${BRAIN_API_URL}/health" > /dev/null 2>&1; then
  exit 0
fi

# Resolve API key
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

if [ -n "$BRAIN_API_KEY" ]; then
  API_KEY="$BRAIN_API_KEY"
elif [ -f "$ENV_FILE" ]; then
  API_KEY=$(grep -m1 '^API_KEY=' "$ENV_FILE" | cut -d= -f2-)
fi

if [ -z "$API_KEY" ]; then
  exit 0
fi

# Check cooldown — skip if we reminded less than COOLDOWN_MINUTES ago
NOW=$(date +%s)
if [ -f "$COOLDOWN_FILE" ]; then
  LAST=$(cat "$COOLDOWN_FILE")
  ELAPSED=$(( NOW - LAST ))
  if [ "$ELAPSED" -lt $(( COOLDOWN_MINUTES * 60 )) ]; then
    exit 0
  fi
fi

# Check brain API for recent decisions within the lookback window
CUTOFF=$(python3 -c "
from datetime import datetime, timezone, timedelta
cutoff = datetime.now(timezone.utc) - timedelta(minutes=$LOOKBACK_MINUTES)
print(cutoff.strftime('%Y-%m-%dT%H:%M:%S.000Z'))
")

RESPONSE=$(curl -sf \
  -H "x-api-key: ${API_KEY}" \
  "${BRAIN_API_URL}/brain/decisions/recent?project_id=${PROJECT_ID}&since=${CUTOFF}" 2>/dev/null)

COUNT=$(echo "$RESPONSE" | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin)['count'])
except Exception:
    print(-1)
")

# API call failed — don't interrupt
if [ "$COUNT" = "-1" ]; then
  exit 0
fi

# Decisions were logged recently — reset cooldown and continue silently
if [ "$COUNT" -gt 0 ]; then
  echo "$NOW" > "$COOLDOWN_FILE"
  exit 0
fi

# Nothing logged in the last 45 minutes — remind Claude and reset cooldown
echo "$NOW" > "$COOLDOWN_FILE"

cat >&2 <<'MSG'
⚠️  Brain check: no decisions logged in the last 45 minutes.

If this session has produced significant choices — a library pick, an approach
rejection, a discovered constraint — log it now while the reasoning is still
explicit in context:

  brain_log_decision({
    session_id: "<slug>",
    project_id: "skalrn_purpl_brain",
    work_completed: "<one sentence>",
    decisions: [{ id, description, rationale }]
  })

MSG
exit 2
