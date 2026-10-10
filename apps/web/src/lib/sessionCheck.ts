import type { createAuthRequestGate } from "./authRequestGate.js";

/** A delayed 401 answers only for its request, not for a newer browser cookie. */
export async function checkSessionAfterDisconnect(options: {
  gate: ReturnType<typeof createAuthRequestGate>;
  lookup: () => Promise<unknown>;
  isUnauthorized: (error: unknown) => boolean;
  signedOut: (error: unknown) => void;
}) {
  const generation = options.gate.begin();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await options.lookup();
      return;
    } catch (error: unknown) {
      if (!options.gate.isCurrent(generation) || !options.isUnauthorized(error)) return;
      if (attempt === 1) options.signedOut(error);
    }
  }
}
