#!/usr/bin/env bash
# Runs as a Claude Code Stop hook.
# Checks whether any decisions were logged to the brain in the last 2 hours.
# Exit 2 + message feeds back into Claude for one more turn, giving it a chance
# to call brain_log_decision before the session truly closes.

PROJECT_ID="skalrn_purpl_brain"
BRAIN_API_URL="${BRAIN_API_URL:-http://localhost:3001}"
HEALTH_URL="${BRAIN_API_URL}/health"
LOOKBACK_HOURS=2

# Resolve API key: prefer env var, fall back to .env file in repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

if [ -n "$BRAIN_API_KEY" ]; then
  API_KEY="$BRAIN_API_KEY"
elif [ -f "$ENV_FILE" ]; then
  API_KEY=$(grep -m1 '^API_KEY=' "$ENV_FILE" | cut -d= -f2-)
fi

if [ -z "$API_KEY" ]; then
  # Can't authenticate — skip silently
  exit 0
fi

# Skip if brain API is not running
if ! curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
  exit 0
fi

# Calculate the ISO cutoff timestamp
CUTOFF=$(python3 -c "
from datetime import datetime, timezone, timedelta
cutoff = datetime.now(timezone.utc) - timedelta(hours=$LOOKBACK_HOURS)
print(cutoff.strftime('%Y-%m-%dT%H:%M:%S.000Z'))
")

# Query via the brain API — no direct Neo4j access required
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

if [ "$COUNT" = "-1" ]; then
  # API call failed — don't block
  exit 0
fi

if [ "$COUNT" -eq 0 ]; then
  cat >&2 <<'MSG'
⚠️  Brain check: no decisions were logged to purpl-brain in the last 2 hours.

If this session involved any significant choices — a library pick, an approach
rejection, a discovered constraint — call brain_log_decision before closing:

  project_id:     skalrn_purpl_brain
  session_id:     <use a short slug or UUID>
  work_completed: <one sentence summary>
  decisions:      <array of {id, description, rationale}>

If nothing significant was decided, you can ignore this message.
MSG
  exit 2
fi

exit 0
