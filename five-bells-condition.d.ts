declare module 'five-bells-condition' {
  export class PreimageSha256 {
    setPreimage(preimage: Buffer): void;
    getConditionBinary(): Buffer;
    serializeBinary(): Buffer;
  }
  // Add more if needed, but this covers basics for our code
}
