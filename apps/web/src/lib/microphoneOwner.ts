import type { MicrophoneInput } from "./microphoneInput.js";

/** Owns the active graph; a prepared replacement remains caller-owned until adopted. */
export class MicrophoneOwner {
  private input: MicrophoneInput | null = null;
  get current() {
    return this.input;
  }

  adopt(input: MicrophoneInput) {
    if (this.input === input) return;
    const previous = this.input;
    this.input = input;
    previous?.dispose();
  }

  release() {
    const previous = this.input;
    this.input = null;
    previous?.dispose();
  }
}
