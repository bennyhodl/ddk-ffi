//! What a party signs with: its contract keys and its wallet.
//!
//! [`Signers`] is built once per wallet and handed to every synchronous
//! lifecycle call. [`ContractSignerProvider`] answers for the contract key the
//! messages name; [`FundingWallet`] signs the wallet inputs in the funding
//! PSBT. Both are synchronous: a signer that answers later, in another
//! process, goes through the prepare/complete API instead.

use crate::contract::{decode_psbt, to_array_32, ContractError};
use bitcoin::bip32::ChildNumber;
use bitcoin::psbt::Psbt;
use bitcoin::script::PushBytesBuf;
use bitcoin::sighash::SighashCache;
use bitcoin::{PrivateKey, ScriptBuf, Witness};
use miniscript::descriptor::{
    Descriptor, DescriptorPublicKey, DescriptorSecretKey, KeyMap, ShInner, Wildcard,
};
use secp256k1_zkp::{All, EcdsaAdaptorSignature, Message, PublicKey, Secp256k1, SecretKey};
use std::sync::Arc;

/// What one party signs with. Build it once per wallet, not per contract:
/// nothing in it refers to a contract, and every lifecycle call finds the
/// key and the inputs it needs in the messages.
///
/// An object rather than a record because ubrn's runtime lowers a foreign
/// trait object only as a direct argument, not as a record field.
#[derive(uniffi::Object)]
pub struct Signers {
    /// Answers for the contract funding key: the refund, the CETs, and this
    /// party's half of any spliced input.
    pub(crate) contract_keys: Arc<dyn ContractSignerProvider>,
    /// Signs the wallet inputs this party contributes to the funding
    /// transaction. Only a party that contributes some needs one.
    pub(crate) wallet: Option<Arc<dyn FundingWallet>>,
}

#[uniffi::export]
impl Signers {
    /// Signers for a party that funds nothing with its wallet, or one that
    /// adds its wallet with [`Signers::with_wallet`].
    #[uniffi::constructor]
    pub fn new(contract_keys: Arc<dyn ContractSignerProvider>) -> Arc<Self> {
        Arc::new(Self {
            contract_keys,
            wallet: None,
        })
    }

    /// The same contract keys plus the wallet that signs this party's
    /// funding inputs.
    pub fn with_wallet(self: Arc<Self>, wallet: Arc<dyn FundingWallet>) -> Arc<Self> {
        Arc::new(Self {
            contract_keys: self.contract_keys.clone(),
            wallet: Some(wallet),
        })
    }
}

/// A wallet that signs its own inputs in a funding PSBT. Implement it over the
/// wallet that holds the coins — a bdk wallet's `sign`, a node's
/// `walletprocesspsbt` — or use [`DescriptorWallet`]. The method is async
/// because every such wallet is, on the JavaScript side.
///
/// Declared twice because the foreign implementation is `Send + Sync` on
/// native targets and single-threaded on wasm, where a JS future is neither.
#[cfg(not(target_arch = "wasm32"))]
#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait FundingWallet: Send + Sync {
    /// Sign and finalize the inputs this wallet owns in a BIP-174 funding PSBT
    /// and return it. Inputs it does not own, including the 2-of-2 splice
    /// inputs, must be left as they are.
    async fn sign_funding_psbt(&self, psbt: Vec<u8>) -> Result<Vec<u8>, ContractError>;
}

#[cfg(target_arch = "wasm32")]
#[uniffi::export(with_foreign)]
#[async_trait::async_trait(?Send)]
pub trait FundingWallet {
    /// Sign and finalize the inputs this wallet owns in a BIP-174 funding PSBT
    /// and return it. Inputs it does not own, including the 2-of-2 splice
    /// inputs, must be left as they are.
    async fn sign_funding_psbt(&self, psbt: Vec<u8>) -> Result<Vec<u8>, ContractError>;
}

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

