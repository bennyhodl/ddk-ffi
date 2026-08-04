//! NAPI bindings for the stateless DLC contract API.
//!
//! Mirrors the surface `ddk_ffi::contract` exposes to React Native (uniffi),
//! so Node.js consumers get the same `ContractKeyProvider`, message-driven
//! lifecycle (create/accept/sign/finalize), splicing, standalone validation,
//! and payout-table inspection. Wire messages and PSBTs cross as `Buffer`;
//! satoshi amounts and serial ids cross as `BigInt`.

use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::conversions::{bigint_to_u64, buffer_to_vec, u64_to_bigint, vec_to_buffer};
use crate::types::DlcTransactions;

use ddk_ffi::contract::ContractError;

/// Maps a `ddk_ffi::contract::ContractError` to a napi error whose JS `code` is
/// the variant tag and `message` is the human-readable `Display` string —
/// mirroring the React Native `ContractError` union so a Node caller can
/// `switch (err.code)` exactly like an RN caller switches on `err.tag`.
pub fn map_contract_error(err: ContractError) -> napi::Error<&'static str> {
  let code = match err {
    ContractError::InvalidOffer { .. } => "InvalidOffer",
    ContractError::InvalidAccept { .. } => "InvalidAccept",
    ContractError::InvalidSign { .. } => "InvalidSign",
    ContractError::InvalidFundingInput { .. } => "InvalidFundingInput",
    ContractError::PsbtMismatch { .. } => "PsbtMismatch",
    ContractError::MissingFinalizedInput { .. } => "MissingFinalizedInput",
    ContractError::UnsupportedScriptType { .. } => "UnsupportedScriptType",
    ContractError::InvalidAttestation { .. } => "InvalidAttestation",
    ContractError::NoMatchingOutcome => "NoMatchingOutcome",
    ContractError::Descriptor { .. } => "Descriptor",
    ContractError::Wallet { .. } => "Wallet",
    ContractError::Bip32 { .. } => "Bip32",
    ContractError::Dlc { .. } => "Dlc",
    ContractError::Key { .. } => "Key",
    ContractError::Serialization { .. } => "Serialization",
    ContractError::InvalidNetwork { .. } => "InvalidNetwork",
    ContractError::InvalidLength { .. } => "InvalidLength",
  };
  napi::Error::new(code, err.to_string())
}

fn opt_bigint_to_u64(value: Option<BigInt>) -> Result<Option<u64>, &'static str> {
  value.map(|b| bigint_to_u64(&b)).transpose()
}

// ---------------------------------------------------------------------------
// Enums & records
// ---------------------------------------------------------------------------

/// Identifies which party's funding inputs an operation applies to.
#[napi]
pub enum Party {
  Offer,
  Accept,
}

impl From<Party> for ddk_ffi::contract::Party {
  fn from(party: Party) -> Self {
    match party {
      Party::Offer => ddk_ffi::contract::Party::Offer,
      Party::Accept => ddk_ffi::contract::Party::Accept,
    }
  }
}

/// One party's Bitcoin-level contract data.
#[napi(object)]
pub struct ContractPartyParams {
  /// The 33-byte compressed DLC funding public key.
  pub funding_pubkey: Buffer,
  /// The wallet UTXOs this party contributes, each a wire-encoded `FundingInput`.
  pub funding_inputs: Vec<Buffer>,
  /// The script pubkey CET and refund payouts are sent to.
  pub payout_spk: Buffer,
  /// Serial id ordering the payout output; randomly generated when omitted.
  pub payout_serial_id: Option<BigInt>,
  /// The script pubkey funding change is sent to.
  pub change_spk: Buffer,
  /// Serial id ordering the change output; randomly generated when omitted.
  pub change_serial_id: Option<BigInt>,
}

impl TryFrom<ContractPartyParams> for ddk_ffi::contract::ContractPartyParams {
  type Error = napi::Error<&'static str>;
  fn try_from(params: ContractPartyParams) -> Result<Self, &'static str> {
    Ok(ddk_ffi::contract::ContractPartyParams {
      funding_pubkey: buffer_to_vec(&params.funding_pubkey),
      funding_inputs: params.funding_inputs.iter().map(buffer_to_vec).collect(),
      payout_spk: buffer_to_vec(&params.payout_spk),
      payout_serial_id: opt_bigint_to_u64(params.payout_serial_id)?,
      change_spk: buffer_to_vec(&params.change_spk),
      change_serial_id: opt_bigint_to_u64(params.change_serial_id)?,
    })
  }
}

