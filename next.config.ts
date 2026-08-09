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
  // node:fs based .wasm loading. No outputFileTracingIncludes entry for the .wasm/.mjs pair —
  // verified (2026-08-09, task-1-report.md) that once something actually imports
  // src/lib/face-model.ts, Next's file tracer already sweeps the whole onnxruntime-web `dist`
  // directory (all wasm variants, not just the ones a static entry would have named) into both
  // the standalone output and the Turbopack-compiled server's hashed-alias symlink target,
  // because it can't statically resolve the package's internal dynamic wasm path and
  // conservatively includes the containing directory. A manual outputFileTracingIncludes entry
  // was tried first and made things worse: its literal `./node_modules/onnxruntime-web/...`
  // path materialises a real (non-symlinked) directory at that exact spot, containing only the
  // two named files — which is not what any resolution path in the compiled server actually
  // looks up, so it does nothing useful and risks masking the real tracing gap. As of this task
  // nothing in the app imports face-model.ts yet, so this whole mechanism is untested against a
  // real route — re-verify (rebuild after Task 2 wires in a real import, check
  // .next/standalone/node_modules/.pnpm/onnxruntime-web@*/node_modules/onnxruntime-web/dist/
  // contains the .wasm) before relying on it in production.
  serverExternalPackages: ['onnxruntime-web'],
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
