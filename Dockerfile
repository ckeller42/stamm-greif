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
# present at load time even though nothing decodes an image during the build itself.
RUN apk add --no-cache vips
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
# Runtime libvips, PLUS vips-cpp (the C++ binding sharp's compiled addon actually links
# against — a separate Alpine package from `vips`, easy to miss since `next build` in the
# `build` stage only needed plain `vips` to load the addon, not exercise it) and the libheif
# dlopen module (vips-heif — pulls in libheif itself as a transitive dependency) so decoding
# actually works at request time. Confirmed empirically: without vips-cpp here, the addon
# compiled in `deps` fails to dlopen (libvips-cpp.so missing) and sharp silently falls back to
# its bundled prebuilt binary, which lacks the HEIF codec — reproducing the exact "Support for
# this compression format has not been built in" error this stage exists to fix. Without
# vips-heif, `vips copy foo.heic foo.jpg` fails with "not a known file format".
RUN apk add --no-cache vips vips-cpp vips-heif
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
USER node
EXPOSE 3000
CMD ["node", "server.js"]