/// Parameters for `createOffer`.
#[napi(object)]
pub struct CreateOfferParams {
  /// The 32-byte chain hash the contract settles on.
  pub chain_hash: Buffer,
  /// The 32-byte temporary contract id; randomly generated when omitted.
  pub temporary_contract_id: Option<Buffer>,
  /// The contract payout and oracle information, wire-encoded `ContractInfo`.
  pub contract_info: Buffer,
  /// The collateral, in satoshis, contributed by the offering party.
  pub offer_collateral_sats: BigInt,
  /// The offering party's Bitcoin-level contract data.
  pub party: ContractPartyParams,
  /// Serial id ordering the funding output; randomly generated when omitted.
  pub fund_output_serial_id: Option<BigInt>,
  /// The fee rate, in satoshis per virtual byte.
  pub fee_rate_per_vb: BigInt,
  /// The earliest time CETs can be broadcast.
  pub cet_locktime: u32,
  /// The time after which the refund transaction can be broadcast.
  pub refund_locktime: u32,
  /// Contract feature flags. Use `0` unless a protocol extension requires otherwise.
  pub contract_flags: u8,
}

impl TryFrom<CreateOfferParams> for ddk_ffi::contract::CreateOfferParams {
  type Error = napi::Error<&'static str>;
  fn try_from(params: CreateOfferParams) -> Result<Self, &'static str> {
    Ok(ddk_ffi::contract::CreateOfferParams {
      chain_hash: buffer_to_vec(&params.chain_hash),
      temporary_contract_id: params.temporary_contract_id.as_ref().map(buffer_to_vec),
      contract_info: buffer_to_vec(&params.contract_info),
      offer_collateral_sats: bigint_to_u64(&params.offer_collateral_sats)?,
      party: params.party.try_into()?,
      fund_output_serial_id: opt_bigint_to_u64(params.fund_output_serial_id)?,
      fee_rate_per_vb: bigint_to_u64(&params.fee_rate_per_vb)?,
      cet_locktime: params.cet_locktime,
      refund_locktime: params.refund_locktime,
      contract_flags: params.contract_flags,
    })
  }
}

/// Parameters for `acceptOffer`.
#[napi(object)]
pub struct AcceptOfferParams {
  /// The accepting party's Bitcoin-level contract data.
  pub party: ContractPartyParams,
  /// The minimum accepted interval between oracle maturity and the refund locktime.
  pub min_timeout_interval: u32,
  /// The maximum accepted interval between oracle maturity and the refund locktime.
  pub max_timeout_interval: u32,
}

impl TryFrom<AcceptOfferParams> for ddk_ffi::contract::AcceptOfferParams {
  type Error = napi::Error<&'static str>;
  fn try_from(params: AcceptOfferParams) -> Result<Self, &'static str> {
    Ok(ddk_ffi::contract::AcceptOfferParams {
      party: params.party.try_into()?,
      min_timeout_interval: params.min_timeout_interval,
      max_timeout_interval: params.max_timeout_interval,
    })
  }
}

/// The result of `acceptOffer`.
#[napi(object)]
pub struct AcceptResult {
  /// The wire-encoded `AcceptDlc` message to send to the offering party.
  pub accept: Buffer,
  /// The unsigned funding, CET, and refund transactions.
  pub transactions: DlcTransactions,
  /// The BIP-174 funding PSBT ready to be signed.
  pub funding_psbt: Buffer,
}

impl From<ddk_ffi::contract::AcceptResult> for AcceptResult {
  fn from(result: ddk_ffi::contract::AcceptResult) -> Self {
    AcceptResult {
      accept: vec_to_buffer(result.accept),
      transactions: result.transactions.into(),
      funding_psbt: vec_to_buffer(result.funding_psbt),
    }
  }
}

