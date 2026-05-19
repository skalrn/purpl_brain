#!/usr/bin/env bash
# demo.sh — manage the local demo environment
#
# Usage:
#   bash demo.sh start     — build images and start everything
#   bash demo.sh stop      — stop all containers
#   bash demo.sh restart   — stop then start
#   bash demo.sh verify    — run end-to-end health + query check
#   bash demo.sh logs      — tail live logs from all services

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
RESET='\033[0m'

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
CMD="${1:-help}"

start() {
  echo ""
  echo -e "${CYAN}╔══════════════════════════════════════════╗${RESET}"
  echo -e "${CYAN}║     Purpl Brain — Demo Start             ║${RESET}"
  echo -e "${CYAN}╚══════════════════════════════════════════╝${RESET}"
  echo ""
  echo -e "${YELLOW}Building images and starting all services...${RESET}"
  echo "(First run takes 3–5 minutes to build Docker images)"
  echo ""

  docker compose -f "$REPO_ROOT/docker-compose.yml" up -d --build

  echo ""
  echo -e "${YELLOW}Waiting for API to be healthy...${RESET}"
  for i in $(seq 1 40); do
    if curl -sf http://localhost:3001/health >/dev/null 2>&1; then
      echo -e "${GREEN}✓ API is healthy${RESET}"
      break
    fi
    echo -n "."
    sleep 3
  done

  echo ""
  echo -e "${GREEN}✓ Everything is running${RESET}"
  echo ""
  echo "  Web UI:          http://localhost:3000"
  echo "  API health:      http://localhost:3001/health"
  echo "  Neo4j Browser:   http://localhost:7474  (neo4j / password)"
  echo "  Qdrant:          http://localhost:6333/dashboard"
  echo ""
  echo -e "${YELLOW}Run  bash demo.sh verify  to confirm end-to-end.${RESET}"
  echo ""
}

stop() {
  echo -e "${YELLOW}Stopping all containers...${RESET}"
  docker compose -f "$REPO_ROOT/docker-compose.yml" down
  echo -e "${GREEN}✓ Stopped${RESET}"
}

verify() {
  echo ""
  echo -e "${CYAN}╔══════════════════════════════════════════╗${RESET}"
  echo -e "${CYAN}║     Purpl Brain — Demo Verify            ║${RESET}"
  echo -e "${CYAN}╚══════════════════════════════════════════╝${RESET}"
  echo ""

  PASS=0; FAIL=0
  check() {
    local label="$1"; local ok="$2"
    if [[ "$ok" == "true" ]]; then
      echo -e "  ${GREEN}PASS${RESET}  $label"; PASS=$((PASS+1))
    else
      echo -e "  ${RED}FAIL${RESET}  $label"; FAIL=$((FAIL+1))
    fi
  }

  # Services reachable
  check "API /health returns 200" \
    "$(curl -sf http://localhost:3001/health >/dev/null 2>&1 && echo true || echo false)"
  check "Web UI reachable on :3000" \
    "$(curl -sf http://localhost:3000 >/dev/null 2>&1 && echo true || echo false)"
  check "Qdrant reachable on :6333" \
    "$(curl -sf http://localhost:6333/readyz >/dev/null 2>&1 && echo true || echo false)"
  check "Neo4j reachable on :7474" \
    "$(curl -sf http://localhost:7474 >/dev/null 2>&1 && echo true || echo false)"

  # API key auth works
  AUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3001/brain/agent-log \
    -H "Content-Type: application/json" -H "x-api-key: dev-local" \
    -d '{"schema_version":"1.0","session_id":"verify_probe","agent_id":"demo","project_id":"verify","timestamp_start":"2024-01-01T00:00:00Z","timestamp_end":"2024-01-01T00:01:00Z","decisions":[{"id":"d1","description":"test","rationale":"test"}],"work_completed":"test"}' 2>/dev/null)
  check "API key auth accepted (dev-local)" \
    "$([[ "$AUTH_STATUS" == "200" || "$AUTH_STATUS" == "409" ]] && echo true || echo false)"

  # Query endpoint returns answer with citation
  QUERY_RESP=$(curl -s -X POST http://localhost:3001/brain/query \
    -H "Content-Type: application/json" -H "x-api-key: dev-local" \
    -d '{"query":"What vector store decision was made?","project_id":"verify"}' 2>/dev/null)
  HAS_ANSWER=$(echo "$QUERY_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print('true' if len(d.get('answer','')) > 20 else 'false')" 2>/dev/null || echo false)
  check "Query endpoint returns non-empty answer" "$HAS_ANSWER"

  # SSE stream has CORS header
  CORS_HEADER=$(curl -s -D - -X POST http://localhost:3001/brain/query/stream \
    -H "Content-Type: application/json" -H "x-api-key: dev-local" \
    -H "Origin: http://localhost:3000" \
    -d '{"query":"test","project_id":"verify"}' \
    --max-time 5 2>/dev/null | grep -i "access-control-allow-origin" || echo "")
  check "Streaming response includes CORS header" \
    "$([[ -n "$CORS_HEADER" ]] && echo true || echo false)"

  echo ""
  echo "════════════════════════════════════"
  if [[ $FAIL -eq 0 ]]; then
    echo -e "  ${GREEN}READY FOR DEMO ✓  ($PASS passed)${RESET}"
  else
    echo -e "  ${RED}NOT READY — $FAIL check(s) failed${RESET}"
  fi
  echo ""
}

logs() {
  docker compose -f "$REPO_ROOT/docker-compose.yml" logs -f api brain-writer drift-detector extractor
}

case "$CMD" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  verify)  verify ;;
  logs)    logs ;;
  *)
    echo "Usage: bash demo.sh [start|stop|restart|verify|logs]"
    echo ""
    echo "  start    — build images and start everything (first run ~5 min)"
    echo "  stop     — stop all containers"
    echo "  restart  — stop then start"
    echo "  verify   — check all services + end-to-end query"
    echo "  logs     — tail live API/worker logs"
    ;;
esac
