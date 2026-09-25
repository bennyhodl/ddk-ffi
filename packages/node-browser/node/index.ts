// Entry for `@bennyblader/ddk` under Node (the `node` export condition).
// Hand-written: everything under generated/ is ubrn output.
//
// This entry loads the N-API binding and nothing else. The native library comes
// from the `@bennyblader/ddk-<triple>` optionalDependency npm installs for this
// machine; when there is none, importing this module throws. It deliberately
// does not fall back to wasm — a Node consumer asks for `@bennyblader/ddk/wasm`
// by name, so it never gets the slower binding without knowing.
import ddk_ffi from './generated/ddk_ffi.js'

export * from './generated/ddk_ffi.js'

try {
  ddk_ffi.initialize()
} catch (e) {
  // @ubjs/node's ResolveLibPathError: exported at runtime but not in its types.
  if (e instanceof Error && e.name === 'ResolveLibPathError') {
    throw new Error(
      `@bennyblader/ddk has no native library for ${process.platform}-${process.arch}: ` +
        'no matching @bennyblader/ddk-<triple> package is installed (an unsupported platform, ' +
        'or an install that omitted optional dependencies). ' +
        "To run on this machine anyway, import '@bennyblader/ddk/wasm' and await its init().",
      { cause: e },
    )
  }
  throw e
}

/**
 * Present so code shared with the browser build can `await init()` on both.
 * The N-API binding is loaded at import, so there is nothing left to do.
 */
export async function init(_source?: unknown): Promise<void> {}
