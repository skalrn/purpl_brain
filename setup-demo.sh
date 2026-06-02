#!/usr/bin/env bash
# Purpl Brain — demo setup (Orion Commerce dataset)
#
# Zero config: downloads compose file, writes Claude Code settings,
# starts all services, and seeds the orion_commerce demo dataset.
#
# Usage:
#   mkdir ~/purpl-brain-demo && cd ~/purpl-brain-demo
#   curl -fsSL https://raw.githubusercontent.com/skalrn/purpl_brain/main/setup-demo.sh | bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
RESET='\033[0m'

REPO_RAW="https://raw.githubusercontent.com/skalrn/purpl_brain/main"
MCP_PORT="${MCP_HOST_PORT:-3742}"
WEB_PORT="${WEB_HOST_PORT:-3740}"
API_PORT="3741"
PROJECT_ID="orion_commerce"

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}║     Purpl Brain — Demo Setup             ║${RESET}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${RESET}"
echo ""
echo "Orion Commerce dataset — 8 weeks of e-commerce engineering decisions."
echo "No API keys or config required."
echo ""

# ── Docker check ──────────────────────────────────────────────────────────────
if ! docker info &>/dev/null; then
  echo -e "${RED}❌  Docker is not running. Start Docker Desktop and re-run.${RESET}"
  exit 1
fi
echo -e "${GREEN}✓ Docker is running${RESET}"

if ! docker compose version &>/dev/null; then
  echo -e "${RED}❌  Docker Compose V2 is required. Update Docker Desktop or install the compose plugin.${RESET}"
  exit 1
fi
echo -e "${GREEN}✓ Docker Compose V2${RESET}"

# ── LLM provider ─────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}── LLM provider ─────────────────────────────────────────${RESET}"
echo ""
echo "  1) Ollama  — runs locally, no API key needed. Slower (~14s/query)."
echo "               Requires: ollama pull llama3.1:8b nomic-embed-text:v1.5"
echo "  2) Anthropic — cloud API, fast (~2s/query). Requires an API key."
echo ""
read -rp "Choose provider [1/2, default 1]: " LLM_CHOICE
LLM_CHOICE="${LLM_CHOICE:-1}"

ANTHROPIC_API_KEY=""
LLM_PROVIDER="ollama"

if [[ "$LLM_CHOICE" == "2" ]]; then
  LLM_PROVIDER="anthropic"
  read -rp "Anthropic API key (sk-ant-...): " ANTHROPIC_API_KEY
  if [[ -z "$ANTHROPIC_API_KEY" ]]; then
    echo -e "${RED}❌  Anthropic API key is required.${RESET}"
    exit 1
  fi
else
  if ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠️   Ollama not detected at http://localhost:11434.${RESET}"
    echo "    Install from https://ollama.ai, then pull the required models:"
    echo "      ollama pull llama3.1:8b"
    echo "      ollama pull nomic-embed-text:v1.5"
    echo ""
    read -rp "Continue anyway? [y/N]: " CONTINUE
    [[ "${CONTINUE:-n}" =~ ^[Yy]$ ]] || exit 1
  else
    echo -e "${GREEN}✓ Ollama is running${RESET}"
    MISSING_MODELS=()
    for MODEL in "llama3.1:8b" "nomic-embed-text:v1.5"; do
      if ! curl -sf http://localhost:11434/api/tags | grep -q "\"$MODEL\"" 2>/dev/null; then
        MISSING_MODELS+=("$MODEL")
      fi
    done
    if [[ ${#MISSING_MODELS[@]} -gt 0 ]]; then
      echo -e "${YELLOW}⚠️   Missing Ollama models: ${MISSING_MODELS[*]}${RESET}"
      echo "    Pull them with:"
      for M in "${MISSING_MODELS[@]}"; do echo "      ollama pull $M"; done
      echo ""
      read -rp "Continue anyway? [y/N]: " CONTINUE
      [[ "${CONTINUE:-n}" =~ ^[Yy]$ ]] || exit 1
    else
      echo -e "${GREEN}✓ Required Ollama models present${RESET}"
    fi
  fi
fi

# ── Download compose file ─────────────────────────────────────────────────────
if [[ ! -f "docker-compose.demo.yml" ]]; then
  echo ""
  echo "Downloading docker-compose.demo.yml..."
  curl -fsSL "$REPO_RAW/docker-compose.demo.yml" -o docker-compose.demo.yml
  echo -e "${GREEN}✓ docker-compose.demo.yml downloaded${RESET}"
else
  echo -e "${GREEN}✓ docker-compose.demo.yml found${RESET}"
fi

# ── Write Claude Code settings ────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}── Configuring Claude Code settings ─────────────────────${RESET}"
mkdir -p ".claude/hooks"

# Download and patch hooks with orion_commerce project ID
for HOOK in "check-brain-decisions.sh" "mid-session-brain-check.sh"; do
  curl -fsSL "$REPO_RAW/.claude/hooks/$HOOK" -o ".claude/hooks/$HOOK"
  sed -i.bak "s/PROJECT_ID=\"skalrn_purpl_brain\"/PROJECT_ID=\"${PROJECT_ID}\"/" ".claude/hooks/$HOOK"
  rm -f ".claude/hooks/${HOOK}.bak"
  chmod +x ".claude/hooks/$HOOK"
done

cat > ".claude/settings.json" << CLAUDESETTINGS
{
  "mcpServers": {
    "purpl-brain-demo": {
      "url": "http://localhost:${MCP_PORT}/mcp"
    }
  },
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ${SCRIPT_DIR}/.claude/hooks/check-brain-decisions.sh"
          }
        ]
      }
    ]
  }
}
CLAUDESETTINGS
echo -e "${GREEN}✓ .claude/settings.json written — MCP and Stop hook wired${RESET}"

