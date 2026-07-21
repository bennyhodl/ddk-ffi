# DDK-TS Changelog

## [0.3.43] - 2026-07-21
- Added `wasm32-wasip1-threads` build target for browser/WASM support (`pnpm build:wasm`)
- Wired the WASM target into CI and the release/publish pipeline (builds the `@bennyblader/ddk-ts-wasm32-wasi` sibling package)
- Added `browser` field so bundlers resolve the WASM binding, plus a Vite browser example (`example-browser/`)

## [0.1.11] - 2025-01-15
- Updated package configuration

## [0.1.10] - 2025-01-15
- Fixed build dependencies

## [0.1.9] - 2025-01-15
- Improved NAPI-RS bindings

## [0.1.8] - 2025-01-15
- Enhanced type definitions

## [0.1.7] - 2025-01-15
- Added platform-specific builds

## [0.1.6] - 2025-01-15
- Fixed TypeScript type exports

## [0.1.5] - 2025-01-15
- Improved build process

## [0.1.4] - 2025-01-15
- Added multi-platform support

## [0.1.3] - 2025-01-15
- Enhanced error handling

## [0.1.2] - 2025-01-15
- Added DLC transaction functions

## [0.1.1] - 2025-01-15
- Initial NAPI-RS setup

## [0.1.0] - 2025-01-15
- Initial release