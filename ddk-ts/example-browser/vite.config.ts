import { defineConfig } from 'vite'

export default defineConfig({
  build: { target: 'es2022' },
  // Vite's dev pre-bundling moves the package into .vite/deps, which breaks the
  // `new URL('./generated/ddk_ffi.wasm', import.meta.url)` the wasm entry uses
  // to find its module. Serving it unbundled keeps that URL valid. `vite build`
  // (Rollup) handles the URL and copies the .wasm without this.
  optimizeDeps: { exclude: ['@bennyblader/ddk-ts'] },
})
