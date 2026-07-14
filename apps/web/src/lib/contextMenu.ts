export interface ContextMenuDescriptor {
  key: string;
  position: { x: number; y: number };
  trigger: HTMLButtonElement | null;
}

export type ContextMenuAction =
  | { type: "open"; menu: ContextMenuDescriptor }
  | { type: "close" };

export function contextMenuReducer(
  _state: ContextMenuDescriptor | null,
  action: ContextMenuAction
): ContextMenuDescriptor | null {
  return action.type === "open" ? action.menu : null;
}

export function clampContextMenuPosition(input: {
  x: number;
  y: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}) {
  const margin = input.margin ?? 8;
  return {
    x: Math.max(margin, Math.min(input.x, input.viewportWidth - input.menuWidth - margin)),
    y: Math.max(margin, Math.min(input.y, input.viewportHeight - input.menuHeight - margin))
  };
}

export function createContextMenuDescriptor(input: Parameters<typeof clampContextMenuPosition>[0] & {
  key: string;
  trigger: HTMLButtonElement | null;
}): ContextMenuDescriptor {
  return {
    key: input.key,
    trigger: input.trigger,
    position: clampContextMenuPosition(input)
  };
}
