# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package manifests
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/server/package.json ./packages/server/
COPY packages/extension/package.json ./packages/extension/
COPY packages/e2e/package.json ./packages/e2e/

RUN npm ci

# Copy sources
COPY packages/protocol ./packages/protocol
COPY packages/server ./packages/server

# Build packages
RUN npm run build -w @colive/protocol
RUN npm run build -w @colive/server

# Stage 2: Production runner
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787

# Create non-root user
USER node

# Copy built artifacts and dependencies
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder --chown=node:node /app/packages/protocol/package.json ./packages/protocol/
COPY --from=builder --chown=node:node /app/packages/server/dist ./packages/server/dist
COPY --from=builder --chown=node:node /app/packages/server/package.json ./packages/server/

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8787/health || exit 1

CMD ["node", "packages/server/dist/index.js"]
