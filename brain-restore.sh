#!/usr/bin/env bash
# brain-restore.sh — restore the brain from a snapshot archive
#
# Usage:
#   bash brain-restore.sh brain_snapshot_my-project-v1.0.tar.gz  # local file
#   bash brain-restore.sh my-project-v1.0                         # GitHub release tag
#
# What it does:
#   1. Extracts the archive (or downloads from GitHub release)
#   2. Wipes Neo4j graph and reimports from Cypher dump
#   3. Deletes + recreates the Qdrant collection from snapshot
#   4. Runs demo verify to confirm everything is healthy

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
RESET='\033[0m'

INPUT="${1:-}"
if [[ -z "$INPUT" ]]; then
  echo "Usage: bash brain-restore.sh <archive.tar.gz | release-label>"
  exit 1
fi

NEO4J_URL="${NEO4J_HTTP_URL:-http://localhost:7474}"
NEO4J_USER="${NEO4J_USER:-neo4j}"

# Load NEO4J_PASSWORD from .env if not already in environment
if [[ -z "${NEO4J_PASSWORD:-}" && -f .env ]]; then
  NEO4J_PASSWORD="$(grep '^NEO4J_PASSWORD=' .env | cut -d= -f2-)"
fi
if [[ -z "${NEO4J_PASSWORD:-}" ]]; then
  echo -e "${RED}❌  NEO4J_PASSWORD is not set. Run: source .env  or export NEO4J_PASSWORD=...${RESET}"
  exit 1
fi
QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"
COLLECTION="${QDRANT_COLLECTION:-brain_chunks}"

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}║     Purpl Brain — Restore                ║${RESET}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${RESET}"
echo ""

# ── Resolve archive ───────────────────────────────────────────────────────────
ARCHIVE=""
if [[ -f "$INPUT" ]]; then
  ARCHIVE="$INPUT"
  echo "  Source: local file $ARCHIVE"
elif command -v gh &>/dev/null; then
  TAG="brain-$INPUT"
  # Strip brain- prefix if user already included it
  [[ "$INPUT" == brain-* ]] && TAG="$INPUT"
  echo -e "${YELLOW}Downloading from GitHub release $TAG...${RESET}"
  ARCHIVE="brain_snapshot_${INPUT}.tar.gz"
  gh release download "$TAG" --pattern "*.tar.gz" --output "$ARCHIVE" 2>/dev/null || {
    echo -e "${RED}❌  Could not find release $TAG or file $INPUT${RESET}"
    exit 1
  }
  echo -e "${GREEN}✓ Downloaded $ARCHIVE${RESET}"
else
  echo -e "${RED}❌  File not found and gh CLI not available: $INPUT${RESET}"
  exit 1
fi

echo ""
echo -e "${YELLOW}Extracting archive...${RESET}"
tar -xzf "$ARCHIVE" -C "$WORK_DIR"

# Show metadata
if [[ -f "$WORK_DIR/brain_meta.json" ]]; then
  python3 -c "
import json
d = json.load(open('$WORK_DIR/brain_meta.json'))
print(f'  Label:     {d[\"label\"]}')
print(f'  Created:   {d[\"created_at\"]}')
print(f'  Projects:  {d[\"projects\"]}')
print(f'  Vectors:   {d[\"qdrant_vectors\"]}')
"
fi
echo ""

# Confirm before wiping
echo -e "${RED}⚠️  This will WIPE the current Neo4j graph and Qdrant collection.${RESET}"
read -rp "Continue? [y/N] " CONFIRM
if [[ "$(echo "$CONFIRM" | tr '[:upper:]' '[:lower:]')" != "y" ]]; then
  echo "Aborted."
  exit 0
fi
echo ""

# ── 1. Neo4j restore ──────────────────────────────────────────────────────────
echo -e "${YELLOW}[1/3] Restoring Neo4j graph...${RESET}"

