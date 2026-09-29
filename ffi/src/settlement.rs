//! Settlement from the messages alone.
//!
//! A CET spends the 2-of-2 funding output, so it needs both parties'
//! signatures, and both are already in the messages: each party's adaptor
//! signatures are its real signatures encrypted to the oracle outcome, the
//! acceptor's in the accept and the offerer's in the sign. The attestation's
//! secret decrypts both. The refund signatures are in the same messages in
//! the clear. Neither party needs a key to settle, and both build the same
//! transaction.
use crate::contract::{decode_msg, ContractError, OracleAttestationRef};
use bitcoin::sighash::EcdsaSighashType;
use bitcoin::{Transaction, Witness};
use ddk::contract as ddk_contract;
use ddk::ddk_manager::contract::execution_contract_infos;
use ddk_messages::{AcceptDlc, OfferDlc, SignDlc};
use secp256k1_zkp::{ecdsa::Signature, EcdsaAdaptorSignature, Secp256k1};

struct Settlement {
    offer: OfferDlc,
    accept: AcceptDlc,
    sign: SignDlc,
    transactions: ddk_dlc::DlcTransactions,
}

impl Settlement {
    /// Rebuilds the contract's transactions, under the old fee rule when the
    /// sign message's contract id says the contract was made under it.
    fn new(offer: &[u8], accept: &[u8], sign: &[u8]) -> Result<Self, ContractError> {
        let offer: OfferDlc = decode_msg(offer, "offer")?;
        let accept: AcceptDlc = decode_msg(accept, "accept")?;
        let sign: SignDlc = decode_msg(sign, "sign")?;
        let transactions = ddk_contract::create_signed_dlc_transactions(&offer, &accept, &sign)?;
        Ok(Self {
            offer,
            accept,
            sign,
            transactions,
        })
    }

    /// The CET the attestations select, with both parties' signatures of it
    /// decrypted from their adaptor signatures.
    fn cet(
        &self,
        attestations: Vec<OracleAttestationRef>,
    ) -> Result<(Transaction, Signature, Signature), ContractError> {
        let attestations = attestations
            .into_iter()
            .map(OracleAttestationRef::into_rust)
            .collect::<Result<Vec<_>, _>>()?;
        let offer_signatures: Vec<EcdsaAdaptorSignature> =
            (&self.sign.cet_adaptor_signatures).into();
        let accept_signatures: Vec<EcdsaAdaptorSignature> =
            (&self.accept.cet_adaptor_signatures).into();
        let secp = Secp256k1::new();
        let infos = execution_contract_infos(&self.offer.contract_info).map_err(dlc_error)?;
        let total = self.offer.get_total_collateral();
        let script = &self.transactions.funding_witness_script;
        let value = self.transactions.get_fund_output().value;
        let mut cet_start = 0;
        let mut signature_index = 0;
        for info in infos {
            let cet_end = cet_start + info.get_payouts(total).map_err(dlc_error)?.len();
            let cets = &self.transactions.cets[cet_start..cet_end];
            let (adaptor_info, next_index) = info
                .verify_and_get_adaptor_info(
                    &secp,
                    total,
                    &self.offer.funding_pubkey,
                    script,
                    value,
                    cets,
                    &offer_signatures,
                    signature_index,
                )
                .map_err(|e| ContractError::InvalidSign {
                    message: format!("invalid CET adaptor signatures: {e}"),
                })?;
            info.verify_and_get_adaptor_info(
                &secp,
                total,
                &self.accept.funding_pubkey,
                script,
                value,
                cets,
                &accept_signatures,
                signature_index,
            )
            .map_err(|e| ContractError::InvalidAccept {
                message: format!("invalid CET adaptor signatures: {e}"),
            })?;
            let resolved = info
                .get_range_info_and_oracle_signatures(&adaptor_info, &attestations, signature_index)
                .map_err(|e| ContractError::InvalidAttestation {
                    message: e.to_string(),
                })?;
            if let Some((range, oracle_signatures)) = resolved {
                for (index, attestation) in &attestations {
                    let announcement = info.oracle_announcements.get(*index).ok_or_else(|| {
                        ContractError::InvalidAttestation {
                            message: format!("unknown oracle index {index}"),
                        }
                    })?;
                    attestation.validate(&secp, announcement).map_err(|e| {
                        ContractError::InvalidAttestation {
                            message: e.to_string(),
                        }
                    })?;
                }
                let secret = crate::signatures_to_secret(&oracle_signatures).map_err(dlc_error)?;
                let offer_signature = offer_signatures[range.adaptor_index]
                    .decrypt(&secret)
                    .map_err(dlc_error)?;
                let accept_signature = accept_signatures[range.adaptor_index]
                    .decrypt(&secret)
                    .map_err(dlc_error)?;
                return Ok((
                    cets[range.cet_index].clone(),
                    offer_signature,
                    accept_signature,
                ));
            }
            cet_start = cet_end;
            signature_index = next_index;
        }
        Err(ContractError::NoMatchingOutcome)
    }

