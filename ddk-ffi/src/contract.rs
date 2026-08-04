//! FFI bindings for the stateless DLC contract API and deterministic contract
//! key derivation, backed by the `ddk::contract` module.
//!
//! # Provider-object key model
//!
//! [`ContractKeyProvider`] is a uniffi object: secret keys are created and held
//! inside Rust and never cross the FFI boundary. Foreign consumers construct a
//! provider from their key material (mnemonic, seed, xprv, or descriptor), then
//! ask for a `funding_pubkey` to publish. The splice sign/finalize functions
//! (added alongside this) take the provider plus contract temporary ids and
//! re-derive the required secret keys internally, so a `SecretKey` is never
//! marshalled out. The only thing a consumer must persist per contract is its
//! 32-byte `temporary_contract_id`.

use std::str::FromStr;
use std::sync::Arc;

use bitcoin::bip32::Xpriv;
use bitcoin::psbt::Psbt;
use bitcoin::{Amount, Network, ScriptBuf, Transaction};
use lightning::util::ser::{Readable, Writeable};
use secp256k1_zkp::PublicKey;

use ddk::contract as ddk_contract;
use ddk::ddk_manager;
use ddk_contract::{
    AcceptOfferParams as RustAcceptOfferParams, CreateOfferParams as RustCreateOfferParams,
    DescriptorInput as RustDescriptorInput, DlcInputSigningKey, Party as RustParty,
    PartyParams as RustPartyParams,
};
use ddk_messages::contract_msgs::ContractInfo;
use ddk_messages::{AcceptDlc, FundingInput, OfferDlc, SignDlc};

/// Errors returned by the stateless contract API.
///
/// Mirrors [`ddk::contract::ContractError`] as a uniffi error so the typed
/// variants survive across the binding boundary. Variants carry plain strings.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum ContractError {
    #[error("invalid offer: {message}")]
    InvalidOffer { message: String },
    #[error("invalid accept: {message}")]
    InvalidAccept { message: String },
    #[error("invalid sign: {message}")]
    InvalidSign { message: String },
    #[error("invalid funding input: {message}")]
    InvalidFundingInput { message: String },
    #[error("PSBT mismatch: {message}")]
    PsbtMismatch { message: String },
    #[error("PSBT input {input_index} does not have a finalized witness")]
    MissingFinalizedInput { input_index: u32 },
    #[error("PSBT input {input_index} has an unsupported script type")]
    UnsupportedScriptType { input_index: u32 },
    #[error("invalid attestation: {message}")]
    InvalidAttestation { message: String },
    #[error("no contract outcome matches the given attestations")]
    NoMatchingOutcome,
    #[error("descriptor error: {message}")]
    Descriptor { message: String },
    #[error("wallet error: {message}")]
    Wallet { message: String },
    #[error("BIP32 error: {message}")]
    Bip32 { message: String },
    #[error("DLC error: {message}")]
    Dlc { message: String },
    #[error("contract key error: {message}")]
    Key { message: String },
    /// A message or PSBT could not be (de)serialized at the FFI boundary.
    #[error("serialization error: {message}")]
    Serialization { message: String },
    /// The network string was not one of bitcoin/testnet/signet/regtest.
    #[error("invalid network: {message}")]
    InvalidNetwork { message: String },
    /// A byte argument had the wrong length (e.g. a 32-byte id).
    #[error("invalid length for {field}: expected {expected}, got {actual}")]
    InvalidLength {
        field: String,
        expected: u32,
        actual: u32,
    },
}

impl From<ddk_contract::ContractError> for ContractError {
    fn from(error: ddk_contract::ContractError) -> Self {
        use ddk_contract::ContractError as E;
        match error {
            E::InvalidOffer(message) => ContractError::InvalidOffer { message },
            E::InvalidAccept(message) => ContractError::InvalidAccept { message },
            E::InvalidSign(message) => ContractError::InvalidSign { message },
            E::InvalidFundingInput(message) => ContractError::InvalidFundingInput { message },
            E::PsbtMismatch(message) => ContractError::PsbtMismatch { message },
            E::MissingFinalizedInput { input_index } => ContractError::MissingFinalizedInput {
                input_index: input_index as u32,
            },
            E::UnsupportedScriptType { input_index } => ContractError::UnsupportedScriptType {
                input_index: input_index as u32,
            },
            E::InvalidAttestation(message) => ContractError::InvalidAttestation { message },
            E::NoMatchingOutcome => ContractError::NoMatchingOutcome,
            E::Descriptor(message) => ContractError::Descriptor { message },
            E::Wallet(message) => ContractError::Wallet { message },
            E::Bip32(message) => ContractError::Bip32 { message },
            E::Dlc(message) => ContractError::Dlc { message },
            E::Key(message) => ContractError::Key { message },
        }
    }
}

/// Parses a network string (`bitcoin` / `testnet` / `signet` / `regtest`).
pub(crate) fn parse_network(network: &str) -> Result<Network, ContractError> {
    Network::from_str(network).map_err(|_| ContractError::InvalidNetwork {
        message: network.to_string(),
    })
}

/// Converts a byte vector to a fixed 32-byte array, erroring on length mismatch.
pub(crate) fn to_array_32(bytes: &[u8], field: &str) -> Result<[u8; 32], ContractError> {
    bytes.try_into().map_err(|_| ContractError::InvalidLength {
        field: field.to_string(),
        expected: 32,
        actual: bytes.len() as u32,
    })
}

/// Deterministically derives DLC contract funding keys from a master extended
/// private key. Secret keys never leave this object.
///
/// Construct one from whatever key material the consumer holds, then call
/// [`ContractKeyProvider::funding_pubkey`] to obtain the public key to publish
/// in an offer/accept message.
#[derive(uniffi::Object)]
pub struct ContractKeyProvider {
    pub(crate) inner: ddk_contract::ContractKeyProvider,
}

#[uniffi::export]
impl ContractKeyProvider {
    /// Builds a provider from a BIP39 mnemonic (with optional passphrase).
    #[uniffi::constructor]
    pub fn from_mnemonic(
        mnemonic: String,
        passphrase: Option<String>,
        network: String,
    ) -> Result<Arc<Self>, ContractError> {
        let network = parse_network(&network)?;
        let inner = ddk_contract::ContractKeyProvider::from_mnemonic(
            &mnemonic,
            passphrase.as_deref(),
            network,
        )?;
        Ok(Arc::new(Self { inner }))
    }

    /// Builds a provider from a raw seed (for example the 64 bytes produced by
    /// `convert_mnemonic_to_seed`).
    #[uniffi::constructor]
    pub fn from_seed(seed: Vec<u8>, network: String) -> Result<Arc<Self>, ContractError> {
        let network = parse_network(&network)?;
        let inner = ddk_contract::ContractKeyProvider::from_seed(&seed, network)?;
        Ok(Arc::new(Self { inner }))
    }

    /// Builds a provider from a 78-byte encoded master extended private key
    /// (the encoding produced by `create_extkey_from_seed`).
    #[uniffi::constructor]
    pub fn from_xprv(xprv: Vec<u8>) -> Result<Arc<Self>, ContractError> {
        let xprv = Xpriv::decode(&xprv).map_err(|e| ContractError::Bip32 {
            message: e.to_string(),
        })?;
        Ok(Arc::new(Self {
            inner: ddk_contract::ContractKeyProvider::from_xprv(xprv),
        }))
    }

    /// Builds a provider from an output descriptor that carries an extended
    /// private key (e.g. `wpkh(xprv.../84h/1h/0h/0/*)`). Watch-only descriptors
    /// are rejected; the descriptor's own path/wildcard is not applied to
    /// contract-key derivation.
    #[uniffi::constructor]
    pub fn from_descriptor(descriptor: String) -> Result<Arc<Self>, ContractError> {
        let inner = ddk_contract::ContractKeyProvider::from_descriptor(&descriptor)?;
        Ok(Arc::new(Self { inner }))
    }

