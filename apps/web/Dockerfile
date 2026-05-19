FROM node:20-alpine AS builder

WORKDIR /app

# Build args — NEXT_PUBLIC_* must be present at build time to be baked into
# the client bundle by Next.js. Runtime environment vars are not visible to
# the browser in standalone mode.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ARG NEXT_PUBLIC_API_KEY=dev-local
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
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
