# React Native development

This package owns JSI generation, native packaging and the mobile build recipes.
The shared Rust interface is in `../../ffi/`; the runnable consumer is in
`../../examples/react-native/`.

Run from the repository root:

```sh
just install
just generate-react-native
just build react-native ios
just build react-native android
just native example-ios
just example react-native ios
just example react-native android
just test react-native
just test react-native ios
just test react-native android
```

`src/index.tsx` is the handwritten package entry. UniFFI generates everything in
`src/generated/` and the native adapters under `cpp/`, `ios/` and `android/`.
The TurboModule codegen config points to `src/generated/`.

`pnpm build`, `pnpm check`, `pnpm format` and `pnpm test` work from this directory.
`pnpm generate` regenerates JSI and TurboModule bindings. Native operations live
in this package's `justfile`; the root `just native` command delegates to it.

The pnpm workspace installs both this package and the example. Run installation
here, not in the example directory. Metro, Babel and autolinking resolve this
package explicitly from the example, while the example retains its own native
projects and dependencies.

See [repository development](../../DEVELOPMENT.md) for the shared commands and
release process. iOS archives are stripped after release compilation; Android
shared libraries retain the symbols UniFFI needs for generation.
