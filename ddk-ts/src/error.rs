//! Error mapping that mirrors the UniFFI/React-Native error surface.
//!
//! On the React Native side, uniffi generates a tagged `DlcError` union where
//! every variant is discriminated by a string `tag` (see `DlcError_Tags` in
//! `ddk-rn/src/ddk_ffi.ts`, e.g. `'InvalidPublicKey'`, `'KeyError'`). Consumers
//! switch on `error.tag`.
//!
//! The Node.js (napi) bindings previously threw a generic `Error` whose message
//! was the Rust `Debug` formatting of the error (`format!("{:?}", e)`), e.g.
//! `"KeyError { key: InvalidXpriv }"`. That is lossy and not discriminable.
//!
//! This module maps `ddk_ffi::DLCError` to a napi error so that the thrown JS
//! error matches the FFI:
//!   - `error.code`    == the variant tag (mirrors uniffi's `DlcError_Tags`)
//!   - `error.message` == the `thiserror` `Display` string (human readable)
//!
//! napi sets the JS error's `.code` from the error's status, and `Error<S>` is
//! generic over any `S: AsRef<str>` — so a `&'static str` variant tag becomes
//! the JS `code` directly. A function that returns `Result<T, &'static str>`
//! (the napi `Result` alias with a custom status) throws exactly this shape.

use ddk_ffi::DLCError;

/// Stable discriminant for a `DLCError` variant.
///
/// Kept byte-for-byte in sync with uniffi's `DlcError_Tags` so a Node.js caller
/// can `switch (err.code)` exactly like a React Native caller switches on
/// `err.tag`.
pub fn dlc_error_code(err: &DLCError) -> &'static str {
  match err {
    DLCError::InvalidSignature => "InvalidSignature",
    DLCError::InvalidPublicKey => "InvalidPublicKey",
    DLCError::InvalidTransaction => "InvalidTransaction",
    DLCError::InsufficientFunds => "InsufficientFunds",
    DLCError::InvalidArgument { .. } => "InvalidArgument",
    DLCError::SerializationError => "SerializationError",
    DLCError::Secp256k1Error { .. } => "Secp256k1Error",
    DLCError::MiniscriptError => "MiniscriptError",
    DLCError::InvalidNetwork => "InvalidNetwork",
    DLCError::KeyError { .. } => "KeyError",
  }
}

/// Map a `ddk_ffi::DLCError` into a napi error whose JS representation matches
/// the FFI: `error.code` is the variant tag and `error.message` is the
/// `Display` string (which already embeds inner fields like `message`/`key`).
pub fn map_dlc_error(err: DLCError) -> napi::Error<&'static str> {
  napi::Error::new(dlc_error_code(&err), err.to_string())
}
