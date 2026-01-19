#![deny(clippy::all)]

pub mod conversions;
mod types;

use conversions::*;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use types::*;

// Import ddk_ffi crate
extern crate ddk_ffi;

// fn log_to_console(env: Env, message: &str) -> Result<()> {
//   let global = env.get_global()?;
//   let console: Object = global.get_named_property("console")?;
//   let log_fn: Function = console.get_named_property("log")?;
//   let msg = env.create_string(message)?.into_unknown(&env)?;
//   log_fn.call(msg)?;
//   Ok(())
// }

#[napi]
pub fn version() -> String {
  ddk_ffi::version()
}

#[napi]
pub fn create_fund_tx_locking_script(
  local_fund_pubkey: Buffer,
  remote_fund_pubkey: Buffer,
) -> Result<Buffer> {
  let local_pubkey = buffer_to_vec(&local_fund_pubkey);
  let remote_pubkey = buffer_to_vec(&remote_fund_pubkey);

  let result = ddk_ffi::create_fund_tx_locking_script(local_pubkey, remote_pubkey)
    .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(vec_to_buffer(result))
}

#[napi]
pub fn create_dlc_transactions(
  outcomes: Vec<Payout>,
  local_params: PartyParams,
  remote_params: PartyParams,
  refund_locktime: u32,
  fee_rate: BigInt,
  fund_lock_time: u32,
  cet_lock_time: u32,
  fund_output_serial_id: BigInt,
) -> Result<DlcTransactions> {
  // log_to_console(env, "create_dlc_transactions: parsing inputs")
  //   .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  let ffi_outcomes: Result<Vec<ddk_ffi::Payout>> =
    outcomes.into_iter().map(TryInto::try_into).collect();

  let ffi_local_params = local_params.try_into()?;
  let ffi_remote_params = remote_params.try_into()?;
  // log_to_console(env, "create_dlc_transactions: inputs parsed correctly")
  //   .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  // log_to_console(
  //   env,
  //   "create_dlc_transactions: calling ddk_ffi::create_dlc_transactions with inputs",
  // )
  // .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  let result = ddk_ffi::create_dlc_transactions(
    ffi_outcomes?,
    ffi_local_params,
    ffi_remote_params,
    refund_locktime,
    bigint_to_u64(&fee_rate)?,
    fund_lock_time,
    cet_lock_time,
    bigint_to_u64(&fund_output_serial_id)?,
  )
  .map_err(|e| {
    // let _ = log_to_console(
    //   env,
    //   &format!("ddk_ffi::create_dlc_transactions: error: {:?}", e),
    // );
    Error::from_reason(format!("{:?}", e))
  })?;

  Ok(result.into())
}

#[napi]
pub fn create_spliced_dlc_transactions(
  outcomes: Vec<Payout>,
  local_params: PartyParams,
  remote_params: PartyParams,
  refund_locktime: u32,
  fee_rate: BigInt,
  fund_lock_time: u32,
  cet_lock_time: u32,
  fund_output_serial_id: BigInt,
) -> Result<DlcTransactions> {
  let ffi_outcomes: Result<Vec<ddk_ffi::Payout>> =
    outcomes.into_iter().map(TryInto::try_into).collect();

  let ffi_local_params = local_params.try_into()?;
  let ffi_remote_params = remote_params.try_into()?;

  let result = ddk_ffi::create_spliced_dlc_transactions(
    ffi_outcomes?,
    ffi_local_params,
    ffi_remote_params,
    refund_locktime,
    bigint_to_u64(&fee_rate)?,
    fund_lock_time,
    cet_lock_time,
    bigint_to_u64(&fund_output_serial_id)?,
  )
  .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(result.into())
}

#[napi]
pub fn create_cet(
  local_output: TxOutput,
  local_payout_serial_id: BigInt,
  remote_output: TxOutput,
  remote_payout_serial_id: BigInt,
  fund_tx_id: String,
  fund_vout: u32,
  lock_time: u32,
) -> Result<Transaction> {
  let result = ddk_ffi::create_cet(
    local_output.try_into()?,
    bigint_to_u64(&local_payout_serial_id)?,
    remote_output.try_into()?,
    bigint_to_u64(&remote_payout_serial_id)?,
    fund_tx_id,
    fund_vout,
    lock_time,
  )
  .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(result.into())
}

