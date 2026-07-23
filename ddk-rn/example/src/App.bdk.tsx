/*
 * PRESERVED — NOT CURRENTLY BUILT.
 *
 * This is the bdk-rn + ddk-rn integration demo. It's kept for when bdk-rn ships
 * a build compatible with our uniffi-bindgen-react-native (ubrn) version.
 *
 * Why it's disabled: bdk-rn (every release — 0.30, 1.0, 2.x, 3.0-rc) pins
 * `uniffi-bindgen-react-native "0.30.0-1"`, while ddk-rn is on `0.31.0-3`. An app
 * can only resolve ONE ubrn pod version, so bdk-rn and ddk-rn can't coexist. Also
 * bdk-rn 0.30 (npm `latest`) doesn't build under RN new architecture, and 1.0+
 * isn't published to npm. See the tracking issue filed against bitcoindevkit/bdk-rn.
 *
 * To re-enable: get bdk-rn on the same ubrn version as ddk-rn, `pnpm add` it back
 * in example/package.json, restore the `pod 'bdk-rn'` autolink, point index.js at
 * this file, and remove it from tsconfig `exclude`.
 */
/**
 * DDK + BDK — full DLC funding flow
 * ---------------------------------
 * Runs an entire two-party DLC funding flow on device, with NO live oracle:
 *
 *   1. Two parties each build a bdk-rn wallet (the on-chain side).
 *   2. The offerer single-funds the contract; ddk-rn `createOffer` produces the
 *      OfferDlc (funding key from the seed, payout/change scripts from bdk).
 *   3. `acceptOffer` produces the AcceptDlc + the funding PSBT.
 *   4. The offerer signs its funding input on the PSBT with its bdk descriptor
 *      (`signFundingPsbtWithDescriptor`), then `signAccept` → SignDlc.
 *   5. The acceptor (no inputs) runs `finalizeSign` → a fully-signed funding
 *      transaction, ready to broadcast.
 *
 * No oracle is needed: the signed oracle *announcement* is already inside the
 * ContractInfo; oracle *attestation* is only required later, to settle a CET.
 * Everything here runs offline.
 */
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  ContractKeyProvider,
  chainHashFromNetwork,
  fundingInput,
  createOffer,
  contractInfoPayouts,
  acceptOffer,
  validateAccept,
  createFundingPsbt,
  signFundingPsbtWithDescriptor,
  signAccept,
  validateSign,
  finalizeSign,
  computeContractId,
  version,
} from '@bennyblader/ddk-rn';
import {
  Mnemonic,
  DescriptorSecretKey,
  Descriptor,
  DatabaseConfig,
  Wallet,
} from 'bdk-rn';
import { Network, KeychainKind, AddressIndex } from 'bdk-rn/lib/lib/enums';

// BIP39 test-vector mnemonics, one per party. FOR DEMO ONLY.
const OFFERER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ACCEPTOR_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

// bdk-rn's `Network.Testnet` is the string "testnet", exactly what ddk-rn's
// ContractKeyProvider / chainHashFromNetwork expect — shared with no conversion.
const NETWORK = Network.Testnet;

// A wire-encoded `ContractInfo`: a two-outcome ("up"/"down") enum contract with
// a signed oracle announcement and 100 000 sats total collateral. In production
// this comes from the oracle / node-dlc; the funding flow only needs the signed
// announcement it contains, not any attestation.
const CONTRACT_INFO_HEX =
  '0000000000000186a0000202757000000000000186a004646f776e000000000000000000fdd824a50e90df7ce7ebd675ee2aa81d38c1e040470e27a9f99fb1a1f923b601464d3002f902a28bd4b9de6373966266daf4fdda538fc968bc1fe92cfcc53c1010bcce2a44b9c62b2e40f9623c61ec464829cf5af49e0abf99cdac5564d05158ddf5a925fdd8224100019c5530e4385ebc41cdaf8257edf9a2baaf8506a4099103211e6ed7382103ed67000002eefdd8060a000202757004646f776e0c64646b2d6666692d74657374';

const TOTAL_COLLATERAL_SATS = 100_000n; // the offerer single-funds all of it
const FUNDING_UTXO_SATS = 200_000; // the offerer's on-chain coin
const FUNDING_INPUT_SERIAL_ID = 100n;

