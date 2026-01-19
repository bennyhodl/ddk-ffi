use crate::types::*;
use napi::bindgen_prelude::*;

// Helper function to convert BigInt to u64 safely
pub fn bigint_to_u64(bi: &BigInt) -> Result<u64> {
  let (sign_bit, value, _lossless) = bi.get_u64();
  if sign_bit {
    return Err(Error::from_reason("BigInt value is negative"));
  }
  Ok(value)
}

// Helper function to convert u64 to BigInt
pub fn u64_to_bigint(value: u64) -> BigInt {
  BigInt::from(value)
}

// Helper function to convert Vec<u8> to Buffer
pub fn vec_to_buffer(vec: Vec<u8>) -> Buffer {
  Buffer::from(vec)
}

// Helper function to convert Buffer to Vec<u8>
pub fn buffer_to_vec(buffer: &Buffer) -> Vec<u8> {
  buffer.to_vec()
}

// Convert ddk_ffi Transaction to NAPI Transaction
impl From<ddk_ffi::Transaction> for Transaction {
  fn from(tx: ddk_ffi::Transaction) -> Self {
    Transaction {
      version: tx.version,
      lock_time: tx.lock_time,
      inputs: tx.inputs.into_iter().map(Into::into).collect(),
      outputs: tx.outputs.into_iter().map(Into::into).collect(),
      raw_bytes: Buffer::from(tx.raw_bytes),
    }
  }
}

// Convert NAPI Transaction to ddk_ffi Transaction
impl TryFrom<Transaction> for ddk_ffi::Transaction {
  type Error = napi::Error;

  fn try_from(tx: Transaction) -> Result<Self> {
    let outputs: Result<Vec<_>> = tx.outputs.into_iter().map(TryInto::try_into).collect();
    Ok(ddk_ffi::Transaction {
      version: tx.version,
      lock_time: tx.lock_time,
      inputs: tx.inputs.into_iter().map(Into::into).collect(),
      outputs: outputs?,
      raw_bytes: tx.raw_bytes.to_vec(),
    })
  }
}

// Convert NAPI TxInput to ddk_ffi TxInput
impl From<TxInput> for ddk_ffi::TxInput {
  fn from(input: TxInput) -> Self {
    ddk_ffi::TxInput {
      txid: input.txid,
      vout: input.vout,
      script_sig: input.script_sig.to_vec(),
      sequence: input.sequence,
      witness: input.witness.into_iter().map(|w| w.to_vec()).collect(),
    }
  }
}

// Convert ddk_ffi TxInput to NAPI TxInput
impl From<ddk_ffi::TxInput> for TxInput {
  fn from(input: ddk_ffi::TxInput) -> Self {
    TxInput {
      txid: input.txid,
      vout: input.vout,
      script_sig: Buffer::from(input.script_sig),
      sequence: input.sequence,
      witness: input.witness.into_iter().map(Buffer::from).collect(),
    }
  }
}

// Convert NAPI TxOutput to ddk_ffi TxOutput
impl TryFrom<TxOutput> for ddk_ffi::TxOutput {
  type Error = napi::Error;

  fn try_from(output: TxOutput) -> Result<Self> {
    Ok(ddk_ffi::TxOutput {
      value: bigint_to_u64(&output.value)?,
      script_pubkey: output.script_pubkey.to_vec(),
    })
  }
}

// Convert ddk_ffi TxOutput to NAPI TxOutput
impl From<ddk_ffi::TxOutput> for TxOutput {
  fn from(output: ddk_ffi::TxOutput) -> Self {
    TxOutput {
      value: BigInt::from(output.value),
      script_pubkey: Buffer::from(output.script_pubkey),
    }
  }
}

// Convert NAPI TxInputInfo to ddk_ffi TxInputInfo
impl TryFrom<TxInputInfo> for ddk_ffi::TxInputInfo {
  type Error = napi::Error;

  fn try_from(info: TxInputInfo) -> Result<Self> {
    Ok(ddk_ffi::TxInputInfo {
      txid: info.txid,
      vout: info.vout,
      script_sig: info.script_sig.to_vec(),
      max_witness_length: info.max_witness_length,
      serial_id: bigint_to_u64(&info.serial_id)?,
    })
  }
}

// Convert ddk_ffi TxInputInfo to NAPI TxInputInfo
impl From<ddk_ffi::TxInputInfo> for TxInputInfo {
  fn from(info: ddk_ffi::TxInputInfo) -> Self {
    TxInputInfo {
      txid: info.txid,
      vout: info.vout,
      script_sig: Buffer::from(info.script_sig),
      max_witness_length: info.max_witness_length,
      serial_id: BigInt::from(info.serial_id),
    }
  }
}

impl TryFrom<Payout> for ddk_ffi::Payout {
  type Error = napi::Error;

  fn try_from(outcome: Payout) -> Result<Self> {
    Ok(ddk_ffi::Payout {
      offer: bigint_to_u64(&outcome.offer)?,
      accept: bigint_to_u64(&outcome.accept)?,
    })
  }
}
impl From<ddk_ffi::Payout> for Payout {
  fn from(outcome: ddk_ffi::Payout) -> Self {
    Payout {
      offer: BigInt::from(outcome.offer),
      accept: BigInt::from(outcome.accept),
    }
  }
}
// Convert NAPI DlcInputInfo to ddk_ffi DlcInputInfo
impl TryFrom<DlcInputInfo> for ddk_ffi::DlcInputInfo {
  type Error = napi::Error;

