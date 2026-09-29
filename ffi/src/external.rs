//! External signing: for a contract key held by a signer that cannot answer
//! inside the call, such as a custody vault that needs a person to approve.
//!
//! Each step that signs with the contract key is a pair. `prepare_*` returns
//! what this party must sign — PSBTs, because that is what such signers take
//! and what shows the approver what they are signing. `complete_*`
//! takes the signatures back, verifies every one against the messages, and
//! produces the same result as the provider-based function. The prepared
//! context preserves the messages and generated serial ids between calls.
//!
//! The contract key signs the refund, one adaptor signature per CET and oracle
//! combination, and — when the offer splices a previous contract — this
//! party's half of that contract's 2-of-2. Wallet inputs are signed as in the
//! key-based flow, through the funding PSBT.
//!
//! Enum-outcome contracts only: a numeric-outcome contract's adaptor points
//! come from its digit trie, which is not exposed yet
//! ([`ContractError::Unsupported`]).

use crate::signer::{ContractKeyRequest, ContractSignerProvider, FundingWallet};
use bitcoin::hashes::Hash;
use bitcoin::psbt::Psbt;
use bitcoin::secp256k1::rand::random;
use bitcoin::sighash::EcdsaSighashType;
use bitcoin::{Transaction, Witness};
use ddk::contract as ddk_contract;
use ddk::ddk_manager::contract::{execution_contract_infos, ContractDescriptor};
use ddk_contract::{advanced, AcceptOfferParams as RustAcceptOfferParams, Party};
use ddk_dlc::dlc_input::DlcInputInfo;
use ddk_messages::oracle_msgs::tagged_attestation_msg;
use ddk_messages::{
    AcceptDlc, CetAdaptorSignatures, FundingSignature, FundingSignatures, OfferDlc, SignDlc,
};
use ddk_trie::combination_iterator::CombinationIterator;
use secp256k1_zkp::ecdsa::Signature;
use secp256k1_zkp::{EcdsaAdaptorSignature, PublicKey, Secp256k1};

use crate::contract::{
    decode_msg, decode_psbt, AcceptOfferParams, AcceptResult, ContractError, SignResult,
};

/// One CET adaptor signature to produce.
#[derive(Clone, uniffi::Record)]
pub struct CetSigningRequest {
    /// The CET as a BIP-174 PSBT spending the 2-of-2 funding output, with its
    /// `witness_utxo` and `witness_script` set.
    pub psbt: Vec<u8>,
    /// The 33-byte point the signature is encrypted to: the oracle outcome
    /// this CET pays out on.
    pub adaptor_point: Vec<u8>,
}

/// Everything one party signs with its contract key in one step.
#[derive(Clone, uniffi::Record)]
pub struct SigningRequest {
    /// The key every refund and CET signature must verify against: this
    /// party's funding public key, with the offer's temporary id and the
    /// contract id, all from the messages.
    pub key: ContractKeyRequest,
    /// The refund transaction as a PSBT spending the 2-of-2 funding output,
    /// with its `witness_utxo` and `witness_script` set.
    pub refund_psbt: Vec<u8>,
    /// One entry per adaptor signature, in the order they are returned.
    pub cets: Vec<CetSigningRequest>,
    /// This party's halves of the splice (DLC) inputs. Nothing to sign unless
    /// the offer splices a contract.
    pub splice: SpliceSigningRequest,
}

/// This party's half of every splice (DLC) input: part of each
/// [`SigningRequest`], and what [`prepare_finalize_sign`] returns to the
/// accepting party once the offerer's sign message has been verified.
#[derive(Clone, uniffi::Record)]
pub struct SpliceSigningRequest {
    /// The funding transaction as a PSBT. Splice (DLC) inputs carry their
    /// `witness_utxo` and 2-of-2 `witness_script` here, unlike in
    /// `create_funding_psbt`, so a signer can produce this party's half.
    pub funding_psbt: Vec<u8>,
    /// The funding transaction input indexes of the splice (DLC) inputs this
    /// party signs a half of. Empty unless the offer splices a contract.
    pub dlc_inputs: Vec<DlcInputSigningRequest>,
}

/// A signer's answer to a [`SigningRequest`]'s refund and CETs.
#[derive(Clone, uniffi::Record)]
pub struct ContractSignatures {
    /// The 64-byte compact (R‖S) ECDSA signature of the refund, SIGHASH_ALL.
    pub refund_signature: Vec<u8>,
    /// The 162-byte ECDSA adaptor signatures, in the request's `cets` order.
    pub cet_adaptor_signatures: Vec<Vec<u8>>,
}

/// A signer's half of one splice (DLC) input's 2-of-2.
#[derive(Clone, uniffi::Record)]
pub struct DlcInputSignature {
    /// The funding transaction input index, from the request's
    /// `dlc_inputs`.
    pub input_index: u32,
    /// The 64-byte compact (R‖S) ECDSA signature, SIGHASH_ALL.
    pub signature: Vec<u8>,
}

/// A splice input's signing identity, read from the offer. No previous
/// contract data needs to be supplied by the caller.
#[derive(Clone, uniffi::Record)]
pub struct DlcInputSigningRequest {
    pub input_index: u32,
    pub key: ContractKeyRequest,
}

/// Serializable preparation state. Preserve both messages exactly; signatures
/// are verified against the transactions reconstructed from them on completion.
#[derive(Clone, uniffi::Record)]
pub struct SigningContext {
    pub offer: Vec<u8>,
    pub accept: Vec<u8>,
}

#[derive(Clone, uniffi::Record)]
pub struct PreparedContract {
    pub context: SigningContext,
    pub request: SigningRequest,
}

/// Contract signatures plus wallet funding witnesses and splice input halves.
#[derive(Clone, uniffi::Record)]
pub struct SigningResponse {
    pub contract: ContractSignatures,
    pub signed_funding_psbt: Vec<u8>,
    #[uniffi(default = [])]
    pub dlc_input_signatures: Vec<DlcInputSignature>,
}

/// Prepare an accept, choosing omitted serial ids once. Persist `context`
/// while waiting for external approval; no key material is retained in it.
#[uniffi::export]
pub fn prepare_accept_offer(
    offer: Vec<u8>,
    params: AcceptOfferParams,
) -> Result<PreparedContract, ContractError> {
    let offer_msg: OfferDlc = decode_msg(&offer, "offer")?;
    let accept = unsigned_accept(&offer_msg, params)?;
    let request = signing_request(&offer_msg, &accept, Party::Accept)?;
    Ok(PreparedContract {
        context: SigningContext {
            offer,
            accept: crate::contract::encode_msg(&accept),
        },
        request,
    })
}