# Wipe all nodes and relationships
curl -sf -u "${NEO4J_USER}:${NEO4J_PASSWORD}" \
  "${NEO4J_URL}/db/neo4j/tx/commit" \
  -H "Content-Type: application/json" \
  -d '{"statements":[{"statement":"MATCH (n) DETACH DELETE n"}]}' >/dev/null 2>&1
echo "      Wiped existing graph"

# Import Cypher dump via cypher-shell inside the container
# Copy the file into the container then run cypher-shell
CONTAINER=$(docker ps --filter "name=purpl_brain-neo4j" --format "{{.Names}}" 2>/dev/null | head -1)
if [[ -z "$CONTAINER" ]]; then
  echo -e "${RED}❌  Neo4j container not running — start with: bash demo.sh start${RESET}"
  exit 1
fi

docker cp "$WORK_DIR/brain_neo4j.cypher" "${CONTAINER}:/var/lib/neo4j/import/brain_restore.cypher"
docker exec "$CONTAINER" bash -c \
  "cypher-shell -u ${NEO4J_USER} -p ${NEO4J_PASSWORD} -f /var/lib/neo4j/import/brain_restore.cypher --format plain" \
  2>&1 | tail -5

# Reapply constraints (idempotent)
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$REPO_ROOT/apps/api/package.json" ]]; then
  cd "$REPO_ROOT" && npm run migrate:constraints -w apps/api 2>&1 | grep -v "^$" || true
fi

echo -e "${GREEN}✓ Neo4j restored${RESET}"

# ── 2. Qdrant restore ─────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[2/3] Restoring Qdrant collection...${RESET}"

# Delete existing collection
curl -sf -X DELETE "${QDRANT_URL}/collections/${COLLECTION}" \
  -H "Content-Type: application/json" >/dev/null 2>&1 || true
echo "      Deleted existing collection"

# Upload snapshot and recover
SNAP_FILE="$WORK_DIR/brain_qdrant.snapshot"
SNAP_SIZE=$(du -sh "$SNAP_FILE" | cut -f1)
echo "      Uploading snapshot ($SNAP_SIZE)..."

# Upload endpoint creates (or replaces) the collection from the snapshot in one call
RECOVER_RESP=$(curl -sf -X POST \
  "${QDRANT_URL}/collections/${COLLECTION}/snapshots/upload" \
  -F "snapshot=@${SNAP_FILE}" 2>/dev/null)

STATUS=$(echo "$RECOVER_RESP" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(d.get('status', 'unknown'))
" 2>/dev/null || echo "unknown")

if [[ "$STATUS" == "ok" ]]; then
  echo -e "${GREEN}✓ Qdrant restored${RESET}"
else
  echo -e "${RED}❌  Qdrant restore returned status: $STATUS${RESET}"
  echo "    Response: $RECOVER_RESP"
  exit 1
fi

# ── 3. Verify ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[3/3] Verifying...${RESET}"

sleep 3

VECTOR_COUNT=$(curl -sf "${QDRANT_URL}/collections/${COLLECTION}" 2>/dev/null | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result',{}).get('points_count',0))" 2>/dev/null || echo "0")

NODE_COUNT=$(curl -sf -u "${NEO4J_USER}:${NEO4J_PASSWORD}" \
  "${NEO4J_URL}/db/neo4j/tx/commit" \
  -H "Content-Type: application/json" \
  -d '{"statements":[{"statement":"MATCH (n) RETURN count(n) AS n"}]}' \
  2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('results',[{}])[0].get('data',[{'row':[0]}])[0]['row'][0])
" 2>/dev/null || echo "0")

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}║  Restore complete                                        ║${RESET}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo "  Neo4j nodes:    $NODE_COUNT"
echo "  Qdrant vectors: $VECTOR_COUNT"
echo ""
echo -e "${YELLOW}Run  bash demo.sh verify  to confirm end-to-end.${RESET}"
echo ""
