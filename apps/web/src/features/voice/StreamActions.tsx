import { useCallback, useState, type ReactNode } from "react";
import type { Translate } from "../../app/types.js";
import { ContextMenu } from "../../components/ContextMenu.js";
import { MoreIcon, ScreenIcon } from "../../components/ui/Icons.js";
import { VolumeControl } from "../../components/ui/Primitives.js";
import { createContextMenuDescriptor, type ContextMenuDescriptor } from "../../lib/contextMenu.js";

/** Both menu entry points share the same stream controls, including in fullscreen. */
export function StreamActions({
  name,
  watched,
  volume,
  onVolume,
  onUnwatch,
  t,
  children
}: {
  name: string;
  watched: boolean;
  volume?: number;
  onVolume?(value: number): void;
  onUnwatch(): void;
  t: Translate;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState<ContextMenuDescriptor | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const open = (x: number, y: number, trigger: HTMLButtonElement | null) =>
    setMenu(
      createContextMenuDescriptor({
        key: `stream:${name}`,
        x,
        y,
        trigger,
        menuWidth: 220,
        menuHeight: volume === undefined ? 64 : 140,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      })
    );
  return (
    <div
      className="stream-actions"
      onContextMenu={(event) => {
        if (!watched) return;
        event.preventDefault();
        event.stopPropagation();
        open(event.clientX, event.clientY, null);
      }}
      onKeyDown={(event) => {
        if (!watched || (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        open(rect.right - 220, rect.top, null);
      }}
    >
      {children}
      {watched ? (
        <button
          className="icon-btn stream-menu-trigger"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={Boolean(menu)}
          aria-label={t("voice.streamOptions", { nickname: name })}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            open(rect.right - 220, rect.bottom + 4, event.currentTarget);
          }}
        >
          <MoreIcon />
        </button>
      ) : null}
      {menu && watched ? (
        <ContextMenu descriptor={menu} label={t("voice.streamOptions", { nickname: name })} onClose={close}>
          {volume !== undefined && onVolume ? (
            <VolumeControl label={t("voice.screenVolume")} value={volume} onChange={onVolume} />
          ) : null}
          <button
            className="context-menu-action"
            type="button"
            onClick={() => {
              close();
              onUnwatch();
            }}
          >
            <ScreenIcon off />
            <span>{t("voice.unwatchStream")}</span>
          </button>
        </ContextMenu>
      ) : null}
    </div>
  );
}