/// A [`FundingWallet`] over a private `wpkh()` or `sh(wpkh())` output
/// descriptor. It recognises its inputs by script, trying wildcard indexes
/// `0..lookahead`, so nothing about a contract is registered with it.
#[derive(uniffi::Object)]
pub struct DescriptorWallet {
    descriptor: Descriptor<DescriptorPublicKey>,
    keys: KeyMap,
    lookahead: u32,
}

#[uniffi::export]
impl DescriptorWallet {
    /// `lookahead` is how many wildcard indexes an input's script is looked
    /// up under; a descriptor without a wildcard has only one script.
    #[uniffi::constructor(default(lookahead = 1000))]
    pub fn new(descriptor: String, lookahead: u32) -> Result<Arc<Self>, ContractError> {
        let (descriptor, keys) =
            Descriptor::<DescriptorPublicKey>::parse_descriptor(&Secp256k1::new(), &descriptor)
                .map_err(|e| ContractError::Descriptor {
                    message: e.to_string(),
                })?;
        if keys.is_empty() {
            return Err(ContractError::Descriptor {
                message: "watch-only descriptor: signing requires a descriptor with private keys"
                    .to_string(),
            });
        }
        match &descriptor {
            Descriptor::Wpkh(_) => {}
            Descriptor::Sh(sh) if matches!(sh.as_inner(), ShInner::Wpkh(_)) => {}
            _ => {
                return Err(ContractError::Descriptor {
                    message: "only wpkh() and sh(wpkh()) descriptors are supported".to_string(),
                })
            }
        }
        Ok(Arc::new(Self {
            descriptor,
            keys,
            lookahead,
        }))
    }

    /// Signs and finalizes every input whose script this descriptor derives,
    /// leaving the others as they are. Async only to match [`FundingWallet`];
    /// nothing in it waits.
    pub async fn sign_funding_psbt(&self, psbt: Vec<u8>) -> Result<Vec<u8>, ContractError> {
        self.sign_psbt(psbt)
    }
}

impl DescriptorWallet {
    fn sign_psbt(&self, psbt: Vec<u8>) -> Result<Vec<u8>, ContractError> {
        let mut psbt = decode_psbt(&psbt)?;
        let secp = Secp256k1::new();
        for input_index in 0..psbt.inputs.len() {
            let input = &psbt.inputs[input_index];
            if input.final_script_witness.is_some() || input.witness_script.is_some() {
                continue;
            }
            let Some(script_pubkey) = input.witness_utxo.as_ref().map(|u| &u.script_pubkey) else {
                continue;
            };
            if let Some(key) = self.key_for_script(script_pubkey, &secp)? {
                sign_p2wpkh_input(&mut psbt, input_index, &key, &secp)?;
            }
        }
        Ok(psbt.serialize())
    }
}

impl DescriptorWallet {
    /// The private key whose P2WPKH program, native or wrapped, is
    /// `script_pubkey`, if the descriptor derives it within the lookahead.
    fn key_for_script(
        &self,
        script_pubkey: &ScriptBuf,
        secp: &Secp256k1<All>,
    ) -> Result<Option<PrivateKey>, ContractError> {
        let indexes = if self.descriptor.has_wildcard() {
            0..self.lookahead
        } else {
            0..1
        };
        for index in indexes {
            let derived = self.descriptor.at_derivation_index(index).map_err(|e| {
                ContractError::Descriptor {
                    message: e.to_string(),
                }
            })?;
            if derived.script_pubkey() != *script_pubkey {
                continue;
            }
            let key = self
                .keys
                .values()
                .filter_map(|secret| private_key_at(secret, index, secp))
                .find(|key| {
                    key.public_key(secp)
                        .wpubkey_hash()
                        .map(|hash| p2wpkh_scripts(&hash).contains(script_pubkey))
                        .unwrap_or(false)
                })
                .ok_or_else(|| ContractError::Descriptor {
                    message: format!(
                        "descriptor private keys do not derive the script at index {index}"
                    ),
                })?;
            return Ok(Some(key));
        }
        Ok(None)
    }
}