    /// Verifies both signatures of `transaction` against the funding keys the
    /// messages published and assembles its witness.
    fn complete(
        &self,
        mut transaction: Transaction,
        offer_signature: Signature,
        accept_signature: Signature,
    ) -> Result<Vec<u8>, ContractError> {
        let secp = Secp256k1::new();
        let script = &self.transactions.funding_witness_script;
        let value = self.transactions.get_fund_output().value;
        let offer_pubkey = &self.offer.funding_pubkey;
        let accept_pubkey = &self.accept.funding_pubkey;
        ddk_dlc::verify_tx_input_sig(
            &secp,
            &offer_signature,
            &transaction,
            0,
            script,
            value,
            offer_pubkey,
        )
        .map_err(|e| ContractError::InvalidSign {
            message: format!("invalid settlement signature: {e}"),
        })?;
        ddk_dlc::verify_tx_input_sig(
            &secp,
            &accept_signature,
            &transaction,
            0,
            script,
            value,
            accept_pubkey,
        )
        .map_err(|e| ContractError::InvalidAccept {
            message: format!("invalid settlement signature: {e}"),
        })?;
        let offer_signature = ddk_dlc::util::finalize_sig(&offer_signature, EcdsaSighashType::All);
        let accept_signature =
            ddk_dlc::util::finalize_sig(&accept_signature, EcdsaSighashType::All);
        let (first, second) = if offer_pubkey.serialize() < accept_pubkey.serialize() {
            (offer_signature, accept_signature)
        } else {
            (accept_signature, offer_signature)
        };
        transaction.input[0].witness =
            Witness::from_slice(&[vec![], first, second, script.as_bytes().to_vec()]);
        Ok(bitcoin::consensus::serialize(&transaction))
    }
}

fn dlc_error(error: impl std::fmt::Display) -> ContractError {
    ContractError::Dlc {
        message: error.to_string(),
    }
}

/// The signed CET the attestations select, consensus serialized and ready to
/// broadcast. Validates the attestations against the contract's announcements
/// and both parties' adaptor signatures against their funding keys; either
/// party builds the same transaction. Rebuilds a contract created before
/// ddk-dlc 2.0.0-rc.4 using the sign message.
#[uniffi::export]
pub fn contract_cet_transaction(
    offer: Vec<u8>,
    accept: Vec<u8>,
    sign: Vec<u8>,
    attestations: Vec<OracleAttestationRef>,
) -> Result<Vec<u8>, ContractError> {
    let settlement = Settlement::new(&offer, &accept, &sign)?;
    let (cet, offer_signature, accept_signature) = settlement.cet(attestations)?;
    settlement.complete(cet, offer_signature, accept_signature)
}

