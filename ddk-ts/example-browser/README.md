# ddk-ts browser example

A minimal [Vite](https://vitejs.dev/) app that loads the **WASM** build of
`@bennyblader/ddk-ts` in the browser and prints `version()` to prove the binding
instantiated. If you see a version number, the WASM binding works in a browser.

## Run it

The example uses the WASM binary built into `../dist`, so build that first:

```bash
# from ddk-ts/  (one level up) — needs the WASI SDK, see ../README
export WASI_SDK_PATH=/path/to/wasi-sdk
pnpm build:wasm
```

Then, from this folder:

```bash
pnpm install
pnpm dev        # http://localhost:5173
# or:
pnpm build && pnpm preview
```

Open the page — you should see:

```
ddk-ts version: 0.3.43
✅ WASM loaded. ddk-ts version() -> 0.3.43
   crossOriginIsolated: true
```

## How a real consumer uses this

In an app that installs the published package, the code is just:

```ts
import { version } from '@bennyblader/ddk-ts'
console.log(version())
```

The bundler follows the package's `browser` field to `dist/browser.js`, which
re-exports `@bennyblader/ddk-ts-wasm32-wasi` (the WASM sibling package). Two
things a consumer must set up:

1. **Install the WASM sibling.** It's published with `cpu: ["wasm32"]`, so npm
   skips it on normal machines. Force it in:
   - **pnpm:** add to your app's `package.json`:
     ```json
     "pnpm": { "supportedArchitectures": { "cpu": ["wasm32"] } }
     ```
   - **npm:** `npm install @bennyblader/ddk-ts-wasm32-wasi --force`
   - **yarn:** `supportedArchitectures: cpu: ["wasm32"]` in `.yarnrc.yml`

2. **Cross-origin isolation.** The target is `wasm32-wasip1-threads`, which uses
   threads + `SharedArrayBuffer`. The page must be served with:
   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```
   Without these, `SharedArrayBuffer` is unavailable and instantiation fails.

## Why this example aliases the package

`@bennyblader/ddk-ts-wasm32-wasi` is generated at publish time and isn't on npm
yet, so this example can't install it the normal way. Instead, `vite.config.ts`
aliases `@bennyblader/ddk-ts` straight to the built `../dist/ddk-ts.wasi-browser.js`.
That's a **local-dev shortcut only** — a published consumer never needs the
alias, just the two steps above. The config also sets the COOP/COEP headers (for
both `dev` and `preview`) and `build.target: "esnext"` (the binding instantiates
via top-level `await`).