#[napi]
pub fn create_cets(
  fund_tx_id: String,
  fund_vout: u32,
  local_final_script_pubkey: Buffer,
  remote_final_script_pubkey: Buffer,
  outcomes: Vec<Payout>,
  lock_time: u32,
  local_serial_id: BigInt,
  remote_serial_id: BigInt,
) -> Result<Vec<Transaction>> {
  let ffi_outcomes: Result<Vec<ddk_ffi::Payout>> =
    outcomes.into_iter().map(TryInto::try_into).collect();

  let result = ddk_ffi::create_cets(
    fund_tx_id,
    fund_vout,
    buffer_to_vec(&local_final_script_pubkey),
    buffer_to_vec(&remote_final_script_pubkey),
    ffi_outcomes?,
    lock_time,
    bigint_to_u64(&local_serial_id)?,
    bigint_to_u64(&remote_serial_id)?,
  )
  .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(result.into_iter().map(Into::into).collect())
}

#[napi]
pub fn create_refund_transaction(
  local_final_script_pubkey: Buffer,
  remote_final_script_pubkey: Buffer,
  local_amount: BigInt,
  remote_amount: BigInt,
  lock_time: u32,
  fund_tx_id: String,
  fund_vout: u32,
) -> Result<Transaction> {
  let result = ddk_ffi::create_refund_transaction(
    buffer_to_vec(&local_final_script_pubkey),
    buffer_to_vec(&remote_final_script_pubkey),
    bigint_to_u64(&local_amount)?,
    bigint_to_u64(&remote_amount)?,
    lock_time,
    fund_tx_id,
    fund_vout,
  )
  .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(result.into())
}

#[napi]
pub fn is_dust_output(output: TxOutput) -> Result<bool> {
  let ffi_output = output.try_into()?;
  Ok(ddk_ffi::is_dust_output(ffi_output))
}

#[napi]
pub fn get_change_output_and_fees(
  params: PartyParams,
  fee_rate: BigInt,
) -> Result<ChangeOutputAndFees> {
  let result = ddk_ffi::get_change_output_and_fees(params.try_into()?, bigint_to_u64(&fee_rate)?)
    .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(result.into())
}

#[napi]
pub fn get_total_input_vsize(inputs: Vec<TxInputInfo>) -> Result<u32> {
  let ffi_inputs: Result<Vec<ddk_ffi::TxInputInfo>> =
    inputs.into_iter().map(TryInto::try_into).collect();

  Ok(ddk_ffi::get_total_input_vsize(ffi_inputs?))
}

#[napi]
pub fn verify_fund_tx_signature(
  fund_tx: Transaction,
  signature: Buffer,
  pubkey: Buffer,
  txid: String,
  vout: u32,
  input_amount: BigInt,
) -> Result<bool> {
  let result = ddk_ffi::verify_fund_tx_signature(
    fund_tx.try_into()?,
    buffer_to_vec(&signature),
    buffer_to_vec(&pubkey),
    txid,
    vout,
    bigint_to_u64(&input_amount)?,
  )
  .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(result)
}

#[napi]
pub fn get_raw_funding_transaction_input_signature(
  funding_transaction: Transaction,
  privkey: Buffer,
  prev_tx_id: String,
  prev_tx_vout: u32,
  value: BigInt,
) -> Result<Buffer> {
  let result = ddk_ffi::get_raw_funding_transaction_input_signature(
    funding_transaction.try_into()?,
    buffer_to_vec(&privkey),
    prev_tx_id,
    prev_tx_vout,
    bigint_to_u64(&value)?,
  )
  .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(vec_to_buffer(result))
}

#[napi]
pub fn verify_cet_adaptor_sig_from_oracle_info(
  adaptor_sig: AdaptorSignature,
  cet: Transaction,
  oracle_info: Vec<OracleInfo>,
  pubkey: Buffer,
  funding_script_pubkey: Buffer,
  total_collateral: BigInt,
  msgs: Vec<Vec<Buffer>>,
) -> bool {
  let ffi_oracle_info = oracle_info.into_iter().map(|info| info.into()).collect();
  let ffi_msgs = msgs
    .into_iter()
    .map(|msg| msg.iter().map(buffer_to_vec).collect())
    .collect();

  let Ok(ffi_cet) = cet.try_into() else {
    return false;
  };

  let Ok(ffi_amount) = bigint_to_u64(&total_collateral) else {
    return false;
  };

  ddk_ffi::verify_cet_adaptor_sig_from_oracle_info(
    adaptor_sig.into(),
    ffi_cet,
    ffi_oracle_info,
    buffer_to_vec(&pubkey),
    buffer_to_vec(&funding_script_pubkey),
    ffi_amount,
    ffi_msgs,
  )
}

