/// <reference types="vite/client" />

// The package name is aliased to the built WASM browser binding, which ships no
// .d.ts. Declare the one export this example uses so tsc/editors stay quiet.
declare module '@bennyblader/ddk-ts' {
  export function version(): string
}
