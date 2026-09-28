//! External signing: for a contract key held by a signer that cannot answer
//! inside the call, such as a custody vault that needs a person to approve.
//!
//! Each step that signs with the contract key is a pair. `*_request` returns
//! what this party must sign — PSBTs, because that is what such signers take
//! and what shows the approver what they are signing. `*_with_signatures`
//! takes the signatures back, verifies every one against the messages, and
//! produces the same result as the key-based function. The messages are the
//! only state between the two calls.
//!
//! The contract key signs the refund, one adaptor signature per CET and oracle
//! combination, and — when the offer splices a previous contract — this
//! party's half of that contract's 2-of-2. Wallet inputs are signed as in the
//! key-based flow, through the funding PSBT.
//!
//! Enum-outcome contracts only: a numeric-outcome contract's adaptor points
//! come from its digit trie, which is not exposed yet
//! ([`ContractError::Unsupported`]).

use bitcoin::psbt::Psbt;
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
#[derive(uniffi::Record)]
pub struct CetSigningRequest {
    /// The CET as a BIP-174 PSBT spending the 2-of-2 funding output, with its
    /// `witness_utxo` and `witness_script` set.
    pub psbt: Vec<u8>,
    /// The 33-byte point the signature is encrypted to: the oracle outcome
    /// this CET pays out on.
    pub adaptor_point: Vec<u8>,
}

/// Everything one party signs with its contract key in one step.
#[derive(uniffi::Record)]
pub struct SigningRequest {
    /// The 33-byte funding public key every refund and CET signature must
    /// verify against: this party's, from the messages.
    pub funding_pubkey: Vec<u8>,
    /// The refund transaction as a PSBT spending the 2-of-2 funding output,
    /// with its `witness_utxo` and `witness_script` set.
    pub refund_psbt: Vec<u8>,
    /// One entry per adaptor signature, in the order they are returned.
    pub cets: Vec<CetSigningRequest>,
    /// The funding transaction as a PSBT. Splice (DLC) inputs carry their
    /// `witness_utxo` and 2-of-2 `witness_script` here, unlike in
    /// `create_funding_psbt`, so a signer can produce this party's half.
    pub funding_psbt: Vec<u8>,
    /// The funding transaction input indexes of the splice (DLC) inputs this
    /// party signs a half of. Empty unless the offer splices a contract.
    pub dlc_input_indexes: Vec<u32>,
}

/// A signer's answer to a [`SigningRequest`]'s refund and CETs.
#[derive(uniffi::Record)]
pub struct ContractSignatures {
    /// The 64-byte compact (R‖S) ECDSA signature of the refund, SIGHASH_ALL.
    pub refund_signature: Vec<u8>,
    /// The 162-byte ECDSA adaptor signatures, in the request's `cets` order.
    pub cet_adaptor_signatures: Vec<Vec<u8>>,
}

/// A signer's half of one splice (DLC) input's 2-of-2.
#[derive(uniffi::Record)]
pub struct DlcInputSignature {
    /// The funding transaction input index, from the request's
    /// `dlc_input_indexes`.
    pub input_index: u32,
    /// The 64-byte compact (R‖S) ECDSA signature, SIGHASH_ALL.
    pub signature: Vec<u8>,
}

/// What the accepting party signs to accept `offer` with `params`.
///
/// `params.party` must fix `payout_serial_id` and `change_serial_id`: they
/// place outputs in every transaction signed here, so this and
/// [`accept_offer_with_signatures`] must be given the same values.
#[uniffi::export]
pub fn accept_offer_request(
    offer: Vec<u8>,
    params: AcceptOfferParams,
) -> Result<SigningRequest, ContractError> {
    let offer: OfferDlc = decode_msg(&offer, "offer")?;
    let accept = unsigned_accept(&offer, params)?;
    signing_request(&offer, &accept, Party::Accept)
}

