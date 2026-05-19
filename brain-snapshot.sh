#!/usr/bin/env bash
# brain-snapshot.sh — export the brain to a portable archive
#
# Creates a .tar.gz containing:
#   brain_neo4j.cypher   — all nodes + relationships as Cypher statements
#   brain_qdrant.snapshot — Qdrant collection snapshot (vectors + payloads)
#   brain_meta.json      — snapshot metadata (date, project count, node counts)
#
# Usage:
#   bash brain-snapshot.sh                         # saves brain_snapshot_<date>.tar.gz
#   bash brain-snapshot.sh my-project-v1.0         # saves brain_snapshot_my-project-v1.0.tar.gz
#   bash brain-snapshot.sh my-project-v1.0 --push  # also creates a GitHub release
#
# Restore with:
#   bash brain-restore.sh brain_snapshot_my-project-v1.0.tar.gz
#   bash brain-restore.sh my-project-v1.0          # pulls from GitHub release

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
RESET='\033[0m'

LABEL="${1:-$(date +%Y-%m-%d)}"
PUSH="${2:-}"
WORK_DIR="$(mktemp -d)"
ARCHIVE="brain_snapshot_${LABEL}.tar.gz"

NEO4J_URL="${NEO4J_HTTP_URL:-http://localhost:7474}"
NEO4J_USER="${NEO4J_USER:-neo4j}"
NEO4J_PASSWORD="${NEO4J_PASSWORD:-password}"
QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"
COLLECTION="${QDRANT_COLLECTION:-brain_chunks}"

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}║     Purpl Brain — Snapshot               ║${RESET}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${RESET}"
echo ""
echo "  Label:   $LABEL"
echo "  Output:  $ARCHIVE"
echo ""

# ── 1. Neo4j Cypher export (streaming — no file config required) ──────────────
echo -e "${YELLOW}[1/3] Exporting Neo4j graph...${RESET}"

NEO4J_EXPORT=$(curl -sf -u "${NEO4J_USER}:${NEO4J_PASSWORD}" \
  "${NEO4J_URL}/db/neo4j/tx/commit" \
  -H "Content-Type: application/json" \
  -d '{"statements":[{"statement":"CALL apoc.export.cypher.all(null, {stream: true, format: \"cypher-shell\", useOptimizations: {type: \"UNWIND_BATCH\", unwindBatchSize: 100}}) YIELD cypherStatements RETURN cypherStatements"}]}' \
  2>/dev/null)