#[napi]
pub fn sign_multi_sig_input(
  tx: Transaction,
  dlc_input: DlcInputInfo,
  local_privkey: Buffer,
  remote_signature: Buffer,
) -> Result<Transaction> {
  let result = ddk_ffi::sign_multi_sig_input(
    tx.try_into()?,
    dlc_input.try_into()?,
    buffer_to_vec(&local_privkey),
    buffer_to_vec(&remote_signature),
  )
  .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(result.into())
}

#[napi]
pub fn add_signature_to_transaction(
  tx: Transaction,
  signature: Buffer,
  pubkey: Buffer,
  input_index: u32,
) -> Result<Transaction> {
  let result = ddk_ffi::add_signature_to_transaction(
    tx.try_into()?,
    buffer_to_vec(&signature),
    buffer_to_vec(&pubkey),
    input_index,
  )
  .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(result.into())
}

#[napi]
pub fn verify_cet_adaptor_sigs_from_oracle_info(
  adaptor_sigs: Vec<AdaptorSignature>,
  cets: Vec<Transaction>,
  oracle_info: Vec<OracleInfo>,
  pubkey: Buffer,
  funding_script_pubkey: Buffer,
  total_collateral: BigInt,
  msgs: Vec<Vec<Vec<Buffer>>>,
) -> bool {
  let ffi_adaptor_sigs = adaptor_sigs.into_iter().map(|sig| sig.into()).collect();
  let Ok(ffi_cets) = cets
    .into_iter()
    .map(|cet| cet.try_into())
    .collect::<Result<Vec<_>, _>>()
  else {
    return false;
  };
  let ffi_oracle_info = oracle_info.into_iter().map(|info| info.into()).collect();
  let ffi_msgs = msgs
    .into_iter()
    .map(|msg| {
      msg
        .iter()
        .map(|msg| msg.iter().map(buffer_to_vec).collect())
        .collect()
    })
    .collect();

  let Ok(ffi_amount) = bigint_to_u64(&total_collateral) else {
    return false;
  };

  ddk_ffi::verify_cet_adaptor_sigs_from_oracle_info(
    ffi_adaptor_sigs,
    ffi_cets,
    ffi_oracle_info,
    buffer_to_vec(&pubkey),
    buffer_to_vec(&funding_script_pubkey),
    ffi_amount,
    ffi_msgs,
  )
}

#[napi]
pub fn sign_fund_transaction_input(
  fund_transaction: Transaction,
  privkey: Buffer,
  prev_tx_id: String,
  prev_tx_vout: u32,
  value: BigInt,
) -> Result<Transaction> {
  let result = ddk_ffi::sign_fund_transaction_input(
    fund_transaction.try_into()?,
    buffer_to_vec(&privkey),
    prev_tx_id,
    prev_tx_vout,
    bigint_to_u64(&value)?,
  )
  .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(result.into())
}

#[napi]
pub fn sign_cet(
  cet: Transaction,
  adaptor_signature: Buffer,
  oracle_signatures: Vec<Buffer>,
  funding_secret_key: Buffer,
  other_pubkey: Buffer,
  funding_script_pubkey: Buffer,
  fund_output_value: BigInt,
) -> Result<Transaction> {
  let result = ddk_ffi::sign_cet(
    cet.try_into()?,
    buffer_to_vec(&adaptor_signature),
    oracle_signatures.iter().map(buffer_to_vec).collect(),
    buffer_to_vec(&funding_secret_key),
    buffer_to_vec(&other_pubkey),
    buffer_to_vec(&funding_script_pubkey),
    bigint_to_u64(&fund_output_value)?,
  )
  .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(result.into())
}

