import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['__test__/**/*.spec.ts'],
    // Lifecycle suites share one regtest chain; run files one at a time.
    // Each file gets its own fork: the generated bindings cannot be evaluated
    // twice in one process. A single fork re-evaluates them per file while
    // Rust still holds the previous instance's foreign handles, and the next
    // callback segfaults.
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 240_000,
    globalSetup: ['./src/global-setup.ts'],
  },
})