/// Verify externally produced signatures and finish the prepared accept.
#[uniffi::export]
pub fn complete_accept_offer(
    context: SigningContext,
    signatures: ContractSignatures,
) -> Result<AcceptResult, ContractError> {
    let offer: OfferDlc = decode_msg(&context.offer, "offer")?;
    let mut accept: AcceptDlc = decode_msg(&context.accept, "prepared accept")?;
    let (refund_signature, cet_adaptor_signatures) = decode_contract_signatures(signatures)?;
    accept.refund_signature = refund_signature;
    accept.cet_adaptor_signatures = cet_adaptor_signatures;
    verify_party_signatures(&offer, &accept, Party::Accept)?;

    Ok(AcceptResult::from_rust(ddk_contract::AcceptResult {
        transactions: ddk_contract::create_dlc_transactions(&offer, &accept)?,
        funding_psbt: ddk_contract::create_funding_psbt(&offer, &accept)?,
        accept,
    }))
}

/// Validate the accept before requesting any offering-party signatures.
#[uniffi::export]
pub fn prepare_sign_accept(
    offer: Vec<u8>,
    accept: Vec<u8>,
) -> Result<PreparedContract, ContractError> {
    let offer_msg: OfferDlc = decode_msg(&offer, "offer")?;
    let accept_msg: AcceptDlc = decode_msg(&accept, "accept")?;
    verify_party_signatures(&offer_msg, &accept_msg, Party::Accept)?;
    let request = signing_request(&offer_msg, &accept_msg, Party::Offer)?;
    Ok(PreparedContract {
        context: SigningContext { offer, accept },
        request,
    })
}

/// Complete SignDlc from the prepared context and signatures. Wallet inputs
/// must have finalized witnesses; splice halves are verified and assembled here.
#[uniffi::export]
pub fn complete_sign_accept(
    context: SigningContext,
    signatures: SigningResponse,
) -> Result<SignResult, ContractError> {
    let offer: OfferDlc = decode_msg(&context.offer, "offer")?;
    let accept: AcceptDlc = decode_msg(&context.accept, "accept")?;
    verify_party_signatures(&offer, &accept, Party::Accept)?;
    let SigningResponse {
        contract: signatures,
        signed_funding_psbt,
        dlc_input_signatures,
    } = signatures;

    let (refund_signature, cet_adaptor_signatures) = decode_contract_signatures(signatures)?;
    advanced::verify_cet_adaptor_signatures(
        &offer,
        &accept,
        Party::Offer,
        &refund_signature,
        &cet_adaptor_signatures,
    )?;

    let transactions = ddk_contract::create_dlc_transactions(&offer, &accept)?;
    let psbt = decode_psbt(&signed_funding_psbt)?;
    ensure_psbt_spends(&psbt, &transactions.fund)?;
    let mut dlc_signatures = DlcInputSignatures::decode(dlc_input_signatures)?;

    let funding_signatures = offer
        .funding_inputs
        .iter()
        .map(|input| {
            let input_index = funding_input_index(&offer, &accept, input.input_serial_id)?;
            let witness = match &input.dlc_input {
                Some(dlc_input) => {
                    let signature = dlc_signatures.take_verified(
                        input_index,
                        &transactions.fund,
                        &input.into(),
                        &dlc_input.local_fund_pubkey,
                    )?;
                    Witness::from_slice(&[signature])
                }
                None => finalized_witness(&psbt, input_index)?,
            };
            Ok(advanced::funding_signature_from_witness(witness))
        })
        .collect::<Result<Vec<FundingSignature>, ContractError>>()?;
    dlc_signatures.ensure_all_used()?;

    let sign = SignDlc {
        protocol_version: offer.protocol_version,
        contract_id: advanced::compute_contract_id(&offer, &accept)?,
        cet_adaptor_signatures,
        refund_signature,
        funding_signatures: FundingSignatures { funding_signatures },
        tlvs: Default::default(),
    };
    Ok(SignResult::from_rust(ddk_contract::SignResult {
        sign,
        transactions,
    }))
}

/// Completes the funding transaction for an accepting party whose contract key
/// is held externally: the same result as `finalize_sign`, with this party's
/// half of each splice input taken from `dlc_input_signatures`
/// (`prepare_finalize_sign` lists them) rather than derived from keys.
///
/// `signed_funding_psbt` carries finalized witnesses for the accepting party's
/// wallet inputs; with none, the unsigned funding PSBT is enough.
#[uniffi::export(default(dlc_input_signatures))]
pub fn finalize_sign_with_signatures(
    offer: Vec<u8>,
    accept: Vec<u8>,
    sign: Vec<u8>,
    signed_funding_psbt: Vec<u8>,
    dlc_input_signatures: Vec<DlcInputSignature>,
) -> Result<Vec<u8>, ContractError> {
    let offer: OfferDlc = decode_msg(&offer, "offer")?;
    let accept: AcceptDlc = decode_msg(&accept, "accept")?;
    let sign: SignDlc = decode_msg(&sign, "sign")?;

    let transactions = verified_sign_transactions(&offer, &accept, &sign)?;
    let offer_signatures = &sign.funding_signatures.funding_signatures;
    let psbt = decode_psbt(&signed_funding_psbt)?;
    let accept_signatures =
        advanced::funding_signatures_from_psbt(&offer, &accept, Party::Accept, &psbt)?;
    let mut dlc_signatures = DlcInputSignatures::decode(dlc_input_signatures)?;

    // Splice halves sign the unsigned transaction: a SegWit sighash does not
    // commit to the other inputs' witnesses.
    let unsigned = &transactions.fund;
    let mut funding_transaction = transactions.fund.clone();
    for (input, offer_signature) in offer.funding_inputs.iter().zip(offer_signatures) {
        let input_index = funding_input_index(&offer, &accept, input.input_serial_id)?;
        let elements = offer_signature
            .witness_elements
            .iter()
            .map(|element| element.witness.clone())
            .collect::<Vec<_>>();
        funding_transaction.input[input_index].witness = match &input.dlc_input {
            Some(dlc_input) => {
                let dlc_input_info: DlcInputInfo = input.into();
                let offer_half = elements[0].clone();
                let accept_half = dlc_signatures.take_verified(
                    input_index,
                    unsigned,
                    &dlc_input_info,
                    &dlc_input.remote_fund_pubkey,
                )?;
                ddk_dlc::dlc_input::combine_dlc_input_signatures(
                    &dlc_input_info,
                    &accept_half,
                    &offer_half,
                    &dlc_input.remote_fund_pubkey,
                    &dlc_input.local_fund_pubkey,
                )
            }
            None => Witness::from_slice(&elements),
        };
    }
    for (input, signature) in accept
        .funding_inputs
        .iter()
        .zip(&accept_signatures.funding_signatures)
    {
        let input_index = funding_input_index(&offer, &accept, input.input_serial_id)?;
        funding_transaction.input[input_index].witness = Witness::from_slice(
            &signature
                .witness_elements
                .iter()
                .map(|element| &element.witness)
                .collect::<Vec<_>>(),
        );
    }
    dlc_signatures.ensure_all_used()?;

    Ok(bitcoin::consensus::serialize(&funding_transaction))
}