/// The result of `signAccept` / `signAcceptSpliced`.
#[napi(object)]
pub struct SignResult {
  /// The wire-encoded `SignDlc` message to send to the accepting party.
  pub sign: Buffer,
  /// The unsigned funding, CET, and refund transactions.
  pub transactions: DlcTransactions,
}

impl From<ddk_ffi::contract::SignResult> for SignResult {
  fn from(result: ddk_ffi::contract::SignResult) -> Self {
    SignResult {
      sign: vec_to_buffer(result.sign),
      transactions: result.transactions.into(),
    }
  }
}

/// References a splice (DLC) funding input and the previous contract it spends.
#[napi(object)]
pub struct SpliceKeyRef {
  /// The serial id of the DLC (splice) funding input this key signs.
  pub input_serial_id: BigInt,
  /// The 32-byte temporary id of the previous contract being spliced from.
  pub prior_temporary_contract_id: Buffer,
}

impl TryFrom<SpliceKeyRef> for ddk_ffi::contract::SpliceKeyRef {
  type Error = napi::Error<&'static str>;
  fn try_from(reference: SpliceKeyRef) -> Result<Self, &'static str> {
    Ok(ddk_ffi::contract::SpliceKeyRef {
      input_serial_id: bigint_to_u64(&reference.input_serial_id)?,
      prior_temporary_contract_id: buffer_to_vec(&reference.prior_temporary_contract_id),
    })
  }
}

fn splice_keys_to_ffi(
  keys: Vec<SpliceKeyRef>,
) -> Result<Vec<ddk_ffi::contract::SpliceKeyRef>, &'static str> {
  keys.into_iter().map(TryInto::try_into).collect()
}

/// Identifies a funding input and the descriptor wildcard index that derives its key.
#[napi(object)]
pub struct DescriptorInput {
  /// The serial id of the funding input to sign.
  pub input_serial_id: BigInt,
  /// The descriptor wildcard derivation index of the input's script.
  pub derivation_index: u32,
}

impl TryFrom<DescriptorInput> for ddk_ffi::contract::DescriptorInput {
  type Error = napi::Error<&'static str>;
  fn try_from(input: DescriptorInput) -> Result<Self, &'static str> {
    Ok(ddk_ffi::contract::DescriptorInput {
      input_serial_id: bigint_to_u64(&input.input_serial_id)?,
      derivation_index: input.derivation_index,
    })
  }
}

/// One row of a contract's payout table.
#[napi(object)]
pub struct PayoutRow {
  /// The outcome label (enum contracts only).
  pub outcome: Option<String>,
  /// Inclusive start of the outcome range (numeric contracts only).
  pub range_start: Option<BigInt>,
  /// Inclusive end of the outcome range (numeric contracts only).
  pub range_end: Option<BigInt>,
  /// The payout to the offering party, in satoshis.
  pub offer_payout_sats: BigInt,
  /// The payout to the accepting party, in satoshis.
  pub accept_payout_sats: BigInt,
}

impl From<ddk_ffi::contract::PayoutRow> for PayoutRow {
  fn from(row: ddk_ffi::contract::PayoutRow) -> Self {
    PayoutRow {
      outcome: row.outcome,
      range_start: row.range_start.map(u64_to_bigint),
      range_end: row.range_end.map(u64_to_bigint),
      offer_payout_sats: u64_to_bigint(row.offer_payout_sats),
      accept_payout_sats: u64_to_bigint(row.accept_payout_sats),
    }
  }
}

/// A contract's payouts, derived from its `ContractInfo`, for display as a table.
#[napi(object)]
pub struct ContractPayouts {
  /// Total collateral (offer + accept), in satoshis.
  pub total_collateral_sats: BigInt,
  /// `true` for enum contracts (labeled outcomes); `false` for numeric (ranges).
  pub is_enum: bool,
  /// The payout rows, in outcome order.
  pub rows: Vec<PayoutRow>,
}

impl From<ddk_ffi::contract::ContractPayouts> for ContractPayouts {
  fn from(payouts: ddk_ffi::contract::ContractPayouts) -> Self {
    ContractPayouts {
      total_collateral_sats: u64_to_bigint(payouts.total_collateral_sats),
      is_enum: payouts.is_enum,
      rows: payouts.rows.into_iter().map(Into::into).collect(),
    }
  }
}

