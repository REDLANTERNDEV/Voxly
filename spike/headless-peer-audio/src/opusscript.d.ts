/**
 * opusscript ships no types. Only the decoding surface the ear uses is declared.
 */
declare module "opusscript" {
  class OpusScript {
    constructor(sampleRate: number, channels: number, application?: number);
    decode(packet: Buffer): Buffer;
    delete(): void;
    static Application: { AUDIO: number };
  }
  export = OpusScript;
}
