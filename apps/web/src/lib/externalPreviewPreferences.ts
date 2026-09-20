import type { MessageEmbedProvider } from "./messageEmbeds.js";

export type ExternalPreviewPreferences = Record<MessageEmbedProvider, boolean>;

export const externalPreviewProviders = ["youtube", "x", "vimeo", "spotify"] as const;

export const defaultExternalPreviewPreferences: ExternalPreviewPreferences = {
  youtube: true,
  x: true,
  vimeo: true,
  spotify: true
};

export function externalPreviewStorageKey(userId: string) {
  return `voxly:external-previews:v1:${userId}`;
}

export function readExternalPreviewPreferences(
  storage: Pick<Storage, "getItem">,
  userId: string
): ExternalPreviewPreferences {
  try {
    const parsed = JSON.parse(storage.getItem(externalPreviewStorageKey(userId)) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object") return { ...defaultExternalPreviewPreferences };
    return Object.fromEntries(externalPreviewProviders.map((provider) => [
      provider,
      typeof (parsed as Record<string, unknown>)[provider] === "boolean"
        ? (parsed as Record<string, boolean>)[provider]
        : true
    ])) as ExternalPreviewPreferences;
  } catch {
    return { ...defaultExternalPreviewPreferences };
  }
}

export function saveExternalPreviewPreferences(
  storage: Pick<Storage, "setItem">,
  userId: string,
  preferences: ExternalPreviewPreferences
) {
  storage.setItem(externalPreviewStorageKey(userId), JSON.stringify(preferences));
}
