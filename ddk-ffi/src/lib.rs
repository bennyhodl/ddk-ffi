#![allow(clippy::too_many_arguments)]
#![allow(deprecated)]
use bip39::{Language, Mnemonic};
use bitcoin::bip32::{IntoDerivationPath, Xpriv, Xpub};
use bitcoin::hashes::Hash;
use bitcoin::sighash::EcdsaSighashType;
use bitcoin::{
    Amount, Network, OutPoint, Psbt, ScriptBuf, Sequence, Transaction as BtcTransaction, TxIn,
    TxOut as BtcTxOut, Txid, Witness,
};
use bitcoin::{Script, WPubkeyHash};
use ddk_dlc::secp_utils;
use ddk_dlc::{
    self, dlc_input::DlcInputInfo as RustDlcInputInfo, DlcTransactions as RustDlcTransactions,
    OracleInfo as DlcOracleInfo, PartyParams as DlcPartyParams, Payout as DlcPayout,
    TxInputInfo as DlcTxInputInfo,
};
use secp256k1_zkp::{
    ecdsa::Signature as EcdsaSignature, Message, PublicKey, Scalar, Secp256k1, SecretKey,
    XOnlyPublicKey,
};
use secp256k1_zkp::{schnorr::Signature as SchnorrSignature, All, EcdsaAdaptorSignature};
use std::str::FromStr;
use std::sync::OnceLock;

uniffi::include_scaffolding!("ddk_ffi");

static SECP_CONTEXT: OnceLock<Secp256k1<All>> = OnceLock::new();

pub fn get_secp_context() -> &'static Secp256k1<All> {
    SECP_CONTEXT.get_or_init(Secp256k1::new)
}

pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Minimum value that can be included in a transaction output. Under this value,
/// outputs are discarded
/// See: https://github.com/discreetlogcontracts/dlcspecs/blob/master/Transactions.md#change-outputs
const DUST_LIMIT: u64 = 1000;

/// The witness size of a P2WPKH input
/// See: <https://github.com/discreetlogcontracts/dlcspecs/blob/master/Transactions.md#fees>
pub const P2WPKH_WITNESS_SIZE: usize = 107;

// Error type implementation
#[derive(Debug, thiserror::Error)]
pub enum DLCError {
    #[error("Invalid signature")]
    InvalidSignature,
    #[error("Invalid public key")]
    InvalidPublicKey,
    #[error("Invalid transaction")]
    InvalidTransaction,
    #[error("Insufficient funds")]
    InsufficientFunds,
    #[error("Invalid argument: {0}")]
    InvalidArgument(String),
    #[error("Serialization error")]
    SerializationError,
    #[error("Secp256k1 error: {0}")]
    Secp256k1Error(String),
    #[error("Miniscript error")]
    MiniscriptError,
    #[error("Invalid network")]
    InvalidNetwork,
    #[error("Extended key error: {0}")]
    KeyError(ExtendedKey),
}

#[derive(Debug, thiserror::Error)]
pub enum ExtendedKey {
    #[error("Invalid mnemonic")]
    InvalidMnemonic,
    #[error("Invalid xpriv")]
    InvalidXpriv,
    #[error("Invalid xpub")]
    InvalidXpub,
    #[error("Invalid derivation path")]
    InvalidDerivationPath,
}

impl From<ddk_dlc::Error> for DLCError {
    fn from(err: ddk_dlc::Error) -> Self {
        match err {
            ddk_dlc::Error::Secp256k1(_) => DLCError::Secp256k1Error(err.to_string()),
            ddk_dlc::Error::InvalidArgument(msg) => DLCError::InvalidArgument(msg),
            ddk_dlc::Error::Miniscript(_) => DLCError::MiniscriptError,
            ddk_dlc::Error::P2wpkh(_) => DLCError::InvalidTransaction,
            ddk_dlc::Error::InputsIndex(_) => {
                DLCError::InvalidArgument("Error from rust-dlc: InputsIndex".to_string())
            }
        }
    }
}

impl From<secp256k1_zkp::Error> for DLCError {
    fn from(err: secp256k1_zkp::Error) -> Self {
        DLCError::Secp256k1Error(err.to_string())
    }
}

// UniFFI struct definitions (as defined in UDL)
#[derive(Clone)]
pub struct Transaction {
    pub version: i32,
    pub lock_time: u32,
    pub inputs: Vec<TxInput>,
    pub outputs: Vec<TxOutput>,
    pub raw_bytes: Vec<u8>,
}

#[derive(Clone)]
pub struct TxInput {
    pub txid: String,
    pub vout: u32,
    pub script_sig: Vec<u8>,
    pub sequence: u32,
    pub witness: Vec<Vec<u8>>,
}

#[derive(Clone)]
pub struct TxOutput {
    pub value: u64,
    pub script_pubkey: Vec<u8>,
}

#[derive(Clone)]
pub struct TxInputInfo {
    pub txid: String,
    pub vout: u32,
    pub script_sig: Vec<u8>,
    pub max_witness_length: u32,
    pub serial_id: u64,
}

#[derive(Clone)]
pub struct Payout {
    pub offer: u64,
    pub accept: u64,
}

#[derive(Clone)]
pub struct DlcInputInfo {
    pub fund_tx: Transaction,
    pub fund_vout: u32,
    pub local_fund_pubkey: Vec<u8>,
    pub remote_fund_pubkey: Vec<u8>,
    pub fund_amount: u64,
    pub max_witness_len: u32,
    pub input_serial_id: u64,
    pub contract_id: Vec<u8>,
}

#[derive(Clone)]
pub struct PartyParams {
    pub fund_pubkey: Vec<u8>,
    pub change_script_pubkey: Vec<u8>,
    pub change_serial_id: u64,
    pub payout_script_pubkey: Vec<u8>,
    pub payout_serial_id: u64,
    pub inputs: Vec<TxInputInfo>,
    pub input_amount: u64,
    pub collateral: u64,
    pub dlc_inputs: Vec<DlcInputInfo>,
}

#[derive(Clone)]
pub struct DlcTransactions {
    pub fund: Transaction,
    pub cets: Vec<Transaction>,
    pub refund: Transaction,
    pub funding_script_pubkey: Vec<u8>,
}

#[derive(Clone)]
pub struct AdaptorSignature {
    pub signature: Vec<u8>,
    pub proof: Vec<u8>,
}

#[derive(Clone)]
pub struct ChangeOutputAndFees {
    pub change_output: TxOutput,
    pub fund_fee: u64,
    pub cet_fee: u64,
}

#[derive(Clone)]
pub struct OracleInfo {
    pub public_key: Vec<u8>,
    pub nonces: Vec<Vec<u8>>,
}

/// Debug info for CET adaptor signature inputs
/// All the values that go into creating an adaptor signature
#[derive(Clone)]
pub struct CetAdaptorSignatureDebugInfo {
    /// The sighash (32 bytes) - this is the message that gets signed
    pub sighash: Vec<u8>,
    /// The adaptor point (33 bytes compressed public key)
    pub adaptor_point: Vec<u8>,
    /// Input index (always 0 for CETs)
    pub input_index: u32,
    /// The funding script pubkey used for sighash
    pub script_pubkey: Vec<u8>,
    /// The fund output value used for sighash
    pub value: u64,
    /// The CET txid
    pub cet_txid: String,
    /// Raw CET bytes for verification
    pub cet_raw: Vec<u8>,
}

// Conversion helpers
pub fn btc_tx_to_transaction(tx: &BtcTransaction) -> Transaction {
    use bitcoin::consensus::Encodable;
    let mut raw_bytes = Vec::new();
    tx.consensus_encode(&mut raw_bytes).unwrap();

    Transaction {
        version: tx.version.0,
        lock_time: tx.lock_time.to_consensus_u32(),
        inputs: tx
            .input
            .iter()
            .map(|input| TxInput {
                txid: input.previous_output.txid.to_string(),
                vout: input.previous_output.vout,
                script_sig: input.script_sig.to_bytes(),
                sequence: input.sequence.0,
                witness: input.witness.iter().map(|w| w.to_vec()).collect(),
            })
            .collect(),
        outputs: tx
            .output
            .iter()
            .map(|output| TxOutput {
                value: output.value.to_sat(),
                script_pubkey: output.script_pubkey.to_bytes(),
            })
            .collect(),
        raw_bytes,
    }
}

pub fn add_signature_to_transaction(
    tx: Transaction,
    signature: Vec<u8>,
    pubkey: Vec<u8>,
    input_index: u32,
) -> Result<Transaction, DLCError> {
    let mut tx = transaction_to_btc_tx(&tx).map_err(|_| DLCError::InvalidTransaction)?;
    let mut witness = Witness::new();
    witness.push(signature);
    witness.push(pubkey);

    tx.input[input_index as usize].witness = witness;

    Ok(btc_tx_to_transaction(&tx))
}

pub fn plz_work() -> String {
    "heyhowareya".to_string()
}

pub fn transaction_to_btc_tx(tx: &Transaction) -> Result<BtcTransaction, DLCError> {
    use bitcoin::consensus::Decodable;
    BtcTransaction::consensus_decode(&mut &tx.raw_bytes[..])
        .map_err(|_| DLCError::SerializationError)
}

pub fn dlc_input_info_to_rust(input: &DlcInputInfo) -> Result<RustDlcInputInfo, DLCError> {
    let btc_tx = transaction_to_btc_tx(&input.fund_tx)?;
    let local_fund_pubkey =
        PublicKey::from_slice(&input.local_fund_pubkey).map_err(|_| DLCError::InvalidPublicKey)?;
    let remote_fund_pubkey =
        PublicKey::from_slice(&input.remote_fund_pubkey).map_err(|_| DLCError::InvalidPublicKey)?;
    let contract_id: [u8; 32] = input.contract_id.as_slice().try_into().map_err(|_| {
        DLCError::InvalidArgument("Contract id length must be 32 bytes.".to_string())
    })?;
    Ok(RustDlcInputInfo {
        fund_tx: btc_tx,
        fund_vout: input.fund_vout,
        local_fund_pubkey,
        remote_fund_pubkey,
        fund_amount: Amount::from_sat(input.fund_amount),
        max_witness_len: input.max_witness_len as usize,
        input_serial_id: input.input_serial_id,
        contract_id,
    })
}

pub fn rust_to_dlc_input(input: &RustDlcInputInfo) -> Result<DlcInputInfo, DLCError> {
    Ok(DlcInputInfo {
        fund_tx: btc_tx_to_transaction(&input.fund_tx),
        fund_vout: input.fund_vout,
        local_fund_pubkey: input.local_fund_pubkey.serialize().to_vec(),
        remote_fund_pubkey: input.remote_fund_pubkey.serialize().to_vec(),
        fund_amount: input.fund_amount.to_sat(),
        max_witness_len: input.max_witness_len as u32,
        input_serial_id: input.input_serial_id,
        contract_id: input.contract_id.to_vec(),
    })
}

