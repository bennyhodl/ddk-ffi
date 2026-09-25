import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['../../tests/conformance/*.spec.ts'],
    testTimeout: 120000,
    pool: 'forks',
  },
})