type DemoResult = {
  ddkVersion: string;
  offererAddress: string;
  acceptorAddress: string;
  offerBytes: number;
  acceptBytes: number;
  signBytes: number;
  contractId: string;
  payoutRows: { label: string; offer: string; accept: string }[];
  fundingTxBytes: number;
  fundingTxPreview: string;
};

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToArrayBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

// Copies a Uint8Array into a fresh ArrayBuffer (the byte type the FFI expects).
function u8ToArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(u8.length);
  new Uint8Array(buffer).set(u8);
  return buffer;
}

// A 32-byte temporary-contract-id (each contract has its own).
function temporaryContractId(marker: number): ArrayBuffer {
  return new Uint8Array(32).fill(marker).buffer;
}

// Builds a minimal transaction paying `valueSats` to `scriptPubkey` — the coin
// the offerer's funding input spends. In production this is a real UTXO from the
// synced wallet; here we synthesize the funding source offline.
function buildFundingSourceTx(
  valueSats: number,
  scriptPubkey: Uint8Array
): ArrayBuffer {
  const value = new Uint8Array(8);
  new DataView(value.buffer).setBigUint64(0, BigInt(valueSats), true); // little-endian
  const bytes: number[] = [
    0x02,
    0x00,
    0x00,
    0x00, // version 2
    0x01, // input count
    ...new Array(32).fill(0), // prev txid (none)
    0xff,
    0xff,
    0xff,
    0xff, // prev vout
    0x00, // scriptSig length
    0xff,
    0xff,
    0xff,
    0xff, // sequence
    0x01, // output count
    ...value, // value (LE)
    scriptPubkey.length, // scriptPubkey length (P2WPKH is 22 bytes, < 0xfd)
    ...scriptPubkey,
    0x00,
    0x00,
    0x00,
    0x00, // locktime
  ];
  return new Uint8Array(bytes).buffer;
}

type WalletParts = {
  address: string;
  scriptPubkey: Uint8Array;
  privateDescriptor: string;
};

async function buildWallet(mnemonicPhrase: string): Promise<WalletParts> {
  const mnemonic = await new Mnemonic().fromString(mnemonicPhrase);
  const secretKey = await new DescriptorSecretKey().create(
    NETWORK,
    mnemonic,
    ''
  );
  const descriptor = await new Descriptor().newBip84(
    secretKey,
    KeychainKind.External,
    NETWORK
  );
  const changeDescriptor = await new Descriptor().newBip84(
    secretKey,
    KeychainKind.Internal,
    NETWORK
  );
  const dbConfig = await new DatabaseConfig().memory();
  const wallet = await new Wallet().create(
    descriptor,
    changeDescriptor,
    NETWORK,
    dbConfig
  );
  // First `New` address is external index 0 — the index the descriptor signer
  // uses below.
  const addressInfo = await wallet.getAddress(AddressIndex.New);
  const address = await addressInfo.address.asString();
  const scriptPubkey = new Uint8Array(
    await (await addressInfo.address.scriptPubKey()).toBytes()
  );
  const privateDescriptor = await descriptor.asStringPrivate();
  return { address, scriptPubkey, privateDescriptor };
}