fn verified_sign_transactions(
    offer: &OfferDlc,
    accept: &AcceptDlc,
    sign: &SignDlc,
) -> Result<ddk_dlc::DlcTransactions, ContractError> {
    if sign.protocol_version != offer.protocol_version {
        return Err(ContractError::InvalidSign {
            message: "offer and sign protocol versions differ".to_string(),
        });
    }
    if sign.contract_id != advanced::compute_contract_id(offer, accept)? {
        return Err(ContractError::InvalidSign {
            message: "sign message contract id does not match the rebuilt funding transaction"
                .to_string(),
        });
    }
    advanced::verify_cet_adaptor_signatures(
        offer,
        accept,
        Party::Offer,
        &sign.refund_signature,
        &sign.cet_adaptor_signatures,
    )?;
    let offer_signatures = &sign.funding_signatures.funding_signatures;
    if offer_signatures.len() != offer.funding_inputs.len() {
        return Err(ContractError::InvalidSign {
            message: format!(
                "sign message carries {} funding signatures but the offer has {} funding inputs",
                offer_signatures.len(),
                offer.funding_inputs.len()
            ),
        });
    }

    let transactions = ddk_contract::create_dlc_transactions(offer, accept)?;
    let secp = Secp256k1::verification_only();
    for (input, signature) in offer.funding_inputs.iter().zip(offer_signatures) {
        let index = funding_input_index(offer, accept, input.input_serial_id)?;
        let first =
            signature
                .witness_elements
                .first()
                .ok_or_else(|| ContractError::InvalidSign {
                    message: format!("funding signature for input {index} is empty"),
                })?;
        if let Some(dlc_input) = &input.dlc_input {
            ddk_dlc::dlc_input::verify_dlc_funding_input_signature(
                &secp,
                &transactions.fund,
                index,
                &input.into(),
                first.witness.clone(),
                &dlc_input.local_fund_pubkey,
            )
            .map_err(|e| ContractError::InvalidSign {
                message: format!("invalid signature for DLC input {index}: {e}"),
            })?;
        }
    }
    Ok(transactions)
}

/// The accept message `params` produce, without its signatures: enough to
/// rebuild every transaction, which none of its signatures take part in.
/// Mirrors the message `ddk::contract::accept_offer` builds.
fn unsigned_accept(
    offer: &OfferDlc,
    params: AcceptOfferParams,
) -> Result<AcceptDlc, ContractError> {
    let RustAcceptOfferParams {
        party,
        min_timeout_interval,
        max_timeout_interval,
        now_unix,
    } = params.into_rust()?;
    ddk_contract::validate_offer(offer, min_timeout_interval, max_timeout_interval, now_unix)?;

    let payout_serial_id = party.payout_serial_id.unwrap_or_else(random);
    let change_serial_id = party.change_serial_id.unwrap_or_else(random);
    let accept_collateral = offer
        .get_total_collateral()
        .checked_sub(offer.offer_collateral)
        .ok_or_else(|| ContractError::InvalidOffer {
            message: "offer collateral exceeds total collateral".to_string(),
        })?;

    Ok(AcceptDlc {
        protocol_version: offer.protocol_version,
        temporary_contract_id: offer.temporary_contract_id,
        accept_collateral,
        funding_pubkey: party.funding_pubkey,
        payout_spk: party.payout_spk,
        payout_serial_id,
        funding_inputs: party.funding_inputs,
        change_spk: party.change_spk,
        change_serial_id,
        cet_adaptor_signatures: CetAdaptorSignatures::from(&[][..]),
        // A placeholder in the prepared context, replaced before completion
        // verifies the message. Rebuilt transactions do not depend on it.
        refund_signature: Signature::from_compact(&[1; 64]).expect("a valid compact signature"),
        negotiation_fields: None,
        tlvs: Default::default(),
    })
}

/// Builds `party`'s signing request for the contract `offer` and `accept`
/// describe.
fn signing_request(
    offer: &OfferDlc,
    accept: &AcceptDlc,
    party: Party,
) -> Result<SigningRequest, ContractError> {
    let transactions = ddk_contract::create_dlc_transactions(offer, accept)?;
    let funding_pubkey = match party {
        Party::Offer => offer.funding_pubkey,
        Party::Accept => accept.funding_pubkey,
    };

    let cets = cet_adaptor_points(offer)?
        .into_iter()
        .map(|(cet_index, adaptor_point)| {
            let cet = transactions
                .cets
                .get(cet_index)
                .ok_or_else(|| ContractError::Dlc {
                    message: format!("the contract has no CET {cet_index}"),
                })?;
            Ok(CetSigningRequest {
                psbt: funding_spend_psbt(&transactions, cet)?,
                adaptor_point: adaptor_point.serialize().to_vec(),
            })
        })
        .collect::<Result<Vec<_>, ContractError>>()?;

    Ok(SigningRequest {
        key: ContractKeyRequest {
            funding_pubkey: funding_pubkey.serialize().to_vec(),
            temporary_contract_id: offer.temporary_contract_id.to_vec(),
            contract_id: advanced::compute_contract_id(offer, accept)?.to_vec(),
        },
        refund_psbt: funding_spend_psbt(&transactions, &transactions.refund)?,
        cets,
        splice: splice_signing_request(offer, accept, party)?,
    })
}

