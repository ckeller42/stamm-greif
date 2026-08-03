import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  // passWithNoTests: tests/unit and tests/int are empty until later tasks add tests;
  // without this, vitest exits 1 on zero matched files and would break `pnpm test:unit` in CI.
  test: { environment: 'node', hookTimeout: 60_000, testTimeout: 60_000, passWithNoTests: true },
})
