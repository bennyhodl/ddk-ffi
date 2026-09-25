import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config'

// The same specs, run against the wasm binding (dist/wasm/, `pnpm build:wasm`)
// instead of N-API. The specs import '@bennyblader/ddk'; this points that one
// specifier at the wasm entry, and the setup file awaits its init() first.
export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: [
        {
          find: /^@bennyblader\/ddk$/,
          replacement: fileURLToPath(new URL('./dist/wasm/index.js', import.meta.url)),
        },
      ],
    },
    test: {
      setupFiles: ['../../tests/conformance/setup-wasm.ts'],
    },
  }),
)