/// `party`'s half of every splice input. Both parties sign a half of each, so
/// both get the same indexes.
fn splice_signing_request(
    offer: &OfferDlc,
    accept: &AcceptDlc,
    party: Party,
) -> Result<SpliceSigningRequest, ContractError> {
    let mut funding_psbt = ddk_contract::create_funding_psbt(offer, accept)?;
    let mut dlc_inputs = Vec::new();
    for input in &offer.funding_inputs {
        let Some(dlc_input) = &input.dlc_input else {
            continue;
        };
        let input_index = funding_input_index(offer, accept, input.input_serial_id)?;
        let dlc_input_info: DlcInputInfo = input.into();
        let spent = dlc_input_info
            .fund_tx
            .output
            .get(dlc_input_info.fund_vout as usize)
            .ok_or_else(|| ContractError::InvalidFundingInput {
                message: format!("DLC input {input_index} spends an output that does not exist"),
            })?;
        funding_psbt.inputs[input_index].witness_utxo = Some(spent.clone());
        funding_psbt.inputs[input_index].witness_script = Some(ddk_dlc::make_funding_redeemscript(
            &dlc_input.local_fund_pubkey,
            &dlc_input.remote_fund_pubkey,
        ));
        let pubkey = match party {
            Party::Offer => dlc_input.local_fund_pubkey,
            Party::Accept => dlc_input.remote_fund_pubkey,
        };
        dlc_inputs.push(DlcInputSigningRequest {
            input_index: input_index as u32,
            key: ContractKeyRequest {
                funding_pubkey: pubkey.serialize().to_vec(),
                temporary_contract_id: splice_temporary_contract_id(
                    &dlc_input_info,
                    &dlc_input.contract_id,
                )
                .to_vec(),
                contract_id: dlc_input.contract_id.to_vec(),
            },
        });
    }
    Ok(SpliceSigningRequest {
        funding_psbt: funding_psbt.serialize(),
        dlc_inputs,
    })
}

/// The previous contract's temporary id, recovered from its splice input. The
/// contract id is the funding txid combined with the temporary id, with the
/// funding output index folded into the last two bytes, so the input's
/// funding transaction and contract id give the temporary id back.
fn splice_temporary_contract_id(input: &DlcInputInfo, contract_id: &[u8; 32]) -> [u8; 32] {
    let txid = input.fund_tx.compute_txid().to_byte_array();
    let vout = input.fund_vout as u16;
    let mut temporary_contract_id = [0u8; 32];
    for (i, byte) in temporary_contract_id.iter_mut().enumerate() {
        *byte = contract_id[i] ^ txid[31 - i];
    }
    temporary_contract_id[30] ^= ((vout >> 8) & 0xff) as u8;
    temporary_contract_id[31] ^= (vout & 0xff) as u8;
    temporary_contract_id
}

/// The same request preparation serves native providers and external signers.
pub(crate) fn sign_contract_request(
    request: &SigningRequest,
    provider: &dyn ContractSignerProvider,
) -> Result<ContractSignatures, ContractError> {
    let signer = provider.get_signer(request.key.clone())?;
    let refund_signature = signer.sign_ecdsa(psbt_sighash(&request.refund_psbt, 0)?)?;
    let cet_adaptor_signatures = request
        .cets
        .iter()
        .map(|cet| signer.sign_adaptor(psbt_sighash(&cet.psbt, 0)?, cet.adaptor_point.clone()))
        .collect::<Result<_, _>>()?;
    Ok(ContractSignatures {
        refund_signature,
        cet_adaptor_signatures,
    })
}

pub(crate) fn sign_dlc_inputs(
    request: &SpliceSigningRequest,
    provider: &dyn ContractSignerProvider,
) -> Result<Vec<DlcInputSignature>, ContractError> {
    request
        .dlc_inputs
        .iter()
        .map(|input| {
            let signer = provider.get_signer(input.key.clone())?;
            Ok(DlcInputSignature {
                input_index: input.input_index,
                signature: signer.sign_ecdsa(psbt_sighash(
                    &request.funding_psbt,
                    input.input_index as usize,
                )?)?,
            })
        })
        .collect()
}

/// The funding PSBT with this party's wallet inputs signed by `wallet`, or as
/// given when this party contributes none. Splice (DLC) inputs are not wallet
/// inputs: the contract key signs those.
pub(crate) async fn sign_wallet_inputs(
    context: &SigningContext,
    party: Party,
    funding_psbt: Vec<u8>,
    wallet: Option<&dyn FundingWallet>,
) -> Result<Vec<u8>, ContractError> {
    let has_wallet_inputs = match party {
        Party::Offer => decode_msg::<OfferDlc>(&context.offer, "offer")?
            .funding_inputs
            .iter()
            .any(|input| input.dlc_input.is_none()),
        Party::Accept => decode_msg::<AcceptDlc>(&context.accept, "accept")?
            .funding_inputs
            .iter()
            .any(|input| input.dlc_input.is_none()),
    };
    if !has_wallet_inputs {
        return Ok(funding_psbt);
    }
    let wallet = wallet.ok_or_else(|| ContractError::Wallet {
        message: "this party has wallet funding inputs but no wallet to sign them".to_string(),
    })?;
    wallet.sign_funding_psbt(funding_psbt).await
}

pub(crate) fn psbt_sighash(bytes: &[u8], index: usize) -> Result<Vec<u8>, ContractError> {
    let psbt = decode_psbt(bytes)?;
    let input = psbt
        .inputs
        .get(index)
        .ok_or_else(|| ContractError::PsbtMismatch {
            message: "signing input not found".into(),
        })?;
    let (Some(script), Some(utxo)) = (&input.witness_script, &input.witness_utxo) else {
        return Err(ContractError::PsbtMismatch {
            message: "signing input needs witness_script and witness_utxo".into(),
        });
    };
    ddk_dlc::util::get_sig_hash_msg(&psbt.unsigned_tx, index, script, utxo.value)
        .map(|msg| msg.as_ref().to_vec())
        .map_err(|e| ContractError::Dlc {
            message: e.to_string(),
        })
}

/// Verify the offerer's sign message, then return the accepting party's half
/// of each splice input to sign; `finalize_sign_with_signatures` takes the
/// signatures. With no `dlc_inputs`, the unsigned funding PSBT is enough.
///
/// The accept step's request lists the same inputs, so a signer may produce
/// its halves then instead; this lets one wait until the peer has signed.
#[uniffi::export]
pub fn prepare_finalize_sign(
    offer: Vec<u8>,
    accept: Vec<u8>,
    sign: Vec<u8>,
) -> Result<SpliceSigningRequest, ContractError> {
    let offer = decode_msg(&offer, "offer")?;
    let accept = decode_msg(&accept, "accept")?;
    verified_sign_transactions(&offer, &accept, &decode_msg(&sign, "sign")?)?;
    splice_signing_request(&offer, &accept, Party::Accept)
}