#[napi]
pub fn create_cet_adaptor_sigs_from_oracle_info(
  cets: Vec<Transaction>,
  oracle_info: Vec<OracleInfo>,
  funding_secret_key: Buffer,
  funding_script_pubkey: Buffer,
  fund_output_value: BigInt,
  msgs: Vec<Vec<Vec<Buffer>>>,
) -> Result<Vec<AdaptorSignature>> {
  let ffi_msgs = msgs
    .into_iter()
    .map(|cet_msgs| {
      // For each CET
      cet_msgs
        .into_iter()
        .map(|outcome_msgs| {
          // For each outcome
          outcome_msgs.iter().map(buffer_to_vec).collect::<Vec<_>>()
        })
        .collect::<Vec<_>>()
    })
    .collect::<Vec<_>>();

  let sigs = ddk_ffi::create_cet_adaptor_sigs_from_oracle_info(
    cets
      .into_iter()
      .map(|cet| cet.try_into())
      .collect::<Result<Vec<_>, _>>()?,
    oracle_info.into_iter().map(|info| info.into()).collect(),
    buffer_to_vec(&funding_secret_key),
    buffer_to_vec(&funding_script_pubkey),
    bigint_to_u64(&fund_output_value)?,
    ffi_msgs,
  )
  .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  let result = sigs
    .into_iter()
    .map(|sig| sig.into())
    .collect::<Vec<AdaptorSignature>>();

  Ok(result)
}

#[napi]
pub fn create_cet_adaptor_signature_from_oracle_info(
  cet: Transaction,
  oracle_info: OracleInfo,
  funding_sk: Buffer,
  funding_script_pubkey: Buffer,
  total_collateral: BigInt,
  msgs: Vec<Buffer>,
) -> Result<AdaptorSignature> {
  let ffi_oracle_info = oracle_info.into();
  let ffi_msgs: Vec<Vec<u8>> = msgs.iter().map(buffer_to_vec).collect();

  let result = ddk_ffi::create_cet_adaptor_signature_from_oracle_info(
    cet.try_into()?,
    ffi_oracle_info,
    buffer_to_vec(&funding_sk),
    buffer_to_vec(&funding_script_pubkey),
    bigint_to_u64(&total_collateral)?,
    ffi_msgs,
  )
  .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(result.into())
}

#[napi]
pub fn create_cet_adaptor_points_from_oracle_info(
  oracle_info: Vec<OracleInfo>,
  msgs: Vec<Vec<Vec<Buffer>>>,
) -> Result<Vec<Buffer>> {
  let ffi_oracle_info: Vec<ddk_ffi::OracleInfo> = oracle_info
    .into_iter()
    .map(|info| info.into())
    .collect();

  let ffi_msgs = msgs
    .into_iter()
    .map(|cet_msgs| {
      // For each CET
      cet_msgs
        .into_iter()
        .map(|outcome_msgs| {
          // For each outcome
          outcome_msgs.iter().map(buffer_to_vec).collect::<Vec<_>>()
        })
        .collect::<Vec<_>>()
    })
    .collect::<Vec<_>>();

  let points = ddk_ffi::create_cet_adaptor_points_from_oracle_info(
    ffi_oracle_info,
    ffi_msgs,
  )
  .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  let result = points
    .into_iter()
    .map(|point| Buffer::from(point))
    .collect::<Vec<Buffer>>();

  Ok(result)
}

#[napi]
pub fn extract_ecdsa_signature_from_oracle_signatures(
  oracle_signatures: Vec<Buffer>,
  adaptor_signature: Buffer,
) -> Result<Buffer> {
  let ffi_oracle_signatures = oracle_signatures
    .into_iter()
    .map(|buffer| buffer_to_vec(&buffer))
    .collect::<Vec<Vec<u8>>>();

  let ffi_adaptor_signature = buffer_to_vec(&adaptor_signature);

  let signature = ddk_ffi::extract_ecdsa_signature_from_oracle_signatures(
    ffi_oracle_signatures,
    ffi_adaptor_signature,
  )
  .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(Buffer::from(signature))
}

#[napi]
pub fn convert_mnemonic_to_seed(mnemonic: String, passphrase: Option<String>) -> Result<Buffer> {
  let result = ddk_ffi::convert_mnemonic_to_seed(mnemonic, passphrase)
    .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(vec_to_buffer(result))
}

