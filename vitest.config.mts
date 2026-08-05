import 'dotenv/config'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

// dotenv/config loads .env (e.g. PAYLOAD_SECRET) without overriding vars already
// set in process.env, so `cross-env DATABASE_URI=... vitest run` (test:int) still wins.
export default defineConfig({
  plugins: [tsconfigPaths()],
  // No passWithNoTests: tests/unit and tests/int now contain tests. Keeping it would let a run
  // that matches zero files (wrong path, empty dir) report success and hide that nothing ran.
  test: { environment: 'node', hookTimeout: 60_000, testTimeout: 60_000 },
})