    /// The 33-byte compressed funding public key for a contract, from its
    /// 32-byte temporary id. Publish this in the offer or accept message.
    pub fn funding_pubkey(&self, temporary_contract_id: Vec<u8>) -> Result<Vec<u8>, ContractError> {
        let temp_id = to_array_32(&temporary_contract_id, "temporary_contract_id")?;
        let pubkey = self.inner.funding_pubkey(temp_id)?;
        Ok(pubkey.serialize().to_vec())
    }
}

// ---------------------------------------------------------------------------
// Serialization helpers
//
// Wire messages (OfferDlc/AcceptDlc/SignDlc/ContractInfo/FundingInput) cross the
// FFI boundary as their lightning `Writeable` (TLV) encoding — the same bytes
// node-dlc/BAL produce. PSBTs use the standard BIP-174 serialization; the final
// signed funding transaction uses Bitcoin consensus serialization.
// ---------------------------------------------------------------------------

fn encode_msg<T: Writeable>(msg: &T) -> Vec<u8> {
    msg.encode()
}

fn decode_msg<T: Readable>(bytes: &[u8], what: &str) -> Result<T, ContractError> {
    let mut cursor = lightning::io::Cursor::new(bytes);
    T::read(&mut cursor).map_err(|e| ContractError::Serialization {
        message: format!("failed to decode {what}: {e:?}"),
    })
}

fn decode_psbt(bytes: &[u8]) -> Result<Psbt, ContractError> {
    Psbt::deserialize(bytes).map_err(|e| ContractError::Serialization {
        message: format!("failed to decode PSBT: {e}"),
    })
}

