#!/usr/bin/env bash
# Purpl Brain — setup
# Gets the agent memory loop working in ~5 minutes.
# GitHub and Slack can be connected afterwards.
#
# Usage: bash setup.sh

set -euo pipefail

# Resolve script directory so paths are correct regardless of where the script is invoked from
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
RESET='\033[0m'

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}║        Purpl Brain — Setup               ║${RESET}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${RESET}"
echo ""
echo "This gets the agent memory loop working:"
echo "  1. Collect your Anthropic API key and a project name"
echo "  2. Build the MCP server"
echo "  3. Start infrastructure (Redis, Neo4j, Qdrant)"
echo "  4. Print the Claude Code MCP config to paste"
echo ""
echo -e "${YELLOW}GitHub and Slack are optional — connect them later.${RESET}"
echo ""

# ── Repo root check ──────────────────────────────────────────────────────────
if [[ ! -f "apps/api/package.json" ]]; then
  echo -e "${RED}❌  Run this script from the purpl_brain repo root.${RESET}"
  exit 1
fi

# ── Prerequisites check ───────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${RED}❌  Node.js is not installed. Install v20+ from https://nodejs.org${RESET}"
  exit 1
fi
NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo -e "${RED}❌  Node.js 20+ is required (found: $(node --version)).${RESET}"
  exit 1
fi
echo -e "${GREEN}✓ Node.js $(node --version)${RESET}"

# ── Docker check ──────────────────────────────────────────────────────────────
if ! docker info &>/dev/null; then
  echo -e "${RED}❌  Docker is not running. Start Docker Desktop and re-run.${RESET}"
  exit 1
fi
echo -e "${GREEN}✓ Docker is running${RESET}"

if ! docker compose version &>/dev/null; then
  echo -e "${RED}❌  Docker Compose V2 is required. Update Docker Desktop or install the compose plugin.${RESET}"
  echo "    See: https://docs.docker.com/compose/install/"
  exit 1
fi
echo -e "${GREEN}✓ Docker Compose V2${RESET}"

# ── LLM provider ─────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}── LLM provider ─────────────────────────────────────────${RESET}"
echo ""
echo "  1) Ollama  — runs locally, no API key needed. Slower (~14s/query)."
echo "               Requires: ollama pull llama3.1:8b qwen2.5:7b nomic-embed-text:v1.5"
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
    echo -e "${RED}❌  Anthropic API key is required for the Anthropic provider.${RESET}"
    exit 1
  fi
else
  # Verify Ollama is reachable
  if ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠️   Ollama not detected at http://localhost:11434.${RESET}"
    echo "    Install from https://ollama.ai, then pull the required models:"
    echo "      ollama pull llama3.1:8b"
    echo "      ollama pull qwen2.5:7b"
    echo "      ollama pull nomic-embed-text:v1.5"
    echo ""
    read -rp "Continue anyway? [y/N]: " CONTINUE
    [[ "${CONTINUE:-n}" =~ ^[Yy]$ ]] || exit 1
  else
    echo -e "${GREEN}✓ Ollama is running${RESET}"
    # Check for required models
    MISSING_MODELS=()
    for MODEL in "llama3.1:8b" "qwen2.5:7b" "nomic-embed-text:v1.5"; do
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

# ── Project name ──────────────────────────────────────────────────────────────
echo ""
read -rp "Project name (e.g. my_team_auth_service): " PROJECT_ID
if [[ -z "$PROJECT_ID" ]]; then
  echo -e "${RED}❌  Project name is required.${RESET}"
  exit 1
fi
# Normalise to underscore slug
PROJECT_ID="${PROJECT_ID//[^a-zA-Z0-9]/_}"

# ── Patch .claude hooks with user's project ID ────────────────────────────────
for HOOK_FILE in ".claude/hooks/check-brain-decisions.sh" ".claude/hooks/mid-session-brain-check.sh"; do
  if [[ -f "$HOOK_FILE" ]]; then
    sed -i.bak "s/PROJECT_ID=\"skalrn_purpl_brain\"/PROJECT_ID=\"${PROJECT_ID}\"/" "$HOOK_FILE"
    rm -f "${HOOK_FILE}.bak"
  fi
