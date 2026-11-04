/**
 * Where pressing Join on the invite card leads (ADR-0036).
 *
 * A signed-in visitor joins at once. A visitor with no session is asked first
 * whether they are new or already have an Account here, because the answer
 * decides whether an Account is created at all — and a second Account for a
 * person who already has one is the bug this card exists to prevent. The two
 * answers are equals; Recovery sits under "already have one" for a member with
 * no other Device to link from.
 */
export type InviteJoinStep = "card" | "choose" | "new" | "link" | "recover";

export type InviteJoinEvent =
  | { kind: "join"; signedIn: boolean }
  | { kind: "new" }
  | { kind: "existing" }
  | { kind: "lostDevice" }
  | { kind: "back" };

/** The next step, or `"accept"` when the Invite should be accepted now. */
export function nextInviteJoinStep(step: InviteJoinStep, event: InviteJoinEvent): InviteJoinStep | "accept" {
  switch (event.kind) {
    case "join":
      if (step !== "card") return step;
      return event.signedIn ? "accept" : "choose";
    case "new":
      return step === "choose" ? "new" : step;
    case "existing":
      return step === "choose" ? "link" : step;
    case "lostDevice":
      return step === "link" ? "recover" : step;
    case "back":
      if (step === "recover") return "link";
      if (step === "new" || step === "link") return "choose";
      return "card";
  }
}

/** The letter a Server is drawn with where it has no picture: its name's first character. */
export function serverMark(name: string) {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "V";
}
