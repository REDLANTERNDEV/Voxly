import type { VisualTarget } from "@voxly/shared";

/** A tile selects one source; pressing the selected tile clears the stage. */
export function stageTileSelection(selectedKeys: ReadonlySet<string>, source: { key: string; target: VisualTarget | null }) {
  if (selectedKeys.has(source.key)) return { localKeys: [] as string[], targets: [] as VisualTarget[], focusKey: null };
  return {
    localKeys: source.target ? [] : [source.key],
    targets: source.target ? [source.target] : [],
    focusKey: source.key
  };
}