  fn try_from(info: DlcInputInfo) -> Result<Self> {
    Ok(ddk_ffi::DlcInputInfo {
      fund_tx: info.fund_tx.try_into()?,
      fund_vout: info.fund_vout,
      local_fund_pubkey: info.local_fund_pubkey.to_vec(),
      remote_fund_pubkey: info.remote_fund_pubkey.to_vec(),
      fund_amount: bigint_to_u64(&info.fund_amount)?,
      max_witness_len: info.max_witness_len,
      input_serial_id: bigint_to_u64(&info.input_serial_id)?,
      contract_id: info.contract_id.to_vec(),
    })
  }
}

// Convert ddk_ffi DlcInputInfo to NAPI DlcInputInfo
impl From<ddk_ffi::DlcInputInfo> for DlcInputInfo {
  fn from(info: ddk_ffi::DlcInputInfo) -> Self {
    DlcInputInfo {
      fund_tx: info.fund_tx.into(),
      fund_vout: info.fund_vout,
      local_fund_pubkey: Buffer::from(info.local_fund_pubkey),
      remote_fund_pubkey: Buffer::from(info.remote_fund_pubkey),
      fund_amount: BigInt::from(info.fund_amount),
      max_witness_len: info.max_witness_len,
      input_serial_id: BigInt::from(info.input_serial_id),
      contract_id: Buffer::from(info.contract_id),
    }
  }
}

// Convert NAPI PartyParams to ddk_ffi PartyParams
impl TryFrom<PartyParams> for ddk_ffi::PartyParams {
  type Error = napi::Error;

  fn try_from(params: PartyParams) -> Result<Self> {
    let inputs: Result<Vec<_>> = params.inputs.into_iter().map(TryInto::try_into).collect();
    let dlc_inputs: Result<Vec<_>> = params
      .dlc_inputs
      .into_iter()
      .map(TryInto::try_into)
      .collect();

    Ok(ddk_ffi::PartyParams {
      fund_pubkey: params.fund_pubkey.to_vec(),
      change_script_pubkey: params.change_script_pubkey.to_vec(),
      change_serial_id: bigint_to_u64(&params.change_serial_id)?,
      payout_script_pubkey: params.payout_script_pubkey.to_vec(),
      payout_serial_id: bigint_to_u64(&params.payout_serial_id)?,
      inputs: inputs?,
      input_amount: bigint_to_u64(&params.input_amount)?,
      collateral: bigint_to_u64(&params.collateral)?,
      dlc_inputs: dlc_inputs?,
    })
  }
}

// Convert ddk_ffi PartyParams to NAPI PartyParams
impl From<ddk_ffi::PartyParams> for PartyParams {
  fn from(params: ddk_ffi::PartyParams) -> Self {
    PartyParams {
      fund_pubkey: Buffer::from(params.fund_pubkey),
      change_script_pubkey: Buffer::from(params.change_script_pubkey),
      change_serial_id: BigInt::from(params.change_serial_id),
      payout_script_pubkey: Buffer::from(params.payout_script_pubkey),
      payout_serial_id: BigInt::from(params.payout_serial_id),
      inputs: params.inputs.into_iter().map(Into::into).collect(),
      input_amount: BigInt::from(params.input_amount),
      collateral: BigInt::from(params.collateral),
      dlc_inputs: params.dlc_inputs.into_iter().map(Into::into).collect(),
    }
  }
}

// Convert ddk_ffi DlcTransactions to NAPI DlcTransactions
impl From<ddk_ffi::DlcTransactions> for DlcTransactions {
  fn from(txs: ddk_ffi::DlcTransactions) -> Self {
    DlcTransactions {
      fund: txs.fund.into(),
      cets: txs.cets.into_iter().map(Into::into).collect(),
      refund: txs.refund.into(),
      funding_script_pubkey: Buffer::from(txs.funding_script_pubkey),
    }
  }
}

// Convert ddk_ffi ChangeOutputAndFees to NAPI ChangeOutputAndFees
impl From<ddk_ffi::ChangeOutputAndFees> for ChangeOutputAndFees {
  fn from(fees: ddk_ffi::ChangeOutputAndFees) -> Self {
    ChangeOutputAndFees {
      change_output: fees.change_output.into(),
      fund_fee: BigInt::from(fees.fund_fee),
      cet_fee: BigInt::from(fees.cet_fee),
    }
  }
}

// Convert NAPI OracleInfo to ddk_ffi OracleInfo
impl From<OracleInfo> for ddk_ffi::OracleInfo {
  fn from(info: OracleInfo) -> Self {
    ddk_ffi::OracleInfo {
      public_key: info.public_key.to_vec(),
      nonces: info.nonces.into_iter().map(|n| n.to_vec()).collect(),
    }
  }
}

// Convert ddk_ffi AdaptorSignature to NAPI AdaptorSignature
impl From<ddk_ffi::AdaptorSignature> for AdaptorSignature {
  fn from(sig: ddk_ffi::AdaptorSignature) -> Self {
    AdaptorSignature {
      signature: Buffer::from(sig.signature),
      proof: Buffer::from(sig.proof),
    }
  }
}

impl From<AdaptorSignature> for ddk_ffi::AdaptorSignature {
  fn from(sig: AdaptorSignature) -> Self {
    ddk_ffi::AdaptorSignature {
      signature: sig.signature.to_vec(),
      proof: sig.proof.to_vec(),
    }
  }
}