# ── Port conflict check ───────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}── Checking ports ───────────────────────────────────────${RESET}"
PORTS_OK=true
for PORT in "$API_PORT" "$MCP_PORT" "$WEB_PORT"; do
  if lsof -i ":${PORT}" >/dev/null 2>&1; then
    PROCESS=$(lsof -ti ":${PORT}" | xargs ps -p 2>/dev/null | tail -1 | awk '{print $4}' || echo "unknown")
    echo -e "${RED}❌  Port ${PORT} is already in use by: ${PROCESS}${RESET}"
    PORTS_OK=false
  fi
done
if [[ "$PORTS_OK" == "false" ]]; then
  echo ""
  echo "    Stop the conflicting process and re-run, or override ports:"
  echo "      MCP_HOST_PORT=3743 WEB_HOST_PORT=3741 bash setup-demo.sh"
  exit 1
fi
echo -e "${GREEN}✓ Ports ${API_PORT}, ${MCP_PORT}, ${WEB_PORT} are available${RESET}"

# ── Start services ────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}── Starting services (pulling images on first run) ──────${RESET}"
echo "(First run pulls images — typically 2-3 minutes)"
LLM_PROVIDER="$LLM_PROVIDER" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  MCP_HOST_PORT="$MCP_PORT" WEB_HOST_PORT="$WEB_PORT" \
  docker compose -f docker-compose.demo.yml up -d
echo -e "${GREEN}✓ All services started${RESET}"

# ── Wait for API ──────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}── Waiting for API to be healthy ────────────────────────${RESET}"
API_TIMEOUT=120
API_ELAPSED=0
until curl -sf "http://localhost:${API_PORT}/health" >/dev/null 2>&1; do
  if [[ $API_ELAPSED -ge $API_TIMEOUT ]]; then
    echo -e "${RED}❌  API did not become healthy within ${API_TIMEOUT}s.${RESET}"
    echo "    Check logs: docker compose -f docker-compose.demo.yml logs api"
    exit 1
  fi
  sleep 2
  API_ELAPSED=$((API_ELAPSED + 2))
done
echo -e "${GREEN}✓ API is healthy (${API_ELAPSED}s)${RESET}"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}║  Demo is running                                         ║${RESET}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo "  Web UI:  http://localhost:${WEB_PORT}  (seeding in progress — ready in ~2min)"
echo "  API:     http://localhost:${API_PORT}"
echo "  MCP:     http://localhost:${MCP_PORT}/mcp"
echo ""
echo "  Project: ${PROJECT_ID}"
echo "  API key: demo-key"
echo ""
echo -e "${YELLOW}── Claude Code ──────────────────────────────────────────${RESET}"
echo ""
echo "  Open Claude Code from this folder — MCP and Stop hook are already wired."
echo "  Try: brain_analyze_impact 'Move inventory reservation step into an async call from the order flow to simplify checkout latency' project_id=orion_commerce"
echo ""
if [[ "$LLM_PROVIDER" == "ollama" ]]; then
  echo -e "${YELLOW}  ⏱  Ollama query latency: ~14s p50, ~28s p95. This is normal.${RESET}"
  echo -e "${YELLOW}     For ~2s responses: re-run setup-demo.sh and choose Anthropic when prompted.${RESET}"
fi
echo ""
echo -e "${YELLOW}Tail logs:${RESET}"
echo "  docker compose -f docker-compose.demo.yml logs -f api extractor brain-writer"
echo ""
