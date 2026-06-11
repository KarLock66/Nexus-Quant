# Shared Dockerfile for TypeScript services (ingestion / workers)
ARG SERVICE

FROM node:24-alpine AS builder
ARG SERVICE

RUN npm install -g pnpm@11

WORKDIR /repo

COPY pnpm-workspace.yaml package.json turbo.json ./
COPY packages ./packages
COPY services/ingestion ./services/ingestion
COPY services/workers ./services/workers
COPY apps/web/package.json ./apps/web/

RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @nexus/core build && pnpm --filter @nexus/events build
RUN pnpm --filter "@nexus/${SERVICE}" build

FROM node:24-alpine AS runner
ARG SERVICE

ENV NODE_ENV=production
WORKDIR /repo

COPY --from=builder /repo ./

WORKDIR /repo/services/${SERVICE}

CMD ["node", "dist/index.js"]