CYPHER=$(echo "$NEO4J_EXPORT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
errs = d.get('errors', [])
if errs:
    print('ERROR: ' + errs[0].get('message','unknown'), file=sys.stderr)
    sys.exit(1)
data = d.get('results', [{}])[0].get('data', [])
if not data:
    print('', file=sys.stdout)
else:
    print(data[0]['row'][0] or '', file=sys.stdout)
")

echo "$CYPHER" > "$WORK_DIR/brain_neo4j.cypher"
CYPHER_LINES=$(wc -l < "$WORK_DIR/brain_neo4j.cypher")
echo -e "${GREEN}✓ Neo4j exported ($CYPHER_LINES lines)${RESET}"

# ── 2. Qdrant snapshot ────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[2/3] Creating Qdrant snapshot...${RESET}"

SNAP_RESP=$(curl -sf -X POST "${QDRANT_URL}/collections/${COLLECTION}/snapshots" \
  -H "Content-Type: application/json" 2>/dev/null)

SNAP_NAME=$(echo "$SNAP_RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d['result']['name'])
")

# Download the snapshot
curl -sf "${QDRANT_URL}/collections/${COLLECTION}/snapshots/${SNAP_NAME}" \
  -o "$WORK_DIR/brain_qdrant.snapshot" 2>/dev/null

SNAP_SIZE=$(du -sh "$WORK_DIR/brain_qdrant.snapshot" | cut -f1)
echo -e "${GREEN}✓ Qdrant snapshot created ($SNAP_SIZE, name: $SNAP_NAME)${RESET}"

# Clean up the snapshot from Qdrant server (we have it locally)
curl -sf -X DELETE "${QDRANT_URL}/collections/${COLLECTION}/snapshots/${SNAP_NAME}" \
  -H "Content-Type: application/json" >/dev/null 2>&1 || true

# ── 3. Metadata ───────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[3/3] Writing metadata...${RESET}"

NODE_COUNTS=$(curl -sf -u "${NEO4J_USER}:${NEO4J_PASSWORD}" \
  "${NEO4J_URL}/db/neo4j/tx/commit" \
  -H "Content-Type: application/json" \
  -d '{"statements":[{"statement":"CALL apoc.meta.stats() YIELD labels RETURN labels"}]}' \
  2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin)
data = d.get('results',[{}])[0].get('data',[])
print(json.dumps(data[0]['row'][0] if data else {}))
" 2>/dev/null || echo "{}")

PROJECT_COUNT=$(curl -sf -u "${NEO4J_USER}:${NEO4J_PASSWORD}" \
  "${NEO4J_URL}/db/neo4j/tx/commit" \
  -H "Content-Type: application/json" \
  -d '{"statements":[{"statement":"MATCH (e:Event) RETURN count(distinct e.project_id) AS n"}]}' \
  2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin)
data = d.get('results',[{}])[0].get('data',[])
print(data[0]['row'][0] if data else 0)
" 2>/dev/null || echo "0")

QDRANT_COUNT=$(curl -sf "${QDRANT_URL}/collections/${COLLECTION}" 2>/dev/null | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result',{}).get('points_count',0))" 2>/dev/null || echo "0")

cat > "$WORK_DIR/brain_meta.json" << EOF
{
  "label": "$LABEL",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "projects": $PROJECT_COUNT,
  "qdrant_vectors": $QDRANT_COUNT,
  "neo4j_node_counts": $NODE_COUNTS,
  "collection": "$COLLECTION",
  "restore_command": "bash brain-restore.sh $ARCHIVE"
}
EOF

echo -e "${GREEN}✓ Metadata written${RESET}"

# ── Package ───────────────────────────────────────────────────────────────────
tar -czf "$ARCHIVE" -C "$WORK_DIR" brain_neo4j.cypher brain_qdrant.snapshot brain_meta.json
ARCHIVE_SIZE=$(du -sh "$ARCHIVE" | cut -f1)

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}║  Snapshot complete                                       ║${RESET}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo "  Archive:   $ARCHIVE ($ARCHIVE_SIZE)"
echo "  Projects:  $PROJECT_COUNT"
echo "  Vectors:   $QDRANT_COUNT"
echo ""
echo "  Restore:   bash brain-restore.sh $ARCHIVE"
echo ""

# ── Optional GitHub release ───────────────────────────────────────────────────
if [[ "$PUSH" == "--push" ]]; then
  if ! command -v gh &>/dev/null; then
    echo -e "${RED}❌  gh CLI not found — skipping GitHub release${RESET}"
    exit 0
  fi

  META=$(cat "$WORK_DIR/brain_meta.json")
  PROJECTS=$(echo "$META" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['projects'])")
  VECTORS=$(echo "$META"  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['qdrant_vectors'])")
  CREATED=$(echo "$META"  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['created_at'])")

  echo -e "${YELLOW}Creating GitHub release brain-$LABEL...${RESET}"
  gh release create "brain-$LABEL" "$ARCHIVE" \
    --title "Brain snapshot: $LABEL" \
    --notes "$(cat <<NOTES
## Brain snapshot — $LABEL

Exported: $CREATED
Projects: $PROJECTS
Qdrant vectors: $VECTORS

### Restore

\`\`\`bash
# Download and restore
gh release download brain-$LABEL --pattern "*.tar.gz"
bash brain-restore.sh $ARCHIVE
\`\`\`
NOTES
)"
  echo -e "${GREEN}✓ GitHub release brain-$LABEL created${RESET}"
fi