// ---------------------------------------------------------------------------
// ContractKeyProvider
// ---------------------------------------------------------------------------

/// Deterministically derives DLC contract funding keys from a master extended
/// private key. Secret keys never leave this object.
#[napi]
pub struct ContractKeyProvider {
  inner: Arc<ddk_ffi::contract::ContractKeyProvider>,
}

#[napi]
impl ContractKeyProvider {
  /// Builds a provider from a BIP39 mnemonic (with optional passphrase).
  #[napi(factory)]
  pub fn from_mnemonic(
    mnemonic: String,
    passphrase: Option<String>,
    network: String,
  ) -> Result<Self, &'static str> {
    let inner =
      ddk_ffi::contract::ContractKeyProvider::from_mnemonic(mnemonic, passphrase, network)
        .map_err(map_contract_error)?;
    Ok(Self { inner })
  }

  /// Builds a provider from a raw seed (e.g. the 64 bytes from a mnemonic).
  #[napi(factory)]
  pub fn from_seed(seed: Buffer, network: String) -> Result<Self, &'static str> {
    let inner = ddk_ffi::contract::ContractKeyProvider::from_seed(buffer_to_vec(&seed), network)
      .map_err(map_contract_error)?;
    Ok(Self { inner })
  }

  /// Builds a provider from a 78-byte encoded master extended private key.
  #[napi(factory)]
  pub fn from_xprv(xprv: Buffer) -> Result<Self, &'static str> {
    let inner = ddk_ffi::contract::ContractKeyProvider::from_xprv(buffer_to_vec(&xprv))
      .map_err(map_contract_error)?;
    Ok(Self { inner })
  }

  /// Builds a provider from an output descriptor carrying an extended private key.
  #[napi(factory)]
  pub fn from_descriptor(descriptor: String) -> Result<Self, &'static str> {
    let inner = ddk_ffi::contract::ContractKeyProvider::from_descriptor(descriptor)
      .map_err(map_contract_error)?;
    Ok(Self { inner })
  }

  /// The 33-byte compressed funding public key for a contract, from its 32-byte
  /// temporary id.
  #[napi]
  pub fn funding_pubkey(&self, temporary_contract_id: Buffer) -> Result<Buffer, &'static str> {
    let pubkey = self
      .inner
      .funding_pubkey(buffer_to_vec(&temporary_contract_id))
      .map_err(map_contract_error)?;
    Ok(vec_to_buffer(pubkey))
  }
}

// ---------------------------------------------------------------------------
// Offer-building helpers
// ---------------------------------------------------------------------------

/// The 32-byte chain hash for a network (bitcoin/testnet/signet/regtest).
#[napi]
pub fn chain_hash_from_network(network: String) -> Result<Buffer, &'static str> {
  let hash = ddk_ffi::contract::chain_hash_from_network(network).map_err(map_contract_error)?;
  Ok(vec_to_buffer(hash))
}

/// Builds a wire-encoded `FundingInput` from a wallet UTXO.
#[napi]
pub fn funding_input(
  previous_transaction: Buffer,
  vout: u32,
  input_serial_id: Option<BigInt>,
  sequence: u32,
  max_witness_len: u16,
  redeem_script: Buffer,
) -> Result<Buffer, &'static str> {
  let input = ddk_ffi::contract::funding_input(
    buffer_to_vec(&previous_transaction),
    vout,
    opt_bigint_to_u64(input_serial_id)?,
    sequence,
    max_witness_len,
    buffer_to_vec(&redeem_script),
  )
  .map_err(map_contract_error)?;
  Ok(vec_to_buffer(input))
}

// ---------------------------------------------------------------------------
// Message-driven lifecycle
// ---------------------------------------------------------------------------

/// Creates an offer. Returns the wire-encoded `OfferDlc`.
#[napi]
pub fn create_offer(params: CreateOfferParams) -> Result<Buffer, &'static str> {
  let offer = ddk_ffi::contract::create_offer(params.try_into()?).map_err(map_contract_error)?;
  Ok(vec_to_buffer(offer))
}