/// The adaptor point of every adaptor signature the contract needs, paired
/// with the index of the CET it signs, in message order.
///
/// Mirrors how ddk-manager signs an enum contract: per outcome, one signature
/// for each combination of `threshold` oracles, the CETs of each execution
/// info following the previous info's.
fn cet_adaptor_points(offer: &OfferDlc) -> Result<Vec<(usize, PublicKey)>, ContractError> {
    let secp = Secp256k1::verification_only();
    let execution_infos = execution_contract_infos(&offer.contract_info).map_err(|e| {
        ContractError::InvalidOffer {
            message: format!("invalid contract info: {e}"),
        }
    })?;

    let mut points = Vec::new();
    let mut first_cet = 0;
    for info in &execution_infos {
        let ContractDescriptor::Enum(descriptor) = &info.contract_descriptor else {
            return Err(ContractError::Unsupported {
                message: "external signing supports enum-outcome contracts only".to_string(),
            });
        };
        let oracle_infos = info.get_oracle_infos();
        let combinations: Vec<Vec<usize>> =
            CombinationIterator::new(oracle_infos.len(), info.threshold).collect();
        for (outcome_index, outcome) in descriptor.outcome_payouts.iter().enumerate() {
            let messages = vec![vec![tagged_attestation_msg(&outcome.outcome)]; info.threshold];
            for combination in &combinations {
                let oracles = combination
                    .iter()
                    .map(|&index| oracle_infos[index].clone())
                    .collect::<Vec<_>>();
                let point = ddk_dlc::get_adaptor_point_from_oracle_info(&secp, &oracles, &messages)
                    .map_err(|e| ContractError::Dlc {
                        message: format!("could not compute an adaptor point: {e}"),
                    })?;
                points.push((first_cet + outcome_index, point));
            }
        }
        first_cet += descriptor.outcome_payouts.len();
    }
    Ok(points)
}

/// A signer's splice-input halves, each used exactly once.
struct DlcInputSignatures(Vec<(usize, Signature)>);

impl DlcInputSignatures {
    fn decode(signatures: Vec<DlcInputSignature>) -> Result<Self, ContractError> {
        signatures
            .into_iter()
            .map(|s| {
                Ok((
                    s.input_index as usize,
                    compact_signature(&s.signature, "DLC input")?,
                ))
            })
            .collect::<Result<_, ContractError>>()
            .map(Self)
    }

    /// Takes the half for `input_index`, verified against `pubkey`, as a
    /// DER + SIGHASH_ALL witness element.
    fn take_verified(
        &mut self,
        input_index: usize,
        funding_transaction: &Transaction,
        dlc_input: &DlcInputInfo,
        pubkey: &PublicKey,
    ) -> Result<Vec<u8>, ContractError> {
        let position = self
            .0
            .iter()
            .position(|(index, _)| *index == input_index)
            .ok_or_else(|| ContractError::InvalidFundingInput {
                message: format!("no signature supplied for DLC input {input_index}"),
            })?;
        let (_, signature) = self.0.remove(position);
        let element = ddk_dlc::util::finalize_sig(&signature, EcdsaSighashType::All);
        ddk_dlc::dlc_input::verify_dlc_funding_input_signature(
            &Secp256k1::verification_only(),
            funding_transaction,
            input_index,
            dlc_input,
            element.clone(),
            pubkey,
        )
        .map_err(|e| ContractError::InvalidFundingInput {
            message: format!("invalid signature for DLC input {input_index}: {e}"),
        })?;
        Ok(element)
    }

    fn ensure_all_used(&self) -> Result<(), ContractError> {
        match self.0.first() {
            Some((index, _)) => Err(ContractError::InvalidFundingInput {
                message: format!("input {index} is not a DLC input this party signs"),
            }),
            None => Ok(()),
        }
    }
}

fn decode_contract_signatures(
    signatures: ContractSignatures,
) -> Result<(Signature, CetAdaptorSignatures), ContractError> {
    let refund_signature = compact_signature(&signatures.refund_signature, "refund")?;
    let adaptor_signatures = signatures
        .cet_adaptor_signatures
        .iter()
        .map(|bytes| {
            EcdsaAdaptorSignature::from_slice(bytes).map_err(|e| ContractError::Serialization {
                message: format!("invalid CET adaptor signature: {e}"),
            })
        })
        .collect::<Result<Vec<_>, ContractError>>()?;
    Ok((
        refund_signature,
        CetAdaptorSignatures::from(adaptor_signatures.as_slice()),
    ))
}

pub(crate) fn compact_signature(bytes: &[u8], what: &str) -> Result<Signature, ContractError> {
    Signature::from_compact(bytes).map_err(|e| ContractError::Serialization {
        message: format!("invalid {what} signature, expected 64-byte compact ECDSA: {e}"),
    })
}

/// Verifies `party`'s refund and CET adaptor signatures in `accept` (for the
/// accepting party) or the offering party's, which only a sign message holds.
fn verify_party_signatures(
    offer: &OfferDlc,
    accept: &AcceptDlc,
    party: Party,
) -> Result<(), ContractError> {
    Ok(advanced::verify_cet_adaptor_signatures(
        offer,
        accept,
        party,
        &accept.refund_signature,
        &accept.cet_adaptor_signatures,
    )?)
}

/// A transaction spending the 2-of-2 funding output as a PSBT, with the input's
/// `witness_utxo` and `witness_script` set so a signer can compute its sighash.
pub(crate) fn funding_spend_psbt(
    transactions: &ddk_dlc::DlcTransactions,
    transaction: &Transaction,
) -> Result<Vec<u8>, ContractError> {
    let mut psbt = unsigned_psbt(transaction)?;
    psbt.inputs[0].witness_utxo = Some(transactions.get_fund_output().clone());
    psbt.inputs[0].witness_script = Some(transactions.funding_witness_script.clone());
    Ok(psbt.serialize())
}

fn unsigned_psbt(transaction: &Transaction) -> Result<Psbt, ContractError> {
    Psbt::from_unsigned_tx(transaction.clone()).map_err(|e| ContractError::PsbtMismatch {
        message: format!("could not create PSBT: {e}"),
    })
}

fn ensure_psbt_spends(psbt: &Psbt, funding_transaction: &Transaction) -> Result<(), ContractError> {
    if psbt.unsigned_tx.compute_txid() != funding_transaction.compute_txid() {
        return Err(ContractError::PsbtMismatch {
            message: "the funding PSBT does not match the funding transaction rebuilt from the \
                      messages"
                .to_string(),
        });
    }
    Ok(())
}

fn finalized_witness(psbt: &Psbt, input_index: usize) -> Result<Witness, ContractError> {
    psbt.inputs
        .get(input_index)
        .and_then(|input| input.final_script_witness.clone())
        .filter(|witness| !witness.is_empty())
        .ok_or(ContractError::MissingFinalizedInput {
            input_index: input_index as u32,
        })
}