/// Convert UniFFI TxInputInfo to rust-dlc TxInputInfo
pub fn tx_input_info_to_rust(input: &TxInputInfo) -> Result<DlcTxInputInfo, DLCError> {
    let txid = Txid::from_str(&input.txid)
        .map_err(|_| DLCError::InvalidArgument("Invalid transaction id".to_string()))?;
    Ok(DlcTxInputInfo {
        outpoint: OutPoint {
            txid,
            vout: input.vout,
        },
        max_witness_len: input.max_witness_length as usize,
        redeem_script: ScriptBuf::from(input.script_sig.clone()),
        serial_id: input.serial_id,
    })
}

/// Convert UniFFI PartyParams to rust-dlc PartyParams
pub fn party_params_to_rust(params: &PartyParams) -> Result<DlcPartyParams, DLCError> {
    let fund_pubkey =
        PublicKey::from_slice(&params.fund_pubkey).map_err(|_| DLCError::InvalidPublicKey)?;

    let inputs: Result<Vec<_>, _> = params.inputs.iter().map(tx_input_info_to_rust).collect();

    let dlc_inputs: Result<Vec<_>, _> = params
        .dlc_inputs
        .iter()
        .map(dlc_input_info_to_rust)
        .collect();

    Ok(DlcPartyParams {
        fund_pubkey,
        change_script_pubkey: ScriptBuf::from(params.change_script_pubkey.clone()),
        change_serial_id: params.change_serial_id,
        payout_script_pubkey: ScriptBuf::from(params.payout_script_pubkey.clone()),
        payout_serial_id: params.payout_serial_id,
        inputs: inputs?,
        dlc_inputs: dlc_inputs?,
        input_amount: Amount::from_sat(params.input_amount),
        collateral: Amount::from_sat(params.collateral),
    })
}

/// Convert rust-dlc DlcTransactions to UniFFI DlcTransactions
pub fn rust_dlc_transactions_to_uniffi(dlc_txs: RustDlcTransactions) -> DlcTransactions {
    DlcTransactions {
        fund: btc_tx_to_transaction(&dlc_txs.fund),
        cets: dlc_txs.cets.iter().map(btc_tx_to_transaction).collect(),
        refund: btc_tx_to_transaction(&dlc_txs.refund),
        funding_script_pubkey: dlc_txs.funding_script_pubkey.to_bytes(),
    }
}

/// Create a funding script pubkey for DLC transactions
pub fn create_fund_tx_locking_script(
    local_fund_pubkey: Vec<u8>,
    remote_fund_pubkey: Vec<u8>,
) -> Result<Vec<u8>, DLCError> {
    let local_pk =
        PublicKey::from_slice(&local_fund_pubkey).map_err(|_| DLCError::InvalidPublicKey)?;
    let remote_pk =
        PublicKey::from_slice(&remote_fund_pubkey).map_err(|_| DLCError::InvalidPublicKey)?;

    let script = ddk_dlc::make_funding_redeemscript(&local_pk, &remote_pk);
    Ok(script.to_bytes())
}

/// Create complete DLC transactions
pub fn create_dlc_transactions(
    outcomes: Vec<Payout>,
    local_params: PartyParams,
    remote_params: PartyParams,
    refund_locktime: u32,
    fee_rate: u64,
    fund_lock_time: u32,
    cet_lock_time: u32,
    fund_output_serial_id: u64,
) -> Result<DlcTransactions, DLCError> {
    // Convert UniFFI types to rust-dlc types
    let rust_local_params = party_params_to_rust(&local_params)?;
    let rust_remote_params = party_params_to_rust(&remote_params)?;

    // Convert outcomes to payouts
    let payouts: Vec<DlcPayout> = outcomes
        .iter()
        .map(|outcome| DlcPayout {
            offer: Amount::from_sat(outcome.offer),
            accept: Amount::from_sat(outcome.accept),
        })
        .collect();

    // Use rust-dlc library to create transactions
    let dlc_txs = ddk_dlc::create_dlc_transactions(
        &rust_local_params,
        &rust_remote_params,
        &payouts,
        refund_locktime,
        fee_rate,
        fund_lock_time,
        cet_lock_time,
        fund_output_serial_id,
    )
    .map_err(DLCError::from)?;

    // Convert back to UniFFI types
    Ok(rust_dlc_transactions_to_uniffi(dlc_txs))
}

/// Create spliced DLC transactions
pub fn create_spliced_dlc_transactions(
    outcomes: Vec<Payout>,
    local_params: PartyParams,
    remote_params: PartyParams,
    refund_locktime: u32,
    fee_rate: u64,
    fund_lock_time: u32,
    cet_lock_time: u32,
    fund_output_serial_id: u64,
) -> Result<DlcTransactions, DLCError> {
    // Convert UniFFI types to rust-dlc types
    let rust_local_params = party_params_to_rust(&local_params)?;
    let rust_remote_params = party_params_to_rust(&remote_params)?;

    // Convert outcomes to payouts
    let payouts: Vec<DlcPayout> = outcomes
        .iter()
        .map(|outcome| DlcPayout {
            offer: Amount::from_sat(outcome.offer),
            accept: Amount::from_sat(outcome.accept),
        })
        .collect();

    // Use rust-dlc library to create spliced transactions
    let dlc_txs = ddk_dlc::create_spliced_dlc_transactions(
        &rust_local_params,
        &rust_remote_params,
        &payouts,
        refund_locktime,
        fee_rate,
        fund_lock_time,
        cet_lock_time,
        fund_output_serial_id,
    )
    .map_err(DLCError::from)?;

    // Convert back to UniFFI types
    Ok(rust_dlc_transactions_to_uniffi(dlc_txs))
}

/// Create a single CET
pub fn create_cet(
    local_output: TxOutput,
    local_payout_serial_id: u64,
    remote_output: TxOutput,
    remote_payout_serial_id: u64,
    fund_tx_id: String,
    fund_vout: u32,
    lock_time: u32,
) -> Result<Transaction, DLCError> {
    let txid = Txid::from_str(&fund_tx_id)
        .map_err(|_| DLCError::InvalidArgument("Invalid transaction id".to_string()))?;

    let local_btc_output = BtcTxOut {
        value: Amount::from_sat(local_output.value),
        script_pubkey: ScriptBuf::from(local_output.script_pubkey),
    };

    let remote_btc_output = BtcTxOut {
        value: Amount::from_sat(remote_output.value),
        script_pubkey: ScriptBuf::from(remote_output.script_pubkey),
    };

    let fund_tx_input = TxIn {
        previous_output: OutPoint {
            txid,
            vout: fund_vout,
        },
        script_sig: ScriptBuf::new(),
        sequence: Sequence::ZERO,
        witness: Witness::new(),
    };

    let btc_tx = ddk_dlc::create_cet(
        local_btc_output,
        local_payout_serial_id,
        remote_btc_output,
        remote_payout_serial_id,
        &fund_tx_input,
        lock_time,
    );

    Ok(btc_tx_to_transaction(&btc_tx))
}

/// Create multiple CETs
pub fn create_cets(
    fund_tx_id: String,
    fund_vout: u32,
    local_final_script_pubkey: Vec<u8>,
    remote_final_script_pubkey: Vec<u8>,
    outcomes: Vec<Payout>,
    lock_time: u32,
    local_serial_id: u64,
    remote_serial_id: u64,
) -> Result<Vec<Transaction>, DLCError> {
    let txid = Txid::from_str(&fund_tx_id)
        .map_err(|_| DLCError::InvalidArgument("Invalid transaction id".to_string()))?;

    let fund_tx_input = TxIn {
        previous_output: OutPoint {
            txid,
            vout: fund_vout,
        },
        script_sig: ScriptBuf::new(),
        sequence: Sequence::ZERO,
        witness: Witness::new(),
    };

    let local_script = Script::from_bytes(&local_final_script_pubkey);
    let remote_script = Script::from_bytes(&remote_final_script_pubkey);

    let payouts: Vec<DlcPayout> = outcomes
        .iter()
        .map(|outcome| DlcPayout {
            offer: Amount::from_sat(outcome.offer),
            accept: Amount::from_sat(outcome.accept),
        })
        .collect();

    let btc_txs = ddk_dlc::create_cets(
        &fund_tx_input,
        local_script,
        local_serial_id,
        remote_script,
        remote_serial_id,
        &payouts,
        lock_time,
    );

    Ok(btc_txs.iter().map(btc_tx_to_transaction).collect())
}

/// Create a refund transaction
pub fn create_refund_transaction(
    local_final_script_pubkey: Vec<u8>,
    remote_final_script_pubkey: Vec<u8>,
    local_amount: u64,
    remote_amount: u64,
    lock_time: u32,
    fund_tx_id: String,
    fund_vout: u32,
) -> Result<Transaction, DLCError> {
    let txid = Txid::from_str(&fund_tx_id)
        .map_err(|_| DLCError::InvalidArgument("Invalid transaction id".to_string()))?;

    let local_output = BtcTxOut {
        value: Amount::from_sat(local_amount),
        script_pubkey: ScriptBuf::from(local_final_script_pubkey),
    };

    let remote_output = BtcTxOut {
        value: Amount::from_sat(remote_amount),
        script_pubkey: ScriptBuf::from(remote_final_script_pubkey),
    };

    let funding_input = TxIn {
        previous_output: OutPoint {
            txid,
            vout: fund_vout,
        },
        script_sig: ScriptBuf::new(),
        sequence: Sequence::ENABLE_LOCKTIME_NO_RBF,
        witness: Witness::new(),
    };

    let btc_tx =
        ddk_dlc::create_refund_transaction(local_output, remote_output, funding_input, lock_time);

    Ok(btc_tx_to_transaction(&btc_tx))
}

/// Check if a transaction output is dust
pub fn is_dust_output(output: TxOutput) -> bool {
    output.value < DUST_LIMIT
}

/// Get change output and fees for a party
pub fn get_change_output_and_fees(
    params: PartyParams,
    fee_rate: u64,
) -> Result<ChangeOutputAndFees, DLCError> {
    let rust_params = party_params_to_rust(&params)?;
    let total_collateral = Amount::from_sat(params.collateral * 2); // Assume bilateral

    let (change_output, fund_fee, cet_fee) = rust_params
        .get_change_output_and_fees(total_collateral, fee_rate, Amount::ZERO)
        .map_err(DLCError::from)?;

    let uniffi_output = TxOutput {
        value: change_output.value.to_sat(),
        script_pubkey: change_output.script_pubkey.to_bytes(),
    };

    Ok(ChangeOutputAndFees {
        change_output: uniffi_output,
        fund_fee: fund_fee.to_sat(),
        cet_fee: cet_fee.to_sat(),
    })
}

