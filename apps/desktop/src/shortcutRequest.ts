import type { TranslationKey } from "./i18n.js";
import { bindingLabel } from "./shortcuts.js";

/** A remote Installation's request to change a global shortcut (ADR-0020). */
export interface ShortcutRequest {
  id: number;
  action: "mute" | "deafen" | "pushToTalk" | "pushToMute";
  binding: string | null;
  origin: string;
}

const actionNames: Record<ShortcutRequest["action"], TranslationKey> = {
  mute: "muteShortcut",
  deafen: "deafenShortcut",
  pushToTalk: "pushToTalk",
  pushToMute: "pushToMute"
};

/** Plain text for the dialog; every part comes from native code, never markup. */
export function shortcutRequestText(request: ShortcutRequest, t: (key: TranslationKey) => string): string {
  const action = t(actionNames[request.action]);
  const sentence = request.binding
    ? t("shortcutRequestSet").replace("{binding}", bindingLabel(request.binding, t("mouseButton")))
    : t("shortcutRequestClear");
  return `${sentence.replace("{action}", action).replace("{origin}", request.origin)} ${t("shortcutRequestHint")}`;
}

/**
 * Asks the member, then answers native code. Only the member's Confirm
 * accepts; closing the dialog any other way declines.
 */
export async function presentShortcutRequest(
  request: ShortcutRequest,
  ask: (text: string) => Promise<boolean>,
  answer: (id: number, accept: boolean) => Promise<unknown>,
  t: (key: TranslationKey) => string
) {
  const accepted = await ask(shortcutRequestText(request, t));
  return answer(request.id, accepted);
}
