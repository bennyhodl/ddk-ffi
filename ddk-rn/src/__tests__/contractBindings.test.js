/**
 * Binding-surface contract test for the generated stateless-contract API.
 *
 * The ddk-rn bindings run over JSI/Hermes and can't execute in a Node/Jest
 * environment (no native TurboModule), so runtime behavior is covered by the
 * shared Rust: `ddk-ffi` unit tests and the `ddk-ts` (NAPI) suite exercise the
 * exact same `ddk_ffi::contract` functions this binding wraps.
 *
 * What this test guards is that the bindings were GENERATED completely and
 * consistently across the whole JSI stack — every function/record/class is
 * present in the TypeScript surface AND has its native symbol in the FFI layer.
 * It catches the classic regression where ddk-ffi changed but ddk-rn wasn't
 * regenerated (e.g. a function silently missing from the generated bindings).
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8');
const ddkFfi = read('ddk_ffi.ts'); // the TypeScript surface consumers import
const ffiLayer = read('ddk_ffi-ffi.ts'); // the native JSI symbol declarations
const index = read('index.tsx'); // the package entrypoint

const toSnake = (name) => name.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

const FUNCTIONS = [
  'chainHashFromNetwork',
  'fundingInput',
  'dlcInputMaxWitnessLen',
  'createOffer',
  'validateOffer',
  'validateAccept',
  'validateSign',
  'computeContractId',
  'contractInfoPayouts',
  'acceptOffer',
  'createFundingPsbt',
  'dlcTransactionsFromMessages',
  'signFundingPsbtWithDescriptor',
  'signAccept',
  'signAcceptSpliced',
  'finalizeSign',
  'finalizeSignSpliced',
  'signContractCet',
  'signContractRefund',
  'createDlcSpliceInput',
];

const RECORD_TYPES = [
  'CreateOfferParams',
  'ContractPartyParams',
  'AcceptOfferParams',
  'AcceptResult',
  'SignResult',
  'SpliceKeyRef',
  'OracleAttestationRef',
  'DescriptorInput',
  'PayoutRow',
  'ContractPayouts',
];

const CONSTRUCTORS = ['fromMnemonic', 'fromSeed', 'fromXprv', 'fromDescriptor'];

describe('generated ddk-rn bindings — stateless contract surface', () => {
  test.each(FUNCTIONS)('exposes function %s in the TS surface', (name) => {
    expect(ddkFfi).toContain(`export function ${name}(`);
  });

  test.each(FUNCTIONS)('function %s has a native JSI binding', (name) => {
    expect(ffiLayer).toContain(`ddk_ffi_fn_func_${toSnake(name)}`);
  });

  test.each(RECORD_TYPES)('exposes record type %s', (name) => {
    expect(ddkFfi).toContain(`export type ${name} = {`);
  });

  test('exposes the ContractKeyProvider class', () => {
    expect(ddkFfi).toContain('export class ContractKeyProvider');
    expect(ddkFfi).toMatch(/fundingPubkey\(temporaryContractId/);
    expect(ffiLayer).toContain(
      'ddk_ffi_fn_method_contractkeyprovider_funding_pubkey'
    );
  });

  test.each(CONSTRUCTORS)(
    'ContractKeyProvider.%s constructor is generated',
    (ctor) => {
      expect(ddkFfi).toContain(`static ${ctor}(`);
      expect(ffiLayer).toContain(
        `ddk_ffi_fn_constructor_contractkeyprovider_${toSnake(ctor)}`
      );
    }
  );

  test('exposes the Party enum with both variants', () => {
    expect(ddkFfi).toContain('export enum Party {');
    expect(ddkFfi).toMatch(
      /enum Party \{[\s\S]*?Offer[\s\S]*?Accept[\s\S]*?\}/
    );
  });

  test('the package entrypoint re-exports the generated bindings', () => {
    expect(index).toContain("export * from './/ddk_ffi'");
  });
});
