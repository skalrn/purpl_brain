#!/usr/bin/env bash
# Runs as a Claude Code Stop hook.
# Checks whether any decisions were logged to the brain in the last 2 hours.
# Exit 2 + message feeds back into Claude for one more turn, giving it a chance
# to call brain_log_decision before the session truly closes.

PROJECT_ID="skalrn_purpl_brain"
NEO4J_URI="http://localhost:7474"
NEO4J_USER="neo4j"
NEO4J_PASS="password"
HEALTH_URL="http://localhost:3001/health"
LOOKBACK_HOURS=2

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

# Query Neo4j for Decision nodes written in the lookback window for this project
QUERY=$(cat <<EOF
{
  "statements": [{
    "statement": "MATCH (d:Decision) WHERE d.project_id = '$PROJECT_ID' AND d.valid_from >= '$CUTOFF' RETURN count(d) AS n"
  }]
}
EOF
)

RESPONSE=$(curl -sf \
  -u "${NEO4J_USER}:${NEO4J_PASS}" \
  -H "Content-Type: application/json" \
  -d "$QUERY" \
  "${NEO4J_URI}/db/neo4j/tx/commit" 2>/dev/null)

COUNT=$(echo "$RESPONSE" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(data['results'][0]['data'][0]['row'][0])
except Exception:
    print(-1)
")

if [ "$COUNT" = "-1" ]; then
  # Neo4j query failed — don't block
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
