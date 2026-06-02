FROM node:20-alpine AS builder

WORKDIR /app

# Build-time vars baked into the Next.js bundle.
# NEXT_PUBLIC_API_KEY is empty by default — set to a demo key for demo images.
ARG NEXT_PUBLIC_API_URL=http://localhost:3741
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_API_KEY=""
ENV NEXT_PUBLIC_API_KEY=$NEXT_PUBLIC_API_KEY

COPY package*.json ./
COPY packages/types/package*.json ./packages/types/
COPY apps/web/package*.json ./apps/web/

RUN npm ci --workspace=packages/types --workspace=apps/web

COPY packages/types/ ./packages/types/
COPY apps/web/ ./apps/web/

RUN npm run build -w packages/types && npm run build -w apps/web

# ── Runtime image ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# standalone output bundles everything needed to run
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "apps/web/server.js"]