/// Validates an offer's structure, funding inputs, fee rate, collateral, and timeouts.
#[napi]
pub fn validate_offer(
  offer: Buffer,
  min_timeout_interval: u32,
  max_timeout_interval: u32,
) -> Result<(), &'static str> {
  ddk_ffi::contract::validate_offer(
    buffer_to_vec(&offer),
    min_timeout_interval,
    max_timeout_interval,
  )
  .map_err(map_contract_error)
}

/// Validates an accept message against its offer (acceptor's signatures).
#[napi]
pub fn validate_accept(offer: Buffer, accept: Buffer) -> Result<(), &'static str> {
  ddk_ffi::contract::validate_accept(buffer_to_vec(&offer), buffer_to_vec(&accept))
    .map_err(map_contract_error)
}

/// Validates a sign message against its offer and accept (offerer's signatures).
#[napi]
pub fn validate_sign(offer: Buffer, accept: Buffer, sign: Buffer) -> Result<(), &'static str> {
  ddk_ffi::contract::validate_sign(
    buffer_to_vec(&offer),
    buffer_to_vec(&accept),
    buffer_to_vec(&sign),
  )
  .map_err(map_contract_error)
}

/// The 32-byte contract id derived from the offer and accept messages.
#[napi]
pub fn compute_contract_id(offer: Buffer, accept: Buffer) -> Result<Buffer, &'static str> {
  let id = ddk_ffi::contract::compute_contract_id(buffer_to_vec(&offer), buffer_to_vec(&accept))
    .map_err(map_contract_error)?;
  Ok(vec_to_buffer(id))
}

/// Derives the per-outcome payout table from a wire-encoded `ContractInfo`.
#[napi]
pub fn contract_info_payouts(contract_info: Buffer) -> Result<ContractPayouts, &'static str> {
  let payouts = ddk_ffi::contract::contract_info_payouts(buffer_to_vec(&contract_info))
    .map_err(map_contract_error)?;
  Ok(payouts.into())
}

/// Accepts an offer. The accepting party's funding key is derived inside Rust
/// from `keys` + `newTemporaryContractId` and never crosses the boundary.
#[napi]
pub fn accept_offer(
  offer: Buffer,
  params: AcceptOfferParams,
  keys: &ContractKeyProvider,
  new_temporary_contract_id: Buffer,
) -> Result<AcceptResult, &'static str> {
  let result = ddk_ffi::contract::accept_offer(
    buffer_to_vec(&offer),
    params.try_into()?,
    keys.inner.clone(),
    buffer_to_vec(&new_temporary_contract_id),
  )
  .map_err(map_contract_error)?;
  Ok(result.into())
}

/// Rebuilds the BIP-174 funding PSBT from the offer and accept messages.
#[napi]
pub fn create_funding_psbt(offer: Buffer, accept: Buffer) -> Result<Buffer, &'static str> {
  let psbt = ddk_ffi::contract::create_funding_psbt(buffer_to_vec(&offer), buffer_to_vec(&accept))
    .map_err(map_contract_error)?;
  Ok(vec_to_buffer(psbt))
}

/// Rebuilds the unsigned funding, CET, and refund transactions from the messages.
#[napi]
pub fn dlc_transactions_from_messages(
  offer: Buffer,
  accept: Buffer,
) -> Result<DlcTransactions, &'static str> {
  let transactions = ddk_ffi::contract::dlc_transactions_from_messages(
    buffer_to_vec(&offer),
    buffer_to_vec(&accept),
  )
  .map_err(map_contract_error)?;
  Ok(transactions.into())
}

/// Signs a party's funding inputs on the funding PSBT using a private descriptor.
#[napi]
pub fn sign_funding_psbt_with_descriptor(
  offer: Buffer,
  accept: Buffer,
  funding_psbt: Buffer,
  descriptor: String,
  inputs: Vec<DescriptorInput>,
) -> Result<Buffer, &'static str> {
  let inputs: Result<Vec<ddk_ffi::contract::DescriptorInput>, &'static str> =
    inputs.into_iter().map(TryInto::try_into).collect();
  let signed = ddk_ffi::contract::sign_funding_psbt_with_descriptor(
    buffer_to_vec(&offer),
    buffer_to_vec(&accept),
    buffer_to_vec(&funding_psbt),
    descriptor,
    inputs?,
  )
  .map_err(map_contract_error)?;
  Ok(vec_to_buffer(signed))
}