#[napi]
pub fn create_extkey_from_seed(seed: Buffer, network: String) -> Result<Buffer> {
  let seed_bytes = buffer_to_vec(&seed);
  let result = ddk_ffi::create_extkey_from_seed(seed_bytes, network)
    .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(vec_to_buffer(result))
}

#[napi]
pub fn create_extkey_from_parent_path(extkey: Buffer, path: String) -> Result<Buffer> {
  let extkey_bytes = buffer_to_vec(&extkey);
  let result = ddk_ffi::create_extkey_from_parent_path(extkey_bytes, path)
    .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(vec_to_buffer(result))
}

#[napi]
pub fn get_pubkey_from_extkey(extkey: Buffer, network: String) -> Result<Buffer> {
  let extkey_bytes = buffer_to_vec(&extkey);
  let result = ddk_ffi::get_pubkey_from_extkey(extkey_bytes, network)
    .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(vec_to_buffer(result))
}

#[napi]
pub fn create_xpriv_from_parent_path(
  xpriv: Buffer,
  base_derivation_path: String,
  network: String,
  path: String,
) -> Result<Buffer> {
  let xpriv_bytes = buffer_to_vec(&xpriv);
  let result =
    ddk_ffi::create_xpriv_from_parent_path(xpriv_bytes, base_derivation_path, network, path)
      .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(vec_to_buffer(result))
}

#[napi]
pub fn get_xpub_from_xpriv(xpriv: Buffer, network: String) -> Result<Buffer> {
  let xpriv_bytes = buffer_to_vec(&xpriv);
  let result = ddk_ffi::get_xpub_from_xpriv(xpriv_bytes, network)
    .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(vec_to_buffer(result))
}

/// Get all the inputs that go into creating a CET adaptor signature.
/// Use this to compare values with Fordefi to debug signature mismatches.
///
/// Returns:
/// - sighash: The 32-byte message that gets signed (BIP143 sighash)
/// - adaptor_point: The 33-byte compressed public key (adaptor point)
/// - input_index: Always 0 for CETs
/// - script_pubkey: The funding script used for sighash calculation
/// - value: The fund output value used for sighash calculation
/// - cet_txid: The CET transaction ID
/// - cet_raw: Raw CET bytes
#[napi]
pub fn get_cet_adaptor_signature_inputs(
  cet: Transaction,
  oracle_info: Vec<OracleInfo>,
  funding_script_pubkey: Buffer,
  fund_output_value: BigInt,
  msgs: Vec<Vec<Buffer>>,
) -> Result<CetAdaptorSignatureDebugInfo> {
  let ffi_oracle_info: Vec<ddk_ffi::OracleInfo> = oracle_info
    .into_iter()
    .map(|info| info.into())
    .collect();

  let ffi_msgs: Vec<Vec<Vec<u8>>> = msgs
    .into_iter()
    .map(|outcome_msgs| outcome_msgs.iter().map(buffer_to_vec).collect())
    .collect();

  let result = ddk_ffi::get_cet_adaptor_signature_inputs(
    cet.try_into()?,
    ffi_oracle_info,
    buffer_to_vec(&funding_script_pubkey),
    bigint_to_u64(&fund_output_value)?,
    ffi_msgs,
  )
  .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(CetAdaptorSignatureDebugInfo {
    sighash: vec_to_buffer(result.sighash),
    adaptor_point: vec_to_buffer(result.adaptor_point),
    input_index: result.input_index,
    script_pubkey: vec_to_buffer(result.script_pubkey),
    value: u64_to_bigint(result.value),
    cet_txid: result.cet_txid,
    cet_raw: vec_to_buffer(result.cet_raw),
  })
}

/// Get the sighash for a CET - the actual 32-byte message that gets signed.
/// This is useful for comparing with Fordefi's sighash calculation.
#[napi]
pub fn get_cet_sighash(
  cet: Transaction,
  funding_script_pubkey: Buffer,
  fund_output_value: BigInt,
) -> Result<Buffer> {
  let result = ddk_ffi::get_cet_sighash(
    cet.try_into()?,
    buffer_to_vec(&funding_script_pubkey),
    bigint_to_u64(&fund_output_value)?,
  )
  .map_err(|e| Error::from_reason(format!("{:?}", e)))?;

  Ok(vec_to_buffer(result))
}

// #[cfg(test)]
// mod tests {
//   use super::*;

