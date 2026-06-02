# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a React Native library that provides Rust-powered DLC (Discreet Log Contract) functionality through UniFFI bindings. The project bridges Rust DLC implementation to React Native using `uniffi-bindgen-react-native`.

## Architecture

The project consists of two main components:

- **ddk-ffi/**: Rust crate containing DLC business logic with UniFFI interface definitions
- **ddk-rn/**: React Native library with generated TypeScript, C++, iOS, and Android bindings

The architecture follows this flow:

1. Rust code defines records, functions, methods, and errors in `ddk-ffi/src/lib.rs`,
   annotated with UniFFI proc-macros (`#[derive(uniffi::Record)]`,
   `#[derive(uniffi::Error)]`/`Enum`, `#[uniffi::export]`). The crate calls
   `uniffi::setup_scaffolding!()` — there is no `.udl` file (it was fully migrated
   to proc-macros; the Rust source is the single source of truth).
2. Bindings are generated from the compiled library (NOT from a UDL) for TypeScript
   (JSI), C++, iOS (Swift/Objective-C), and Android (Kotlin/JNI). Library-based
   generation is required so proc-macro definitions are visible.
3. React Native consumes the generated TypeScript API

## Build System & Commands

This project uses `just` as the primary build orchestrator. All build commands should be run from the project root.

### Core Build Commands

- `just uniffi`: Complete build pipeline (generates all bindings + builds iOS/Android)
- `just uniffi-jsi`: Build the crate and generate TypeScript + C++ JSI bindings from the compiled library
- `just uniffi-turbo`: Generate React Native TurboModule specifications
- `just build-ios`: Build iOS static libraries and create XCFramework
- `just build-android`: Build Android native libraries (JNI)

### Example App Commands

- `just example-ios`: Install iOS dependencies with new architecture enabled
- `just example-android`: Build Android example app
- `cd ddk-rn/example && npx react-native run-ios`: Run iOS example
- `cd ddk-rn/example && npx react-native run-android`: Run Android example

### React Native Library Commands (run from ddk-rn/)

- `pnpm test`: Run Jest tests
- `pnpm typecheck`: Run TypeScript type checking
- `pnpm lint`: Run ESLint
- `pnpm prepare`: Build library with react-native-builder-bob

### Rust Commands (run from ddk-ffi/)

- `cargo build`: Build Rust crate
- `cargo test`: Run Rust tests

## Development Workflow

1. **Modify Rust Code**: Edit `ddk-ffi/src/lib.rs`. Annotate new types with
   `#[derive(uniffi::Record)]` / `#[derive(uniffi::Enum)]` / `#[derive(uniffi::Error)]`,
   and exported functions/methods with `#[uniffi::export]`. No `.udl` to update.
2. **Generate Bindings**: Run `just uniffi` to regenerate all language bindings
3. **Test Changes**: Use example app or run tests

## Key Files & Locations

### Rust FFI Layer

- `ddk-ffi/src/lib.rs`: Core Rust implementation + UniFFI proc-macro annotations (single source of truth; no `.udl`)
- `ddk-ffi/Cargo.toml`: Rust project configuration

### React Native Layer

- `ddk-rn/src/`: Generated TypeScript bindings
- `ddk-rn/cpp/`: Generated C++ bindings for JSI
- `ddk-rn/ios/`: iOS native module and XCFramework
- `ddk-rn/android/`: Android native module and JNI libraries
- `ddk-rn/ubrn.config.yaml`: UniFFI React Native configuration

### Generated Files (do not edit manually)

- TypeScript bindings in `ddk-rn/src/`
- C++ bindings in `ddk-rn/cpp/`
- iOS frameworks in `ddk-rn/ios/*.xcframework`
- Android libraries in `ddk-rn/android/src/main/jniLibs/`

## Known Issues

### UniFFI / ubrn version lockstep

The `uniffi` crate (`ddk-ffi/Cargo.toml`), the `uniffi-bindgen-react-native` dependency
(`ddk-rn/package.json`), and the **globally installed** `uniffi-bindgen-react-native`
binary must all be the same release. The `just uniffi-*` recipes call the bare
`uniffi-bindgen-react-native` on `$PATH`, which resolves to the global pnpm install —
not `ddk-rn/node_modules`. A version skew shows up as TypeScript errors like
"Expected 2 arguments, but got 1" on every generated `.lower()` call.

ubrn pins an exact `uniffi_core` version (e.g. ubrn `0.31.0-3` requires `uniffi_core =0.31.0`),
so pin the Rust crate to that exact patch. Update the global binary with
`pnpm add -g uniffi-bindgen-react-native@<version>`.

> Note: as of uniffi 0.31, the old manual fix for `#include "/ddk_ffi.hpp"` is no longer
> needed — the generator emits the correct `#include "ddk_ffi.hpp"`.

### Dependencies

- Requires `uniffi-bindgen-react-native` globally installed (version must match `ddk-rn/package.json`)
- Uses pnpm as package manager (not npm/yarn)
- React Native new architecture enabled by default

## Testing

- Rust tests: `cargo test` (in ddk-ffi/)
- TypeScript tests: `pnpm test` (in ddk-rn/)
- Integration testing via example app

## Code Generation

All TypeScript, C++, iOS, and Android code is automatically generated from the Rust code and UDL definitions. Do not manually edit generated files as they will be overwritten on the next build.

## Changelog Management

When making changes or releases, update the appropriate changelog:

- **ddk-rn/CHANGELOG.md**: For React Native library changes
- **ddk-ts/CHANGELOG.md**: For TypeScript/Node.js library changes

### Changelog Entry Format

Keep entries concise - just the main idea of the change:

```markdown
## [VERSION] - DATE
- Brief description of change
- Another change description
```

### When to Update Changelog

- After creating a new release
- After implementing significant features
- After fixing important bugs

Example entry:
```markdown
## [0.1.5] - 2025-01-16
- Added new DLC validation functions
- Fixed memory leak in native bindings
- Improved error handling
```

## GitHub Issue Management

### Creating Issues

When asked to create a GitHub issue, use the `gh` CLI tool:

```bash
# Basic issue creation
gh issue create --title "Issue title" --body "Issue description"

# With labels
gh issue create --title "Issue title" --body "Issue description" --label "bug,enhancement"

# Assign to someone
gh issue create --title "Issue title" --body "Issue description" --assignee "@username"

# With milestone
gh issue create --title "Issue title" --body "Issue description" --milestone "v1.0"
```

### Issue Body Format

Use markdown for clear, structured issue descriptions:

```markdown
## Summary
Brief description of the issue

## Details
- Detailed point 1
- Detailed point 2

## Tasks
- [ ] Task 1
- [ ] Task 2

## Notes
Any additional context
```

### Listing and Viewing Issues

```bash
# List all open issues
gh issue list

# List issues with specific labels
gh issue list --label "bug"

# View a specific issue
gh issue view <issue-number>

# Search issues
gh issue list --search "keyword"
```

## GitHub Pull Request Management

### Creating Pull Requests

When asked to create a pull request, use the `gh` CLI tool:

```bash
# Create PR with title and body
gh pr create --title "PR title" --body "$(cat <<'EOF'
## Summary
Brief description of changes

## Changes
- Change 1
- Change 2

## Testing
- How to test these changes

## Related Issues
Closes #123
EOF
)"

# Create PR with specific base branch
gh pr create --base main --title "PR title" --body "PR description"

# Create PR and assign reviewers
gh pr create --title "PR title" --body "PR description" --reviewer @username

# Create PR with labels
gh pr create --title "PR title" --body "PR description" --label "enhancement,documentation"

# Create PR as draft
gh pr create --draft --title "WIP: PR title" --body "Work in progress"
```

### PR Body Template

```markdown
## Summary
Brief description of what this PR does

## Changes
- Specific change 1
- Specific change 2
- Specific change 3

## Testing
Describe how to test these changes

## Checklist
- [ ] Tests pass
- [ ] Documentation updated
- [ ] Changelog updated (if applicable)

## Related Issues
Closes #issue-number
```

### Managing Pull Requests

```bash
# List all open PRs
gh pr list

# View a specific PR
gh pr view <pr-number>

# Check PR status
gh pr status

# Checkout a PR locally
gh pr checkout <pr-number>

# Merge a PR
gh pr merge <pr-number> --merge  # or --squash, --rebase
```