/// Completes [`accept_offer_request`] into the same result as `accept_offer`.
#[uniffi::export]
pub fn accept_offer_with_signatures(
    offer: Vec<u8>,
    params: AcceptOfferParams,
    signatures: ContractSignatures,
) -> Result<AcceptResult, ContractError> {
    let offer: OfferDlc = decode_msg(&offer, "offer")?;
    let mut accept = unsigned_accept(&offer, params)?;
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

/// What the offering party signs to answer `accept`. The accept message's
/// signatures are verified first, so nothing is signed for an invalid accept.
#[uniffi::export]
pub fn sign_accept_request(
    offer: Vec<u8>,
    accept: Vec<u8>,
) -> Result<SigningRequest, ContractError> {
    let offer: OfferDlc = decode_msg(&offer, "offer")?;
    let accept: AcceptDlc = decode_msg(&accept, "accept")?;
    verify_party_signatures(&offer, &accept, Party::Accept)?;
    signing_request(&offer, &accept, Party::Offer)
}

/// Completes [`sign_accept_request`] into the same result as `sign_accept`.
///
/// `signed_funding_psbt` carries finalized witnesses for the offering party's
/// wallet inputs, as for `sign_accept`. `dlc_input_signatures` carries this
/// party's half of each splice input; omit it otherwise.
#[uniffi::export(default(dlc_input_signatures))]
pub fn sign_accept_with_signatures(
    offer: Vec<u8>,
    accept: Vec<u8>,
    signatures: ContractSignatures,
    signed_funding_psbt: Vec<u8>,
    dlc_input_signatures: Vec<DlcInputSignature>,
) -> Result<SignResult, ContractError> {
    let offer: OfferDlc = decode_msg(&offer, "offer")?;
    let accept: AcceptDlc = decode_msg(&accept, "accept")?;
    verify_party_signatures(&offer, &accept, Party::Accept)?;

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
/// half of each splice input taken from `dlc_input_signatures` (the
/// accept step's request lists their indexes) rather than derived from keys.
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

    if sign.protocol_version != offer.protocol_version {
        return Err(ContractError::InvalidSign {
            message: "offer and sign protocol versions differ".to_string(),
        });
    }
    if sign.contract_id != advanced::compute_contract_id(&offer, &accept)? {
        return Err(ContractError::InvalidSign {
            message: "sign message contract id does not match the rebuilt funding transaction"
                .to_string(),
        });
    }
    advanced::verify_cet_adaptor_signatures(
        &offer,
        &accept,
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

    let transactions = ddk_contract::create_dlc_transactions(&offer, &accept)?;
    let psbt = decode_psbt(&signed_funding_psbt)?;
    ensure_psbt_spends(&psbt, &transactions.fund)?;
    let mut dlc_signatures = DlcInputSignatures::decode(dlc_input_signatures)?;

    // Splice halves sign the unsigned transaction: a SegWit sighash does not
    // commit to the other inputs' witnesses.
    let unsigned = &transactions.fund;
    let mut funding_transaction = transactions.fund.clone();
    let secp = Secp256k1::verification_only();
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
                let offer_half =
                    elements
                        .first()
                        .cloned()
                        .ok_or_else(|| ContractError::InvalidSign {
                            message: format!("DLC input {input_index} funding signature is empty"),
                        })?;
                ddk_dlc::dlc_input::verify_dlc_funding_input_signature(
                    &secp,
                    unsigned,
                    input_index,
                    &dlc_input_info,
                    offer_half.clone(),
                    &dlc_input.local_fund_pubkey,
                )
                .map_err(|e| ContractError::InvalidSign {
                    message: format!("invalid signature for DLC input {input_index}: {e}"),
                })?;
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
            None if elements.is_empty() => {
                return Err(ContractError::InvalidSign {
                    message: format!("funding signature for input {input_index} is empty"),
                })
            }
            None => Witness::from_slice(&elements),
        };
    }
    for input in &accept.funding_inputs {
        let input_index = funding_input_index(&offer, &accept, input.input_serial_id)?;
        funding_transaction.input[input_index].witness = finalized_witness(&psbt, input_index)?;
    }
    dlc_signatures.ensure_all_used()?;

    Ok(bitcoin::consensus::serialize(&funding_transaction))
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

    let (Some(payout_serial_id), Some(change_serial_id)) =
        (party.payout_serial_id, party.change_serial_id)
    else {
        return Err(ContractError::InvalidAccept {
            message: "external signing needs payout_serial_id and change_serial_id set, so the \
                      request and the signed accept build the same transactions"
                .to_string(),
        });
    };
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
        // Replaced before the message is encoded or verified; the rebuilt
        // transactions do not depend on it.
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
    let fund_output = transactions.get_fund_output().clone();
    let spend_psbt = |transaction: &Transaction| -> Result<Vec<u8>, ContractError> {
        let mut psbt = unsigned_psbt(transaction)?;
        psbt.inputs[0].witness_utxo = Some(fund_output.clone());
        psbt.inputs[0].witness_script = Some(transactions.funding_witness_script.clone());
        Ok(psbt.serialize())
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
                psbt: spend_psbt(cet)?,
                adaptor_point: adaptor_point.serialize().to_vec(),
            })
        })
        .collect::<Result<Vec<_>, ContractError>>()?;

    // Both parties sign a half of every splice input, so both get the same
    // indexes.
    let mut funding_psbt = ddk_contract::create_funding_psbt(offer, accept)?;
    let mut dlc_input_indexes = Vec::new();
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
        dlc_input_indexes.push(input_index as u32);
    }

    Ok(SigningRequest {
        funding_pubkey: funding_pubkey.serialize().to_vec(),
        refund_psbt: spend_psbt(&transactions.refund)?,
        cets,
        funding_psbt: funding_psbt.serialize(),
        dlc_input_indexes,
    })
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