done
echo -e "${GREEN}✓ .claude hooks patched with project ID: ${PROJECT_ID}${RESET}"

# Generate random credentials for local use
API_KEY="pbk_$(openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)"
NEO4J_PASSWORD_GEN="$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)"

# ── Write apps/api/.env ───────────────────────────────────────────────────────
ENV_FILE="apps/api/.env"

cat > "$ENV_FILE" << ENVEOF
# Generated by setup.sh on $(date)

PORT=3001

# ── Infrastructure ──────────────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=${NEO4J_PASSWORD_GEN}
NEO4J_AUTH=neo4j/${NEO4J_PASSWORD_GEN}
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=brain_chunks
QDRANT_VECTOR_SIZE=768

# ── LLM ────────────────────────────────────────────────────────────────────
LLM_PROVIDER=${LLM_PROVIDER}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
LLM_MODEL=$([ "$LLM_PROVIDER" = "anthropic" ] && echo "claude-sonnet-4-6" || echo "llama3.1:8b")
EXTRACTION_MODEL=$([ "$LLM_PROVIDER" = "anthropic" ] && echo "claude-haiku-4-5-20251001" || echo "qwen2.5:7b")
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_FAST_MODEL=qwen2.5:7b
OLLAMA_SMART_MODEL=llama3.1:8b
OLLAMA_EMBED_MODEL=nomic-embed-text:v1.5

# ── Auth ────────────────────────────────────────────────────────────────────
# DEV_API_KEY: used for local dev authentication — matches the key in the MCP config
DEV_API_KEY=${API_KEY}
SESSION_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | base64 | head -c 44)
SESSION_COOKIE_SECURE=false

# ── Default project ─────────────────────────────────────────────────────────
DEFAULT_PROJECT_ID=${PROJECT_ID}

# ── GitHub (optional — add to connect GitHub signal) ────────────────────────
# GITHUB_TOKEN=ghp_...
# GITHUB_WEBHOOK_SECRET=local-dev-secret

# ── Slack (optional) ────────────────────────────────────────────────────────
# SLACK_BOT_TOKEN=xoxb-...
# SLACK_APP_TOKEN=xapp-...
# SLACK_CHANNEL_IDS=C01234,C05678

# ── Tuning ──────────────────────────────────────────────────────────────────
DRIFT_SEMANTIC_THRESHOLD=0.55
DRIFT_TOP_K=3
QUERY_TOP_K=20
QUERY_CONTEXT_BUDGET=$([ "$LLM_PROVIDER" = "anthropic" ] && echo "12000" || echo "6000")
ENVEOF

echo -e "${GREEN}✓ Written apps/api/.env${RESET}"

# ── Write apps/mcp/.env ───────────────────────────────────────────────────────
cat > "apps/mcp/.env" << MCPEOF
BRAIN_API_URL=http://localhost:3001
BRAIN_API_KEY=${API_KEY}
BRAIN_AGENT_ID=claude-code
MCPEOF
echo -e "${GREEN}✓ Written apps/mcp/.env${RESET}"

# ── Write root .env for docker-compose variable substitution ──────────────────
# NEO4J_AUTH must match between this file (neo4j container init) and apps/api/.env
# (API connection). Missing this file causes Neo4j to start with the wrong password.
cat > ".env" << ROOTENV
OLLAMA_BASE_URL=http://host.docker.internal:11434/v1
DRIFT_SEMANTIC_THRESHOLD=0.55
NEXT_PUBLIC_API_URL=http://localhost:3001
NEO4J_AUTH=neo4j/${NEO4J_PASSWORD_GEN}
ROOTENV
echo -e "${GREEN}✓ Written .env${RESET}"

# ── Install dependencies ──────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}── Installing dependencies ──────────────────────────────${RESET}"
npm install
echo -e "${GREEN}✓ Dependencies installed${RESET}"

