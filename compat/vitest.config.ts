import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['__test__/**/*.spec.ts'],
    // Lifecycle suites share one regtest chain; run files one at a time.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 240_000,
    globalSetup: ['./src/global-setup.ts'],
  },
})
