declare module 'bs58check' {
  const bs58check: {
    encode(payload: Uint8Array): string
    decode(input: string): Uint8Array
  }
  export default bs58check
}
