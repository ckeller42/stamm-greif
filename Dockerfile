# Production image for the Payload/Next app. Multi-stage, Node 22 alpine, relies on
# `output: 'standalone'` in next.config.ts (Task 14). Build with the repo root as context:
#   docker compose build
FROM node:22-alpine AS deps
WORKDIR /app
# HEIC/HEIF support: Alpine's vips package is built with libheif as a dynamically-loaded
# module (confirmed via `vips --vips-config`), but sharp's own prebuilt binary bundles a
# stripped-down libvips without that module and can't be told to load it. vips-dev (headers +
# .pc file, pulls in `vips` + `pkgconfig` transitively) plus build-base/python3 let sharp's
# postinstall compile its native addon against the *system* libvips instead of using the
# prebuilt — see SHARP_FORCE_GLOBAL_LIBVIPS below. Compiling only needs libvips' headers; the
# actual libheif module (vips-heif, runtime-dlopened) is installed separately in the `run`
# stage — no need for it here since nothing decodes an image during `pnpm install`.
RUN apk add --no-cache vips-dev build-base python3
# Pin the pnpm version corepack activates so the build is reproducible regardless of what
# corepack's bundled default happens to be (adaptation on top of the task brief's plain
# `corepack enable`, which works but isn't pinned).
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
# pnpm-workspace.yaml carries `allowBuilds` (sharp, esbuild, unrs-resolver) — without copying
# it, pnpm's default build-script blocking would skip sharp's native postinstall step and
# break image resizing at runtime. .npmrc is copied too for completeness (legacy-peer-deps).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# Forces sharp's postinstall to link against the system libvips (found via pkg-config, from
# vips-dev above) and compile from source, instead of downloading its own prebuilt libvips
# that lacks libheif. This is what actually gives us HEIC decoding — the prebuilt sharp binary
# never can, regardless of what's installed alongside it.
ENV SHARP_FORCE_GLOBAL_LIBVIPS=1
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
# `next build` collects page data by importing payload.config, which imports sharp; sharp's
# native addon (compiled against system libvips in the `deps` stage above) needs libvips.so
# *and* libvips-cpp.so present at load time to dlopen successfully, even though nothing
# decodes an image during the build itself. Plain `vips` alone is not sufficient here either
# (same gap Finding in the `run` stage below applies here too) — without `vips-cpp`, the addon's
# dlopen fails and sharp silently falls back to its bundled non-HEIF prebuilt for the rest of
# the build. That fallback doesn't fail the build (the prebuilt loads fine, it just can't
# decode HEIC — irrelevant to `next build`, which never decodes anything), so this had been
# quietly wrong until caught by review: this comment used to claim the from-source addon was
# active here, which it wasn't.
RUN apk add --no-cache vips vips-cpp
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
# vips-cpp — the C++ binding sharp's compiled addon actually links against, a separate Alpine
# package from plain `vips` (easy to miss since the `build` stage only needed `vips` to load
# the addon, not exercise it) — plus the libheif dlopen module (vips-heif, which pulls in
# libheif itself as a transitive dependency) so decoding actually works at request time.
# Confirmed empirically: without vips-cpp here, the addon compiled in `deps` fails to dlopen
# (libvips-cpp.so missing) and sharp silently falls back to its bundled prebuilt binary, which
# lacks the HEIF codec — reproducing the exact "Support for this compression format has not
# been built in" error this stage exists to fix. Without vips-heif, `vips copy foo.heic
# foo.jpg` fails with "not a known file format". Plain `vips` is deliberately not listed
# explicitly: vips-cpp depends on it (`so:libvips.so.42`) and apk resolves that transitively —
# confirmed by building with only `vips-cpp vips-heif` and checking `apk info -e vips` still
# reports it installed.
RUN apk add --no-cache vips-cpp vips-heif
ENV NODE_ENV=production
# The standalone server binds to this host/port; 0.0.0.0 is required so the caddy container
# can reach it by service name over the compose network (the default, localhost, would
# refuse connections from other containers).
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
# Run as the built-in unprivileged `node` user, not root. Copy app files owned by node, and
# create /app/photos owned by node so the uploads volume (mounted there by docker-compose.yml)
# is writable — a fresh named volume inherits the mount point's ownership from the image.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
RUN mkdir -p /app/photos && chown node:node /app/photos
# Hard build-time gate on HEIC decode actually working, not just "the layer that installs
# vips-heif ran without error." Both real failure modes hit during development left a green
# build: missing node-addon-api/node-gyp makes sharp's postinstall silently no-op and fall back
# to the non-HEIF prebuilt (Finding 2, deps stage); missing vips-cpp makes the compiled addon's
# dlopen fail and fall back the same way (Finding 1, this stage) — in both cases `next build`
# and `docker build` complete successfully regardless, because the fallback sharp binary loads
# fine and nothing else in the build exercises HEIC decode. This probe actually decodes a real
# HEIC file with the exact sharp module the running container will use, so any future
# regression in this chain (an Alpine package rename, a sharp upgrade changing its fallback
# behavior, etc.) fails `docker build` loudly instead of shipping a silently-broken image.
COPY tests/fixtures/dia.heic /tmp/heic-probe.heic
RUN node -e "require('sharp')('/tmp/heic-probe.heic').jpeg().toBuffer().then(()=>console.log('heic ok'),e=>{console.error(e);process.exit(1)})"
RUN rm /tmp/heic-probe.heic
USER node
EXPOSE 3000
CMD ["node", "server.js"]