fn private_key_at(
    secret: &DescriptorSecretKey,
    index: u32,
    secp: &Secp256k1<All>,
) -> Option<PrivateKey> {
    match secret {
        DescriptorSecretKey::Single(single) => Some(single.key),
        DescriptorSecretKey::XPrv(xkey) => {
            let path = match xkey.wildcard {
                Wildcard::None => xkey.derivation_path.clone(),
                Wildcard::Unhardened => xkey
                    .derivation_path
                    .child(ChildNumber::from_normal_idx(index).ok()?),
                Wildcard::Hardened => xkey
                    .derivation_path
                    .child(ChildNumber::from_hardened_idx(index).ok()?),
            };
            Some(xkey.xkey.derive_priv(secp, &path).ok()?.to_priv())
        }
        DescriptorSecretKey::MultiXPrv(_) => None,
    }
}

/// The native P2WPKH script for a key hash and its P2SH wrapping.
fn p2wpkh_scripts(hash: &bitcoin::WPubkeyHash) -> [ScriptBuf; 2] {
    let native = ScriptBuf::new_p2wpkh(hash);
    let wrapped = ScriptBuf::new_p2sh(&native.script_hash());
    [native, wrapped]
}

/// Signs one P2WPKH or P2SH-P2WPKH input with `key`, SIGHASH_ALL unless the
/// PSBT says otherwise, and finalizes it the way a wallet would.
fn sign_p2wpkh_input(
    psbt: &mut Psbt,
    input_index: usize,
    key: &PrivateKey,
    secp: &Secp256k1<All>,
) -> Result<(), ContractError> {
    let public_key = key.public_key(secp);
    let hash = public_key
        .wpubkey_hash()
        .map_err(|_| ContractError::InvalidFundingInput {
            message: format!("input {input_index} cannot be signed with an uncompressed key"),
        })?;
    let [native, wrapped] = p2wpkh_scripts(&hash);
    let input = &mut psbt.inputs[input_index];
    let script_pubkey = &input
        .witness_utxo
        .as_ref()
        .expect("checked by the caller")
        .script_pubkey;
    let redeem_script = if *script_pubkey == wrapped {
        input.redeem_script = Some(native.clone());
        Some(native)
    } else if *script_pubkey == native {
        None
    } else {
        return Err(ContractError::InvalidFundingInput {
            message: format!("the derived key does not control the script of input {input_index}"),
        });
    };

    let (message, sighash_type) = psbt
        .sighash_ecdsa(input_index, &mut SighashCache::new(&psbt.unsigned_tx))
        .map_err(|e| ContractError::InvalidFundingInput {
            message: format!("could not compute the sighash for input {input_index}: {e}"),
        })?;
    let signature = bitcoin::ecdsa::Signature {
        signature: secp.sign_ecdsa(&message, &key.inner),
        sighash_type,
    };

    let input = &mut psbt.inputs[input_index];
    input.final_script_witness = Some(Witness::p2wpkh(&signature, &public_key.inner));
    if let Some(redeem_script) = redeem_script {
        let push = PushBytesBuf::try_from(redeem_script.into_bytes()).map_err(|_| {
            ContractError::InvalidFundingInput {
                message: format!("input {input_index} redeem script is too long"),
            }
        })?;
        input.final_script_sig = Some(ScriptBuf::builder().push_slice(push).into_script());
    }
    input.partial_sigs.clear();
    Ok(())
}