# ── Build MCP server ──────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}── Building MCP server ──────────────────────────────────${RESET}"
npm run build -w apps/mcp
chmod +x apps/mcp/dist/index.js
echo -e "${GREEN}✓ MCP server built at apps/mcp/dist/index.js${RESET}"

# ── Start everything via docker compose ───────────────────────────────────────
echo ""
echo -e "${YELLOW}── Starting infrastructure + API + workers ──────────────${RESET}"
echo "(First run builds the API image — typically 2-3 minutes)"
if ! docker compose up -d --build; then
  echo -e "${RED}❌  Docker Compose failed. Last 20 lines of logs:${RESET}"
  docker compose logs --tail=20 2>/dev/null || true
  exit 1
fi
echo -e "${GREEN}✓ All services started${RESET}"

# Wait for the API to be healthy before running migrations
echo ""
echo -e "${YELLOW}── Waiting for API to be healthy ────────────────────────${RESET}"
API_TIMEOUT=120
API_ELAPSED=0
until curl -sf http://localhost:3001/health >/dev/null 2>&1; do
  if [[ $API_ELAPSED -ge $API_TIMEOUT ]]; then
    echo -e "${RED}❌  API did not become healthy within ${API_TIMEOUT}s.${RESET}"
    echo "    Check logs: docker compose logs api"
    exit 1
  fi
  sleep 2
  API_ELAPSED=$((API_ELAPSED + 2))
done
echo -e "${GREEN}✓ API is healthy (${API_ELAPSED}s)${RESET}"

# Wait for Neo4j Bolt port before running migrations — API can be healthy while Neo4j is still starting
echo ""
echo -e "${YELLOW}── Waiting for Neo4j to be ready ────────────────────────${RESET}"
NEO4J_TIMEOUT=60
NEO4J_ELAPSED=0
until nc -z localhost 7687 2>/dev/null; do
  if [[ $NEO4J_ELAPSED -ge $NEO4J_TIMEOUT ]]; then
    echo -e "${RED}❌  Neo4j Bolt port did not open within ${NEO4J_TIMEOUT}s.${RESET}"
    echo "    Check logs: docker compose logs neo4j"
    exit 1
  fi
  sleep 2
  NEO4J_ELAPSED=$((NEO4J_ELAPSED + 2))
done
sleep 3  # brief pause after port opens — Neo4j needs a moment before accepting queries
echo -e "${GREEN}✓ Neo4j is ready (${NEO4J_ELAPSED}s)${RESET}"

# Apply Neo4j schema constraints (idempotent — safe to re-run)
echo ""
echo -e "${YELLOW}── Applying Neo4j schema constraints ───────────────────${RESET}"
if ! npm run migrate:constraints -w apps/api 2>&1 | grep -v "^$"; then
  echo -e "${YELLOW}⚠️   migrate:constraints reported an error — check Neo4j logs if queries are slow.${RESET}"
fi
if ! npm run migrate:m5 -w apps/api 2>&1 | grep -v "^$"; then
  echo -e "${YELLOW}⚠️   migrate:m5 reported an error — identity fields may be missing.${RESET}"
fi
echo -e "${GREEN}✓ Schema constraints and identity fields applied${RESET}"

echo ""
echo "  - API:           http://localhost:3001"
echo "  - Web UI:        http://localhost:3000"
echo "  - Neo4j Browser: http://localhost:7474  (neo4j / ${NEO4J_PASSWORD_GEN})"
echo "  - Qdrant:        http://localhost:6333"
echo "  - Workers:       normalizer, extractor, brain-writer, drift-detector"

# ── Print MCP config ──────────────────────────────────────────────────────────
MCP_ABS_PATH="${SCRIPT_DIR}/apps/mcp/dist/index.js"

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}║  Add this to ~/.claude/settings.json                     ║${RESET}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
cat << MCPCONFIG
{
  "mcpServers": {
    "purpl-brain": {
      "command": "node",
      "args": ["${MCP_ABS_PATH}"],
      "env": {
        "BRAIN_API_URL": "http://localhost:3001",
        "BRAIN_API_KEY": "${API_KEY}",
        "BRAIN_AGENT_ID": "claude-code"
      }
    }
  }
}
MCPCONFIG

