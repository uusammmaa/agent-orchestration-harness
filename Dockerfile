# The API and the worker: one image, ROLE picks which.
#
# Runs TypeScript directly via tsx rather than compiling. For a workspace where the
# packages are consumed as source, a build step buys a marginally faster cold start and
# costs a whole class of "works in dev, not in the image" problems.

FROM node:22-alpine AS deps
WORKDIR /app
# Copy manifests first so a source-only change does not reinstall the world.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/odoo/package.json packages/odoo/
COPY packages/agents/package.json packages/agents/
COPY apps/api/package.json apps/api/
COPY apps/console/package.json apps/console/
RUN npm ci --omit=dev --ignore-scripts && npm i -g tsx@4

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /usr/local/lib/node_modules/tsx /usr/local/lib/node_modules/tsx
COPY --from=deps /usr/local/bin/tsx /usr/local/bin/tsx

COPY package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api

# Non-root. A worker that talks to an ERP and a mail gateway has no business being root.
RUN addgroup -S harness && adduser -S harness -G harness && chown -R harness:harness /app
USER harness

EXPOSE 3000
# tini-style signal handling comes free from node as PID 1 here because the process
# installs its own SIGTERM handler and drains.
CMD ["tsx", "apps/api/src/server.ts"]
