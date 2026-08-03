import 'dotenv/config'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

// dotenv/config loads .env (e.g. PAYLOAD_SECRET) without overriding vars already
// set in process.env, so `cross-env DATABASE_URI=... vitest run` (test:int) still wins.
export default defineConfig({
  plugins: [tsconfigPaths()],
  // passWithNoTests: tests/unit and tests/int are empty until later tasks add tests;
  // without this, vitest exits 1 on zero matched files and would break `pnpm test:unit` in CI.
  test: { environment: 'node', hookTimeout: 60_000, testTimeout: 60_000, passWithNoTests: true },
})
