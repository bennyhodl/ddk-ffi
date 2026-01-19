use napi::bindgen_prelude::*;
use napi_derive::napi;

// Transaction representation - matches UDL exactly
#[napi(object)]
pub struct Transaction {
  pub version: i32,
  pub lock_time: u32,
  pub inputs: Vec<TxInput>,
  pub outputs: Vec<TxOutput>,
  pub raw_bytes: Buffer,
}

// Transaction input - matches UDL exactly
#[napi(object)]
pub struct TxInput {
  pub txid: String,
  pub vout: u32,
  pub script_sig: Buffer,
  pub sequence: u32,
  pub witness: Vec<Buffer>,
}

// Transaction output - matches UDL exactly
#[napi(object)]
pub struct TxOutput {
  pub value: BigInt,
  pub script_pubkey: Buffer,
}

// Input information for funding - matches UDL exactly
#[napi(object)]
pub struct TxInputInfo {
  pub txid: String,
  pub vout: u32,
  pub script_sig: Buffer,
  pub max_witness_length: u32,
  pub serial_id: BigInt,
}

// Payout for offer and accept parties - matches UDL exactly
#[napi(object)]
pub struct Payout {
  pub offer: BigInt,
  pub accept: BigInt,
}

// DLC input information - matches UDL exactly
#[napi(object)]
pub struct DlcInputInfo {
  pub fund_tx: Transaction,
  pub fund_vout: u32,
  pub local_fund_pubkey: Buffer,
  pub remote_fund_pubkey: Buffer,
  pub fund_amount: BigInt,
  pub max_witness_len: u32,
  pub input_serial_id: BigInt,
  pub contract_id: Buffer,
}

// Parameters for a party in the DLC - matches UDL exactly
#[napi(object)]
pub struct PartyParams {
  pub fund_pubkey: Buffer,
  pub change_script_pubkey: Buffer,
  pub change_serial_id: BigInt,
  pub payout_script_pubkey: Buffer,
  pub payout_serial_id: BigInt,
  pub inputs: Vec<TxInputInfo>,
  pub input_amount: BigInt,
  pub collateral: BigInt,
  pub dlc_inputs: Vec<DlcInputInfo>,
}

// Container for all DLC transactions - matches UDL exactly
#[napi(object)]
pub struct DlcTransactions {
  pub fund: Transaction,
  pub cets: Vec<Transaction>,
  pub refund: Transaction,
  pub funding_script_pubkey: Buffer,
}

// Adaptor signature with proof - matches UDL exactly
#[napi(object)]
pub struct AdaptorSignature {
  pub signature: Buffer,
  pub proof: Buffer,
}

// Change output and fees result - matches UDL exactly
#[napi(object)]
pub struct ChangeOutputAndFees {
  pub change_output: TxOutput,
  pub fund_fee: BigInt,
  pub cet_fee: BigInt,
}

// Oracle information - matches UDL exactly
#[napi(object)]
pub struct OracleInfo {
  pub public_key: Buffer,
  pub nonces: Vec<Buffer>,
}

// Debug info for CET adaptor signature inputs
// All the values that go into creating an adaptor signature
#[napi(object)]
pub struct CetAdaptorSignatureDebugInfo {
  /// The sighash (32 bytes) - this is the message that gets signed
  pub sighash: Buffer,
  /// The adaptor point (33 bytes compressed public key)
  pub adaptor_point: Buffer,
  /// Input index (always 0 for CETs)
  pub input_index: u32,
  /// The funding script pubkey used for sighash
  pub script_pubkey: Buffer,
  /// The fund output value used for sighash
  pub value: BigInt,
  /// The CET txid
  pub cet_txid: String,
  /// Raw CET bytes for verification
  pub cet_raw: Buffer,
}