//   struct DlcTransactionsInput {
//     outcomes: Vec<Payout>,
//     local_params: PartyParams,
//     remote_params: PartyParams,
//     refund_lock_time: u32,
//     feerate: BigInt,
//     fund_lock_time: u32,
//     cet_lock_time: u32,
//     fund_output_serial_id: BigInt,
//   }

//   fn convert_test_input() -> DlcTransactionsInput {
//     let outcomes = vec![
//       Payout {
//         offer: BigInt::from(1000000 as u64),
//         accept: BigInt::from(0 as u64),
//       },
//       Payout {
//         offer: BigInt::from(0 as u64),
//         accept: BigInt::from(1000000 as u64),
//       },
//       Payout {
//         offer: BigInt::from(500000 as u64),
//         accept: BigInt::from(500000 as u64),
//       },
//     ];

//     let local_params = PartyParams {
//       fund_pubkey: Buffer::from(
//         hex::decode("02ce79d1a726ffb61582b0273a1467b0bf9015334fa092c0814d7e8eb438f18406").unwrap(),
//       ),
//       change_script_pubkey: Buffer::from(
//         hex::decode("00141c40b566b9dfb4a99033fab17a42c12928b7298a").unwrap(),
//       ),
//       change_serial_id: BigInt::from(13503 as u64),
//       payout_script_pubkey: Buffer::from(
//         hex::decode("0014e330dca589a593b86b4ade6631899fb81dd6e66b").unwrap(),
//       ),
//       payout_serial_id: BigInt::from(10552966 as u64),
//       inputs: vec![TxInputInfo {
//         txid: "3a0cc8f8eb942a35713ed08220e68168548a7acd88c8154de7c6c154997af06a".to_string(),
//         vout: 1,
//         script_sig: Buffer::from(vec![]),
//         max_witness_length: 108,
//         serial_id: BigInt::from(16613448 as u64),
//       }],
//       input_amount: BigInt::from(200000000 as u64),
//       collateral: BigInt::from(998000 as u64),
//       dlc_inputs: vec![],
//     };

//     let remote_params = PartyParams {
//       fund_pubkey: Buffer::from(
//         hex::decode("03ffe16ce03bf2c3171cf6fb96bf3c1f39fc86e6df6d88f8d2725612f33eef83d1").unwrap(),
//       ),
//       change_script_pubkey: Buffer::from(
//         hex::decode("0014a21f425beec96857b25b02cb65cd3e236b9e3a79").unwrap(),
//       ),
//       change_serial_id: BigInt::from(5583 as u64),
//       payout_script_pubkey: Buffer::from(
//         hex::decode("0014eb93d76b8b19fc3f89a7a89e49b5bcc73d1c6212").unwrap(),
//       ),
//       payout_serial_id: BigInt::from(535622 as u64),
//       inputs: vec![TxInputInfo {
//         txid: "ad4d051fa11dfcb35f8764c0a878fb245bd4845cda3ca5f214a3746b0047e29b".to_string(),
//         vout: 0,
//         script_sig: Buffer::from(vec![]),
//         max_witness_length: 108,
//         serial_id: BigInt::from(5601888 as u64),
//       }],
//       input_amount: BigInt::from(200000000 as u64),
//       collateral: BigInt::from(2000 as u64),
//       dlc_inputs: vec![],
//     };

//     let refund_lock_time = 1617170573;
//     let feerate = BigInt::from(10 as u64);
//     let fund_lock_time = 0;
//     let cet_lock_time = 1617170572;
//     let fund_output_serial_id = BigInt::from(141263 as u64);

//     DlcTransactionsInput {
//       outcomes,
//       local_params,
//       remote_params,
//       refund_lock_time,
//       feerate,
//       fund_lock_time,
//       cet_lock_time,
//       fund_output_serial_id,
//     }
//   }

//   #[test]
//   fn test_create_dlc_transactions() {
//     let input = convert_test_input();
//     Env::
//     let result = create_dlc_transactions(
//       Env::new().unwrap(),
//       input.outcomes,
//       input.local_params,
//       input.remote_params,
//       input.refund_lock_time,
//       input.feerate,
//       input.fund_lock_time,
//       input.cet_lock_time,
//       input.fund_output_serial_id,
//     );

//     assert!(result.is_ok());
//   }
// }
