import type { VisualTarget } from "@voxly/shared";

/** Camera presentation can change independently of retained screen subscriptions. */
export function stageTileSelection(selectedKeys: ReadonlySet<string>, source: { key: string; target: VisualTarget | null }, retainedTargets: readonly VisualTarget[] = []) {
  if (selectedKeys.has(source.key)) return { localKeys: [] as string[], targets: [...retainedTargets], focusKey: null };
  return {
    localKeys: source.target ? [] : [source.key],
    targets: source.target ? [...retainedTargets, source.target] : [...retainedTargets],
    focusKey: source.key
  };
}

/** Fullscreen is a view of the stage; leaving it must retain the subscription. */
export function stageClickAction(fullscreen: boolean, focused: boolean) {
  return fullscreen ? "exit-fullscreen" as const : focused ? "dismiss" as const : "focus" as const;
}
