# Multi-stage build — keeps final image lean by excluding devDependencies and src
FROM node:20-alpine AS builder

WORKDIR /app

# Install monorepo root deps first (better layer caching)
COPY package*.json ./
COPY packages/types/package*.json ./packages/types/
COPY apps/api/package*.json ./apps/api/

RUN npm ci --workspace=packages/types --workspace=apps/api

# Copy source
COPY packages/types/ ./packages/types/
COPY apps/api/src/ ./apps/api/src/
COPY apps/api/tsconfig.json ./apps/api/

# Build types package first, then API
RUN npm run build -w packages/types && npm run build -w apps/api

# ── Runtime image ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Production deps only
COPY package*.json ./
COPY packages/types/package*.json ./packages/types/
COPY apps/api/package*.json ./apps/api/

RUN npm ci --omit=dev --workspace=packages/types --workspace=apps/api

# Copy compiled output from builder
COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/apps/api/dist ./apps/api/dist

WORKDIR /app/apps/api

EXPOSE 3001

# Default: start the API server. Workers override CMD in ECS task definitions.
CMD ["node", "dist/index.js"]
