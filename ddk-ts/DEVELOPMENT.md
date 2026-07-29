# DDK-TS Development

This document covers development practices specific to the TypeScript/Node.js bindings (ddk-ts).

## Quick Start

```bash
# Build native bindings
pnpm build

# Run tests
pnpm test

# Verify type parity with Rust
pnpm verify
```

## Development Workflow

1. **Modify Rust code** in `src/lib.rs`
2. **Update types** in `src/types.rs` and `src/conversions.rs`
3. **Build**: `pnpm build`
4. **Test**: `pnpm test`
5. **Verify parity**: `pnpm verify`

## Architecture

DDK-TS uses NAPI-RS to create native Node.js bindings from Rust code:

- `src/lib.rs`: Main Rust entry point with NAPI exports
- `src/types.rs`: TypeScript-compatible type definitions
- `src/conversions.rs`: Type conversion utilities
- `dist/`: Generated JavaScript and TypeScript definitions

## Building

### Local Development

```bash
pnpm build        # Build for current platform
pnpm build:debug  # Build with debug symbols
```

### Multi-platform Build

```bash
pnpm build:all              # Build for all supported platforms
pnpm build:darwin-arm64     # macOS Apple Silicon
pnpm build:linux-x64        # Linux x64
```

## Testing

```bash
pnpm test           # Run all tests
pnpm verify:parity  # Verify type parity with Rust
pnpm verify:types   # Verify TypeScript types
```

## Release Process

```bash
# 1. Update version in package.json
vim package.json

# 2. Build for all platforms
pnpm build:all

# 3. Run tests
pnpm test:all

# 4. Publish to npm
npm publish
```

## Platform Support

Currently supported platforms:

- `darwin-arm64`: macOS Apple Silicon
- `linux-x64-gnu`: Linux x64 with GNU libc

## Example Usage

See `example/` directory for usage examples:

```bash
cd example
pnpm install
pnpm start
```
