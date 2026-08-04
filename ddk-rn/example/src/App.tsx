/**
 * ddk-rn — full DLC contract lifecycle, on device.
 *
 * Runs an entire two-party DLC through the ddk-rn (JSI → Rust) bindings, with NO
 * live oracle and NO network:
 *
 *   createOffer → validateOffer → acceptOffer → validateAccept →
 *   createFundingPsbt → signFundingPsbtWithDescriptor → signAccept →
 *   validateSign → finalizeSign → a fully-signed funding transaction, then
 *   signContractCet / signContractRefund → the two settlement transactions.
 *
 * The wallet parts (a private descriptor + a funding UTXO) and the oracle
 * attestation are fixtures here, so the flow is deterministic and offline — this
 * is what the Maestro E2E asserts.
 * (An earlier version wired this to bdk-rn for a real wallet; that's preserved in
 * App.bdk.tsx, disabled until bdk-rn ships an ubrn-0.31-compatible build.)
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
  validateOffer,
  acceptOffer,
  validateAccept,
  createFundingPsbt,
  signFundingPsbtWithDescriptor,
  signAccept,
  validateSign,
  computeContractId,
  contractInfoPayouts,
  finalizeSign,
  signContractCet,
  signContractRefund,
  version,
} from '@bennyblader/ddk-rn';

// Fixtures (generated from the ddk-ffi Rust tests). The offerer's wpkh descriptor
// drives both its wallet (funding-input signing) and, via fromDescriptor, its DLC
// contract keys; the prev-tx is a 200k UTXO paying to that descriptor's index-0.
const OFFERER_DESCRIPTOR =
  'wpkh(tprv8ZgxMBicQKsPdeeuBw7yrpnwFVYj1ehvmPPtkwwnRdSAyCre8qxoyWWuaWLsfNUXNraEoucZQJzLzdj3KNZFJd9Tdv7rm97ikN9yYxQLfMz/84h/1h/0h/0/*)';
const PREV_TX_HEX =
  '02000000010000000000000000000000000000000000000000000000000000000000000000ffffffff00ffffffff01400d0300000000001600143a4279e9c96f8305f3bc0566f9d8be101c189a8300000000';
const OFFERER_SPK_HEX = '00143a4279e9c96f8305f3bc0566f9d8be101c189a83';
// A two-outcome ("up"/"down") enum contract with a signed oracle announcement
// and 100 000 sats total collateral.
const CONTRACT_INFO_HEX =
  '0000000000000186a0000202757000000000000186a004646f776e000000000000000000fdd824a5e7bcb1a4d0af5cd7bcc1b9aaabc2ee7463752c4db3d34d28817e27f459da722f4b1c649cec355f3f7bb5d7d3c67605f03ebc4b2b1d42c1aedaa7f186b3077fd944b9c62b2e40f9623c61ec464829cf5af49e0abf99cdac5564d05158ddf5a925fdd8224100019c5530e4385ebc41cdaf8257edf9a2baaf8506a4099103211e6ed7382103ed67000002eefdd8060a000202757004646f776e0c64646b2d6666692d74657374';
// The same oracle attesting to "up" — the outcome that pays the offerer the
// whole 100 000 sats. Regenerate alongside CONTRACT_INFO_HEX with
// `cargo test print_example_fixtures -- --ignored --nocapture` in ddk-ffi/.
const ATTESTATION_UP_HEX =
  '0c64646b2d6666692d7465737444b9c62b2e40f9623c61ec464829cf5af49e0abf99cdac5564d05158ddf5a92500019c5530e4385ebc41cdaf8257edf9a2baaf8506a4099103211e6ed7382103ed67e0b00db2f09efc08cda1554ae4f910a6fb5365c240e24d7be3514eed6825ce230001027570';
const ATTESTED_OUTCOME = 'up';
const ACCEPTOR_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

const TOTAL_COLLATERAL_SATS = 100_000n;
const FUNDING_INPUT_SERIAL_ID = 100n;

type DemoResult = {
  ddkVersion: string;
  offerBytes: number;
  acceptBytes: number;
  signBytes: number;
  contractId: string;
  payoutRows: { label: string; offer: string; accept: string }[];
  fundingTxBytes: number;
  fundingTxPreview: string;
  cetBytes: number;
  cetPreview: string;
  refundBytes: number;
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

function temporaryContractId(marker: number): ArrayBuffer {
  return new Uint8Array(32).fill(marker).buffer;
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
      // DLC key providers for both parties.
      const offererKeys =
        ContractKeyProvider.fromDescriptor(OFFERER_DESCRIPTOR);
      const acceptorKeys = ContractKeyProvider.fromMnemonic(
        ACCEPTOR_MNEMONIC,
        undefined,
        'regtest'
      );
      const offerTempId = temporaryContractId(0x5c);
      const acceptTempId = temporaryContractId(0xa1);
      const spk = hexToArrayBuffer(OFFERER_SPK_HEX);

      // 1) Offer — single-funded from the fixture UTXO.
      const funding = fundingInput(
        hexToArrayBuffer(PREV_TX_HEX),
        0,
        FUNDING_INPUT_SERIAL_ID,
        0xffffffff,
        108,
        new ArrayBuffer(0)
      );
      const offer = createOffer({
        chainHash: chainHashFromNetwork('regtest'),
        temporaryContractId: offerTempId,
        contractInfo: hexToArrayBuffer(CONTRACT_INFO_HEX),
        offerCollateralSats: TOTAL_COLLATERAL_SATS,
        party: {
          fundingPubkey: offererKeys.fundingPubkey(offerTempId),
          fundingInputs: [funding],
          payoutSpk: spk,
          payoutSerialId: 1n,
          changeSpk: spk,
          changeSerialId: 2n,
        },
        fundOutputSerialId: 3n,
        feeRatePerVb: 2n,
        cetLocktime: 500,
        refundLocktime: 1_000,
        contractFlags: 0,
      });
      validateOffer(offer, 100, 100_000);

      // 2) Accept — the acceptor contributes nothing.
      const acceptResult = acceptOffer(
        offer,
        {
          party: {
            fundingPubkey: acceptorKeys.fundingPubkey(acceptTempId),
            fundingInputs: [],
            payoutSpk: spk,
            payoutSerialId: 4n,
            changeSpk: spk,
            changeSerialId: 5n,
          },
          minTimeoutInterval: 100,
          maxTimeoutInterval: 100_000,
        },
        acceptorKeys,
        acceptTempId
      );
      const accept = acceptResult.accept;
      validateAccept(offer, accept);

      // 3) Fund PSBT, offerer signs its input, produces the sign message.
      const fundingPsbt = createFundingPsbt(offer, accept);
      const signedPsbt = signFundingPsbtWithDescriptor(
        offer,
        accept,
        fundingPsbt,
        OFFERER_DESCRIPTOR,
        [{ inputSerialId: FUNDING_INPUT_SERIAL_ID, derivationIndex: 0 }]
      );
      const signResult = signAccept(
        offer,
        accept,
        offererKeys,
        offerTempId,
        signedPsbt
      );
      validateSign(offer, accept, signResult.sign);

      // 4) Inspect: contract id + payout table.
      const contractId = toHex(computeContractId(offer, accept));
      const payouts = contractInfoPayouts(hexToArrayBuffer(CONTRACT_INFO_HEX));
      const payoutRows = payouts.rows.map((row) => ({
        label: row.outcome ?? `${row.rangeStart}–${row.rangeEnd}`,
        offer: `${row.offerPayoutSats.toString()} sats`,
        accept: `${row.acceptPayoutSats.toString()} sats`,
      }));

      // 5) Accepter finalizes → signed funding transaction.
      const fundingTx = finalizeSign(
        offer,
        accept,
        signResult.sign,
        fundingPsbt
      );

      // 6) Settle. Both paths are rebuilt from the three wire messages alone —
      // nothing about the contract was stored. The offerer signs the CET the
      // oracle's attestation selects; the acceptor signs the refund. Each side
      // settles on its own: the counterparty's half of the 2-of-2 comes from
      // the messages it already sent.
      const cet = signContractCet(
        offer,
        accept,
        signResult.sign,
        offererKeys,
        offerTempId,
        [{ oracleIndex: 0, attestation: hexToArrayBuffer(ATTESTATION_UP_HEX) }]
      );
      const refund = signContractRefund(
        offer,
        accept,
        signResult.sign,
        acceptorKeys,
        acceptTempId
      );

      setResult({
        ddkVersion: version(),
        offerBytes: offer.byteLength,
        acceptBytes: accept.byteLength,
        signBytes: signResult.sign.byteLength,
        contractId,
        payoutRows,
        fundingTxBytes: fundingTx.byteLength,
        fundingTxPreview: `${toHex(fundingTx).slice(0, 64)}…`,
        cetBytes: cet.byteLength,
        cetPreview: `${toHex(cet).slice(0, 64)}…`,
        refundBytes: refund.byteLength,
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
        <Text style={styles.title}>DDK · DLC</Text>
        <Text style={styles.subtitle}>
          A full two-party DLC — offer to settlement — through the ddk-rn
          bindings. No live oracle, no network.
        </Text>

        <Pressable
          testID="run-flow"
          accessibilityLabel="Run the contract flow"
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
            <Text style={styles.buttonText}>Run the contract flow</Text>
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
              <Text style={styles.cardTitle}>DLC messages</Text>
              <Field label="OfferDlc" value={`${result.offerBytes} bytes`} />
              <Field label="AcceptDlc" value={`${result.acceptBytes} bytes`} />
              <Field label="SignDlc" value={`${result.signBytes} bytes`} />
              <Field label="Contract id" value={result.contractId} mono />
              <Text style={styles.note}>
                Each message was validated independently (validateOffer /
                validateAccept / validateSign).
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Payout table</Text>
              <Text style={styles.note}>
                What each party receives per outcome (contractInfoPayouts).
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
                Fully signed and ready to broadcast.
              </Text>
            </View>

            <View
              testID="flow-settled"
              style={[styles.card, styles.successCard]}
            >
              <Text style={styles.cardTitle}>✓ Settled</Text>
              <Field
                label={`CET · oracle attested "${ATTESTED_OUTCOME}"`}
                value={`${result.cetBytes} bytes`}
              />
              <Field label="Raw CET" value={result.cetPreview} mono />
              <Field
                label="Refund transaction"
                value={`${result.refundBytes} bytes`}
              />
              <Text style={styles.note}>
                Both rebuilt from the three wire messages alone — no stored
                contract state. The offerer signed the CET, the acceptor the
                refund; either party can settle without the other.
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
  safe: { flex: 1, backgroundColor: '#0b0f1a' },
  container: { padding: 20, gap: 16 },
  title: { fontSize: 32, fontWeight: '800', color: '#f2a900' },
  subtitle: { fontSize: 15, color: '#9aa4b2', marginBottom: 4 },
  button: {
    backgroundColor: '#f2a900',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: '#0b0f1a', fontSize: 16, fontWeight: '700' },
  card: {
    backgroundColor: '#131a2a',
    borderRadius: 14,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: '#1e2942',
  },
  errorCard: { borderColor: '#7f1d1d', backgroundColor: '#1f1113' },
  successCard: { borderColor: '#1f7a3d', backgroundColor: '#0f1a13' },
  cardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#f2a900',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  note: { fontSize: 12, color: '#7c8698', lineHeight: 17 },
  field: { gap: 2 },
  fieldLabel: { fontSize: 12, color: '#9aa4b2' },
  fieldValue: { fontSize: 14, color: '#e6e9ef' },
  mono: { fontFamily: 'Courier', fontSize: 12, color: '#cfd6e4' },
  tableHeaderRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#1e2942',
    paddingBottom: 6,
    marginTop: 4,
  },
  tableRow: { flexDirection: 'row', paddingVertical: 4 },
  th: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: '#9aa4b2',
    textAlign: 'right',
  },
  thOutcome: { flex: 1.4, textAlign: 'left' },
  td: { flex: 1, fontSize: 13, color: '#e6e9ef', textAlign: 'right' },
});
