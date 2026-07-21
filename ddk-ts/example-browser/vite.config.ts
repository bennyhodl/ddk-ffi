import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// The ddk-ts package root (one level up), where the built dist/ lives.
const ddkTsRoot = resolve(__dirname, '..')

// wasm32-wasip1-threads uses threads (SharedArrayBuffer), so the page MUST be
// cross-origin isolated. These headers make the browser grant SAB.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  resolve: {
    alias: {
      // LOCAL DEV SHORTCUT: point the package name straight at the built WASM
      // browser binding in ../dist. A published consumer never needs this — the
      // package's `browser` field forwards `@bennyblader/ddk-ts` to the
      // `@bennyblader/ddk-ts-wasm32-wasi` sibling automatically. We alias here
      // only because that sibling is generated at publish time and isn't on npm
      // yet. See README.md.
      '@bennyblader/ddk-ts': resolve(ddkTsRoot, 'dist/ddk-ts.wasi-browser.js'),
    },
  },
  optimizeDeps: {
    // The WASM binding pulls a Worker + .wasm via import.meta.url; esbuild
    // pre-bundling mangles those URLs, so keep it out of the optimizer.
    exclude: ['@bennyblader/ddk-ts', '@napi-rs/wasm-runtime'],
  },
  // The WASM binding instantiates via top-level await, so target a runtime
  // that supports it.
  build: { target: 'esnext' },
  server: {
    // Allow Vite to serve ../dist/*.wasm and the worker file (outside this dir).
    fs: { allow: [ddkTsRoot, __dirname] },
    headers: crossOriginIsolation,
  },
  preview: {
    headers: crossOriginIsolation,
  },
})