/// The offering party verifies the accept message and produces its `SignDlc`.
#[napi]
pub fn sign_accept(
  offer: Buffer,
  accept: Buffer,
  keys: &ContractKeyProvider,
  temporary_contract_id: Buffer,
  signed_funding_psbt: Buffer,
) -> Result<SignResult, &'static str> {
  let result = ddk_ffi::contract::sign_accept(
    buffer_to_vec(&offer),
    buffer_to_vec(&accept),
    keys.inner.clone(),
    buffer_to_vec(&temporary_contract_id),
    buffer_to_vec(&signed_funding_psbt),
  )
  .map_err(map_contract_error)?;
  Ok(result.into())
}

/// Like `signAccept`, additionally co-signing any splice (DLC) funding inputs.
#[napi]
pub fn sign_accept_spliced(
  offer: Buffer,
  accept: Buffer,
  keys: &ContractKeyProvider,
  temporary_contract_id: Buffer,
  signed_funding_psbt: Buffer,
  splice_keys: Vec<SpliceKeyRef>,
) -> Result<SignResult, &'static str> {
  let result = ddk_ffi::contract::sign_accept_spliced(
    buffer_to_vec(&offer),
    buffer_to_vec(&accept),
    keys.inner.clone(),
    buffer_to_vec(&temporary_contract_id),
    buffer_to_vec(&signed_funding_psbt),
    splice_keys_to_ffi(splice_keys)?,
  )
  .map_err(map_contract_error)?;
  Ok(result.into())
}

/// The accepting party verifies the sign message and completes the funding tx.
/// Returns the Bitcoin consensus-serialized signed transaction.
#[napi]
pub fn finalize_sign(
  offer: Buffer,
  accept: Buffer,
  sign: Buffer,
  signed_funding_psbt: Buffer,
) -> Result<Buffer, &'static str> {
  let tx = ddk_ffi::contract::finalize_sign(
    buffer_to_vec(&offer),
    buffer_to_vec(&accept),
    buffer_to_vec(&sign),
    buffer_to_vec(&signed_funding_psbt),
  )
  .map_err(map_contract_error)?;
  Ok(vec_to_buffer(tx))
}

/// Like `finalizeSign`, additionally completing any splice (DLC) input witnesses.
#[napi]
pub fn finalize_sign_spliced(
  offer: Buffer,
  accept: Buffer,
  sign: Buffer,
  signed_funding_psbt: Buffer,
  keys: &ContractKeyProvider,
  splice_keys: Vec<SpliceKeyRef>,
) -> Result<Buffer, &'static str> {
  let tx = ddk_ffi::contract::finalize_sign_spliced(
    buffer_to_vec(&offer),
    buffer_to_vec(&accept),
    buffer_to_vec(&sign),
    buffer_to_vec(&signed_funding_psbt),
    keys.inner.clone(),
    splice_keys_to_ffi(splice_keys)?,
  )
  .map_err(map_contract_error)?;
  Ok(vec_to_buffer(tx))
}

// ---------------------------------------------------------------------------
// Splicing
// ---------------------------------------------------------------------------

/// Rebuilds the splice `FundingInput` (wire-encoded) that spends a previous
/// contract's 2-of-2 funding output, from that contract's offer and accept.
#[napi]
pub fn create_dlc_splice_input(
  prev_offer: Buffer,
  prev_accept: Buffer,
  local_party: Party,
  input_serial_id: Option<BigInt>,
  max_witness_len: u16,
) -> Result<Buffer, &'static str> {
  let input = ddk_ffi::contract::create_dlc_splice_input(
    buffer_to_vec(&prev_offer),
    buffer_to_vec(&prev_accept),
    local_party.into(),
    opt_bigint_to_u64(input_serial_id)?,
    max_witness_len,
  )
  .map_err(map_contract_error)?;
  Ok(vec_to_buffer(input))
}

/// The required `max_witness_len` for a DLC (splice) funding input (220).
#[napi]
pub fn dlc_input_max_witness_len() -> u16 {
  ddk_ffi::contract::dlc_input_max_witness_len()
}