export default function App() {
  const [result, setResult] = useState<DemoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function runDemo() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      // On-chain wallets (bdk-rn) and DLC key providers (ddk-rn) for both parties.
      const offerer = await buildWallet(OFFERER_MNEMONIC);
      const acceptor = await buildWallet(ACCEPTOR_MNEMONIC);
      const offererKeys = ContractKeyProvider.fromMnemonic(
        OFFERER_MNEMONIC,
        undefined,
        NETWORK
      );
      const acceptorKeys = ContractKeyProvider.fromMnemonic(
        ACCEPTOR_MNEMONIC,
        undefined,
        NETWORK
      );
      const offerTempId = temporaryContractId(0x5c);
      const acceptTempId = temporaryContractId(0xa1);
      const chainHash = chainHashFromNetwork(NETWORK);

      // The offerer's funding UTXO pays to its own index-0 address, then becomes
      // a DLC funding input.
      const prevTx = buildFundingSourceTx(
        FUNDING_UTXO_SATS,
        offerer.scriptPubkey
      );
      const funding = fundingInput(
        prevTx,
        0, // vout
        FUNDING_INPUT_SERIAL_ID,
        0xffffffff, // sequence
        108, // max witness length (P2WPKH)
        new ArrayBuffer(0) // no redeem script
      );

      // 1) Offer — single-funded: the offerer contributes all the collateral.
      const offer = createOffer({
        chainHash,
        temporaryContractId: offerTempId,
        contractInfo: hexToArrayBuffer(CONTRACT_INFO_HEX),
        offerCollateralSats: TOTAL_COLLATERAL_SATS,
        party: {
          fundingPubkey: offererKeys.fundingPubkey(offerTempId),
          fundingInputs: [funding],
          payoutSpk: u8ToArrayBuffer(offerer.scriptPubkey),
          payoutSerialId: 1n,
          changeSpk: u8ToArrayBuffer(offerer.scriptPubkey),
          changeSerialId: 2n,
        },
        fundOutputSerialId: 3n,
        feeRatePerVb: 2n,
        cetLocktime: 500,
        refundLocktime: 1_000,
        contractFlags: 0,
      });

      // 2) Accept — the acceptor contributes no inputs and no collateral.
      const acceptResult = acceptOffer(
        offer,
        {
          party: {
            fundingPubkey: acceptorKeys.fundingPubkey(acceptTempId),
            fundingInputs: [],
            payoutSpk: u8ToArrayBuffer(acceptor.scriptPubkey),
            payoutSerialId: 4n,
            changeSpk: u8ToArrayBuffer(acceptor.scriptPubkey),
            changeSerialId: 5n,
          },
          minTimeoutInterval: 100,
          maxTimeoutInterval: 100_000,
        },
        acceptorKeys,
        acceptTempId
      );
      const accept = acceptResult.accept;

      // The offerer independently validates the accept before signing — the same
      // check `signAccept` runs internally, exposed so a stored/received message
      // can be verified on its own.
      validateAccept(offer, accept);

      // 3) Funding PSBT, and 4) the offerer signs its input with its descriptor.
      const fundingPsbt = createFundingPsbt(offer, accept);
      const signedPsbt = signFundingPsbtWithDescriptor(
        offer,
        accept,
        fundingPsbt,
        offerer.privateDescriptor,
        [{ inputSerialId: FUNDING_INPUT_SERIAL_ID, derivationIndex: 0 }]
      );

      // 5) Offerer produces the sign message.
      const signResult = signAccept(
        offer,
        accept,
        offererKeys,
        offerTempId,
        signedPsbt
      );

      // The acceptor independently validates the sign before finalizing.
      validateSign(offer, accept, signResult.sign);

      // The stable contract id (from offer + accept) — a natural storage key.
      const contractId = toHex(computeContractId(offer, accept));

      // Derive the payout table from the contract info — what each party
      // receives for every outcome. Enum contracts give labeled outcomes;
      // numeric contracts give outcome ranges (rangeStart–rangeEnd).
      const payouts = contractInfoPayouts(hexToArrayBuffer(CONTRACT_INFO_HEX));
      const payoutRows = payouts.rows.map((row) => ({
        label: row.outcome ?? `${row.rangeStart}–${row.rangeEnd}`,
        offer: `${row.offerPayoutSats.toString()} sats`,
        accept: `${row.acceptPayoutSats.toString()} sats`,
      }));

      // 6) Acceptor (no inputs of its own) finalizes → signed funding tx.
      const fundingTx = finalizeSign(
        offer,
        accept,
        signResult.sign,
        fundingPsbt
      );

      setResult({
        ddkVersion: version(),
        offererAddress: offerer.address,
        acceptorAddress: acceptor.address,
        offerBytes: offer.byteLength,
        acceptBytes: accept.byteLength,
        signBytes: signResult.sign.byteLength,
        contractId,
        payoutRows,
        fundingTxBytes: fundingTx.byteLength,
        fundingTxPreview: `${toHex(fundingTx).slice(0, 64)}…`,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>DDK × BDK</Text>
        <Text style={styles.subtitle}>
          A full two-party DLC funding flow — no oracle, no network.
        </Text>

        <Pressable
          testID="run-flow"
          accessibilityLabel="Run the funding flow"
          style={({ pressed }) => [
            styles.button,
            pressed && styles.buttonPressed,
          ]}
          disabled={loading}
          onPress={runDemo}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Run the funding flow</Text>
          )}
        </Pressable>

        {error != null && (
          <View testID="flow-error" style={[styles.card, styles.errorCard]}>
            <Text style={styles.cardTitle}>Error</Text>
            <Text style={styles.mono}>{error}</Text>
          </View>
        )}

        {result != null && (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>bdk-rn · parties</Text>
              <Field
                label="Offerer address"
                value={result.offererAddress}
                mono
              />
              <Field
                label="Acceptor address"
                value={result.acceptorAddress}
                mono
              />
              <Text style={styles.note}>
                Each party's on-chain wallet. The offerer single-funds{' '}
                {TOTAL_COLLATERAL_SATS.toString()} sats from a{' '}
                {FUNDING_UTXO_SATS.toLocaleString()}-sat UTXO.
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>ddk-rn · DLC messages</Text>
              <Field label="OfferDlc" value={`${result.offerBytes} bytes`} />
              <Field label="AcceptDlc" value={`${result.acceptBytes} bytes`} />
              <Field label="SignDlc" value={`${result.signBytes} bytes`} />
              <Field label="Contract id" value={result.contractId} mono />
              <Text style={styles.note}>
                Each message was validated independently (validateOffer /
                validateAccept / validateSign) — the same checks the lifecycle
                runs, callable on stored or received messages at any time.
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>ddk-rn · payout table</Text>
              <Text style={styles.note}>
                What each party receives per outcome, derived from the
                ContractInfo (contractInfoPayouts).
              </Text>
              <View style={styles.tableHeaderRow}>
                <Text style={[styles.th, styles.thOutcome]}>Outcome</Text>
                <Text style={styles.th}>Offerer</Text>
                <Text style={styles.th}>Acceptor</Text>
              </View>
              {result.payoutRows.map((row, index) => (
                <View key={index} style={styles.tableRow}>
                  <Text style={[styles.td, styles.thOutcome]}>{row.label}</Text>
                  <Text style={styles.td}>{row.offer}</Text>
                  <Text style={styles.td}>{row.accept}</Text>
                </View>
              ))}
            </View>

            <View
              testID="flow-success"
              style={[styles.card, styles.successCard]}
            >
              <Text style={styles.cardTitle}>✓ Signed funding transaction</Text>
              <Field label="Size" value={`${result.fundingTxBytes} bytes`} />
              <Field label="Raw tx" value={result.fundingTxPreview} mono />
              <Text style={styles.note}>
                Fully signed and ready to broadcast. To settle the contract
                after maturity you'd add the oracle's attestation and broadcast
                a CET — the only step that needs the live oracle.
              </Text>
            </View>

            <View style={styles.card}>
              <Field label="ddk-rn version" value={result.ddkVersion} />
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text
        style={[styles.fieldValue, mono && styles.mono]}
        selectable
        numberOfLines={mono ? undefined : 1}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0b0f1a',
  },
  container: {
    padding: 20,
    gap: 16,
  },
  title: {
    fontSize: 32,
    fontWeight: '800',
    color: '#f2a900',
  },
  subtitle: {
    fontSize: 15,
    color: '#9aa4b2',
    marginBottom: 4,
  },
  button: {
    backgroundColor: '#f2a900',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  buttonText: {
    color: '#0b0f1a',
    fontSize: 16,
    fontWeight: '700',
  },
  card: {
    backgroundColor: '#131a2a',
    borderRadius: 14,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: '#1e2942',
  },
  errorCard: {
    borderColor: '#7f1d1d',
    backgroundColor: '#1f1113',
  },
  successCard: {
    borderColor: '#1f7a3d',
    backgroundColor: '#0f1a13',
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#f2a900',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  note: {
    fontSize: 12,
    color: '#7c8698',
    lineHeight: 17,
  },
  field: {
    gap: 2,
  },
  fieldLabel: {
    fontSize: 12,
    color: '#9aa4b2',
  },
  fieldValue: {
    fontSize: 14,
    color: '#e6e9ef',
  },
  mono: {
    fontFamily: 'Courier',
    fontSize: 12,
    color: '#cfd6e4',
  },
  tableHeaderRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#1e2942',
    paddingBottom: 6,
    marginTop: 4,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 4,
  },
  th: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: '#9aa4b2',
    textAlign: 'right',
  },
  thOutcome: {
    flex: 1.4,
    textAlign: 'left',
  },
  td: {
    flex: 1,
    fontSize: 13,
    color: '#e6e9ef',
    textAlign: 'right',
  },
});