/// Re-derives each splice input's previous-contract funding secret key from the
/// provider, keyed by (prior temporary id, input serial id). Secret keys stay
/// inside Rust — only the temporary ids cross the FFI boundary.
fn resolve_splice_keys(
    keys: &ContractKeyProvider,
    refs: &[SpliceKeyRef],
) -> Result<Vec<DlcInputSigningKey>, ContractError> {
    refs.iter()
        .map(|r| {
            let prior = to_array_32(
                &r.prior_temporary_contract_id,
                "prior_temporary_contract_id",
            )?;
            keys.inner
                .dlc_input_signing_key(prior, r.input_serial_id)
                .map_err(ContractError::from)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Parameter / result records
// ---------------------------------------------------------------------------

/// Identifies which party's funding inputs an operation applies to.
#[derive(uniffi::Enum)]
pub enum Party {
    /// The party that created the offer.
    Offer,
    /// The party that accepted the offer.
    Accept,
}

impl From<Party> for RustParty {
    fn from(party: Party) -> Self {
        match party {
            Party::Offer => RustParty::Offer,
            Party::Accept => RustParty::Accept,
        }
    }
}

/// One party's Bitcoin-level contract data (mirrors [`ddk::contract::PartyParams`]).
#[derive(uniffi::Record)]
pub struct ContractPartyParams {
    /// The 33-byte compressed DLC funding public key.
    pub funding_pubkey: Vec<u8>,
    /// The wallet UTXOs this party contributes, each a wire-encoded `FundingInput`.
    pub funding_inputs: Vec<Vec<u8>>,
    /// The script pubkey (raw bytes) CET and refund payouts are sent to.
    pub payout_spk: Vec<u8>,
    /// Serial id ordering the payout output; randomly generated when `None`.
    pub payout_serial_id: Option<u64>,
    /// The script pubkey (raw bytes) funding change is sent to.
    pub change_spk: Vec<u8>,
    /// Serial id ordering the change output; randomly generated when `None`.
    pub change_serial_id: Option<u64>,
}

impl ContractPartyParams {
    fn into_rust(self) -> Result<RustPartyParams, ContractError> {
        let funding_pubkey =
            PublicKey::from_slice(&self.funding_pubkey).map_err(|e| ContractError::Key {
                message: format!("invalid funding pubkey: {e}"),
            })?;
        let funding_inputs = self
            .funding_inputs
            .iter()
            .map(|bytes| decode_msg::<FundingInput>(bytes, "funding input"))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(RustPartyParams {
            funding_pubkey,
            funding_inputs,
            payout_spk: ScriptBuf::from_bytes(self.payout_spk),
            payout_serial_id: self.payout_serial_id,
            change_spk: ScriptBuf::from_bytes(self.change_spk),
            change_serial_id: self.change_serial_id,
        })
    }
}

/// Parameters for [`create_offer`] (mirrors [`ddk::contract::CreateOfferParams`]).
#[derive(uniffi::Record)]
pub struct CreateOfferParams {
    /// The 32-byte chain hash the contract settles on.
    pub chain_hash: Vec<u8>,
    /// The 32-byte temporary contract id; randomly generated when `None`.
    pub temporary_contract_id: Option<Vec<u8>>,
    /// The contract payout and oracle information, wire-encoded `ContractInfo`.
    pub contract_info: Vec<u8>,
    /// The collateral, in satoshis, contributed by the offering party.
    pub offer_collateral_sats: u64,
    /// The offering party's Bitcoin-level contract data.
    pub party: ContractPartyParams,
    /// Serial id ordering the funding output; randomly generated when `None`.
    pub fund_output_serial_id: Option<u64>,
    /// The fee rate, in satoshis per virtual byte.
    pub fee_rate_per_vb: u64,
    /// The earliest time CETs can be broadcast.
    pub cet_locktime: u32,
    /// The time after which the refund transaction can be broadcast.
    pub refund_locktime: u32,
    /// Contract feature flags. Use `0` unless a protocol extension requires otherwise.
    pub contract_flags: u8,
}

impl CreateOfferParams {
    fn into_rust(self) -> Result<RustCreateOfferParams, ContractError> {
        let chain_hash = to_array_32(&self.chain_hash, "chain_hash")?;
        let temporary_contract_id = self
            .temporary_contract_id
            .map(|bytes| to_array_32(&bytes, "temporary_contract_id"))
            .transpose()?;
        let contract_info: ContractInfo = decode_msg(&self.contract_info, "contract info")?;
        Ok(RustCreateOfferParams {
            chain_hash,
            temporary_contract_id,
            contract_info,
            offer_collateral: Amount::from_sat(self.offer_collateral_sats),
            party: self.party.into_rust()?,
            fund_output_serial_id: self.fund_output_serial_id,
            fee_rate_per_vb: self.fee_rate_per_vb,
            cet_locktime: self.cet_locktime,
            refund_locktime: self.refund_locktime,
            contract_flags: self.contract_flags,
        })
    }
}

/// Parameters for [`accept_offer`] (mirrors [`ddk::contract::AcceptOfferParams`]).
#[derive(uniffi::Record)]
pub struct AcceptOfferParams {
    /// The accepting party's Bitcoin-level contract data.
    pub party: ContractPartyParams,
    /// The minimum accepted interval between oracle maturity and the refund locktime.
    pub min_timeout_interval: u32,
    /// The maximum accepted interval between oracle maturity and the refund locktime.
    pub max_timeout_interval: u32,
}

impl AcceptOfferParams {
    fn into_rust(self) -> Result<RustAcceptOfferParams, ContractError> {
        Ok(RustAcceptOfferParams {
            party: self.party.into_rust()?,
            min_timeout_interval: self.min_timeout_interval,
            max_timeout_interval: self.max_timeout_interval,
        })
    }
}

/// The result of [`accept_offer`].
#[derive(uniffi::Record)]
pub struct AcceptResult {
    /// The wire-encoded `AcceptDlc` message to send to the offering party.
    pub accept: Vec<u8>,
    /// The unsigned funding, CET, and refund transactions.
    pub transactions: crate::DlcTransactions,
    /// The BIP-174 funding PSBT ready to be signed by either party's funding source.
    pub funding_psbt: Vec<u8>,
}

impl AcceptResult {
    fn from_rust(result: ddk_contract::AcceptResult) -> Self {
        AcceptResult {
            accept: encode_msg(&result.accept),
            transactions: crate::rust_dlc_transactions_to_uniffi(result.transactions),
            funding_psbt: result.funding_psbt.serialize(),
        }
    }
}

/// The result of [`sign_accept`] / [`sign_accept_spliced`].
#[derive(uniffi::Record)]
pub struct SignResult {
    /// The wire-encoded `SignDlc` message to send to the accepting party.
    pub sign: Vec<u8>,
    /// The unsigned funding, CET, and refund transactions.
    pub transactions: crate::DlcTransactions,
}

impl SignResult {
    fn from_rust(result: ddk_contract::SignResult) -> Self {
        SignResult {
            sign: encode_msg(&result.sign),
            transactions: crate::rust_dlc_transactions_to_uniffi(result.transactions),
        }
    }
}

/// References a splice (DLC) funding input and the previous contract whose
/// 2-of-2 output it spends, so the provider can re-derive the signing key.
#[derive(Clone, uniffi::Record)]
pub struct SpliceKeyRef {
    /// The serial id of the DLC (splice) funding input this key signs.
    pub input_serial_id: u64,
    /// The 32-byte temporary id of the previous contract being spliced from.
    pub prior_temporary_contract_id: Vec<u8>,
}

/// Identifies a funding input and the descriptor wildcard index that derives its
/// key, for [`sign_funding_psbt_with_descriptor`].
#[derive(uniffi::Record)]
pub struct DescriptorInput {
    /// The serial id of the funding input to sign.
    pub input_serial_id: u64,
    /// The descriptor wildcard derivation index of the input's script (ignored
    /// for descriptors without a wildcard).
    pub derivation_index: u32,
}

impl From<DescriptorInput> for RustDescriptorInput {
    fn from(input: DescriptorInput) -> Self {
        RustDescriptorInput {
            input_serial_id: input.input_serial_id,
            derivation_index: input.derivation_index,
        }
    }
}

// ---------------------------------------------------------------------------
// Offer-building helpers
// ---------------------------------------------------------------------------

/// The 32-byte chain hash for a network (`bitcoin` / `testnet` / `signet` /
/// `regtest`). Use it for [`CreateOfferParams::chain_hash`].
#[uniffi::export]
pub fn chain_hash_from_network(network: String) -> Result<Vec<u8>, ContractError> {
    Ok(ddk_contract::chain_hash_from_network(parse_network(&network)?).to_vec())
}

/// Builds a wire-encoded `FundingInput` from a wallet UTXO, ready to place in a
/// party's `funding_inputs`.
///
/// - `previous_transaction`: the full consensus-serialized transaction that
///   created the UTXO being spent.
/// - `vout`: the output index of the UTXO within that transaction.
/// - `input_serial_id`: orders the input in the funding transaction; randomly
///   generated when `None`.
/// - `sequence`: the input sequence (usually `0xffffffff`).
/// - `max_witness_len`: the input's maximum witness length (e.g. 108 for
///   P2WPKH).
/// - `redeem_script`: the redeem script for a P2SH input, or empty for others.
#[uniffi::export]
pub fn funding_input(
    previous_transaction: Vec<u8>,
    vout: u32,
    input_serial_id: Option<u64>,
    sequence: u32,
    max_witness_len: u16,
    redeem_script: Vec<u8>,
) -> Result<Vec<u8>, ContractError> {
    let previous_transaction: Transaction = bitcoin::consensus::deserialize(&previous_transaction)
        .map_err(|e| ContractError::Serialization {
            message: format!("failed to decode previous transaction: {e}"),
        })?;
    let input = ddk_contract::funding_input(
        &previous_transaction,
        vout,
        input_serial_id,
        sequence,
        max_witness_len,
        ScriptBuf::from_bytes(redeem_script),
    )?;
    Ok(encode_msg(&input))
}

// ---------------------------------------------------------------------------
// Message-driven lifecycle
// ---------------------------------------------------------------------------

/// Creates an offer. Returns the wire-encoded `OfferDlc` to send to the accepting party.
#[uniffi::export]
pub fn create_offer(params: CreateOfferParams) -> Result<Vec<u8>, ContractError> {
    let offer = ddk_contract::create_offer(params.into_rust()?)?;
    Ok(encode_msg(&offer))
}

/// Validates an offer's protocol version, funding inputs, fee rate, collateral,
/// and oracle timeouts.
///
/// The lifecycle functions already validate internally (`accept_offer` validates
/// the offer, `sign_accept` validates the accept, `finalize_sign` validates the
/// sign); these `validate_*` functions expose the same checks standalone, so a
/// consumer can independently verify a stored or received message at any time —
/// e.g. before persisting it, or when loading it back later.
#[uniffi::export]
pub fn validate_offer(
    offer: Vec<u8>,
    min_timeout_interval: u32,
    max_timeout_interval: u32,
) -> Result<(), ContractError> {
    let offer: OfferDlc = decode_msg(&offer, "offer")?;
    ddk_contract::validate_offer(&offer, min_timeout_interval, max_timeout_interval)?;
    Ok(())
}

/// Validates an accept message against its offer: the acceptor's CET adaptor
/// signatures and refund signature must be valid for the contract the two
/// messages describe. This is the same check `sign_accept` runs internally,
/// exposed so a stored/received `AcceptDlc` can be verified on its own.
#[uniffi::export]
pub fn validate_accept(offer: Vec<u8>, accept: Vec<u8>) -> Result<(), ContractError> {
    let offer: OfferDlc = decode_msg(&offer, "offer")?;
    let accept: AcceptDlc = decode_msg(&accept, "accept")?;
    ddk_contract::advanced::verify_cet_adaptor_signatures(
        &offer,
        &accept,
        RustParty::Accept,
        &accept.refund_signature,
        &accept.cet_adaptor_signatures,
    )?;
    Ok(())
}

/// Validates a sign message against its offer and accept: the offerer's CET
/// adaptor signatures and refund signature must be valid. This is the same
/// check `finalize_sign` runs internally, exposed so a stored/received `SignDlc`
/// can be verified on its own.
#[uniffi::export]
pub fn validate_sign(offer: Vec<u8>, accept: Vec<u8>, sign: Vec<u8>) -> Result<(), ContractError> {
    let offer: OfferDlc = decode_msg(&offer, "offer")?;
    let accept: AcceptDlc = decode_msg(&accept, "accept")?;
    let sign: SignDlc = decode_msg(&sign, "sign")?;
    ddk_contract::advanced::verify_cet_adaptor_signatures(
        &offer,
        &accept,
        RustParty::Offer,
        &sign.refund_signature,
        &sign.cet_adaptor_signatures,
    )?;
    Ok(())
}

/// The 32-byte contract id derived from the offer and accept messages — the
/// stable id of the funded contract. Use it to key stored contracts.
#[uniffi::export]
pub fn compute_contract_id(offer: Vec<u8>, accept: Vec<u8>) -> Result<Vec<u8>, ContractError> {
    let offer: OfferDlc = decode_msg(&offer, "offer")?;
    let accept: AcceptDlc = decode_msg(&accept, "accept")?;
    Ok(ddk_contract::advanced::compute_contract_id(&offer, &accept)?.to_vec())
}

/// One row of a contract's payout table.
///
/// Enum-contract rows carry an `outcome` label; numeric-contract rows carry an
/// inclusive `[range_start, range_end]` of outcome values that share the payout.
#[derive(uniffi::Record)]
pub struct PayoutRow {
    /// The outcome label (enum contracts only; `None` for numeric).
    pub outcome: Option<String>,
    /// Inclusive start of the outcome range (numeric contracts only; `None` for enum).
    pub range_start: Option<u64>,
    /// Inclusive end of the outcome range (numeric contracts only; `None` for enum).
    pub range_end: Option<u64>,
    /// The payout to the offering party, in satoshis.
    pub offer_payout_sats: u64,
    /// The payout to the accepting party, in satoshis.
    pub accept_payout_sats: u64,
}

/// A contract's payouts, derived from its `ContractInfo`, for display as a table.
#[derive(uniffi::Record)]
pub struct ContractPayouts {
    /// Total collateral (offer + accept), in satoshis.
    pub total_collateral_sats: u64,
    /// `true` for enum contracts (rows are labeled outcomes); `false` for numeric
    /// contracts (rows are outcome ranges).
    pub is_enum: bool,
    /// The payout rows, in outcome order.
    pub rows: Vec<PayoutRow>,
}

/// Derives the offer/accept payouts for every outcome of a contract from its
/// wire-encoded `ContractInfo`, for building a payout table to show users.
///
/// Handles both enum contracts (each row a labeled outcome) and numeric-outcome
/// contracts (each row an inclusive outcome range that shares a single payout,
/// as determined by the payout function and rounding intervals). Disjoint
/// contracts contribute the rows of each of their sub-contracts.
#[uniffi::export]
pub fn contract_info_payouts(contract_info: Vec<u8>) -> Result<ContractPayouts, ContractError> {
    use ddk_manager::contract::ContractDescriptor;

    let contract_info: ContractInfo = decode_msg(&contract_info, "contract info")?;
    let total_collateral = match &contract_info {
        ContractInfo::SingleContractInfo(single) => single.total_collateral,
        ContractInfo::DisjointContractInfo(disjoint) => disjoint.total_collateral,
    };

    let execution_infos =
        ddk_manager::contract::execution_contract_infos(&contract_info).map_err(|e| {
            ContractError::Dlc {
                message: format!("invalid contract info: {e}"),
            }
        })?;

    let mut is_enum = true;
    let mut rows = Vec::new();
    for info in &execution_infos {
        match &info.contract_descriptor {
            ContractDescriptor::Enum(descriptor) => {
                for outcome_payout in &descriptor.outcome_payouts {
                    rows.push(PayoutRow {
                        outcome: Some(outcome_payout.outcome.clone()),
                        range_start: None,
                        range_end: None,
                        offer_payout_sats: outcome_payout.payout.offer.to_sat(),
                        accept_payout_sats: outcome_payout.payout.accept.to_sat(),
                    });
                }
            }
            ContractDescriptor::Numerical(descriptor) => {
                is_enum = false;
                let range_payouts =
                    descriptor
                        .get_range_payouts(total_collateral)
                        .map_err(|e| ContractError::Dlc {
                            message: format!("failed to derive payouts: {e}"),
                        })?;
                for range in range_payouts {
                    let end = range.start.saturating_add(range.count.saturating_sub(1));
                    rows.push(PayoutRow {
                        outcome: None,
                        range_start: Some(range.start as u64),
                        range_end: Some(end as u64),
                        offer_payout_sats: range.payout.offer.to_sat(),
                        accept_payout_sats: range.payout.accept.to_sat(),
                    });
                }
            }
        }
    }

    Ok(ContractPayouts {
        total_collateral_sats: total_collateral.to_sat(),
        is_enum,
        rows,
    })
}

/// Accepts an offer. The accepting party's funding secret key is derived inside
/// Rust from `keys` + `new_temporary_contract_id` and never crosses the boundary;
/// it must match `params.party.funding_pubkey` (derive both from the same provider).
#[uniffi::export]
pub fn accept_offer(
    offer: Vec<u8>,
    params: AcceptOfferParams,
    keys: Arc<ContractKeyProvider>,
    new_temporary_contract_id: Vec<u8>,
) -> Result<AcceptResult, ContractError> {
    let offer: OfferDlc = decode_msg(&offer, "offer")?;
    let new_temp_id = to_array_32(&new_temporary_contract_id, "new_temporary_contract_id")?;
    let funding_secret_key = keys.inner.funding_secret_key(new_temp_id)?;
    let result = ddk_contract::accept_offer(&offer, params.into_rust()?, &funding_secret_key)?;
    Ok(AcceptResult::from_rust(result))
}

/// Rebuilds the BIP-174 funding PSBT from the offer and accept messages.
#[uniffi::export]
pub fn create_funding_psbt(offer: Vec<u8>, accept: Vec<u8>) -> Result<Vec<u8>, ContractError> {
    let offer: OfferDlc = decode_msg(&offer, "offer")?;
    let accept: AcceptDlc = decode_msg(&accept, "accept")?;
    let psbt = ddk_contract::create_funding_psbt(&offer, &accept)?;
    Ok(psbt.serialize())
}

/// Signs a party's own funding inputs on the funding PSBT using a private output
/// descriptor (e.g. bdk's `wpkh(...)` with an xprv), returning the updated PSBT.
/// Each entry in `inputs` names one of this party's funding inputs (by serial
/// id) and the descriptor wildcard index that derives its key. Supports `wpkh()`
/// and `sh(wpkh())`, with or without a wildcard.
#[uniffi::export]
pub fn sign_funding_psbt_with_descriptor(
    offer: Vec<u8>,
    accept: Vec<u8>,
    funding_psbt: Vec<u8>,
    descriptor: String,
    inputs: Vec<DescriptorInput>,
) -> Result<Vec<u8>, ContractError> {
    let offer: OfferDlc = decode_msg(&offer, "offer")?;
    let accept: AcceptDlc = decode_msg(&accept, "accept")?;
    let mut psbt = decode_psbt(&funding_psbt)?;
    let inputs: Vec<RustDescriptorInput> = inputs.into_iter().map(Into::into).collect();
    ddk_contract::signing::sign_funding_psbt_with_descriptor(
        &offer,
        &accept,
        &mut psbt,
        &descriptor,
        &inputs,
    )?;
    Ok(psbt.serialize())
}

/// Rebuilds the unsigned funding, CET, and refund transactions from the messages.
#[uniffi::export]
pub fn dlc_transactions_from_messages(
    offer: Vec<u8>,
    accept: Vec<u8>,
) -> Result<crate::DlcTransactions, ContractError> {
    let offer: OfferDlc = decode_msg(&offer, "offer")?;
    let accept: AcceptDlc = decode_msg(&accept, "accept")?;
    let transactions = ddk_contract::create_dlc_transactions(&offer, &accept)?;
    Ok(crate::rust_dlc_transactions_to_uniffi(transactions))
}

/// The offering party verifies the accept message and produces its `SignDlc`.
/// The offer party's funding secret key is derived from `keys` +
/// `temporary_contract_id` (the new contract's id).
#[uniffi::export]
pub fn sign_accept(
    offer: Vec<u8>,
    accept: Vec<u8>,
    keys: Arc<ContractKeyProvider>,
    temporary_contract_id: Vec<u8>,
    signed_funding_psbt: Vec<u8>,
) -> Result<SignResult, ContractError> {
    sign_accept_spliced(
        offer,
        accept,
        keys,
        temporary_contract_id,
        signed_funding_psbt,
        Vec::new(),
    )
}

/// Like [`sign_accept`], but additionally co-signs any splice (DLC) funding
/// inputs. For each splice input, `splice_keys` names the previous contract; the
/// prior funding secret key is re-derived inside Rust from `keys`.
#[uniffi::export]
pub fn sign_accept_spliced(
    offer: Vec<u8>,
    accept: Vec<u8>,
    keys: Arc<ContractKeyProvider>,
    temporary_contract_id: Vec<u8>,
    signed_funding_psbt: Vec<u8>,
    splice_keys: Vec<SpliceKeyRef>,
) -> Result<SignResult, ContractError> {
    let offer: OfferDlc = decode_msg(&offer, "offer")?;
    let accept: AcceptDlc = decode_msg(&accept, "accept")?;
    let temp_id = to_array_32(&temporary_contract_id, "temporary_contract_id")?;
    let funding_secret_key = keys.inner.funding_secret_key(temp_id)?;
    let psbt = decode_psbt(&signed_funding_psbt)?;
    let dlc_input_keys = resolve_splice_keys(&keys, &splice_keys)?;
    let result = ddk_contract::sign_accept_spliced(
        &offer,
        &accept,
        &funding_secret_key,
        &psbt,
        &dlc_input_keys,
    )?;
    Ok(SignResult::from_rust(result))
}

/// The accepting party verifies the sign message and completes the funding
/// transaction. Returns the Bitcoin consensus-serialized signed transaction.
#[uniffi::export]
pub fn finalize_sign(
    offer: Vec<u8>,
    accept: Vec<u8>,
    sign: Vec<u8>,
    signed_funding_psbt: Vec<u8>,
) -> Result<Vec<u8>, ContractError> {
    let offer: OfferDlc = decode_msg(&offer, "offer")?;
    let accept: AcceptDlc = decode_msg(&accept, "accept")?;
    let sign: SignDlc = decode_msg(&sign, "sign")?;
    let psbt = decode_psbt(&signed_funding_psbt)?;
    let tx = ddk_contract::finalize_sign(&offer, &accept, &sign, &psbt)?;
    Ok(bitcoin::consensus::serialize(&tx))
}

/// Like [`finalize_sign`], but additionally completes the 2-of-2 witness for any
/// splice (DLC) funding input using this (accepting) party's prior funding keys,
/// re-derived inside Rust from `keys`.
#[uniffi::export]
pub fn finalize_sign_spliced(
    offer: Vec<u8>,
    accept: Vec<u8>,
    sign: Vec<u8>,
    signed_funding_psbt: Vec<u8>,
    keys: Arc<ContractKeyProvider>,
    splice_keys: Vec<SpliceKeyRef>,
) -> Result<Vec<u8>, ContractError> {
    let offer: OfferDlc = decode_msg(&offer, "offer")?;
    let accept: AcceptDlc = decode_msg(&accept, "accept")?;
    let sign: SignDlc = decode_msg(&sign, "sign")?;
    let psbt = decode_psbt(&signed_funding_psbt)?;
    let dlc_input_keys = resolve_splice_keys(&keys, &splice_keys)?;
    let tx = ddk_contract::finalize_sign_spliced(&offer, &accept, &sign, &psbt, &dlc_input_keys)?;
    Ok(bitcoin::consensus::serialize(&tx))
}

// ---------------------------------------------------------------------------
// Splicing
// ---------------------------------------------------------------------------

/// Rebuilds the splice `FundingInput` (wire-encoded) that spends a previous
/// contract's 2-of-2 funding output, from that contract's offer and accept
/// messages. Only the offering party contributes a splice input; place the
/// result in the offering party's `funding_inputs`. `max_witness_len` must be
/// greater than 108 — use [`dlc_input_max_witness_len`].
#[uniffi::export]
pub fn create_dlc_splice_input(
    prev_offer: Vec<u8>,
    prev_accept: Vec<u8>,
    local_party: Party,
    input_serial_id: Option<u64>,
    max_witness_len: u16,
) -> Result<Vec<u8>, ContractError> {
    let prev_offer: OfferDlc = decode_msg(&prev_offer, "previous offer")?;
    let prev_accept: AcceptDlc = decode_msg(&prev_accept, "previous accept")?;
    let input = ddk_contract::create_dlc_splice_input(
        &prev_offer,
        &prev_accept,
        local_party.into(),
        input_serial_id,
        max_witness_len,
    )?;
    Ok(encode_msg(&input))
}

/// The required `max_witness_len` for a DLC (splice) funding input (220).
#[uniffi::export]
pub fn dlc_input_max_witness_len() -> u16 {
    ddk_contract::DLC_INPUT_MAX_WITNESS_LEN
}

#[cfg(test)]
mod tests {
    use super::*;

    const MNEMONIC: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn provider(network: &str) -> Arc<ContractKeyProvider> {
        ContractKeyProvider::from_mnemonic(MNEMONIC.to_string(), None, network.to_string()).unwrap()
    }

    #[test]
    fn funding_pubkey_is_a_deterministic_compressed_point() {
        let provider = provider("regtest");
        let temp_id = vec![7u8; 32];
        let pk1 = provider.funding_pubkey(temp_id.clone()).unwrap();
        let pk2 = provider.funding_pubkey(temp_id).unwrap();
        assert_eq!(pk1.len(), 33);
        assert_eq!(pk1, pk2);
        assert!(pk1[0] == 0x02 || pk1[0] == 0x03, "compressed pubkey prefix");
    }

    #[test]
    fn wrapper_matches_underlying_ddk_provider() {
        let wrapped = provider("regtest");
        let direct =
            ddk_contract::ContractKeyProvider::from_mnemonic(MNEMONIC, None, Network::Regtest)
                .unwrap();
        let temp_id = [42u8; 32];
        let expected = direct.funding_pubkey(temp_id).unwrap().serialize().to_vec();
        assert_eq!(wrapped.funding_pubkey(temp_id.to_vec()).unwrap(), expected);
    }

    #[test]
    fn constructors_agree_across_mnemonic_seed_and_xprv() {
        let seed = bip39::Mnemonic::from_str(MNEMONIC).unwrap().to_seed("");
        let from_mnemonic = provider("bitcoin");
        let from_seed =
            ContractKeyProvider::from_seed(seed.to_vec(), "bitcoin".to_string()).unwrap();
        let xprv = Xpriv::new_master(Network::Bitcoin, &seed).unwrap();
        let from_xprv = ContractKeyProvider::from_xprv(xprv.encode().to_vec()).unwrap();

        let temp_id = vec![1u8; 32];
        let expected = from_mnemonic.funding_pubkey(temp_id.clone()).unwrap();
        assert_eq!(from_seed.funding_pubkey(temp_id.clone()).unwrap(), expected);
        assert_eq!(from_xprv.funding_pubkey(temp_id).unwrap(), expected);
    }

    #[test]
    fn rejects_wrong_length_temporary_id() {
        let provider = provider("regtest");
        let err = provider.funding_pubkey(vec![0u8; 31]).unwrap_err();
        assert!(matches!(
            err,
            ContractError::InvalidLength {
                expected: 32,
                actual: 31,
                ..
            }
        ));
    }

    #[test]
    fn rejects_unknown_network() {
        // ContractKeyProvider is intentionally not Debug (it holds secret key
        // material), so match on the Result rather than calling unwrap_err().
        let result = ContractKeyProvider::from_seed(vec![0u8; 64], "mainnet-typo".to_string());
        assert!(matches!(result, Err(ContractError::InvalidNetwork { .. })));
    }

    // -----------------------------------------------------------------------
    // Lifecycle marshalling round-trips.
    //
    // These build a contract via the direct `ddk::contract` API and via the FFI
    // records with identical data, then assert the wire-encoded messages match
    // byte-for-byte. All serial ids and the temporary id are fixed so
    // create_offer / accept_offer are deterministic.
    // -----------------------------------------------------------------------

    use bitcoin::absolute::LockTime;
    use bitcoin::bip32::DerivationPath;
    use bitcoin::transaction::Version;
    use bitcoin::{OutPoint, Sequence, Transaction, TxIn, TxOut, Witness};
    use ddk_messages::contract_msgs::{
        ContractDescriptor, ContractInfoInner, ContractOutcome, EnumeratedContractDescriptor,
        SingleContractInfo,
    };
    use ddk_messages::oracle_msgs::{
        tagged_announcement_msg, EnumEventDescriptor, EventDescriptor, OracleAnnouncement,
        OracleEvent, OracleInfo, SingleOracleInfo,
    };
    use secp256k1_zkp::{All, Keypair, Secp256k1, SecretKey, XOnlyPublicKey};

    const TOTAL_COLLATERAL: Amount = Amount::from_sat(100_000);
    const OFFER_TEMP_ID: [u8; 32] = [0x5c; 32];
    const ACCEPT_TEMP_ID: [u8; 32] = [0xa1; 32];
    const NETWORK: Network = Network::Regtest;

    fn enum_contract_info() -> ContractInfo {
        enum_contract_info_with(TOTAL_COLLATERAL)
    }

    // A two-outcome enum contract with `total` collateral ("up" pays it all to
    // the offerer, "down" all to the accepter).
    fn enum_contract_info_with(total: Amount) -> ContractInfo {
        let secp = Secp256k1::new();
        let oracle_key =
            Keypair::from_secret_key(&secp, &SecretKey::from_slice(&[88; 32]).unwrap());
        let nonce_key = Keypair::from_secret_key(&secp, &SecretKey::from_slice(&[90; 32]).unwrap());
        let oracle_event = OracleEvent {
            oracle_nonces: vec![XOnlyPublicKey::from_keypair(&nonce_key).0],
            event_maturity_epoch: 750,
            event_descriptor: EventDescriptor::EnumEvent(EnumEventDescriptor {
                outcomes: vec!["up".to_string(), "down".to_string()],
            }),
            event_id: "ddk-ffi-test".to_string(),
        };
        let announcement = OracleAnnouncement {
            announcement_signature: secp
                .sign_schnorr(&tagged_announcement_msg(&oracle_event), &oracle_key),
            oracle_public_key: XOnlyPublicKey::from_keypair(&oracle_key).0,
            oracle_event,
        };
        ContractInfo::SingleContractInfo(SingleContractInfo {
            total_collateral: total,
            contract_info: ContractInfoInner {
                contract_descriptor: ContractDescriptor::EnumeratedContractDescriptor(
                    EnumeratedContractDescriptor {
                        payouts: vec![
                            ContractOutcome {
                                outcome: "up".to_string(),
                                offer_payout: total,
                            },
                            ContractOutcome {
                                outcome: "down".to_string(),
                                offer_payout: Amount::ZERO,
                            },
                        ],
                    },
                ),
                oracle_info: OracleInfo::Single(SingleOracleInfo {
                    oracle_announcement: announcement,
                }),
            },
        })
    }

    fn p2wpkh_script(secp: &Secp256k1<All>, xpriv: &Xpriv, path: &DerivationPath) -> ScriptBuf {
        let public_key = xpriv
            .derive_priv(secp, path)
            .unwrap()
            .to_priv()
            .public_key(secp);
        ScriptBuf::new_p2wpkh(&public_key.wpubkey_hash().unwrap())
    }

    fn previous_transaction(value: Amount, script_pubkey: ScriptBuf) -> Transaction {
        Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint::null(),
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value,
                script_pubkey,
            }],
        }
    }

    /// A party built exactly as the FFI provider-object model expects: the DLC
    /// funding key comes from a ContractKeyProvider (by temp id), and a single
    /// P2WPKH funding UTXO with a fixed serial id.
    struct BuiltParty {
        provider: Arc<ContractKeyProvider>,
        rust: RustPartyParams,
        script: ScriptBuf,
        funding_input: FundingInput,
    }

    fn build_party(seed_byte: u8, temp_id: [u8; 32], input_serial: u64) -> BuiltParty {
        let secp = Secp256k1::new();
        let xpriv = Xpriv::new_master(NETWORK, &[seed_byte; 64]).unwrap();
        let provider = ContractKeyProvider::from_xprv(xpriv.encode().to_vec()).unwrap();
        let funding_pubkey = provider.inner.funding_pubkey(temp_id).unwrap();
        let path = DerivationPath::from_str("84h/1h/0h/0/0").unwrap();
        let script = p2wpkh_script(&secp, &xpriv, &path);
        let prev = previous_transaction(Amount::from_sat(200_000), script.clone());
        let funding_input = ddk_contract::funding_input(
            &prev,
            0,
            Some(input_serial),
            u32::MAX,
            108,
            ScriptBuf::new(),
        )
        .unwrap();
        let rust = RustPartyParams {
            funding_pubkey,
            funding_inputs: vec![funding_input.clone()],
            payout_spk: script.clone(),
            payout_serial_id: Some(input_serial + 1),
            change_spk: script.clone(),
            change_serial_id: Some(input_serial + 2),
        };
        BuiltParty {
            provider,
            rust,
            script,
            funding_input,
        }
    }

    fn ffi_party(party: &BuiltParty) -> ContractPartyParams {
        ContractPartyParams {
            funding_pubkey: party.rust.funding_pubkey.serialize().to_vec(),
            funding_inputs: vec![encode_msg(&party.funding_input)],
            payout_spk: party.script.as_bytes().to_vec(),
            payout_serial_id: party.rust.payout_serial_id,
            change_spk: party.script.as_bytes().to_vec(),
            change_serial_id: party.rust.change_serial_id,
        }
    }

    #[test]
    fn create_offer_marshals_identically_to_ddk() {
        let offerer = build_party(11, OFFER_TEMP_ID, 100);
        let contract_info = enum_contract_info();
        let chain_hash = ddk_contract::chain_hash_from_network(NETWORK);

        let rust_params = RustCreateOfferParams {
            chain_hash,
            temporary_contract_id: Some(OFFER_TEMP_ID),
            contract_info: contract_info.clone(),
            offer_collateral: Amount::from_sat(60_000),
            party: offerer.rust.clone(),
            fund_output_serial_id: Some(500),
            fee_rate_per_vb: 2,
            cet_locktime: 500,
            refund_locktime: 1_000,
            contract_flags: 0,
        };
        let direct = ddk_contract::create_offer(rust_params).unwrap();

        let ffi_params = CreateOfferParams {
            chain_hash: chain_hash.to_vec(),
            temporary_contract_id: Some(OFFER_TEMP_ID.to_vec()),
            contract_info: encode_msg(&contract_info),
            offer_collateral_sats: 60_000,
            party: ffi_party(&offerer),
            fund_output_serial_id: Some(500),
            fee_rate_per_vb: 2,
            cet_locktime: 500,
            refund_locktime: 1_000,
            contract_flags: 0,
        };
        let ffi_offer = create_offer(ffi_params).unwrap();

        assert_eq!(ffi_offer, encode_msg(&direct));
        // And the resulting offer passes validation.
        validate_offer(ffi_offer, 100, 100_000).unwrap();
    }

    #[test]
    fn accept_offer_marshals_identically_to_ddk() {
        // Offerer builds and encodes an offer.
        let offerer = build_party(11, OFFER_TEMP_ID, 100);
        let contract_info = enum_contract_info();
        let chain_hash = ddk_contract::chain_hash_from_network(NETWORK);
        let offer = ddk_contract::create_offer(RustCreateOfferParams {
            chain_hash,
            temporary_contract_id: Some(OFFER_TEMP_ID),
            contract_info,
            offer_collateral: Amount::from_sat(60_000),
            party: offerer.rust,
            fund_output_serial_id: Some(500),
            fee_rate_per_vb: 2,
            cet_locktime: 500,
            refund_locktime: 1_000,
            contract_flags: 0,
        })
        .unwrap();
        let offer_bytes = encode_msg(&offer);

        // Acceptor derives its DLC funding key from a provider (by temp id).
        let acceptor = build_party(22, ACCEPT_TEMP_ID, 200);
        let funding_secret_key = acceptor
            .provider
            .inner
            .funding_secret_key(ACCEPT_TEMP_ID)
            .unwrap();

        let direct = ddk_contract::accept_offer(
            &offer,
            RustAcceptOfferParams {
                party: acceptor.rust.clone(),
                min_timeout_interval: 100,
                max_timeout_interval: 100_000,
            },
            &funding_secret_key,
        )
        .unwrap();

        let ffi = accept_offer(
            offer_bytes,
            AcceptOfferParams {
                party: ffi_party(&acceptor),
                min_timeout_interval: 100,
                max_timeout_interval: 100_000,
            },
            acceptor.provider.clone(),
            ACCEPT_TEMP_ID.to_vec(),
        )
        .unwrap();

        // The funding PSBT carries no signatures yet, so it is deterministic
        // and must match byte-for-byte.
        assert_eq!(ffi.funding_psbt, direct.funding_psbt.serialize());

        // The full accept message is NOT byte-comparable: its CET adaptor
        // signatures use fresh nonces, so they differ between the two calls.
        // Instead verify the FFI accept is valid, round-trippable wire bytes
        // whose deterministic fields match the direct call.
        let decoded: AcceptDlc = decode_msg(&ffi.accept, "accept").unwrap();
        assert_eq!(encode_msg(&decoded), ffi.accept, "accept bytes round-trip");
        assert_eq!(
            decoded.temporary_contract_id,
            direct.accept.temporary_contract_id
        );
        assert_eq!(decoded.accept_collateral, direct.accept.accept_collateral);
        assert_eq!(decoded.funding_pubkey, direct.accept.funding_pubkey);
        assert_eq!(decoded.change_spk, direct.accept.change_spk);
        // The acceptor's funding key was derived inside Rust from the provider.
        assert_eq!(decoded.funding_pubkey, acceptor.rust.funding_pubkey);
    }

    // Exercises the full offer-building surface exactly as the example app does:
    // chain_hash_from_network + funding_input helpers, a ContractKeyProvider
    // funding key, and a valid oracle contract info, all the way through
    // create_offer + validate_offer.
    #[test]
    fn create_offer_via_ffi_helpers() {
        let secp = Secp256k1::new();
        let xpriv = Xpriv::new_master(NETWORK, &[9u8; 64]).unwrap();
        let path = DerivationPath::from_str("84h/1h/0h/0/0").unwrap();
        let script = p2wpkh_script(&secp, &xpriv, &path);
        let prev = previous_transaction(Amount::from_sat(200_000), script.clone());
        let prev_tx_bytes = bitcoin::consensus::serialize(&prev);
        let contract_info_bytes = encode_msg(&enum_contract_info());

        // Build the funding input and chain hash through the FFI helpers.
        let funding_input_bytes =
            funding_input(prev_tx_bytes, 0, Some(100), 0xffff_ffff, 108, Vec::new()).unwrap();
        let chain_hash = chain_hash_from_network("testnet".to_string()).unwrap();
        assert_eq!(chain_hash.len(), 32);

        // Funding key from the provider; payout/change scripts from the wallet.
        let keys =
            ContractKeyProvider::from_mnemonic(MNEMONIC.to_string(), None, "testnet".to_string())
                .unwrap();
        let funding_pubkey = keys.funding_pubkey(vec![0x5c; 32]).unwrap();
        let script_bytes = script.as_bytes().to_vec();

        let params = CreateOfferParams {
            chain_hash,
            temporary_contract_id: Some(vec![0x5c; 32]),
            contract_info: contract_info_bytes,
            offer_collateral_sats: 60_000,
            party: ContractPartyParams {
                funding_pubkey,
                funding_inputs: vec![funding_input_bytes],
                payout_spk: script_bytes.clone(),
                payout_serial_id: Some(1),
                change_spk: script_bytes,
                change_serial_id: Some(2),
            },
            fund_output_serial_id: Some(3),
            fee_rate_per_vb: 2,
            cet_locktime: 500,
            refund_locktime: 1_000,
            contract_flags: 0,
        };

        let offer = create_offer(params).unwrap();
        validate_offer(offer, 100, 100_000).unwrap();
    }

    // The complete funding flow with NO live oracle: a single-funded contract
    // (the offerer funds all collateral, the acceptor contributes nothing) is
    // driven offer -> accept -> fund PSBT -> descriptor-sign -> sign -> finalize
    // entirely through the FFI, producing a fully-signed funding transaction.
    // This is exactly the flow the example app runs.
    #[test]
    fn full_single_funded_flow_via_ffi() {
        let secp = Secp256k1::new();
        let path = DerivationPath::from_str("84h/1h/0h/0/0").unwrap();

        // Offerer wallet: a wpkh descriptor and its index-0 P2WPKH funding UTXO.
        let offerer_master = Xpriv::new_master(NETWORK, &[3u8; 64]).unwrap();
        let offerer_script = p2wpkh_script(&secp, &offerer_master, &path);
        let offerer_descriptor = format!("wpkh({offerer_master}/84h/1h/0h/0/*)");
        let prev = previous_transaction(Amount::from_sat(200_000), offerer_script.clone());
        let funding = funding_input(
            bitcoin::consensus::serialize(&prev),
            0,
            Some(100),
            0xffff_ffff,
            108,
            Vec::new(),
        )
        .unwrap();

        // DLC funding keys (distinct from the wallet keys) from each party.
        let offerer_keys =
            ContractKeyProvider::from_xprv(offerer_master.encode().to_vec()).unwrap();
        let offer_temp_id = vec![0x5c; 32];
        let offerer_funding_pubkey = offerer_keys.funding_pubkey(offer_temp_id.clone()).unwrap();

        let acceptor_master = Xpriv::new_master(NETWORK, &[4u8; 64]).unwrap();
        let acceptor_keys =
            ContractKeyProvider::from_xprv(acceptor_master.encode().to_vec()).unwrap();
        let accept_temp_id = vec![0xa1; 32];
        let acceptor_funding_pubkey = acceptor_keys
            .funding_pubkey(accept_temp_id.clone())
            .unwrap();
        let acceptor_script = p2wpkh_script(&secp, &acceptor_master, &path)
            .as_bytes()
            .to_vec();

        // Offer: single-funded, the offerer contributes all 100 000 sats.
        let offer = create_offer(CreateOfferParams {
            chain_hash: chain_hash_from_network("regtest".to_string()).unwrap(),
            temporary_contract_id: Some(offer_temp_id.clone()),
            contract_info: encode_msg(&enum_contract_info()),
            offer_collateral_sats: 100_000,
            party: ContractPartyParams {
                funding_pubkey: offerer_funding_pubkey,
                funding_inputs: vec![funding],
                payout_spk: offerer_script.as_bytes().to_vec(),
                payout_serial_id: Some(1),
                change_spk: offerer_script.as_bytes().to_vec(),
                change_serial_id: Some(2),
            },
            fund_output_serial_id: Some(3),
            fee_rate_per_vb: 2,
            cet_locktime: 500,
            refund_locktime: 1_000,
            contract_flags: 0,
        })
        .unwrap();

        // Accept: the acceptor contributes no inputs and no collateral.
        let accept = accept_offer(
            offer.clone(),
            AcceptOfferParams {
                party: ContractPartyParams {
                    funding_pubkey: acceptor_funding_pubkey,
                    funding_inputs: vec![],
                    payout_spk: acceptor_script.clone(),
                    payout_serial_id: Some(4),
                    change_spk: acceptor_script,
                    change_serial_id: Some(5),
                },
                min_timeout_interval: 100,
                max_timeout_interval: 100_000,
            },
            acceptor_keys,
            accept_temp_id,
        )
        .unwrap()
        .accept;

        // Offerer builds the funding PSBT and signs its input with its descriptor.
        let funding_psbt = create_funding_psbt(offer.clone(), accept.clone()).unwrap();
        let signed_psbt = sign_funding_psbt_with_descriptor(
            offer.clone(),
            accept.clone(),
            funding_psbt.clone(),
            offerer_descriptor,
            vec![DescriptorInput {
                input_serial_id: 100,
                derivation_index: 0,
            }],
        )
        .unwrap();

        // Offerer produces the sign message; acceptor (no inputs) finalizes.
        let sign = sign_accept(
            offer.clone(),
            accept.clone(),
            offerer_keys,
            offer_temp_id,
            signed_psbt,
        )
        .unwrap()
        .sign;

        // Standalone validation API: the same checks the lifecycle runs
        // internally, callable on stored/received messages at any time.
        validate_accept(offer.clone(), accept.clone()).unwrap();
        validate_sign(offer.clone(), accept.clone(), sign.clone()).unwrap();
        let contract_id = compute_contract_id(offer.clone(), accept.clone()).unwrap();
        assert_eq!(contract_id.len(), 32);
        // A message that is not a valid SignDlc for these two is rejected.
        assert!(validate_sign(offer.clone(), accept.clone(), accept.clone()).is_err());

        let signed_tx_bytes = finalize_sign(offer, accept, sign, funding_psbt).unwrap();

        let signed_tx: Transaction = bitcoin::consensus::deserialize(&signed_tx_bytes).unwrap();
        assert_eq!(
            signed_tx.input.len(),
            1,
            "the offerer's single funding input"
        );
        assert!(
            !signed_tx.input[0].witness.is_empty(),
            "funding input is signed"
        );
    }

    #[test]
    fn contract_info_payouts_enum_table() {
        // The fixture is a two-outcome ("up"/"down") enum with 100k collateral.
        let payouts = contract_info_payouts(encode_msg(&enum_contract_info())).unwrap();
        assert!(payouts.is_enum);
        assert_eq!(payouts.total_collateral_sats, 100_000);
        assert_eq!(payouts.rows.len(), 2);

        let up = payouts
            .rows
            .iter()
            .find(|row| row.outcome.as_deref() == Some("up"))
            .unwrap();
        assert_eq!(up.offer_payout_sats, 100_000);
        assert_eq!(up.accept_payout_sats, 0);
        assert!(up.range_start.is_none());

        let down = payouts
            .rows
            .iter()
            .find(|row| row.outcome.as_deref() == Some("down"))
            .unwrap();
        assert_eq!(down.offer_payout_sats, 0);
        assert_eq!(down.accept_payout_sats, 100_000);
    }

    // A splice-out rollover through the FFI: a prior dual-funded contract A is
    // spliced into a new single-funded contract B whose only funding input is
    // A's 2-of-2 output. Both parties co-sign the prior 2-of-2 with keys the
    // provider re-derives from A's temporary id. Exercises create_dlc_splice_input
    // + sign_accept_spliced + finalize_sign_spliced end-to-end.
    #[test]
    fn splice_out_round_trip_via_ffi() {
        let temp_id_a = vec![0xaa_u8; 32];
        let temp_id_b = vec![0xbb_u8; 32];

        // Contract A: a dual-funded 100k enum contract. Only its messages are
        // needed to build the splice input, so it need not be signed.
        let offerer_a = build_party(11, [0xaa; 32], 100);
        let acceptor_a = build_party(22, [0xaa; 32], 200);
        let offer_a = create_offer(CreateOfferParams {
            chain_hash: chain_hash_from_network("regtest".to_string()).unwrap(),
            temporary_contract_id: Some(temp_id_a.clone()),
            contract_info: encode_msg(&enum_contract_info()),
            offer_collateral_sats: 50_000, // accepter contributes the other 50k
            party: ffi_party(&offerer_a),
            fund_output_serial_id: Some(3),
            fee_rate_per_vb: 2,
            cet_locktime: 500,
            refund_locktime: 1_000,
            contract_flags: 0,
        })
        .unwrap();
        let accept_a = accept_offer(
            offer_a.clone(),
            AcceptOfferParams {
                party: ffi_party(&acceptor_a),
                min_timeout_interval: 100,
                max_timeout_interval: 100_000,
            },
            acceptor_a.provider.clone(),
            temp_id_a.clone(),
        )
        .unwrap()
        .accept;

        // The splice input spends A's 2-of-2 funding output (value = A's 100k).
        let splice_serial = 900_u64;
        let splice_input = create_dlc_splice_input(
            offer_a,
            accept_a,
            Party::Offer,
            Some(splice_serial),
            dlc_input_max_witness_len(),
        )
        .unwrap();

        // Contract B: single-funded by the offerer via the splice input
        // (splice-out). Same parties as A (same providers), new temporary ids.
        let offerer_b = build_party(11, [0xbb; 32], 300);
        let acceptor_b = build_party(22, [0xbb; 32], 400);
        let collateral_b = 60_000_u64; // 100k prior value - 40k spliced out

        let offer_b = create_offer(CreateOfferParams {
            chain_hash: chain_hash_from_network("regtest".to_string()).unwrap(),
            temporary_contract_id: Some(temp_id_b.clone()),
            contract_info: encode_msg(&enum_contract_info_with(Amount::from_sat(collateral_b))),
            offer_collateral_sats: collateral_b,
            party: ContractPartyParams {
                funding_pubkey: offerer_b.rust.funding_pubkey.serialize().to_vec(),
                funding_inputs: vec![splice_input],
                payout_spk: offerer_b.script.as_bytes().to_vec(),
                payout_serial_id: Some(1),
                change_spk: offerer_b.script.as_bytes().to_vec(),
                change_serial_id: Some(2),
            },
            fund_output_serial_id: Some(3),
            fee_rate_per_vb: 2,
            cet_locktime: 500,
            refund_locktime: 1_000,
            contract_flags: 0,
        })
        .unwrap();
        let accept_b = accept_offer(
            offer_b.clone(),
            AcceptOfferParams {
                party: ContractPartyParams {
                    funding_pubkey: acceptor_b.rust.funding_pubkey.serialize().to_vec(),
                    funding_inputs: vec![],
                    payout_spk: acceptor_b.script.as_bytes().to_vec(),
                    payout_serial_id: Some(4),
                    change_spk: acceptor_b.script.as_bytes().to_vec(),
                    change_serial_id: Some(5),
                },
                min_timeout_interval: 100,
                max_timeout_interval: 100_000,
            },
            acceptor_b.provider.clone(),
            temp_id_b.clone(),
        )
        .unwrap()
        .accept;

        let splice_keys = vec![SpliceKeyRef {
            input_serial_id: splice_serial,
            prior_temporary_contract_id: temp_id_a.clone(),
        }];

        // Offerer signs its half of the prior 2-of-2 (no wallet inputs to sign).
        let offer_psbt = create_funding_psbt(offer_b.clone(), accept_b.clone()).unwrap();
        let sign = sign_accept_spliced(
            offer_b.clone(),
            accept_b.clone(),
            offerer_b.provider.clone(),
            temp_id_b,
            offer_psbt,
            splice_keys.clone(),
        )
        .unwrap()
        .sign;

        // Accepter completes the other half -> fully-signed funding transaction.
        let accept_psbt = create_funding_psbt(offer_b.clone(), accept_b.clone()).unwrap();
        let tx_bytes = finalize_sign_spliced(
            offer_b,
            accept_b,
            sign,
            accept_psbt,
            acceptor_b.provider.clone(),
            splice_keys,
        )
        .unwrap();

        let tx: Transaction = bitcoin::consensus::deserialize(&tx_bytes).unwrap();
        assert_eq!(tx.input.len(), 1, "the single splice funding input");
        assert!(
            !tx.input[0].witness.is_empty(),
            "splice input 2-of-2 is signed"
        );
    }
}
