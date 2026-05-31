# Multi-stage build — keeps final image lean by excluding devDependencies and src
FROM node:20-alpine AS builder

WORKDIR /app

# Install monorepo root deps first (better layer caching)
COPY package*.json ./
COPY packages/types/package*.json ./packages/types/
COPY apps/api/package*.json ./apps/api/
COPY apps/mcp/package*.json ./apps/mcp/

RUN npm ci --workspace=packages/types --workspace=apps/api --workspace=apps/mcp

# Copy source
COPY packages/types/ ./packages/types/
COPY apps/api/src/ ./apps/api/src/
COPY apps/api/tsconfig.json ./apps/api/
COPY apps/mcp/src/ ./apps/mcp/src/
COPY apps/mcp/tsconfig.json ./apps/mcp/

# Build types package first, then API and MCP
RUN npm run build -w packages/types && npm run build -w apps/api && npm run build -w apps/mcp

# ── Runtime image ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Production deps only (types package has no runtime deps — all imports are erased by tsc)
COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
COPY apps/mcp/package*.json ./apps/mcp/

RUN npm ci --omit=dev --workspace=apps/api --workspace=apps/mcp

# Copy compiled output from builder
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/mcp/dist ./apps/mcp/dist

WORKDIR /app/apps/api

EXPOSE 3001

# Default: start the API server. Workers override CMD in ECS task definitions.
CMD ["node", "dist/index.js"]