/// Get total input virtual size for fee calculation
pub fn get_total_input_vsize(inputs: Vec<TxInputInfo>) -> u32 {
    // Simplified calculation: P2WPKH inputs are ~148 vbytes each
    inputs.len() as u32 * 148
}

/// Verify a fund transaction signature
pub fn verify_fund_tx_signature(
    fund_tx: Transaction,
    signature: Vec<u8>,
    pubkey: Vec<u8>,
    txid: String,
    vout: u32,
    input_amount: u64,
) -> Result<bool, DLCError> {
    let btc_tx = transaction_to_btc_tx(&fund_tx)?;
    let pk = PublicKey::from_slice(&pubkey).map_err(|_| DLCError::InvalidPublicKey)?;
    let input_txid = Txid::from_str(&txid)
        .map_err(|_| DLCError::InvalidArgument("Invalid transaction id".to_string()))?;

    // Find the input index
    let input_index = btc_tx
        .input
        .iter()
        .position(|input| {
            input.previous_output.txid == input_txid && input.previous_output.vout == vout
        })
        .ok_or(DLCError::InvalidArgument(format!(
            "Input index not found in {input_txid}"
        )))?;

    // Create a simple P2WPKH script for verification
    let wpkh = WPubkeyHash::hash(&pk.serialize());
    let script = bitcoin::ScriptBuf::new_p2wpkh(&wpkh);

    // Parse signature
    let sig = EcdsaSignature::from_der(&signature).map_err(|_| DLCError::InvalidSignature)?;

    let secp = Secp256k1::verification_only();
    match ddk_dlc::verify_tx_input_sig(
        &secp,
        &sig,
        &btc_tx,
        input_index,
        &script,
        Amount::from_sat(input_amount),
        &pk,
    ) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}

// ============================================================================
// SIGNING AND SIGNATURE FUNCTIONS (using rust-dlc library)
// ============================================================================

/// Get raw signature for a fund transaction input
pub fn get_raw_funding_transaction_input_signature(
    funding_transaction: Transaction,
    privkey: Vec<u8>,
    prev_tx_id: String,
    prev_tx_vout: u32,
    value: u64,
) -> Result<Vec<u8>, DLCError> {
    let btc_tx = transaction_to_btc_tx(&funding_transaction)?;
    let sk = SecretKey::from_slice(&privkey)
        .map_err(|_| DLCError::InvalidArgument("Invalid private key".to_string()))?;
    let prev_txid = Txid::from_str(&prev_tx_id)
        .map_err(|_| DLCError::InvalidArgument("Invalid transaction id".to_string()))?;

    // Find the input index
    let input_index = btc_tx
        .input
        .iter()
        .position(|input| {
            input.previous_output.txid == prev_txid && input.previous_output.vout == prev_tx_vout
        })
        .ok_or(DLCError::InvalidArgument(format!(
            "Input index not found in {prev_txid}"
        )))?;

    let secp = get_secp_context();
    // Create P2WPKH script for signing
    let pk = PublicKey::from_secret_key(secp, &sk);
    let wpkh = WPubkeyHash::hash(&pk.serialize());
    let script = bitcoin::ScriptBuf::new_p2wpkh(&wpkh);

    let sig = ddk_dlc::util::get_sig_for_tx_input(
        secp,
        &btc_tx,
        input_index,
        &script,
        Amount::from_sat(value),
        EcdsaSighashType::All,
        &sk,
    )
    .map_err(DLCError::from)?;

    Ok(sig)
}

/// Sign a funding transaction input
pub fn sign_fund_transaction_input(
    fund_transaction: Transaction,
    privkey: Vec<u8>,
    prev_tx_id: String,
    prev_tx_vout: u32,
    value: u64,
) -> Result<Transaction, DLCError> {
    let mut btc_tx = transaction_to_btc_tx(&fund_transaction)?;
    let sk = SecretKey::from_slice(&privkey)
        .map_err(|_| DLCError::InvalidArgument("Invalid private key".to_string()))?;
    let prev_txid = Txid::from_str(&prev_tx_id)
        .map_err(|_| DLCError::InvalidArgument("Invalid transaction id".to_string()))?;

    // Find the input index
    let input_index = btc_tx
        .input
        .iter()
        .position(|input| {
            input.previous_output.txid == prev_txid && input.previous_output.vout == prev_tx_vout
        })
        .ok_or(DLCError::InvalidArgument(format!(
            "Input index not found in {prev_txid}"
        )))?;

    let secp = Secp256k1::signing_only();
    ddk_dlc::util::sign_p2wpkh_input(
        &secp,
        &sk,
        &mut btc_tx,
        input_index,
        EcdsaSighashType::All,
        Amount::from_sat(value),
    )
    .map_err(DLCError::from)?;

    Ok(btc_tx_to_transaction(&btc_tx))
}

pub fn sign_multi_sig_input(
    txn: Transaction,
    dlc_input: DlcInputInfo,
    local_privkey: Vec<u8>,
    remote_signature: Vec<u8>,
) -> Result<Transaction, DLCError> {
    let secp = get_secp_context();
    let btc_tx = transaction_to_btc_tx(&txn)?;
    let sk = SecretKey::from_slice(&local_privkey)
        .map_err(|_| DLCError::InvalidArgument("Invalid private key".to_string()))?;

    let local_pk = PublicKey::from_slice(&dlc_input.local_fund_pubkey)
        .map_err(|_| DLCError::InvalidPublicKey)?;
    let remote_pk = PublicKey::from_slice(&dlc_input.remote_fund_pubkey)
        .map_err(|_| DLCError::InvalidPublicKey)?;

    let dlc_input = dlc_input_info_to_rust(&dlc_input)?;

    let signature = ddk_dlc::dlc_input::create_dlc_funding_input_signature(
        secp,
        &btc_tx,
        dlc_input.fund_vout as usize,
        &dlc_input,
        &sk,
    )
    .map_err(|_| DLCError::InvalidSignature)?;

    let (first, second) = if local_pk < remote_pk {
        (local_pk, remote_pk)
    } else {
        (remote_pk, local_pk)
    };

    let witness = ddk_dlc::dlc_input::combine_dlc_input_signatures(
        &dlc_input,
        &signature,
        &remote_signature,
        &first,
        &second,
    );

    let mut fund_psbt = Psbt::from_unsigned_tx(btc_tx).map_err(|_| DLCError::InvalidTransaction)?;
    fund_psbt.inputs[dlc_input.fund_vout as usize].final_script_witness = Some(witness);

    Ok(btc_tx_to_transaction(
        &fund_psbt.extract_tx_unchecked_fee_rate(),
    ))
}

pub fn sign_cet(
    cet: Transaction,
    adaptor_signature: Vec<u8>,
    oracle_signatures: Vec<Vec<u8>>,
    funding_secret_key: Vec<u8>,
    other_pubkey: Vec<u8>,
    funding_script_pubkey: Vec<u8>,
    fund_output_value: u64,
) -> Result<Transaction, DLCError> {
    let mut btc_tx = transaction_to_btc_tx(&cet)?;
    let adaptor_sig = vec_to_ecdsa_adaptor_signature(adaptor_signature)?;
    let oracle_sigs = oracle_signatures
        .iter()
        .map(|sig| vec_to_schnorr_signature(sig.as_slice()))
        .collect::<Result<Vec<_>, _>>()?;
    let funding_sk = SecretKey::from_slice(&funding_secret_key)
        .map_err(|_| DLCError::InvalidArgument("Invalid funding secret key".to_string()))?;
    let other_pk = PublicKey::from_slice(&other_pubkey).map_err(|_| DLCError::InvalidPublicKey)?;
    let funding_pubkey =
        PublicKey::from_slice(&funding_script_pubkey).map_err(|_| DLCError::InvalidPublicKey)?;
    let dlc_redeem_script = ddk_dlc::make_funding_redeemscript(&funding_pubkey, &other_pk);
    let secp = get_secp_context();

    ddk_dlc::sign_cet(
        secp,
        &mut btc_tx,
        &adaptor_sig,
        &[oracle_sigs],
        &funding_sk,
        &other_pk,
        dlc_redeem_script.as_script(),
        Amount::from_sat(fund_output_value),
    )
    .map_err(|e| DLCError::Secp256k1Error(e.to_string()))?;

    Ok(btc_tx_to_transaction(&btc_tx))
}

fn vec_to_schnorr_signature(signature: &[u8]) -> Result<SchnorrSignature, DLCError> {
    let sig = SchnorrSignature::from_slice(signature).map_err(|_| DLCError::InvalidSignature)?;
    Ok(sig)
}

fn vec_to_ecdsa_adaptor_signature(signature: Vec<u8>) -> Result<EcdsaAdaptorSignature, DLCError> {
    EcdsaAdaptorSignature::from_slice(&signature).map_err(|_| DLCError::InvalidSignature)
}

fn signatures_to_secret(signatures: &[Vec<SchnorrSignature>]) -> Result<SecretKey, DLCError> {
    let s_values = signatures
        .iter()
        .flatten()
        .map(|x| match secp_utils::schnorrsig_decompose(x) {
            Ok(v) => Ok(v.1),
            Err(err) => Err(DLCError::Secp256k1Error(err.to_string())),
        })
        .collect::<Result<Vec<&[u8]>, DLCError>>()?;

    if s_values.is_empty() {
        return Err(DLCError::InvalidArgument(
            "No signatures provided".to_string(),
        ));
    }

    let secret = SecretKey::from_slice(s_values[0])
        .map_err(|_| DLCError::InvalidArgument("Invalid signature".to_string()))?;

    let result = s_values.iter().skip(1).fold(secret, |accum, s| {
        let sec = SecretKey::from_slice(s).unwrap();
        accum.add_tweak(&Scalar::from(sec)).unwrap()
    });

    Ok(result)
}

