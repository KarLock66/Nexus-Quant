# Next.js web app — standalone output
FROM node:24-alpine AS builder

RUN npm install -g pnpm@11

WORKDIR /repo

COPY pnpm-workspace.yaml package.json turbo.json ./
COPY packages ./packages
COPY apps/web ./apps/web
COPY services/ingestion/package.json ./services/ingestion/
COPY services/workers/package.json ./services/workers/

RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @nexus/db generate
RUN pnpm --filter @nexus/core build && pnpm --filter @nexus/db build
ENV NEXT_OUTPUT_STANDALONE=1
RUN pnpm --filter @nexus/web build

FROM node:24-alpine AS runner

ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /repo/apps/web/public ./apps/web/public

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
