// Entry for `@bennyblader/ddk-ts/wasm`. Hand-written: everything under
// generated/ is ubrn output.
//
// The generated `uniffiInitAsync(source)` takes the .wasm location with no
// default, because only the host knows how its bundler names assets. The file
// ships at a fixed place in this package, so `init()` can supply one:
// `new URL(..., import.meta.url)` resolves in Node and is rewritten by Vite,
// webpack 5, Rollup and Parcel when they copy the asset.
import type { WasmSource } from '@ubjs/wasm'
import { uniffiInitAsync } from './generated/index.js'

export * from './generated/index.js'

/**
 * Load the wasm module. Call it once, and await it, before any other call.
 * Safe to call again; later calls return the first one's promise.
 *
 * @param source Override where the .wasm comes from (URL, path, Response or
 *   bytes) — for hosts that serve it from somewhere else.
 */
export function init(source?: WasmSource): Promise<void> {
  return uniffiInitAsync(source ?? new URL('./generated/ddk_ffi.wasm', import.meta.url))
}