/// A funding input's position in the funding transaction: inputs are ordered
/// by ascending serial id across both parties.
fn funding_input_index(
    offer: &OfferDlc,
    accept: &AcceptDlc,
    input_serial_id: u64,
) -> Result<usize, ContractError> {
    let mut serial_ids = offer
        .funding_inputs
        .iter()
        .chain(&accept.funding_inputs)
        .map(|input| input.input_serial_id)
        .collect::<Vec<_>>();
    serial_ids.sort_unstable();
    serial_ids
        .binary_search(&input_serial_id)
        .map_err(|_| ContractError::InvalidFundingInput {
            message: format!("funding input serial id {input_serial_id} was not found"),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::tests::{
        attestation_ref, finalize_sign, offerer_signed_funding_psbt, sign_accept, signers,
        single_funded_offer, splice_fixture,
    };
    use crate::contract::{
        compute_contract_id, contract_cet_transaction, create_funding_psbt, to_array_32,
        validate_accept, validate_sign, ContractKeyProvider,
    };
    use secp256k1_zkp::{Message, SecretKey};

    /// Signs a request the way an external signer does: from its PSBTs,
    /// adaptor points and input indexes alone, never the messages. ECDSA here is
    /// RFC 6979 low-R, as in ddk, so its funding-transaction signatures are the
    /// same bytes the key-based path produces. Adaptor signatures also use
    /// deterministic nonces so complete messages can be compared byte-for-byte.
    struct RequestSigner {
        contract_key: SecretKey,
        /// The previous contract's key, for a splice.
        dlc_input_key: Option<SecretKey>,
    }

    impl RequestSigner {
        fn for_contract(keys: &ContractKeyProvider, temporary_contract_id: &[u8]) -> Self {
            let temp_id = to_array_32(temporary_contract_id, "temporary_contract_id").unwrap();
            RequestSigner {
                contract_key: keys.inner.funding_secret_key(temp_id).unwrap(),
                dlc_input_key: None,
            }
        }

        fn sign(&self, request: &SigningRequest) -> (ContractSignatures, Vec<DlcInputSignature>) {
            let secp = Secp256k1::new();
            let refund = Psbt::deserialize(&request.refund_psbt).unwrap();
            let refund_signature = secp
                .sign_ecdsa_low_r(&sighash(&refund, 0), &self.contract_key)
                .serialize_compact()
                .to_vec();
            let cet_adaptor_signatures = request
                .cets
                .iter()
                .map(|cet| {
                    let psbt = Psbt::deserialize(&cet.psbt).unwrap();
                    EcdsaAdaptorSignature::encrypt_no_aux_rand(
                        &secp,
                        &sighash(&psbt, 0),
                        &self.contract_key,
                        &PublicKey::from_slice(&cet.adaptor_point).unwrap(),
                    )
                    .as_ref()
                    .to_vec()
                })
                .collect();
            (
                ContractSignatures {
                    refund_signature,
                    cet_adaptor_signatures,
                },
                self.sign_splice(&request.splice),
            )
        }

        fn sign_splice(&self, request: &SpliceSigningRequest) -> Vec<DlcInputSignature> {
            let secp = Secp256k1::new();
            let funding = Psbt::deserialize(&request.funding_psbt).unwrap();
            request
                .dlc_inputs
                .iter()
                .map(|input| DlcInputSignature {
                    input_index: input.input_index,
                    signature: secp
                        .sign_ecdsa_low_r(
                            &sighash(&funding, input.input_index as usize),
                            self.dlc_input_key.as_ref().unwrap(),
                        )
                        .serialize_compact()
                        .to_vec(),
                })
                .collect()
        }
    }

    fn sighash(psbt: &Psbt, input_index: usize) -> Message {
        let input = &psbt.inputs[input_index];
        ddk_dlc::util::get_sig_hash_msg(
            &psbt.unsigned_tx,
            input_index,
            input.witness_script.as_ref().unwrap(),
            input.witness_utxo.as_ref().unwrap().value,
        )
        .unwrap()
    }

    fn sign_message(bytes: &[u8]) -> SignDlc {
        decode_msg(bytes, "sign").unwrap()
    }

    /// Both parties sign externally, and the contract is the one the key-based
    /// functions build: the same contract id and refund signature, a
    /// byte-identical funding transaction, and CETs either party can settle
    /// with the other's externally made adaptor signatures.
    #[test]
    fn an_external_signer_reproduces_the_key_based_contract() {
        let fixture = single_funded_offer();
        let offer = fixture.offer.clone();
        let acceptor = RequestSigner::for_contract(&fixture.acceptor_keys, &fixture.offer_temp_id);
        let offerer = RequestSigner::for_contract(&fixture.offerer_keys, &fixture.offer_temp_id);

        let request = prepare_accept_offer(offer.clone(), fixture.accept_params.clone())
            .unwrap()
            .request;
        assert_eq!(
            request.key.funding_pubkey,
            fixture.accept_params.party.funding_pubkey
        );
        assert_eq!(request.key.temporary_contract_id, fixture.offer_temp_id);
        assert_eq!(request.cets.len(), 2, "one per outcome of the one oracle");
        assert!(request.splice.dlc_inputs.is_empty());
        let (signatures, _) = acceptor.sign(&request);
        let accept = complete_accept_offer(
            prepare_accept_offer(offer.clone(), fixture.accept_params.clone())
                .unwrap()
                .context,
            signatures,
        )
        .unwrap()
        .accept;
        validate_accept(offer.clone(), accept.clone()).unwrap();
        assert_eq!(
            request.key.contract_id,
            compute_contract_id(offer.clone(), accept.clone()).unwrap()
        );

        let signed_psbt = offerer_signed_funding_psbt(&offer, &accept, &fixture.offerer_descriptor);
        let (signatures, _) = offerer.sign(
            &prepare_sign_accept(offer.clone(), accept.clone())
                .unwrap()
                .request,
        );
        let sign = complete_sign_accept(
            SigningContext {
                offer: offer.clone(),
                accept: accept.clone(),
            },
            SigningResponse {
                contract: signatures,
                signed_funding_psbt: signed_psbt.clone(),
                dlc_input_signatures: vec![],
            },
        )
        .unwrap()
        .sign;
        validate_sign(offer.clone(), accept.clone(), sign.clone()).unwrap();

        let unsigned_psbt = create_funding_psbt(offer.clone(), accept.clone()).unwrap();
        let funding_transaction = finalize_sign_with_signatures(
            offer.clone(),
            accept.clone(),
            sign.clone(),
            unsigned_psbt.clone(),
            vec![],
        )
        .unwrap();

        let key_sign = sign_accept(
            offer.clone(),
            accept.clone(),
            signers(
                fixture.offerer_keys.clone(),
                Some(&fixture.offerer_descriptor),
            ),
        )
        .unwrap()
        .sign;
        let key_funding_transaction = finalize_sign(
            offer.clone(),
            accept.clone(),
            key_sign.clone(),
            signers(fixture.acceptor_keys.clone(), None),
        )
        .unwrap();
        assert_eq!(funding_transaction, key_funding_transaction);
        assert_eq!(
            sign_message(&sign).contract_id,
            sign_message(&key_sign).contract_id
        );
        assert_eq!(
            sign_message(&sign).refund_signature,
            sign_message(&key_sign).refund_signature
        );

        // The contract settles from the externally made adaptor signatures.
        contract_cet_transaction(offer, accept, sign, vec![attestation_ref("up")]).unwrap();
    }

    /// DDK's peer signs a contract funded by both wallets. Finalization must
    /// accept its PSBT encoding, including the empty scriptSig of a wrapped
    /// SegWit input, and attach the accepting wallet's witness at its serial id.
    #[test]
    fn finalization_accepts_ddk_wallet_psbts_and_rejects_invalid_ones() {
        use crate::contract::encode_msg;
        use crate::signer::DescriptorWallet;
        use bitcoin::bip32::{DerivationPath, Xpriv};
        use bitcoin::{Amount, Network, ScriptBuf};
        use std::str::FromStr;

        for wrapped in [false, true] {
            let fixture = single_funded_offer();
            let mut offer: OfferDlc = decode_msg(&fixture.offer, "offer").unwrap();
            offer.offer_collateral = Amount::from_sat(50_000);
            let wallet = Xpriv::new_master(Network::Regtest, &[8; 64]).unwrap();
            let wallet_key = wallet
                .derive_priv(&Secp256k1::new(), &DerivationPath::from_str("0/0").unwrap())
                .unwrap()
                .to_priv()
                .public_key(&Secp256k1::new());
            let program = ScriptBuf::new_p2wpkh(&wallet_key.wpubkey_hash().unwrap());
            let mut previous: Transaction =
                bitcoin::consensus::deserialize(&offer.funding_inputs[0].prev_tx).unwrap();
            previous.output[0].script_pubkey = if wrapped {
                program.to_p2sh()
            } else {
                program.clone()
            };
            let input = ddk_contract::funding_input(
                &previous,
                0,
                Some(50),
                u32::MAX,
                108,
                if wrapped { program } else { ScriptBuf::new() },
            )
            .unwrap();
            let mut params = fixture.accept_params;
            params.party.funding_inputs = vec![encode_msg(&input)];
            let offer_bytes = encode_msg(&offer);
            let accepted = crate::contract::accept_offer(
                offer_bytes.clone(),
                params,
                signers(fixture.acceptor_keys, None),
            )
            .unwrap();
            let accept: AcceptDlc = decode_msg(&accepted.accept, "accept").unwrap();
            let offer_psbt = offerer_signed_funding_psbt(
                &offer_bytes,
                &accepted.accept,
                &fixture.offerer_descriptor,
            );
            // Produce the peer's message through DDK, independently of FFI's
            // offer-side completion, whose PSBT handling is a separate path.
            let peer_sign = ddk_contract::sign_accept(
                &offer,
                &accept,
                &fixture
                    .offerer_keys
                    .inner
                    .funding_secret_key(offer.temporary_contract_id)
                    .unwrap(),
                &Psbt::deserialize(&offer_psbt).unwrap(),
            )
            .unwrap()
            .sign;
            let descriptor = if wrapped {
                format!("sh(wpkh({wallet}/0/*))")
            } else {
                format!("wpkh({wallet}/0/*)")
            };
            let signed = futures::executor::block_on(
                DescriptorWallet::new(descriptor, 1000)
                    .unwrap()
                    .sign_funding_psbt(accepted.funding_psbt),
            )
            .unwrap();
            let psbt = Psbt::deserialize(&signed).unwrap();
            let finalize = |psbt: &Psbt| {
                finalize_sign_with_signatures(
                    offer_bytes.clone(),
                    accepted.accept.clone(),
                    encode_msg(&peer_sign),
                    psbt.serialize(),
                    vec![],
                )
            };
            let expected = ddk_contract::finalize_sign(&offer, &accept, &peer_sign, &psbt).unwrap();
            assert_eq!(
                finalize(&psbt).unwrap(),
                bitcoin::consensus::serialize(&expected),
                "wrapped SegWit: {wrapped}"
            );
            let mut mutated = psbt.clone();
            mutated.unsigned_tx.output[0].value += Amount::from_sat(1);
            assert!(matches!(
                finalize(&mutated),
                Err(ContractError::PsbtMismatch { .. })
            ));
            let mut missing = psbt;
            missing.inputs[0].final_script_witness = None;
            assert!(matches!(
                finalize(&missing),
                Err(ContractError::MissingFinalizedInput { input_index: 0 })
            ));
        }
    }

    /// A splice signed externally by both parties — each signer's half of the
    /// previous contract's 2-of-2 taken from the request's funding PSBT — is
    /// byte-for-byte the funding transaction the key-based path builds.
    #[test]
    fn an_external_signer_reproduces_the_key_based_splice() {
        let splice = splice_fixture();
        let offer: OfferDlc = decode_msg(&splice.offer_b, "offer").unwrap();
        let input = &offer.funding_inputs[0];
        let dlc_input = input.dlc_input.as_ref().unwrap();
        let prior_temp_id = to_array_32(&splice.prior_temp_id, "id").unwrap();
        let prior_key = |keys: &ContractKeyProvider, pubkey| {
            keys.inner
                .dlc_input_signing_key(prior_temp_id, pubkey, input.input_serial_id)
                .unwrap()
                .prior_funding_secret_key
        };
        let offerer = RequestSigner {
            dlc_input_key: Some(prior_key(
                &splice.offerer_keys,
                &dlc_input.local_fund_pubkey,
            )),
            ..RequestSigner::for_contract(&splice.offerer_keys, &offer.temporary_contract_id)
        };
        let acceptor = RequestSigner {
            dlc_input_key: Some(prior_key(
                &splice.acceptor_keys,
                &dlc_input.remote_fund_pubkey,
            )),
            ..RequestSigner::for_contract(&splice.acceptor_keys, &offer.temporary_contract_id)
        };

        // The accept request already lists the acceptor's splice halves; this
        // signer waits for the offerer's sign message and asks again.
        let prepared_accept =
            prepare_accept_offer(splice.offer_b.clone(), splice.accept_params_b.clone()).unwrap();
        let accept_request = &prepared_accept.request;
        assert_eq!(
            accept_request
                .splice
                .dlc_inputs
                .iter()
                .map(|input| input.input_index)
                .collect::<Vec<_>>(),
            vec![0]
        );
        let (accept_signatures, _) = acceptor.sign(accept_request);
        let accept = complete_accept_offer(prepared_accept.context, accept_signatures)
            .unwrap()
            .accept;
        assert_eq!(accept, splice.accept_b);

        let unsigned_psbt = create_funding_psbt(splice.offer_b.clone(), accept.clone()).unwrap();
        let sign_request = prepare_sign_accept(splice.offer_b.clone(), accept.clone())
            .unwrap()
            .request;
        let (signatures, offerer_halves) = offerer.sign(&sign_request);
        let sign = complete_sign_accept(
            SigningContext {
                offer: splice.offer_b.clone(),
                accept: accept.clone(),
            },
            SigningResponse {
                contract: signatures,
                signed_funding_psbt: unsigned_psbt.clone(),
                dlc_input_signatures: offerer_halves,
            },
        )
        .unwrap()
        .sign;
        let finalize_request =
            prepare_finalize_sign(splice.offer_b.clone(), accept.clone(), sign.clone()).unwrap();
        assert_eq!(
            finalize_request
                .dlc_inputs
                .iter()
                .map(|input| &input.key)
                .collect::<Vec<_>>(),
            accept_request
                .splice
                .dlc_inputs
                .iter()
                .map(|input| &input.key)
                .collect::<Vec<_>>()
        );
        let acceptor_halves = acceptor.sign_splice(&finalize_request);
        let funding_transaction = finalize_sign_with_signatures(
            splice.offer_b.clone(),
            accept,
            sign,
            unsigned_psbt.clone(),
            acceptor_halves,
        )
        .unwrap();

        let key_sign = sign_accept(
            splice.offer_b.clone(),
            splice.accept_b.clone(),
            signers(splice.offerer_keys.clone(), None),
        )
        .unwrap()
        .sign;
        let key_funding_transaction = finalize_sign(
            splice.offer_b,
            splice.accept_b,
            key_sign,
            signers(splice.acceptor_keys, None),
        )
        .unwrap();
        assert_eq!(funding_transaction, key_funding_transaction);
    }

    /// Every returned signature is checked before anything is built from it.
    #[test]
    fn signatures_from_the_wrong_key_are_rejected() {
        let fixture = single_funded_offer();
        let stranger = RequestSigner::for_contract(&fixture.offerer_keys, &[0x42; 32]);
        let request = prepare_accept_offer(fixture.offer.clone(), fixture.accept_params.clone())
            .unwrap()
            .request;
        let (signatures, _) = stranger.sign(&request);
        let result = complete_accept_offer(
            prepare_accept_offer(fixture.offer, fixture.accept_params)
                .unwrap()
                .context,
            signatures,
        );
        assert!(matches!(result, Err(ContractError::InvalidAccept { .. })));

        // A splice half from a key that is not the input's.
        let splice = splice_fixture();
        let offer: OfferDlc = decode_msg(&splice.offer_b, "offer").unwrap();
        let unsigned_psbt =
            create_funding_psbt(splice.offer_b.clone(), splice.accept_b.clone()).unwrap();
        let offerer = RequestSigner {
            dlc_input_key: Some(SecretKey::from_slice(&[7; 32]).unwrap()),
            ..RequestSigner::for_contract(&splice.offerer_keys, &offer.temporary_contract_id)
        };
        let (signatures, halves) = offerer.sign(
            &prepare_sign_accept(splice.offer_b.clone(), splice.accept_b.clone())
                .unwrap()
                .request,
        );
        let result = complete_sign_accept(
            SigningContext {
                offer: splice.offer_b,
                accept: splice.accept_b,
            },
            SigningResponse {
                contract: signatures,
                signed_funding_psbt: unsigned_psbt,
                dlc_input_signatures: halves,
            },
        );
        assert!(matches!(
            result,
            Err(ContractError::InvalidFundingInput { message }) if message.contains("invalid signature for DLC input 0")
        ));
    }

    #[test]
    fn invalid_peer_sign_never_reaches_the_accepting_signer() {
        struct MustNotSign;
        impl ContractSignerProvider for MustNotSign {
            fn get_signer(
                &self,
                _: ContractKeyRequest,
            ) -> Result<std::sync::Arc<dyn crate::signer::ContractSigner>, ContractError>
            {
                panic!("an invalid peer message must be rejected before key lookup")
            }
        }
        let splice = splice_fixture();
        let signed = sign_accept(
            splice.offer_b.clone(),
            splice.accept_b.clone(),
            signers(splice.offerer_keys, None),
        )
        .unwrap();
        let valid: SignDlc = decode_msg(&signed.sign, "sign").unwrap();
        let mut wrong_id = valid.clone();
        wrong_id.contract_id[0] ^= 1;
        let mut wrong_half = valid;
        wrong_half.funding_signatures.funding_signatures[0].witness_elements[0].witness = vec![0];
        for invalid in [wrong_id, wrong_half] {
            let request = prepare_finalize_sign(
                splice.offer_b.clone(),
                splice.accept_b.clone(),
                crate::contract::encode_msg(&invalid),
            );
            assert!(matches!(request, Err(ContractError::InvalidSign { .. })));
            let result = finalize_sign(
                splice.offer_b.clone(),
                splice.accept_b.clone(),
                crate::contract::encode_msg(&invalid),
                signers(std::sync::Arc::new(MustNotSign), None),
            );
            assert!(matches!(result, Err(ContractError::InvalidSign { .. })));
        }
    }

    /// Omitted serial ids are generated once and survive persisted preparation.
    #[test]
    fn prepared_accept_retains_generated_serial_ids() {
        let fixture = single_funded_offer();
        let mut params = fixture.accept_params;
        params.party.change_serial_id = None;
        params.party.payout_serial_id = None;
        let prepared = prepare_accept_offer(fixture.offer.clone(), params).unwrap();
        let signer = RequestSigner::for_contract(&fixture.acceptor_keys, &fixture.offer_temp_id);
        let unsigned: AcceptDlc = decode_msg(&prepared.context.accept, "prepared accept").unwrap();
        let (signatures, _) = signer.sign(&prepared.request);
        let accepted = complete_accept_offer(prepared.context, signatures).unwrap();
        let completed: AcceptDlc = decode_msg(&accepted.accept, "accept").unwrap();
        assert_eq!(unsigned.payout_serial_id, completed.payout_serial_id);
        assert_eq!(unsigned.change_serial_id, completed.change_serial_id);
        assert_eq!(prepared.request.splice.funding_psbt, accepted.funding_psbt);
        validate_accept(fixture.offer, accepted.accept).unwrap();
    }
}
