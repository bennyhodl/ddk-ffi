import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__test__/**/*.spec.ts'],
    testTimeout: 120000,
    pool: 'forks',
  },
})
