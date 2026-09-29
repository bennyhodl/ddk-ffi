//! Consumer-owned contract key lookup and synchronous signing.

use crate::contract::{to_array_32, ContractError};
use secp256k1_zkp::{EcdsaAdaptorSignature, Message, PublicKey, Secp256k1, SecretKey};
use std::sync::Arc;

/// Identifies the key a message needs. Every field is read from the messages,
/// so a provider can resolve it from stored contracts or derive it directly.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct ContractKeyRequest {
    /// The 33-byte funding public key that must sign, as published in the
    /// offer or accept.
    pub funding_pubkey: Vec<u8>,
    /// The contract's 32-byte temporary id: the offer's, from which both
    /// parties derive their keys. For a splice input, the previous contract's,
    /// recovered from the input.
    pub temporary_contract_id: Vec<u8>,
    /// The contract's 32-byte id: the funding txid combined with the temporary
    /// id and the funding output index.
    pub contract_id: Vec<u8>,
}

/// Implement in the consumer to resolve stored contracts, legacy derivation
/// paths, or delegated signers. No secret key needs to cross this interface.
#[uniffi::export(with_foreign)]
pub trait ContractSignerProvider: Send + Sync {
    fn get_signer(&self, key: ContractKeyRequest)
        -> Result<Arc<dyn ContractSigner>, ContractError>;
}

/// Signs 32-byte transaction sighashes. Calls are synchronous; signers needing
/// approval should use the prepare/complete API instead.
#[uniffi::export(with_foreign)]
pub trait ContractSigner: Send + Sync {
    /// Return a 64-byte compact ECDSA signature, without a sighash suffix.
    fn sign_ecdsa(&self, sighash: Vec<u8>) -> Result<Vec<u8>, ContractError>;
    /// Return a 162-byte ECDSA adaptor signature for the 33-byte adaptor point.
    fn sign_adaptor(
        &self,
        sighash: Vec<u8>,
        adaptor_point: Vec<u8>,
    ) -> Result<Vec<u8>, ContractError>;
}

impl From<uniffi::UnexpectedUniFFICallbackError> for ContractError {
    fn from(error: uniffi::UnexpectedUniFFICallbackError) -> Self {
        Self::Key {
            message: format!("contract signer callback failed: {}", error.reason),
        }
    }
}

/// A local signer for a consumer-derived key, including legacy BIP84 keys.
/// The constructor imports a key; signing never exports it.
#[derive(uniffi::Object)]
pub struct PrivateKeySigner {
    pub(crate) secret: SecretKey,
}

#[uniffi::export]
impl PrivateKeySigner {
    #[uniffi::constructor]
    pub fn from_secret_key(secret_key: Vec<u8>) -> Result<Arc<Self>, ContractError> {
        let secret = SecretKey::from_slice(&secret_key).map_err(|e| ContractError::Key {
            message: e.to_string(),
        })?;
        Ok(Arc::new(Self { secret }))
    }

    pub fn public_key(&self) -> Vec<u8> {
        self.secret
            .public_key(&Secp256k1::new())
            .serialize()
            .to_vec()
    }

    pub fn sign_ecdsa(&self, sighash: Vec<u8>) -> Result<Vec<u8>, ContractError> {
        let message = Message::from_digest(to_array_32(&sighash, "sighash")?);
        Ok(Secp256k1::new()
            .sign_ecdsa_low_r(&message, &self.secret)
            .serialize_compact()
            .to_vec())
    }

    pub fn sign_adaptor(
        &self,
        sighash: Vec<u8>,
        adaptor_point: Vec<u8>,
    ) -> Result<Vec<u8>, ContractError> {
        let message = Message::from_digest(to_array_32(&sighash, "sighash")?);
        let point = PublicKey::from_slice(&adaptor_point).map_err(|e| ContractError::Key {
            message: e.to_string(),
        })?;
        Ok(EcdsaAdaptorSignature::encrypt_no_aux_rand(
            &Secp256k1::new(),
            &message,
            &self.secret,
            &point,
        )
        .as_ref()
        .to_vec())
    }
}

impl ContractSigner for PrivateKeySigner {
    fn sign_ecdsa(&self, sighash: Vec<u8>) -> Result<Vec<u8>, ContractError> {
        self.sign_ecdsa(sighash)
    }
    fn sign_adaptor(
        &self,
        sighash: Vec<u8>,
        adaptor_point: Vec<u8>,
    ) -> Result<Vec<u8>, ContractError> {
        self.sign_adaptor(sighash, adaptor_point)
    }
}

impl Drop for PrivateKeySigner {
    fn drop(&mut self) {
        self.secret.non_secure_erase();
    }
}