#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
impl FundingWallet for DescriptorWallet {
    async fn sign_funding_psbt(&self, psbt: Vec<u8>) -> Result<Vec<u8>, ContractError> {
        self.sign_psbt(psbt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::accept_offer;
    use crate::contract::tests::{sign_accept, signers, single_funded_offer};
    use bitcoin::bip32::{Xpriv, Xpub};
    use bitcoin::hashes::Hash;
    use bitcoin::{Amount, Network, OutPoint, Transaction, TxIn, TxOut, Txid};

    /// An unsigned PSBT with one input per script, each carrying its UTXO.
    fn unsigned_psbt(scripts: &[ScriptBuf]) -> Psbt {
        let transaction = Transaction {
            version: bitcoin::transaction::Version::TWO,
            lock_time: bitcoin::absolute::LockTime::ZERO,
            input: (0..scripts.len())
                .map(|vout| TxIn {
                    previous_output: OutPoint::new(Txid::all_zeros(), vout as u32),
                    ..Default::default()
                })
                .collect(),
            output: vec![TxOut {
                value: Amount::from_sat(1_000),
                script_pubkey: scripts[0].clone(),
            }],
        };
        let mut psbt = Psbt::from_unsigned_tx(transaction).unwrap();
        for (input, script) in psbt.inputs.iter_mut().zip(scripts) {
            input.witness_utxo = Some(TxOut {
                value: Amount::from_sat(10_000),
                script_pubkey: script.clone(),
            });
        }
        psbt
    }

    /// The wallet finds its input by script within the lookahead, native or
    /// wrapped, and leaves every other input exactly as it was.
    #[test]
    fn descriptor_wallet_signs_only_the_inputs_it_derives() {
        let secp = Secp256k1::new();
        let xprv = Xpriv::new_master(Network::Regtest, &[3; 64]).unwrap();
        let peer_key = SecretKey::from_slice(&[9; 32]).unwrap().public_key(&secp);
        let peer =
            ScriptBuf::new_p2wpkh(&bitcoin::PublicKey::new(peer_key).wpubkey_hash().unwrap());
        for wrapped in [false, true] {
            let descriptor = if wrapped {
                format!("sh(wpkh({xprv}/84h/1h/0h/0/*))")
            } else {
                format!("wpkh({xprv}/84h/1h/0h/0/*)")
            };
            let (parsed, _) =
                Descriptor::<DescriptorPublicKey>::parse_descriptor(&secp, &descriptor).unwrap();
            let script_at = |index| parsed.at_derivation_index(index).unwrap().script_pubkey();
            let wallet = DescriptorWallet::new(descriptor, 10).unwrap();
            let psbt = unsigned_psbt(&[script_at(7), peer.clone(), script_at(10)]);
            let signed = Psbt::deserialize(&wallet.sign_psbt(psbt.serialize()).unwrap()).unwrap();
            assert!(
                signed.inputs[0].final_script_witness.is_some(),
                "wrapped {wrapped}: the input at index 7 is signed"
            );
            assert_eq!(signed.inputs[0].final_script_sig.is_some(), wrapped);
            assert_eq!(
                signed.inputs[1], psbt.inputs[1],
                "the peer's input is untouched"
            );
            assert_eq!(
                signed.inputs[2], psbt.inputs[2],
                "an index past the lookahead is not found"
            );
        }
    }

    #[test]
    fn descriptor_wallet_rejects_descriptors_it_cannot_sign_with() {
        let secp = Secp256k1::new();
        let xprv = Xpriv::new_master(Network::Regtest, &[3; 64]).unwrap();
        let xpub = Xpub::from_priv(&secp, &xprv);
        for descriptor in [
            format!("wpkh({xpub}/0/*)"),
            format!("tr({xprv}/86h/1h/0h/0/*)"),
        ] {
            assert!(matches!(
                DescriptorWallet::new(descriptor, 10),
                Err(ContractError::Descriptor { .. })
            ));
        }
    }

    /// A party that funds the contract must bring a wallet; one that does not
    /// needs only its contract keys.
    #[test]
    fn a_funding_party_needs_a_wallet() {
        let fixture = single_funded_offer();
        let accept = accept_offer(
            fixture.offer.clone(),
            fixture.accept_params,
            signers(fixture.acceptor_keys, None),
        )
        .unwrap()
        .accept;
        assert!(matches!(
            sign_accept(
                fixture.offer.clone(),
                accept.clone(),
                signers(fixture.offerer_keys.clone(), None)
            ),
            Err(ContractError::Wallet { .. })
        ));
        sign_accept(
            fixture.offer,
            accept,
            signers(fixture.offerer_keys, Some(&fixture.offerer_descriptor)),
        )
        .unwrap();
    }
}