fn compact_signature(bytes: &[u8], what: &str) -> Result<Signature, ContractError> {
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
        attestation_ref, offerer_signed_funding_psbt, single_funded_offer, splice_fixture,
    };
    use crate::contract::{
        create_funding_psbt, finalize_sign, sign_accept, sign_contract_cet, to_array_32,
        validate_accept, validate_sign, ContractKeyProvider,
    };
    use secp256k1_zkp::{Message, SecretKey};

    /// Signs a request the way an external signer does: from its PSBTs,
    /// adaptor points and input indexes alone, never the messages. ECDSA here is
    /// RFC 6979 low-R, as in ddk, so its funding-transaction signatures are the
    /// same bytes the key-based path produces.
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
                    let input = &psbt.inputs[0];
                    ddk_dlc::create_cet_adaptor_sig_from_point(
                        &secp,
                        &psbt.unsigned_tx,
                        &PublicKey::from_slice(&cet.adaptor_point).unwrap(),
                        &self.contract_key,
                        input.witness_script.as_ref().unwrap(),
                        input.witness_utxo.as_ref().unwrap().value,
                    )
                    .unwrap()
                    .as_ref()
                    .to_vec()
                })
                .collect();
            let funding = Psbt::deserialize(&request.funding_psbt).unwrap();
            let dlc_input_signatures = request
                .dlc_input_indexes
                .iter()
                .map(|&input_index| DlcInputSignature {
                    input_index,
                    signature: secp
                        .sign_ecdsa_low_r(
                            &sighash(&funding, input_index as usize),
                            self.dlc_input_key.as_ref().unwrap(),
                        )
                        .serialize_compact()
                        .to_vec(),
                })
                .collect();
            (
                ContractSignatures {
                    refund_signature,
                    cet_adaptor_signatures,
                },
                dlc_input_signatures,
            )
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
        let acceptor = RequestSigner::for_contract(&fixture.acceptor_keys, &fixture.accept_temp_id);
        let offerer = RequestSigner::for_contract(&fixture.offerer_keys, &fixture.offer_temp_id);

        let request = accept_offer_request(offer.clone(), fixture.accept_params.clone()).unwrap();
        assert_eq!(
            request.funding_pubkey,
            fixture.accept_params.party.funding_pubkey
        );
        assert_eq!(request.cets.len(), 2, "one per outcome of the one oracle");
        assert!(request.dlc_input_indexes.is_empty());
        let (signatures, _) = acceptor.sign(&request);
        let accept =
            accept_offer_with_signatures(offer.clone(), fixture.accept_params.clone(), signatures)
                .unwrap()
                .accept;
        validate_accept(offer.clone(), accept.clone()).unwrap();

        let signed_psbt = offerer_signed_funding_psbt(&offer, &accept, &fixture.offerer_descriptor);
        let (signatures, _) =
            offerer.sign(&sign_accept_request(offer.clone(), accept.clone()).unwrap());
        let sign = sign_accept_with_signatures(
            offer.clone(),
            accept.clone(),
            signatures,
            signed_psbt.clone(),
            vec![],
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
            fixture.offerer_keys.clone(),
            signed_psbt,
            vec![],
        )
        .unwrap()
        .sign;
        let key_funding_transaction = finalize_sign(
            offer.clone(),
            accept.clone(),
            key_sign.clone(),
            unsigned_psbt,
            fixture.acceptor_keys.clone(),
            vec![],
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

        // Each settles with the counterparty's adaptor signature, which was
        // made externally.
        for (keys, temp_id) in [
            (fixture.offerer_keys, fixture.offer_temp_id),
            (fixture.acceptor_keys, fixture.accept_temp_id),
        ] {
            sign_contract_cet(
                offer.clone(),
                accept.clone(),
                sign.clone(),
                keys,
                temp_id,
                vec![attestation_ref("up")],
            )
            .unwrap();
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
        let prior_temp_id = to_array_32(&splice.spliced_a.temporary_contract_id, "id").unwrap();
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

        // The acceptor signs its half at the accept step, as a vault does,
        // and keeps it for finalize.
        let accept_request =
            accept_offer_request(splice.offer_b.clone(), splice.accept_params_b.clone()).unwrap();
        assert_eq!(accept_request.dlc_input_indexes, vec![0]);
        let (_, acceptor_halves) = acceptor.sign(&accept_request);

        let unsigned_psbt =
            create_funding_psbt(splice.offer_b.clone(), splice.accept_b.clone()).unwrap();
        let sign_request =
            sign_accept_request(splice.offer_b.clone(), splice.accept_b.clone()).unwrap();
        let (signatures, offerer_halves) = offerer.sign(&sign_request);
        let sign = sign_accept_with_signatures(
            splice.offer_b.clone(),
            splice.accept_b.clone(),
            signatures,
            unsigned_psbt.clone(),
            offerer_halves,
        )
        .unwrap()
        .sign;
        let funding_transaction = finalize_sign_with_signatures(
            splice.offer_b.clone(),
            splice.accept_b.clone(),
            sign,
            unsigned_psbt.clone(),
            acceptor_halves,
        )
        .unwrap();

        let key_sign = sign_accept(
            splice.offer_b.clone(),
            splice.accept_b.clone(),
            splice.offerer_keys.clone(),
            unsigned_psbt.clone(),
            vec![splice.spliced_a.clone()],
        )
        .unwrap()
        .sign;
        let key_funding_transaction = finalize_sign(
            splice.offer_b,
            splice.accept_b,
            key_sign,
            unsigned_psbt,
            splice.acceptor_keys,
            vec![splice.spliced_a],
        )
        .unwrap();
        assert_eq!(funding_transaction, key_funding_transaction);
    }

    /// Every returned signature is checked before anything is built from it.
    #[test]
    fn signatures_from_the_wrong_key_are_rejected() {
        let fixture = single_funded_offer();
        let stranger = RequestSigner::for_contract(&fixture.offerer_keys, &fixture.accept_temp_id);
        let request =
            accept_offer_request(fixture.offer.clone(), fixture.accept_params.clone()).unwrap();
        let (signatures, _) = stranger.sign(&request);
        let result = accept_offer_with_signatures(fixture.offer, fixture.accept_params, signatures);
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
        let (signatures, halves) = offerer
            .sign(&sign_accept_request(splice.offer_b.clone(), splice.accept_b.clone()).unwrap());
        let result = sign_accept_with_signatures(
            splice.offer_b,
            splice.accept_b,
            signatures,
            unsigned_psbt,
            halves,
        );
        assert!(matches!(
            result,
            Err(ContractError::InvalidFundingInput { message }) if message.contains("invalid signature for DLC input 0")
        ));
    }

    /// The request and the signed accept are two calls; without fixed serial
    /// ids they would describe different transactions.
    #[test]
    fn accepting_externally_needs_fixed_serial_ids() {
        let fixture = single_funded_offer();
        let mut params = fixture.accept_params;
        params.party.change_serial_id = None;
        let result = accept_offer_request(fixture.offer, params);
        assert!(matches!(result, Err(ContractError::InvalidAccept { .. })));
    }
}