/// The signed refund, consensus serialized and ready to broadcast once its
/// locktime passes, from the refund signatures in the accept and sign messages.
#[uniffi::export]
pub fn contract_refund_transaction(
    offer: Vec<u8>,
    accept: Vec<u8>,
    sign: Vec<u8>,
) -> Result<Vec<u8>, ContractError> {
    let settlement = Settlement::new(&offer, &accept, &sign)?;
    settlement.complete(
        settlement.transactions.refund.clone(),
        settlement.sign.refund_signature,
        settlement.accept.refund_signature,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::tests::{
        attestation_ref, offerer_signed_funding_psbt, single_funded_offer,
    };
    use crate::contract::{accept_offer, encode_msg, sign_accept};
    use secp256k1_zkp::PublicKey;

    fn signed_contract() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let fixture = single_funded_offer();
        let accept = accept_offer(
            fixture.offer.clone(),
            fixture.accept_params.clone(),
            fixture.acceptor_keys.clone(),
        )
        .unwrap()
        .accept;
        let psbt =
            offerer_signed_funding_psbt(&fixture.offer, &accept, &fixture.offerer_descriptor);
        let sign = sign_accept(
            fixture.offer.clone(),
            accept.clone(),
            fixture.offerer_keys,
            psbt,
        )
        .unwrap()
        .sign;
        (fixture.offer, accept, sign)
    }

    /// Checks a settlement transaction's witness the way a node does: two
    /// signatures over the funding output that verify against the two
    /// published funding keys.
    fn assert_spends_funding_output(
        transaction: &[u8],
        offer: &[u8],
        accept: &[u8],
        sign: &[u8],
    ) -> Transaction {
        let transaction: Transaction = bitcoin::consensus::deserialize(transaction).unwrap();
        let settlement = Settlement::new(offer, accept, sign).unwrap();
        let fund_txid = settlement.transactions.fund.compute_txid();
        assert_eq!(transaction.input[0].previous_output.txid, fund_txid);
        let witness = &transaction.input[0].witness;
        assert_eq!(witness.len(), 4, "OP_0, two signatures, witness script");
        assert_eq!(
            witness.nth(3).unwrap(),
            settlement.transactions.funding_witness_script.as_bytes()
        );
        let secp = Secp256k1::new();
        let mut keys: Vec<PublicKey> = vec![
            settlement.offer.funding_pubkey,
            settlement.accept.funding_pubkey,
        ];
        keys.sort_by_key(|key| key.serialize());
        for (element, key) in [witness.nth(1).unwrap(), witness.nth(2).unwrap()]
            .into_iter()
            .zip(keys)
        {
            let (der, sighash_type) = element.split_at(element.len() - 1);
            assert_eq!(sighash_type, [EcdsaSighashType::All as u8]);
            let signature = Signature::from_der(der).unwrap();
            ddk_dlc::verify_tx_input_sig(
                &secp,
                &signature,
                &transaction,
                0,
                &settlement.transactions.funding_witness_script,
                settlement.transactions.get_fund_output().value,
                &key,
            )
            .unwrap();
        }
        transaction
    }

    /// No key is involved: both CET signatures decrypt from the adaptor
    /// signatures the messages carry, and the refund signatures are read from
    /// them directly.
    #[test]
    fn settlement_needs_only_the_messages_and_the_attestation() {
        let (offer, accept, sign) = signed_contract();
        let cet = contract_cet_transaction(
            offer.clone(),
            accept.clone(),
            sign.clone(),
            vec![attestation_ref("up")],
        )
        .unwrap();
        let cet = assert_spends_funding_output(&cet, &offer, &accept, &sign);
        let settlement = Settlement::new(&offer, &accept, &sign).unwrap();
        assert_eq!(
            cet.compute_txid(),
            settlement.transactions.cets[0].compute_txid()
        );

        let down = contract_cet_transaction(
            offer.clone(),
            accept.clone(),
            sign.clone(),
            vec![attestation_ref("down")],
        )
        .unwrap();
        let down = assert_spends_funding_output(&down, &offer, &accept, &sign);
        assert_eq!(
            down.compute_txid(),
            settlement.transactions.cets[1].compute_txid()
        );

        let refund =
            contract_refund_transaction(offer.clone(), accept.clone(), sign.clone()).unwrap();
        let refund = assert_spends_funding_output(&refund, &offer, &accept, &sign);
        assert_eq!(
            refund.compute_txid(),
            settlement.transactions.refund.compute_txid()
        );
    }

    /// Each party's signatures are checked against its published key before a
    /// transaction is built, and the error names the message at fault.
    #[test]
    fn settlement_verifies_both_parties_signatures() {
        let (offer, accept, sign) = signed_contract();

        let mut wrong_refund: AcceptDlc = decode_msg(&accept, "accept").unwrap();
        wrong_refund.refund_signature = decode_msg::<SignDlc>(&sign, "sign")
            .unwrap()
            .refund_signature;
        let result =
            contract_refund_transaction(offer.clone(), encode_msg(&wrong_refund), sign.clone());
        assert!(matches!(result, Err(ContractError::InvalidAccept { .. })));

        let mut wrong_adaptor: SignDlc = decode_msg(&sign, "sign").unwrap();
        wrong_adaptor.cet_adaptor_signatures = decode_msg::<AcceptDlc>(&accept, "accept")
            .unwrap()
            .cet_adaptor_signatures;
        let result = contract_cet_transaction(
            offer,
            accept,
            encode_msg(&wrong_adaptor),
            vec![attestation_ref("up")],
        );
        assert!(matches!(result, Err(ContractError::InvalidSign { .. })));
    }
}
