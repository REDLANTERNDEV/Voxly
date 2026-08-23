/**
 * Reading a whole Ogg Opus file at once.
 *
 * The bot itself never does this — it reads a stream that arrives in pieces —
 * so this lives with the tests that want a file rather than in `src`, where it
 * would be production code with no production caller. It is the same
 * `OggOpusReader`, fed once.
 */

import { OggOpusReader } from "../src/audio.js";

export interface OggOpusFile {
  channels: number;
  /** Samples libopus needs to discard at the start; reported, not applied. */
  preSkip: number;
  /** One Opus packet per entry, header packets removed. */
  packets: Buffer[];
}

export function readOggOpus(file: Buffer): OggOpusFile {
  const reader = new OggOpusReader();
  const packets = reader.push(file);
  const identification = reader.identification;
  if (!identification) {
    throw new Error("Expected the first packet to be an OpusHead identification header");
  }
  return { ...identification, packets };
}