echo ""
# ── Print CLAUDE.md snippet ───────────────────────────────────────────────────
echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}║  Add this to CLAUDE.md in your project repo              ║${RESET}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
cat << 'CLAUDEMD'
## Brain (purpl-brain MCP)

The purpl-brain MCP is connected. Follow these rules in every session:

- **Session start:** call `brain_query` before picking up existing work to surface
  relevant decisions and open drift alerts. Use your project's `project_id`.
- **Before changing anything architectural:** call `brain_analyze_impact` before
  refactoring a core module, switching a library, changing an API contract, or
  any change that could invalidate a prior design decision.
- **When you make a significant choice:** call `brain_log_decision` at the end of
  the session — library choice, approach taken, approach rejected, unresolved question.
- **When you find something unexpected:** call `brain_log_signal` if you discover
  a constraint, performance finding, or API limitation that may contradict an
  existing decision.

Never skip these calls because they seem obvious — the value is in the audit trail,
not just the lookup.
CLAUDEMD

echo ""
echo -e "${YELLOW}This snippet makes Claude proactively check the brain before every significant change.${RESET}"
echo -e "${YELLOW}Without it, brain tool calls depend on model judgment and will be inconsistent.${RESET}"

# ── Print slash command ────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}║  Optional: add a /analyze-impact slash command           ║${RESET}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo "Copy this file into your project repo:"
echo ""
echo "  mkdir -p .claude/commands"
echo "  cp ${SCRIPT_DIR}/.claude/commands/analyze-impact.md .claude/commands/"
echo ""
echo "Then in any Claude Code session:"
echo ""
echo "  /analyze-impact switch auth library from JWT to session tokens"
echo ""
echo -e "${YELLOW}This gives engineers an explicit on-demand impact check before big changes.${RESET}"

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}║  Setup complete                                          ║${RESET}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo "Next steps:"
echo ""
echo "  1. Paste the MCP config above into ~/.claude/settings.json"
echo ""
echo "  2. Paste the CLAUDE.md snippet above into CLAUDE.md in your project repo"
echo "     (this makes Claude check the brain proactively — without it, coverage"
echo "     depends on model judgment and will be inconsistent)"
echo ""
echo "  3. Verify the loop end-to-end:"
echo ""
echo "     BRAIN_API_KEY=${API_KEY} npm run demo:agent-memory -w apps/api"
echo ""
if [[ "$LLM_PROVIDER" == "ollama" ]]; then
echo -e "${YELLOW}  ⏱  Ollama query latency: ~14s p50, ~28s p95. This is normal — not a hang.${RESET}"
echo -e "${YELLOW}     Switch to LLM_PROVIDER=anthropic in apps/api/.env for ~2s latency.${RESET}"
fi
echo ""
echo "  4. (Optional) copy .claude/commands/analyze-impact.md into your project"
echo "     repo for an explicit /analyze-impact slash command."
echo ""
echo "  5. Open a Claude Code session in your project repo — brain_query and"
echo "     brain_log_decision are now in the tool chain automatically."
echo ""
echo -e "${YELLOW}Tail logs:${RESET}"
echo ""
echo "  docker compose logs -f api extractor brain-writer"
echo ""
echo -e "${YELLOW}Optional — connect signal sources:${RESET}"
echo ""
echo "  GitHub:  uncomment GITHUB_TOKEN in apps/api/.env, then:"
echo "           npm run seed:github -w apps/api -- --repo org/repo"
echo ""
echo "  Slack:   uncomment SLACK_* vars in apps/api/.env, then:"
echo "           npm run worker:slack -w apps/api"
echo ""
echo "  Docs/transcripts: see README.md for the ingest API."
echo ""