pub fn create_cet_adaptor_sigs_from_oracle_info(
    cets: Vec<Transaction>,
    oracle_info: Vec<OracleInfo>,
    funding_secret_key: Vec<u8>,
    funding_script_pubkey: Vec<u8>,
    fund_output_value: u64,
    msgs: Vec<Vec<Vec<Vec<u8>>>>,
) -> Result<Vec<AdaptorSignature>, DLCError> {
    let cets = cets
        .iter()
        .map(transaction_to_btc_tx)
        .collect::<Result<Vec<_>, _>>()?;
    let oracle_infos = oracle_info
        .iter()
        .map(|info| {
            let public_key = XOnlyPublicKey::from_slice(&info.public_key)
                .map_err(|_| DLCError::InvalidPublicKey)?;
            let nonces = info
                .nonces
                .iter()
                .map(|nonce| XOnlyPublicKey::from_slice(nonce))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| DLCError::InvalidArgument("Invalid nonce pubkey".to_string()))?;
            Ok(DlcOracleInfo { public_key, nonces })
        })
        .collect::<Result<Vec<_>, DLCError>>()
        .map_err(|_| DLCError::InvalidArgument("Invalid oracle info".to_string()))?;

    let funding_sk = SecretKey::from_slice(&funding_secret_key)
        .map_err(|_| DLCError::InvalidArgument("Invalid funding secret key".to_string()))?;
    let funding_script = Script::from_bytes(&funding_script_pubkey);
    let msgs: Vec<Vec<Vec<Message>>> = msgs
        .iter()
        .map(|cet_msgs| {
            // For each CET
            cet_msgs
                .iter()
                .map(|outcome_msgs| {
                    // For each outcome
                    outcome_msgs
                        .iter()
                        .map(|msg_bytes| {
                            // For each message (Vec<u8>)
                            Message::from_digest_slice(msg_bytes).map_err(|_| {
                                DLCError::InvalidArgument("Invalid message".to_string())
                            })
                        })
                        .collect::<Result<Vec<_>, _>>()
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()?;
    let secp = get_secp_context();
    let adaptor_sigs = ddk_dlc::create_cet_adaptor_sigs_from_oracle_info(
        secp,
        &cets,
        &oracle_infos,
        &funding_sk,
        funding_script,
        Amount::from_sat(fund_output_value),
        &msgs,
    )
    .map_err(|e| DLCError::Secp256k1Error(e.to_string()))?;

    let adaptor_sigs = adaptor_sigs
        .iter()
        .map(|sig| AdaptorSignature {
            signature: sig.as_ref().to_vec(),
            proof: Vec::new(),
        })
        .collect::<Vec<_>>();

    Ok(adaptor_sigs)
}

pub fn verify_cet_adaptor_sig_from_oracle_info(
    adaptor_sig: AdaptorSignature,
    cet: Transaction,
    oracle_infos: Vec<OracleInfo>,
    pubkey: Vec<u8>,
    funding_script_pubkey: Vec<u8>,
    total_collateral: u64,
    msgs: Vec<Vec<Vec<u8>>>,
) -> bool {
    let secp = get_secp_context();
    let Ok(btc_tx) = transaction_to_btc_tx(&cet) else {
        return false;
    };
    let Ok(adaptor_sig) = vec_to_ecdsa_adaptor_signature(adaptor_sig.signature) else {
        return false;
    };
    let Ok(oracle_infos) = oracle_infos
        .iter()
        .map(|info| {
            let public_key = XOnlyPublicKey::from_slice(&info.public_key)?;
            let nonces = info
                .nonces
                .iter()
                .map(|nonce| XOnlyPublicKey::from_slice(nonce))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(DlcOracleInfo { public_key, nonces })
        })
        .collect::<Result<Vec<_>, ddk_dlc::Error>>()
    else {
        return false;
    };
    let Ok(pubkey) = PublicKey::from_slice(&pubkey) else {
        return false;
    };
    let funding_script = Script::from_bytes(&funding_script_pubkey);
    let Ok(msgs) = msgs
        .into_iter()
        .map(|msg| {
            msg.iter()
                .map(|m| Message::from_digest_slice(m).map_err(|_| DLCError::InvalidArgument))
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()
    else {
        return false;
    };
    let Ok(adaptor_point) = ddk_dlc::get_adaptor_point_from_oracle_info(secp, &oracle_infos, &msgs)
    else {
        return false;
    };
    let Ok(_) = ddk_dlc::verify_cet_adaptor_sig_from_point(
        secp,
        &adaptor_sig,
        &btc_tx,
        &adaptor_point,
        &pubkey,
        funding_script,
        Amount::from_sat(total_collateral),
    ) else {
        return false;
    };

    true
}

pub fn verify_cet_adaptor_sigs_from_oracle_info(
    adaptor_sigs: Vec<AdaptorSignature>,
    cets: Vec<Transaction>,
    oracle_infos: Vec<OracleInfo>,
    pubkey: Vec<u8>,
    funding_script_pubkey: Vec<u8>,
    total_collateral: u64,
    msgs: Vec<Vec<Vec<Vec<u8>>>>,
) -> bool {
    cets.into_iter()
        .zip(adaptor_sigs)
        .enumerate()
        .all(|(i, (cet, adaptor_sig))| {
            verify_cet_adaptor_sig_from_oracle_info(
                adaptor_sig,
                cet,
                oracle_infos.clone(),
                pubkey.clone(),
                funding_script_pubkey.clone(),
                total_collateral,
                msgs[i].clone(),
            )
        })
}

/// Create CET adaptor signature from oracle info
pub fn create_cet_adaptor_signature_from_oracle_info(
    cet: Transaction,
    oracle_info: OracleInfo,
    funding_sk: Vec<u8>,
    funding_script_pubkey: Vec<u8>,
    total_collateral: u64,
    msgs: Vec<Vec<u8>>,
) -> Result<AdaptorSignature, DLCError> {
    let btc_tx = transaction_to_btc_tx(&cet)?;
    let sk = SecretKey::from_slice(&funding_sk)
        .map_err(|_| DLCError::InvalidArgument("Invalid funding secret key".to_string()))?;
    let funding_script = Script::from_bytes(&funding_script_pubkey);

    // Convert oracle info
    let oracle_pk = XOnlyPublicKey::from_slice(&oracle_info.public_key)
        .map_err(|_| DLCError::InvalidPublicKey)?;
    let nonces: Result<Vec<_>, _> = oracle_info
        .nonces
        .iter()
        .map(|n| XOnlyPublicKey::from_slice(n))
        .collect();
    let oracle_nonces = nonces.map_err(|_| DLCError::InvalidPublicKey)?;

    let dlc_oracle_info = DlcOracleInfo {
        public_key: oracle_pk,
        nonces: oracle_nonces,
    };

    // Convert messages
    let messages: Result<Vec<_>, _> = msgs
        .iter()
        .map(|msg| Message::from_digest_slice(msg))
        .collect();
    let msg_vec = messages.map_err(|_| DLCError::InvalidArgument("Invalid message".to_string()))?;
    let nested_msgs = vec![msg_vec]; // Wrap in vector for single oracle

    let secp = get_secp_context();
    let adaptor_sig = ddk_dlc::create_cet_adaptor_sig_from_oracle_info(
        secp,
        &btc_tx,
        &[dlc_oracle_info],
        &sk,
        funding_script,
        Amount::from_sat(total_collateral),
        &nested_msgs,
    )
    .map_err(DLCError::from)?;

    Ok(AdaptorSignature {
        signature: adaptor_sig.as_ref().to_vec(),
        proof: Vec::new(), // EcdsaAdaptorSignature doesn't expose proof directly
    })
}

pub fn create_cet_adaptor_points_from_oracle_info(
    oracle_info: Vec<OracleInfo>,
    msgs: Vec<Vec<Vec<Vec<u8>>>>,
) -> Result<Vec<Vec<u8>>, DLCError> {
    let oracle_infos = oracle_info
        .iter()
        .map(|info| {
            let public_key = XOnlyPublicKey::from_slice(&info.public_key)
                .map_err(|_| DLCError::InvalidPublicKey)?;
            let nonces = info
                .nonces
                .iter()
                .map(|nonce| XOnlyPublicKey::from_slice(nonce))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| DLCError::InvalidArgument("Invalid nonce pubkey".to_string()))?;
            Ok(DlcOracleInfo { public_key, nonces })
        })
        .collect::<Result<Vec<_>, DLCError>>()
        .map_err(|_| DLCError::InvalidArgument("Invalid oracle info".to_string()))?;

    let secp = get_secp_context();
    let mut adaptor_points = Vec::new();

    // Process each CET's messages separately
    for cet_msgs in msgs {
        // Flatten from Vec<Vec<Vec<u8>>> to Vec<Vec<u8>>
        let cet_msgs: Vec<Vec<Message>> = cet_msgs
            .into_iter()
            .map(|outcome_msgs| {
                outcome_msgs
                    .iter()
                    .map(|m| {
                        Message::from_digest_slice(m)
                            .map_err(|_| DLCError::InvalidArgument("Invalid message".to_string()))
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .collect::<Result<Vec<_>, _>>()?;

        // Get adaptor point for this CET
        let adaptor_point =
            ddk_dlc::get_adaptor_point_from_oracle_info(secp, &oracle_infos, &cet_msgs)
                .map_err(|e| DLCError::Secp256k1Error(e.to_string()))?;

        // Convert the adaptor point to bytes
        let adaptor_point_bytes = adaptor_point.serialize().to_vec();
        adaptor_points.push(adaptor_point_bytes);
    }

    Ok(adaptor_points)
}

pub fn extract_ecdsa_signature_from_oracle_signatures(
    oracle_signatures: Vec<Vec<u8>>,
    adaptor_signature: Vec<u8>,
) -> Result<Vec<u8>, DLCError> {
    // Convert oracle signatures to Schnorr signatures
    let oracle_sigs = oracle_signatures
        .iter()
        .map(|sig| vec_to_schnorr_signature(sig.as_slice()))
        .collect::<Result<Vec<_>, _>>()?;

    // Extract the secret key from oracle signatures
    let adaptor_secret = signatures_to_secret(&[oracle_sigs])?;

    // Convert adaptor signature to EcdsaAdaptorSignature
    let adaptor_sig = vec_to_ecdsa_adaptor_signature(adaptor_signature)?;

    // Decrypt the adaptor signature to get the final ECDSA signature
    let ecdsa_sig = adaptor_sig
        .decrypt(&adaptor_secret)
        .map_err(|e| DLCError::Secp256k1Error(e.to_string()))?;

    // Return the DER-encoded signature
    Ok(ecdsa_sig.serialize_der().to_vec())
}

/// Get all the inputs that go into creating a CET adaptor signature.
/// Use this to compare values with Fordefi to debug signature mismatches.
pub fn get_cet_adaptor_signature_inputs(
    cet: Transaction,
    oracle_info: Vec<OracleInfo>,
    funding_script_pubkey: Vec<u8>,
    fund_output_value: u64,
    msgs: Vec<Vec<Vec<u8>>>,
) -> Result<CetAdaptorSignatureDebugInfo, DLCError> {
    let btc_tx = transaction_to_btc_tx(&cet)?;
    let funding_script = Script::from_bytes(&funding_script_pubkey);

    // Convert oracle info
    let oracle_infos: Vec<DlcOracleInfo> = oracle_info
        .iter()
        .map(|info| {
            let public_key = XOnlyPublicKey::from_slice(&info.public_key)
                .map_err(|_| DLCError::InvalidPublicKey)?;
            let nonces = info
                .nonces
                .iter()
                .map(|nonce| XOnlyPublicKey::from_slice(nonce))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| DLCError::InvalidArgument("Invalid nonce pubkey".to_string()))?;
            Ok(DlcOracleInfo { public_key, nonces })
        })
        .collect::<Result<Vec<_>, DLCError>>()?;

    // Convert messages
    let cet_msgs: Vec<Vec<Message>> = msgs
        .into_iter()
        .map(|outcome_msgs| {
            outcome_msgs
                .iter()
                .map(|m| {
                    Message::from_digest_slice(m)
                        .map_err(|_| DLCError::InvalidArgument("Invalid message".to_string()))
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()?;

    let secp = get_secp_context();

    // Get the adaptor point
    let adaptor_point = ddk_dlc::get_adaptor_point_from_oracle_info(secp, &oracle_infos, &cet_msgs)
        .map_err(|e| DLCError::Secp256k1Error(e.to_string()))?;

    // Get the sighash - this is the actual message being signed
    let sig_hash = ddk_dlc::util::get_sig_hash_msg(
        &btc_tx,
        0, // input_index is always 0 for CETs
        funding_script,
        Amount::from_sat(fund_output_value),
    )
    .map_err(DLCError::from)?;

    Ok(CetAdaptorSignatureDebugInfo {
        sighash: sig_hash.as_ref().to_vec(),
        adaptor_point: adaptor_point.serialize().to_vec(),
        input_index: 0,
        script_pubkey: funding_script_pubkey,
        value: fund_output_value,
        cet_txid: btc_tx.compute_txid().to_string(),
        cet_raw: cet.raw_bytes,
    })
}

/// Get the sighash for a CET - the actual 32-byte message that gets signed.
/// This is useful for comparing with Fordefi's sighash calculation.
pub fn get_cet_sighash(
    cet: Transaction,
    funding_script_pubkey: Vec<u8>,
    fund_output_value: u64,
) -> Result<Vec<u8>, DLCError> {
    let btc_tx = transaction_to_btc_tx(&cet)?;
    let funding_script = Script::from_bytes(&funding_script_pubkey);

    let sig_hash = ddk_dlc::util::get_sig_hash_msg(
        &btc_tx,
        0, // input_index is always 0 for CETs
        funding_script,
        Amount::from_sat(fund_output_value),
    )
    .map_err(DLCError::from)?;

    Ok(sig_hash.as_ref().to_vec())
}

pub fn convert_mnemonic_to_seed(
    mnemonic: String,
    passphrase: Option<String>,
) -> Result<Vec<u8>, DLCError> {
    let seed_mnemonic = Mnemonic::parse_in_normalized(Language::English, &mnemonic)
        .map_err(|_| DLCError::KeyError(ExtendedKey::InvalidMnemonic))?;
    let passphrase = passphrase.unwrap_or("".to_string());
    let seed = seed_mnemonic.to_seed(&passphrase);
    Ok(seed.to_vec())
}

/// Create master extended private key from 64-byte seed
/// Returns 78-byte encoded xpriv
pub fn create_extkey_from_seed(seed: Vec<u8>, network: String) -> Result<Vec<u8>, DLCError> {
    if seed.len() != 64 {
        return Err(DLCError::KeyError(ExtendedKey::InvalidXpriv));
    }
    let network = Network::from_str(&network).map_err(|_| DLCError::InvalidNetwork)?;
    let xpriv = Xpriv::new_master(network, &seed)
        .map_err(|_| DLCError::KeyError(ExtendedKey::InvalidXpriv))?;
    Ok(xpriv.encode().to_vec())
}

/// Derive child extended private key from parent extended key
/// Input: 78-byte encoded xpriv, Output: 78-byte encoded xpriv
pub fn create_extkey_from_parent_path(extkey: Vec<u8>, path: String) -> Result<Vec<u8>, DLCError> {
    if extkey.len() != 78 {
        return Err(DLCError::KeyError(ExtendedKey::InvalidXpriv));
    }

    let secp = get_secp_context();
    let xpriv =
        Xpriv::decode(&extkey).map_err(|_| DLCError::KeyError(ExtendedKey::InvalidXpriv))?;

    let derivation_path = path
        .into_derivation_path()
        .map_err(|_| DLCError::KeyError(ExtendedKey::InvalidDerivationPath))?;

    let derived_xpriv = xpriv
        .derive_priv(secp, &derivation_path)
        .map_err(|_| DLCError::KeyError(ExtendedKey::InvalidXpriv))?;

    Ok(derived_xpriv.encode().to_vec())
}

/// Extract public key from extended key (private or public)
/// Input: 78-byte encoded xpriv/xpub, Output: 33-byte compressed public key
pub fn get_pubkey_from_extkey(extkey: Vec<u8>, network: String) -> Result<Vec<u8>, DLCError> {
    if extkey.len() != 78 {
        return Err(DLCError::KeyError(ExtendedKey::InvalidXpriv));
    }

    let secp = get_secp_context();
    let _network = Network::from_str(&network).map_err(|_| DLCError::InvalidNetwork)?;

    // Try as xpriv first
    if let Ok(xpriv) = Xpriv::decode(&extkey) {
        let xpub = Xpub::from_priv(secp, &xpriv);
        return Ok(xpub.public_key.serialize().to_vec());
    }

    // Try as xpub
    if let Ok(xpub) = Xpub::decode(&extkey) {
        return Ok(xpub.public_key.serialize().to_vec());
    }

    Err(DLCError::KeyError(ExtendedKey::InvalidXpriv))
}

/// DEPRECATED: Use create_extkey_from_seed + create_extkey_from_parent_path instead
/// This function handles both seeds (64 bytes) and xprivs (78 bytes) which is confusing
#[deprecated(
    since = "0.4.0",
    note = "Use create_extkey_from_seed + create_extkey_from_parent_path"
)]
pub fn create_xpriv_from_parent_path(
    seed_or_xpriv: Vec<u8>,
    base_derivation_path: String,
    network: String,
    path: String,
) -> Result<Vec<u8>, DLCError> {
    let master_xpriv = if seed_or_xpriv.len() == 64 {
        // This is a seed, create master xpriv
        create_extkey_from_seed(seed_or_xpriv, network.clone())?
    } else if seed_or_xpriv.len() == 78 {
        // This is already an xpriv
        seed_or_xpriv
    } else {
        return Err(DLCError::KeyError(ExtendedKey::InvalidXpriv));
    };

    // Derive base path from master
    let base_xpriv =
        create_extkey_from_parent_path(master_xpriv, base_derivation_path.replace("m/", ""))?;

    // Derive final path from base
    create_extkey_from_parent_path(base_xpriv, path)
}

/// Convert extended private key to extended public key
/// Input: 78-byte encoded xpriv, Output: 78-byte encoded xpub
pub fn get_xpub_from_xpriv(xpriv: Vec<u8>, network: String) -> Result<Vec<u8>, DLCError> {
    if xpriv.len() != 78 {
        return Err(DLCError::KeyError(ExtendedKey::InvalidXpriv));
    }

    let secp = get_secp_context();
    let _network = Network::from_str(&network).map_err(|_| DLCError::InvalidNetwork)?;

    let xpriv = Xpriv::decode(&xpriv).map_err(|_| DLCError::KeyError(ExtendedKey::InvalidXpriv))?;

    let xpub = Xpub::from_priv(secp, &xpriv);
    Ok(xpub.encode().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::bip32::DerivationPath;
    use bitcoin::{hashes::sha256, locktime::absolute::LockTime, Address, CompressedPublicKey};
    use ddk_dlc::secp_utils;
    use secp256k1_zkp::{
        rand::{thread_rng, RngCore},
        Keypair, Scalar,
    };
    use std::str::FromStr;

    /// Create test keys similar to rust-dlc tests
    fn create_test_keys() -> (SecretKey, PublicKey, SecretKey, PublicKey) {
        let secp = Secp256k1::new();
        let offer_sk =
            SecretKey::from_str("0000000000000000000000000000000000000000000000000000000000000001")
                .unwrap();
        let offer_pk = PublicKey::from_secret_key(&secp, &offer_sk);
        let accept_sk =
            SecretKey::from_str("0000000000000000000000000000000000000000000000000000000000000002")
                .unwrap();
        let accept_pk = PublicKey::from_secret_key(&secp, &accept_sk);
        (offer_sk, offer_pk, accept_sk, accept_pk)
    }

    /// Create realistic party params for testing
    fn create_test_party_params(
        input_amount: u64,
        collateral: u64,
        fund_pubkey: Vec<u8>,
        serial_id: u64,
    ) -> PartyParams {
        let mut rng = thread_rng();

        // Create a realistic P2WPKH script
        let mut random_hash = [0u8; 20];
        rng.fill_bytes(&mut random_hash);
        let mut change_script = vec![0x00, 0x14]; // OP_0 + 20 bytes (P2WPKH)
        change_script.extend_from_slice(&random_hash);

        rng.fill_bytes(&mut random_hash);
        let mut payout_script = vec![0x00, 0x14]; // OP_0 + 20 bytes (P2WPKH)
        payout_script.extend_from_slice(&random_hash);

        PartyParams {
            fund_pubkey,
            change_script_pubkey: change_script,
            change_serial_id: serial_id + 1,
            payout_script_pubkey: payout_script,
            payout_serial_id: serial_id + 2,
            inputs: vec![TxInputInfo {
                txid: "5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456"
                    .to_string(),
                vout: serial_id as u32,
                script_sig: vec![],
                max_witness_length: 108,
                serial_id,
            }],
            input_amount,
            collateral,
            dlc_inputs: vec![],
        }
    }

    #[test]
    fn mnemonic_to_seed_test() {
        let mnemonic = Mnemonic::generate(24).unwrap();
        let rust_seed = mnemonic.to_seed_normalized("").to_vec();
        let ffi_seed = convert_mnemonic_to_seed(mnemonic.to_string(), None).unwrap();
        assert_eq!(rust_seed, ffi_seed);
    }

    #[test]
    fn xpriv_to_xpub_test() {
        let mnemonic = Mnemonic::generate(24).unwrap();
        let rust_xpriv =
            Xpriv::new_master(Network::Bitcoin, &mnemonic.to_seed_normalized("").to_vec()).unwrap();
        let ffi_xpriv = create_extkey_from_seed(
            mnemonic.to_seed_normalized("").to_vec(),
            "bitcoin".to_string(),
        )
        .unwrap();
        let rust_xpub = Xpub::from_priv(get_secp_context(), &rust_xpriv);
        let ffi_xpub = get_xpub_from_xpriv(ffi_xpriv, "bitcoin".to_string()).unwrap();
        assert_eq!(rust_xpub.encode().to_vec(), ffi_xpub);
    }

    #[test]
    fn xpriv_to_path() {
        let base_derivation_path = "84'/0'/0'";
        let app_path = "0/1";
        let network = "bitcoin";
        let secp = get_secp_context();

        let mnemonic = Mnemonic::generate(24).unwrap();
        let rust_xpriv =
            Xpriv::new_master(Network::Bitcoin, &mnemonic.to_seed_normalized("")).unwrap();
        let rust_path =
            DerivationPath::from_str(&format!("{}/{}", base_derivation_path, app_path)).unwrap();
        let rust_xpriv = rust_xpriv.derive_priv(&secp, &rust_path).unwrap();

        let ffi_xpriv_bytes = convert_mnemonic_to_seed(mnemonic.to_string(), None).unwrap();
        let ffi_xpub = create_xpriv_from_parent_path(
            ffi_xpriv_bytes,
            base_derivation_path.to_string(),
            network.to_string(),
            app_path.to_string(),
        )
        .unwrap();
        assert_eq!(rust_xpriv.encode().to_vec(), ffi_xpub);
    }

    #[test]
    fn test_create_fund_tx_locking_script_matches_rust_dlc() {
        let (_offer_sk, offer_pk, _accept_sk, accept_pk) = create_test_keys();

        // Test our wrapper
        let wrapper_result = create_fund_tx_locking_script(
            offer_pk.serialize().to_vec(),
            accept_pk.serialize().to_vec(),
        )
        .unwrap();

        // Compare with direct rust-dlc call
        let direct_result = ddk_dlc::make_funding_redeemscript(&offer_pk, &accept_pk);

        assert_eq!(wrapper_result, direct_result.to_bytes());
    }

    #[test]
    fn test_get_change_output_and_fees_wrapper() {
        let (_offer_sk, offer_pk, _accept_sk, _accept_pk) = create_test_keys();

        let params = create_test_party_params(
            150_000_000, // 1.5 BTC input
            100_000_000, // 1 BTC collateral
            offer_pk.serialize().to_vec(),
            1,
        );

        let result = get_change_output_and_fees(params.clone(), 4);
        assert!(result.is_ok());

        let change_and_fees = result.unwrap();

        // Verify we get reasonable values
        assert!(change_and_fees.fund_fee > 0);
        assert!(change_and_fees.cet_fee > 0);
        assert!(change_and_fees.change_output.value > 0);

        // Compare with direct rust-dlc call
        let rust_params = party_params_to_rust(&params).unwrap();
        let total_collateral = Amount::from_sat(params.collateral * 2);
        let direct_result = rust_params
            .get_change_output_and_fees(total_collateral, 4, Amount::ZERO)
            .unwrap();

        assert_eq!(change_and_fees.fund_fee, direct_result.1.to_sat());
        assert_eq!(change_and_fees.cet_fee, direct_result.2.to_sat());
        assert_eq!(
            change_and_fees.change_output.value,
            direct_result.0.value.to_sat()
        );
    }

    #[test]
    fn test_create_dlc_transactions_wrapper() {
        let (_offer_sk, offer_pk, _accept_sk, accept_pk) = create_test_keys();

        let offer_params = create_test_party_params(
            1_000_000_000, // 10 BTC input
            100_000_000,   // 1 BTC collateral
            offer_pk.serialize().to_vec(),
            1,
        );

        let accept_params = create_test_party_params(
            1_000_000_000, // 10 BTC input
            100_000_000,   // 1 BTC collateral
            accept_pk.serialize().to_vec(),
            2,
        );

        let outcomes = vec![
            Payout {
                offer: 200_000_000, // 2 BTC to offer
                accept: 0,          // 0 BTC to accept
            },
            Payout {
                offer: 0,            // 0 BTC to offer
                accept: 200_000_000, // 2 BTC to accept
            },
        ];

        let result = create_dlc_transactions(
            outcomes,
            offer_params,
            accept_params,
            100, // refund locktime
            4,   // fee rate
            10,  // fund lock time
            10,  // cet lock time
            0,   // fund output serial id
        );

        assert!(result.is_ok());
        let dlc_txs = result.unwrap();

        // Verify structure
        assert_eq!(dlc_txs.fund.lock_time, 10);
        assert_eq!(dlc_txs.refund.lock_time, 100);
        assert_eq!(dlc_txs.cets.len(), 2);
        assert!(dlc_txs.cets.iter().all(|cet| cet.lock_time == 10));

        // Verify funding transaction has correct structure
        assert_eq!(dlc_txs.fund.inputs.len(), 2); // Two parties contributing
        assert!(dlc_txs.fund.outputs.len() >= 1); // At least funding output

        // Verify CETs have correct structure
        for cet in &dlc_txs.cets {
            assert_eq!(cet.inputs.len(), 1); // Single funding input
            assert!(cet.outputs.len() >= 1); // At least one output (dust may be filtered)
        }

        // Verify refund transaction
        assert_eq!(dlc_txs.refund.inputs.len(), 1); // Single funding input
        assert!(dlc_txs.refund.outputs.len() >= 2); // At least two refund outputs
    }

    #[test]
    fn test_create_cet_wrapper() {
        let local_output = TxOutput {
            value: 100_000_000, // 1 BTC
            script_pubkey: vec![
                0x00, 0x14, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
                0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14,
            ],
        };

        let remote_output = TxOutput {
            value: 100_000_000, // 1 BTC
            script_pubkey: vec![
                0x00, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
                0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28,
            ],
        };

        let result = create_cet(
            local_output,
            1,
            remote_output,
            2,
            "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
            0,
            10,
        );

        assert!(result.is_ok());
        let cet = result.unwrap();

        assert_eq!(cet.lock_time, 10);
        assert_eq!(cet.inputs.len(), 1);
        assert_eq!(cet.outputs.len(), 2);
        assert_eq!(cet.outputs[0].value, 100_000_000);
        assert_eq!(cet.outputs[1].value, 100_000_000);
    }

    #[test]
    fn test_create_refund_transaction_wrapper() {
        let local_script = vec![
            0x00, 0x14, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
            0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14,
        ];
        let remote_script = vec![
            0x00, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
            0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28,
        ];

        let result = create_refund_transaction(
            local_script,
            remote_script,
            100_000_000, // 1 BTC to local
            100_000_000, // 1 BTC to remote
            144,         // locktime (1 day in blocks)
            "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
            0,
        );

        assert!(result.is_ok());
        let refund_tx = result.unwrap();

        assert_eq!(refund_tx.lock_time, 144);
        assert_eq!(refund_tx.inputs.len(), 1);
        assert_eq!(refund_tx.outputs.len(), 2);
        assert_eq!(refund_tx.outputs[0].value, 100_000_000);
        assert_eq!(refund_tx.outputs[1].value, 100_000_000);
    }

    #[test]
    fn test_is_dust_output() {
        let dust_output = TxOutput {
            value: 500, // Below dust limit
            script_pubkey: vec![],
        };

        let non_dust_output = TxOutput {
            value: 5000, // Above dust limit
            script_pubkey: vec![],
        };

        assert!(is_dust_output(dust_output));
        assert!(!is_dust_output(non_dust_output));
    }

    #[test]
    fn test_conversion_functions() {
        let (_offer_sk, offer_pk, _accept_sk, _accept_pk) = create_test_keys();

        // Test party params conversion
        let params =
            create_test_party_params(100_000_000, 50_000_000, offer_pk.serialize().to_vec(), 1);

        let rust_params = party_params_to_rust(&params).unwrap();
        assert_eq!(rust_params.fund_pubkey, offer_pk);
        assert_eq!(rust_params.input_amount, Amount::from_sat(100_000_000));
        assert_eq!(rust_params.collateral, Amount::from_sat(50_000_000));

        // Test TX input conversion
        let tx_input = TxInputInfo {
            txid: "5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456".to_string(),
            vout: 0,
            script_sig: vec![],
            max_witness_length: 108,
            serial_id: 1,
        };

        let rust_input = tx_input_info_to_rust(&tx_input).unwrap();
        assert_eq!(rust_input.serial_id, 1);
        assert_eq!(rust_input.max_witness_len, 108);
        assert_eq!(rust_input.outpoint.vout, 0);
    }

    #[test]
    fn test_transaction_bidirectional_conversion() {
        // Create a test Bitcoin transaction
        let btc_tx = BtcTransaction {
            version: bitcoin::transaction::Version::TWO,
            lock_time: LockTime::from_consensus(144),
            input: vec![TxIn {
                previous_output: OutPoint {
                    txid: Txid::from_str(
                        "5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456",
                    )
                    .unwrap(),
                    vout: 0,
                },
                script_sig: ScriptBuf::new(),
                sequence: Sequence::ZERO,
                witness: Witness::new(),
            }],
            output: vec![BtcTxOut {
                value: Amount::from_sat(100_000_000),
                script_pubkey: ScriptBuf::from(vec![0x00, 0x14]),
            }],
        };

        // Convert to UniFFI format and back
        let uniffi_tx = btc_tx_to_transaction(&btc_tx);
        let converted_back = transaction_to_btc_tx(&uniffi_tx).unwrap();

        // Verify they're equivalent
        assert_eq!(btc_tx.version, converted_back.version);
        assert_eq!(btc_tx.lock_time, converted_back.lock_time);
        assert_eq!(btc_tx.input.len(), converted_back.input.len());
        assert_eq!(btc_tx.output.len(), converted_back.output.len());
        assert_eq!(
            btc_tx.input[0].previous_output,
            converted_back.input[0].previous_output
        );
        assert_eq!(btc_tx.output[0].value, converted_back.output[0].value);
    }

    #[test]
    fn test_error_handling_invalid_keys() {
        // Test invalid public key
        let result = create_fund_tx_locking_script(
            vec![0u8; 20], // Invalid key length
            vec![1u8; 33],
        );
        assert!(matches!(result, Err(DLCError::InvalidPublicKey)));

        // Test invalid txid
        let result = create_cet(
            TxOutput {
                value: 1000,
                script_pubkey: vec![],
            },
            1,
            TxOutput {
                value: 1000,
                script_pubkey: vec![],
            },
            2,
            "invalid_txid".to_string(),
            0,
            0,
        );
        assert!(matches!(result, Err(DLCError::InvalidArgument(_))));
    }

    fn get_p2wpkh_script_pubkey(secp: &Secp256k1<All>) -> ScriptBuf {
        let mut rng = secp256k1_zkp::rand::thread_rng();
        let sk = bitcoin::PrivateKey {
            inner: SecretKey::new(&mut rng),
            network: Network::Testnet.into(),
            compressed: true,
        };
        let pk = CompressedPublicKey::from_private_key(secp, &sk).unwrap();
        Address::p2wpkh(&pk, Network::Testnet).script_pubkey()
    }

    fn get_party_params(
        input_amount: u64,
        collateral: u64,
        serial_id: Option<u64>,
    ) -> (PartyParams, SecretKey) {
        let secp = Secp256k1::new();
        let mut rng = secp256k1_zkp::rand::thread_rng();
        let fund_privkey = SecretKey::new(&mut rng);
        let serial_id = serial_id.unwrap_or(1);
        (
            PartyParams {
                fund_pubkey: PublicKey::from_secret_key(&secp, &fund_privkey)
                    .serialize()
                    .to_vec(),
                change_script_pubkey: get_p2wpkh_script_pubkey(&secp).into_bytes(),
                change_serial_id: serial_id,
                payout_script_pubkey: get_p2wpkh_script_pubkey(&secp).into_bytes(),
                payout_serial_id: serial_id,
                input_amount,
                collateral,
                inputs: vec![TxInputInfo {
                    txid: "5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456"
                        .to_string(),
                    vout: 0,
                    max_witness_length: 108,
                    script_sig: vec![],
                    serial_id,
                }],
                dlc_inputs: vec![],
            },
            fund_privkey,
        )
    }

    fn payouts_test() -> Vec<Payout> {
        vec![
            Payout {
                offer: 100000000,
                accept: 100000000,
            },
            Payout {
                offer: 100000000,
                accept: 100000000,
            },
            Payout {
                offer: 100000000,
                accept: 100000000,
            },
        ]
    }

    fn signatures_to_secret(signatures: &[Vec<SchnorrSignature>]) -> SecretKey {
        let s_values = signatures
            .iter()
            .flatten()
            .map(|x| secp_utils::schnorrsig_decompose(x).unwrap().1)
            .collect::<Vec<_>>();
        let secret = SecretKey::from_slice(s_values[0]).unwrap();

        s_values.iter().skip(1).fold(secret, |accum, s| {
            let sec = SecretKey::from_slice(s).unwrap();
            accum.add_tweak(&Scalar::from(sec)).unwrap()
        })
    }

    /// Verify a signature for a given transaction input.
    fn verify_tx_input_sig(
        signature: Vec<u8>,
        tx: Transaction,
        input_index: usize,
        script_pubkey: Vec<u8>,
        value: u64,
        pk: Vec<u8>,
    ) -> Result<(), DLCError> {
        let secp = get_secp_context();
        let btc_txn = transaction_to_btc_tx(&tx)?;
        let script = ScriptBuf::from_bytes(script_pubkey);
        let sig = EcdsaSignature::from_der(&signature).map_err(|_| DLCError::InvalidSignature)?;
        let pk = PublicKey::from_slice(&pk).map_err(|_| DLCError::InvalidPublicKey)?;
        ddk_dlc::verify_tx_input_sig(
            secp,
            &sig,
            &btc_txn,
            input_index,
            &script,
            Amount::from_sat(value),
            &pk,
        )?;
        Ok(())
    }

    #[test]
    fn create_cet_adaptor_sig_single_oracle_three_outcomes() {
        // Arrange
        let secp = Secp256k1::new();
        let mut rng = secp256k1_zkp::rand::thread_rng();
        let (offer_party_params, offer_fund_sk) =
            get_party_params(1_000_000_000, 100_000_000, None);
        let (accept_party_params, _accept_fund_sk) =
            get_party_params(1_000_000_000, 100_000_000, None);

        let dlc_txs = create_dlc_transactions(
            payouts_test(),
            offer_party_params.clone(),
            accept_party_params.clone(),
            100,
            4,
            10,
            10,
            0,
        )
        .unwrap();

        let cets = dlc_txs.cets;
        const NB_ORACLES: usize = 1; // 1 oracle
        const NB_OUTCOMES: usize = 3; // 3 outcomes (enumeration)
        const NB_DIGITS: usize = 1; // 1 nonce for enumeration contract

        let mut oracle_infos: Vec<OracleInfo> = Vec::with_capacity(NB_ORACLES);
        let mut oracle_sks: Vec<Keypair> = Vec::with_capacity(NB_ORACLES);
        let mut oracle_sk_nonce: Vec<Vec<[u8; 32]>> = Vec::with_capacity(NB_ORACLES);
        let mut oracle_sigs: Vec<Vec<SchnorrSignature>> = Vec::with_capacity(NB_ORACLES);

        // Messages: 3 outcomes × 1 oracle × 1 message per outcome
        let messages: Vec<Vec<Vec<_>>> = (0..NB_OUTCOMES)
            .map(|outcome_idx| {
                vec![
                    // Single oracle
                    vec![
                        // Single message for this outcome
                        {
                            let message = &[outcome_idx as u8]; // Different message per outcome
                            let hash = sha256::Hash::hash(message).to_byte_array();
                            hash.to_vec()
                        },
                    ],
                ]
            })
            .collect();

        // Setup single oracle with single nonce
        for i in 0..NB_ORACLES {
            // Runs once
            let oracle_kp = Keypair::new(&secp, &mut rng);
            let oracle_pubkey = oracle_kp.x_only_public_key().0;
            let mut nonces: Vec<XOnlyPublicKey> = Vec::with_capacity(NB_DIGITS);
            let mut sk_nonces: Vec<[u8; 32]> = Vec::with_capacity(NB_DIGITS);
            oracle_sigs.push(Vec::with_capacity(NB_DIGITS));

            // Single nonce for enumeration
            let mut sk_nonce = [0u8; 32];
            rng.fill_bytes(&mut sk_nonce);
            let oracle_r_kp = Keypair::from_seckey_slice(&secp, &sk_nonce).unwrap();
            let nonce = XOnlyPublicKey::from_keypair(&oracle_r_kp).0;

            // Sign the first outcome's message with the single nonce
            let sig = secp_utils::schnorrsig_sign_with_nonce(
                &secp,
                &Message::from_digest_slice(&messages[0][0][0]).unwrap(), // First outcome, first oracle, first message
                &oracle_kp,
                &sk_nonce,
            );

            oracle_sigs[i].push(sig);
            nonces.push(nonce);
            sk_nonces.push(sk_nonce);

            oracle_infos.push(OracleInfo {
                public_key: oracle_pubkey.serialize().to_vec(),
                nonces: nonces.iter().map(|n| n.serialize().to_vec()).collect(), // Just 1 nonce
            });
            oracle_sk_nonce.push(sk_nonces);
            oracle_sks.push(oracle_kp);
        }
        let funding_script_pubkey = ddk_dlc::make_funding_redeemscript(
            &PublicKey::from_slice(&offer_party_params.fund_pubkey.clone()).unwrap(),
            &PublicKey::from_slice(&accept_party_params.fund_pubkey.clone()).unwrap(),
        );
        let fund_output_value = dlc_txs.fund.outputs[0].value;

        // Act
        let cet_sigs = create_cet_adaptor_sigs_from_oracle_info(
            cets.clone(), // Use only first 3 CETs
            oracle_infos.clone(),
            offer_fund_sk.secret_bytes().to_vec(),
            funding_script_pubkey.clone().into_bytes(),
            fund_output_value,
            messages.clone(),
        )
        .unwrap();

        let oracle_signatures = oracle_sigs
            .iter()
            .map(|s| s.iter().map(|s| s.serialize().to_vec()).collect::<Vec<_>>())
            .collect::<Vec<_>>();

        let sign_res = sign_cet(
            cets[0].clone(),
            cet_sigs[0].signature.clone(),
            oracle_signatures[0].clone(),
            _accept_fund_sk.secret_bytes().to_vec(),
            offer_party_params.fund_pubkey.clone(),
            accept_party_params.fund_pubkey.clone(),
            fund_output_value,
        );

        assert!(sign_res.is_ok());

        let adaptor_secret = signatures_to_secret(&oracle_sigs);
        let signature = vec_to_ecdsa_adaptor_signature(cet_sigs[0].signature.clone()).unwrap();
        let adapted_sig = signature.decrypt(&adaptor_secret).unwrap();

        let batch_verify = verify_cet_adaptor_sigs_from_oracle_info(
            cet_sigs.clone(),
            cets.clone(),
            oracle_infos.clone(),
            offer_party_params.fund_pubkey.clone(),
            funding_script_pubkey.clone().into_bytes(),
            fund_output_value,
            messages.clone(),
        );

        assert!(batch_verify);

        // Assert
        assert_eq!(cet_sigs.len(), 3, "Should have 3 CET signatures");
        assert!(cet_sigs
            .iter()
            .enumerate()
            .all(|(i, x)| verify_cet_adaptor_sig_from_oracle_info(
                x.clone(),
                cets[i].clone(),
                oracle_infos.clone(),
                offer_party_params.fund_pubkey.clone(),
                funding_script_pubkey.clone().into_bytes(),
                fund_output_value,
                messages[i].clone(),
            )));
        sign_res.expect("Error signing CET");
        verify_tx_input_sig(
            adapted_sig.serialize_der().to_vec(),
            cets[0].clone(),
            0,
            funding_script_pubkey.clone().into_bytes(),
            fund_output_value,
            offer_party_params.fund_pubkey.clone(),
        )
        .expect("Invalid decrypted adaptor signature");
    }

    #[test]
    fn test_extract_ecdsa_signature_from_oracle_signatures() {
        // Setup test data (similar to the main test)
        let secp = Secp256k1::new();
        let mut rng = secp256k1_zkp::rand::thread_rng();
        let (offer_party_params, offer_fund_sk) =
            get_party_params(1_000_000_000, 100_000_000, None);
        let (accept_party_params, _accept_fund_sk) =
            get_party_params(1_000_000_000, 100_000_000, None);

        let dlc_txs = create_dlc_transactions(
            payouts_test(),
            offer_party_params.clone(),
            accept_party_params.clone(),
            100,
            4,
            10,
            10,
            0, // Add missing fund_output_serial_id parameter
        )
        .unwrap();

        let cets = dlc_txs.cets;
        const NB_ORACLES: usize = 1; // 1 oracle
        const NB_OUTCOMES: usize = 3; // 3 outcomes (enumeration)
        const NB_DIGITS: usize = 1; // 1 nonce for enumeration contract

        let mut oracle_infos: Vec<OracleInfo> = Vec::with_capacity(NB_ORACLES);
        let mut oracle_sks: Vec<Keypair> = Vec::with_capacity(NB_ORACLES);
        let mut oracle_sk_nonce: Vec<Vec<[u8; 32]>> = Vec::with_capacity(NB_ORACLES);
        let mut oracle_sigs: Vec<Vec<SchnorrSignature>> = Vec::with_capacity(NB_ORACLES);

        // Messages: 3 outcomes × 1 oracle × 1 message per outcome
        let messages: Vec<Vec<Vec<_>>> = (0..NB_OUTCOMES)
            .map(|outcome_idx| {
                vec![
                    // Single oracle
                    vec![
                        // Single message for this outcome
                        {
                            let message = &[outcome_idx as u8]; // Different message per outcome
                            let hash = sha256::Hash::hash(message).to_byte_array();
                            hash.to_vec()
                        },
                    ],
                ]
            })
            .collect();

        // Setup single oracle with single nonce
        for i in 0..NB_ORACLES {
            // Runs once
            let oracle_kp = Keypair::new(&secp, &mut rng);
            let oracle_pubkey = oracle_kp.x_only_public_key().0;
            let mut nonces: Vec<XOnlyPublicKey> = Vec::with_capacity(NB_DIGITS);
            let mut sk_nonces: Vec<[u8; 32]> = Vec::with_capacity(NB_DIGITS);
            oracle_sigs.push(Vec::with_capacity(NB_DIGITS));

            // Single nonce for enumeration
            let mut sk_nonce = [0u8; 32];
            rng.fill_bytes(&mut sk_nonce);
            let oracle_r_kp = Keypair::from_seckey_slice(&secp, &sk_nonce).unwrap();
            let nonce = XOnlyPublicKey::from_keypair(&oracle_r_kp).0;

            // Sign the first outcome's message with the single nonce
            let sig = secp_utils::schnorrsig_sign_with_nonce(
                &secp,
                &Message::from_digest_slice(&messages[0][0][0]).unwrap(), // First outcome, first oracle, first message
                &oracle_kp,
                &sk_nonce,
            );

            oracle_sigs[i].push(sig);
            nonces.push(nonce);
            sk_nonces.push(sk_nonce);

            oracle_infos.push(OracleInfo {
                public_key: oracle_pubkey.serialize().to_vec(),
                nonces: nonces.iter().map(|n| n.serialize().to_vec()).collect(), // Just 1 nonce
            });
            oracle_sk_nonce.push(sk_nonces);
            oracle_sks.push(oracle_kp);
        }

        let funding_script_pubkey = ddk_dlc::make_funding_redeemscript(
            &PublicKey::from_slice(&offer_party_params.fund_pubkey.clone()).unwrap(),
            &PublicKey::from_slice(&accept_party_params.fund_pubkey.clone()).unwrap(),
        );
        let fund_output_value = dlc_txs.fund.outputs[0].value;

        // Create adaptor signatures
        let cet_sigs = create_cet_adaptor_sigs_from_oracle_info(
            cets.clone(),
            oracle_infos.clone(),
            offer_fund_sk.secret_bytes().to_vec(),
            funding_script_pubkey.clone().into_bytes(),
            fund_output_value,
            messages.clone(),
        )
        .unwrap();

        // Convert oracle signatures to the format expected by our function
        let oracle_signatures = oracle_sigs
            .iter()
            .map(|s| s.iter().map(|s| s.serialize().to_vec()).collect::<Vec<_>>())
            .collect::<Vec<_>>();

        // Test our new function
        let result = extract_ecdsa_signature_from_oracle_signatures(
            oracle_signatures[0].clone(),
            cet_sigs[0].signature.clone(),
        );

        assert!(result.is_ok(), "Function should succeed");

        let ecdsa_sig_bytes = result.unwrap();
        assert!(
            !ecdsa_sig_bytes.is_empty(),
            "Should return non-empty signature"
        );

        // Verify the signature is valid DER format
        let ecdsa_sig = EcdsaSignature::from_der(&ecdsa_sig_bytes);
        assert!(ecdsa_sig.is_ok(), "Should be valid DER signature");
    }

    #[test]
    fn test_create_spliced_dlc_transactions_with_failing_data() {
        // Exact data from the failing integration test
        let outcomes = vec![
            Payout {
                offer: 200998630,
                accept: 0,
            },
            Payout {
                offer: 0,
                accept: 200998630,
            },
        ];

        let local_params = PartyParams {
            fund_pubkey: hex::decode("033bdbcb6651977925f12aa2008393f73d7587347e061c8f2aca2744e734d6509d").unwrap(),
            change_script_pubkey: hex::decode("00142f92d4f2ec12f11a0e1c6bb86d8cc4c284c2f3e6").unwrap(),
            change_serial_id: 1299805,
            payout_script_pubkey: hex::decode("0014381fbc6470cda3cd0e5c194680f3242a6b896466").unwrap(),
            payout_serial_id: 14910176,
            inputs: vec![TxInputInfo {
                txid: "a70ea5d3c49194370616cd3036b514b3339fd072afc64da2a2cb1f606fd49b3f".to_string(),
                vout: 1,
                script_sig: vec![],
                max_witness_length: 108,
                serial_id: 23958,
            }],
            input_amount: 200000000,
            collateral: 200998630,
            dlc_inputs: vec![DlcInputInfo {
                fund_tx: Transaction {
                    version: 2,
                    lock_time: 1617170574,
                    inputs: vec![
                        TxInput {
                            txid: "1329ee675813b09732ac94234d44035189537e7f839b793ba93b6ec582".to_string(),
                            vout: 0,
                            script_sig: vec![],
                            sequence: 4294967295,
                            witness: vec![],
                        },
                        TxInput {
                            txid: "3aaf44df860f2f1fbc439c8a947fcfc434aea788b2f9affb406070509be505".to_string(),
                            vout: 0,
                            script_sig: vec![],
                            sequence: 4294967295,
                            witness: vec![],
                        },
                    ],
                    outputs: vec![
                        TxOutput {
                            value: 1001700,
                            script_pubkey: hex::decode("160014b8a3a42f43eb9e211cc86247c349c3d8d8620603").unwrap(),
                        },
                        TxOutput {
                            value: 1000000,
                            script_pubkey: hex::decode("220020e4bdf4adc13419eca173b43b28bd863b0ba69793fda0bf03d04544cb037ea95a").unwrap(),
                        },
                        TxOutput {
                            value: 200000000,
                            script_pubkey: hex::decode("160014982f1bc078c49d32352913579443d8c78690030a").unwrap(),
                        },
                    ],
                    raw_bytes: hex::decode("0200000000010282c56e3ba93b799b832e7f573e58953103444d43294ac3297b0135867eee92130000000000ffffffffe5059b50706040fbaff9b288a7ae34c4cf7f948a399c431bf2f10f86df44af3a0000000000ffffffff03f2b1eb0b00000000160014b8a3a42f43eb9e211cc86247c349c3d8d8620603e4480f0000000000220020e4bdf4adc13419eca173b43b28bd863b0ba69793fda0bf03d04544cb037ea95a527fdc0b00000000160014982f1bc078c49d32352913579443d8c78690030a02483045022100f758c4b22544df4e4372c5e01379954564df69f627f1f1402bf9514530db57d8022076e6aa10ff9e6af0f832ab6cf287830c97ae72d2400330cadf3d397798e10daf01210365f417bc5df7414b6f06622f6ac60cc918e8313c8aa7dce4d0050b6076707db602473044022069980c969da7b21c66ddd3794bed7b9dcd4fefae0dab12b3504d2ba010558e670220287fa84f313a72c37b10b47123cc6f57dc8038c7035dfdd9b6b7380a9676691d012103ce59c1343fee68943acd457c569fcfb0c30eaa9996c0eb8011cd5c828dd9100200000000").unwrap(),
                },
                fund_vout: 1,
                local_fund_pubkey: hex::decode("024d97f1fcc303da595f91fcfcb4affa4bc4676d5e451912282202c283c2ebd306").unwrap(),
                remote_fund_pubkey: hex::decode("0302ed01c9a6d7618271d1e752aa19655e0ebebbef968f41185e6d69ce0845b640").unwrap(),
                fund_amount: 1001700,
                max_witness_len: 220,
                input_serial_id: 1,
                contract_id: hex::decode("0000000000000000000000000000000000000000000000000000000000000000").unwrap(),
            }],
        };

        let remote_params = PartyParams {
            fund_pubkey: hex::decode("03a1bd2a7e8ebfa9b51c645c2cf9fd94897bd4083ae3da5118044f5acc631517d2").unwrap(),
            change_script_pubkey: hex::decode("0014ecd675858f6d993286aa95efbff400553ff0ceb8").unwrap(),
            change_serial_id: 3237572,
            payout_script_pubkey: hex::decode("001434f4c603066449d3b50b60ba7ddd878cf969ed71").unwrap(),
            payout_serial_id: 8044989,
            inputs: vec![],
            input_amount: 0,
            collateral: 0,
            dlc_inputs: vec![],
        };

        let refund_locktime = 1617170575;
        let fee_rate = 10;
        let fund_lock_time = 1617170574;
        let cet_lock_time = 1617170574;
        let fund_output_serial_id = 36665;

        println!("Testing create_spliced_dlc_transactions with exact failing data...");

        let result = create_spliced_dlc_transactions(
            outcomes,
            local_params,
            remote_params.clone(),
            refund_locktime,
            fee_rate,
            fund_lock_time,
            cet_lock_time,
            fund_output_serial_id,
        );

        match result {
            Ok(dlc_txs) => {
                println!("Success! Created spliced DLC transactions");
                println!("Fund tx version: {}", dlc_txs.fund.version);
                println!("Number of CETs: {}", dlc_txs.cets.len());
                println!("Refund tx lock time: {}", dlc_txs.refund.lock_time);
            }
            Err(e) => {
                println!("Error: {:?}", e);

                // Try to isolate the issue by testing with minimal data
                println!("Testing with minimal data (no DLC inputs)...");

                let minimal_local_params = PartyParams {
                    fund_pubkey: hex::decode("033bdbcb6651977925f12aa2008393f73d7587347e061c8f2aca2744e734d6509d").unwrap(),
                    change_script_pubkey: hex::decode("00142f92d4f2ec12f11a0e1c6bb86d8cc4c284c2f3e6").unwrap(),
                    change_serial_id: 1299805,
                    payout_script_pubkey: hex::decode("0014381fbc6470cda3cd0e5c194680f3242a6b896466").unwrap(),
                    payout_serial_id: 14910176,
                    inputs: vec![TxInputInfo {
                        txid: "a70ea5d3c49194370616cd3036b514b3339fd072afc64da2a2cb1f606fd49b3f".to_string(),
                        vout: 1,
                        script_sig: vec![],
                        max_witness_length: 108,
                        serial_id: 23958,
                    }],
                    input_amount: 200000000,
                    collateral: 200998630,
                    dlc_inputs: vec![], // Remove DLC inputs
                };

                let minimal_outcomes = vec![
                    Payout {
                        offer: 200998630,
                        accept: 0,
                    },
                    Payout {
                        offer: 0,
                        accept: 200998630,
                    },
                ];

                let minimal_result = create_spliced_dlc_transactions(
                    minimal_outcomes,
                    minimal_local_params,
                    remote_params,
                    refund_locktime,
                    fee_rate,
                    fund_lock_time,
                    cet_lock_time,
                    fund_output_serial_id,
                );

                match minimal_result {
                    Ok(_) => println!("Minimal test succeeded - DLC inputs are the issue"),
                    Err(minimal_e) => println!("Minimal test also failed: {:?}", minimal_e),
                }
            }
        }
    }
}
