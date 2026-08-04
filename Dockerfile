# Production image for the Payload/Next app. Multi-stage, Node 22 alpine, relies on
# `output: 'standalone'` in next.config.ts (Task 14). Build with the repo root as context:
#   docker compose build
FROM node:22-alpine AS deps
WORKDIR /app
# Pin the pnpm version corepack activates so the build is reproducible regardless of what
# corepack's bundled default happens to be (adaptation on top of the task brief's plain
# `corepack enable`, which works but isn't pinned).
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
# pnpm-workspace.yaml carries `allowBuilds` (sharp, esbuild, unrs-resolver) — without copying
# it, pnpm's default build-script blocking would skip sharp's native postinstall step and
# break image resizing at runtime. .npmrc is copied too for completeness (legacy-peer-deps).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# payload.config.ts throws if PAYLOAD_SECRET is unset, and `next build` imports it while
# collecting page data — even though no page actually connects to the DB at build time
# (see the `dynamic = 'force-dynamic'` note in src/app/(frontend)/layout.tsx). This
# placeholder is only ever read during the build step; the real secret is injected at
# container runtime via compose.
ENV PAYLOAD_SECRET=build-time-placeholder-not-used-at-runtime
RUN pnpm build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
# The standalone server binds to this host/port; 0.0.0.0 is required so the caddy container
# can reach it by service name over the compose network (the default, localhost, would
# refuse connections from other containers).
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
