//! Settlement using the same consumer-owned signers as contract creation.
use crate::contract::{decode_msg, ContractError, OracleAttestationRef, Party};
use crate::signer::{ContractKeyRequest, ContractSignerProvider};
use bitcoin::sighash::EcdsaSighashType;
use bitcoin::{Transaction, Witness};
use ddk::contract as ddk_contract;
use ddk::ddk_manager::contract::execution_contract_infos;
use ddk_messages::{AcceptDlc, OfferDlc, SignDlc};
use secp256k1_zkp::{ecdsa::Signature, EcdsaAdaptorSignature, PublicKey, Secp256k1};
use std::sync::Arc;

struct Settlement {
    offer: OfferDlc,
    accept: AcceptDlc,
    sign: SignDlc,
    transactions: ddk_dlc::DlcTransactions,
    local: PublicKey,
    remote: PublicKey,
    party: Party,
}

impl Settlement {
    fn new(
        offer: Vec<u8>,
        accept: Vec<u8>,
        sign: Vec<u8>,
        party: Party,
    ) -> Result<Self, ContractError> {
        let offer: OfferDlc = decode_msg(&offer, "offer")?;
        let accept: AcceptDlc = decode_msg(&accept, "accept")?;
        let sign: SignDlc = decode_msg(&sign, "sign")?;
        let transactions = ddk_contract::create_signed_dlc_transactions(&offer, &accept, &sign)?;
        let (local, remote) = match party {
            Party::Offer => (offer.funding_pubkey, accept.funding_pubkey),
            Party::Accept => (accept.funding_pubkey, offer.funding_pubkey),
        };
        Ok(Self {
            offer,
            accept,
            sign,
            transactions,
            local,
            remote,
            party,
        })
    }

    fn peer_error(&self, message: String) -> ContractError {
        match self.party {
            Party::Offer => ContractError::InvalidAccept { message },
            Party::Accept => ContractError::InvalidSign { message },
        }
    }

    fn complete(
        &self,
        mut transaction: Transaction,
        remote: Signature,
        provider: &dyn ContractSignerProvider,
    ) -> Result<Vec<u8>, ContractError> {
        let secp = Secp256k1::new();
        let script = &self.transactions.funding_witness_script;
        let value = self.transactions.get_fund_output().value;
        ddk_dlc::verify_tx_input_sig(&secp, &remote, &transaction, 0, script, value, &self.remote)
            .map_err(|e| self.peer_error(format!("invalid settlement signature: {e}")))?;
        let signer = provider.get_signer(ContractKeyRequest {
            funding_pubkey: self.local.serialize().to_vec(),
            contract_id: Some(self.sign.contract_id.to_vec()),
        })?;
        let sighash =
            ddk_dlc::util::get_sig_hash_msg(&transaction, 0, script, value).map_err(dlc_error)?;
        let signature = signer.sign_ecdsa(sighash.as_ref().to_vec())?;
        let local = Signature::from_compact(&signature).map_err(|e| ContractError::Key {
            message: e.to_string(),
        })?;
        secp.verify_ecdsa(&sighash, &local, &self.local)
            .map_err(|e| ContractError::Key {
                message: format!("invalid settlement signature from provider: {e}"),
            })?;
        let local = ddk_dlc::util::finalize_sig(&local, EcdsaSighashType::All);
        let remote = ddk_dlc::util::finalize_sig(&remote, EcdsaSighashType::All);
        let (first, second) = if self.local.serialize() < self.remote.serialize() {
            (local, remote)
        } else {
            (remote, local)
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

/// Sign the refund with the local party's provider. Rebuilds old fee-rule
/// contracts using the sign message and verifies the peer's stored signature.
#[uniffi::export]
pub fn sign_contract_refund(
    offer: Vec<u8>,
    accept: Vec<u8>,
    sign: Vec<u8>,
    signers: Arc<dyn ContractSignerProvider>,
    party: Party,
) -> Result<Vec<u8>, ContractError> {
    let context = Settlement::new(offer, accept, sign, party)?;
    let remote = match context.party {
        Party::Offer => context.accept.refund_signature,
        Party::Accept => context.sign.refund_signature,
    };
    context.complete(
        context.transactions.refund.clone(),
        remote,
        signers.as_ref(),
    )
}

/// Resolve and validate oracle attestations, decrypt the peer's adaptor
/// signature, and request the local signature from the provider.
#[uniffi::export]
pub fn sign_contract_cet(
    offer: Vec<u8>,
    accept: Vec<u8>,
    sign: Vec<u8>,
    signers: Arc<dyn ContractSignerProvider>,
    party: Party,
    attestations: Vec<OracleAttestationRef>,
) -> Result<Vec<u8>, ContractError> {
    let context = Settlement::new(offer, accept, sign, party)?;
    let attestations = attestations
        .into_iter()
        .map(OracleAttestationRef::into_rust)
        .collect::<Result<Vec<_>, _>>()?;
    let signatures: Vec<EcdsaAdaptorSignature> = match context.party {
        Party::Offer => (&context.accept.cet_adaptor_signatures).into(),
        Party::Accept => (&context.sign.cet_adaptor_signatures).into(),
    };
    let secp = Secp256k1::new();
    let infos = execution_contract_infos(&context.offer.contract_info).map_err(dlc_error)?;
    let total = context.offer.get_total_collateral();
    let mut cet_start = 0;
    let mut signature_index = 0;
    for info in infos {
        let cet_end = cet_start + info.get_payouts(total).map_err(dlc_error)?.len();
        let (adaptor_info, next_index) = info
            .verify_and_get_adaptor_info(
                &secp,
                total,
                &context.remote,
                &context.transactions.funding_witness_script,
                context.transactions.get_fund_output().value,
                &context.transactions.cets[cet_start..cet_end],
                &signatures,
                signature_index,
            )
            .map_err(|e| context.peer_error(format!("invalid CET adaptor signatures: {e}")))?;
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
            let remote = signatures[range.adaptor_index]
                .decrypt(&secret)
                .map_err(dlc_error)?;
            return context.complete(
                context.transactions.cets[cet_start + range.cet_index].clone(),
                remote,
                signers.as_ref(),
            );
        }
        cet_start = cet_end;
        signature_index = next_index;
    }
    Err(ContractError::NoMatchingOutcome)
}
