import { withPayload } from '@payloadcms/next/withPayload'
import type { NextConfig } from 'next'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(__filename)

const nextConfig: NextConfig = {
  // Enables the .next/standalone output consumed by the production Dockerfile (Task 14).
  output: 'standalone',
  // onnxruntime-web must stay an external runtime require: bundling it breaks its Node entry's
  // node:fs based .wasm loading.
  //
  // RE-VERIFIED 2026-08-09 (task-3-report.md), now that Task 3 makes detectFaces.ts (and so
  // face-model.ts) actually reachable from a real route (Photos' afterChange -> jobs.queue,
  // driven from an HTTP request or the autoRun cron): Task 1's assumption above — that Next's
  // tracer "already sweeps the whole onnxruntime-web dist directory" once something imports
  // face-model.ts — does NOT hold. Built `pnpm build`, ran the real `.next/standalone/server.js`
  // (docker-compose.yml's actual runtime shape) and drove a real detectFaces job through it: only
  // `ort.node.min.mjs` + `package.json` landed under
  // `.next/standalone/node_modules/.pnpm/onnxruntime-web@*/node_modules/onnxruntime-web/dist/` —
  // no `.wasm`, no `ort-wasm-simd-threaded.mjs`. The job failed for real: "no available backend
  // found. ERR: [wasm] ... Cannot find module '.../dist/ort-wasm-simd-threaded.mjs' imported from
  // .../dist/ort.node.min.mjs". So every face-detection job would silently fail-and-retry forever
  // in the actual container, exactly the "no suggestions ever appear, weeks later" failure mode
  // scripts/probe-faces.mjs exists to catch at build time for the model files — except that probe
  // runs via tsx against source in the Dockerfile's `build` stage (full node_modules, no
  // standalone tracing involved at all), so it can't and doesn't catch this.
  //
  // Fix: outputFileTracingIncludes, but keyed correctly this time. The earlier attempt (Task 1)
  // used a literal `./node_modules/onnxruntime-web/...` glob — under pnpm that path is a
  // *symlink*, and Next's tracer materialises outputFileTracingIncludes matches as real files at
  // the glob's own path rather than following the symlink to the real store location the compiled
  // server actually resolves against (confirmed above: `node_modules/.pnpm/onnxruntime-web@*/
  // node_modules/onnxruntime-web/dist/`), so it landed nowhere any resolution path looks. Globbing
  // the real `.pnpm` store path directly (version-agnostic wildcard, since the lockfile pins the
  // version but this shouldn't hardcode it twice) fixes that. `/**` so it's included regardless of
  // which route/chunk ends up pulling face-model.ts in — the actual trigger (Photos' afterChange
  // hook, or the jobs `autoRun` cron ticking inside instrumentation.ts) isn't itself a traceable
  // per-route entry the way a page or API route is.
  outputFileTracingIncludes: {
    '/**': ['./node_modules/.pnpm/onnxruntime-web@*/node_modules/onnxruntime-web/dist/**'],
  },
  // @react-pdf/renderer (P2.5 Fotobuch PDF export, Task 1): pure JS + yoga-layout's WASM layout
  // engine, no native addon (verified via a musl-alpine container probe — see
  // task-1-report.md). Unlike onnxruntime-web, yoga's wasm binary is base64-inlined inside a
  // plain ESM module (dist/binaries/yoga-wasm-base64-esm.js), loaded via a normal `import`
  // rather than a runtime node:fs read of a separate .wasm file — so Next's file tracer should
  // pick it up like any other JS module dependency, without needing the onnxruntime-web-style
  // outputFileTracingIncludes escape hatch below. Left unverified against the standalone-traced
  // bundle here: nothing in app code imports @react-pdf/renderer yet for the tracer to trace
  // from (that lands with the actual PDF-generation route in a later task) — do not add an
  // outputFileTracingIncludes entry speculatively; only add one if that later task's docker
  // build render-check actually shows the wasm asset missing from `.next/standalone`.
  serverExternalPackages: ['onnxruntime-web', '@react-pdf/renderer'],
  images: {
    localPatterns: [
      {
        pathname: '/api/media/file/**',
      },
    ],
  },
  webpack: (webpackConfig) => {
    webpackConfig.resolve.extensionAlias = {
      '.cjs': ['.cts', '.cjs'],
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    }

    return webpackConfig
  },
  turbopack: {
    root: path.resolve(dirname),
  },
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
