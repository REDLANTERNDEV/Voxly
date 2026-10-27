import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  autoUpdate,
  flip,
  shift,
  size,
  offset,
  safePolygon,
  FloatingNode,
  FloatingTree,
  useFloating,
  useFloatingNodeId,
  useFloatingParentNodeId,
  useHover,
  useClick,
  useRole,
  useListNavigation,
  useInteractions
} from "@floating-ui/react";
import { useMenuOverlays } from "./ContextMenu.js";

export interface SubmenuItem {
  id: string;
  label: string;
  disabled?: boolean;
}
type MenuSubmenuProps = {
  label: string;
  /** A flat list of choices. Leave it out and pass `children` for a panel of richer rows. */
  items?: readonly SubmenuItem[];
  onSelect?(id: string): void;
  /**
   * Panel mode: the flyout holds these rows instead of `items`, and may hold
   * further submenus. They share one floating tree, so hovering a child keeps
   * its parent open and Escape closes the innermost panel first.
   */
  children?: ReactNode;
  /** Leading glyph on the trigger, decorative: the label names it. */
  icon?: ReactNode;
  /** A second line under the trigger's label, read as its description. */
  description?: string;
  /** The panel's accessible name, when the trigger's label alone would not say what is being chosen. */
  panelLabel?: string;
  className?: string;
};

/** Rows a panel-mode flyout moves between with the arrow keys: its own, not a nested panel's. */
const panelRows =
  ':scope > [role^="menuitem"]:not(:disabled), :scope > .menu-submenu > .menu-submenu-trigger, :scope > * > [role^="menuitem"]:not(:disabled)';

const noItems: readonly SubmenuItem[] = [];

/**
 * The side a parent flyout opened on. A nested flyout keeps going the same way,
 * so a chain that had to open leftwards from the dock does not double back over
 * its own parent.
 */
const SubmenuSide = createContext<"right" | "left">("right");

export function MenuSubmenu(props: MenuSubmenuProps) {
  const parentId = useFloatingParentNodeId();
  if (parentId === null) {
    return (
      <FloatingTree>
        <SubmenuNode {...props} />
      </FloatingTree>
    );
  }
  return <SubmenuNode {...props} />;
}

function SubmenuNode({
  label,
  items = noItems,
  onSelect,
  children,
  icon,
  description,
  panelLabel,
  className
}: MenuSubmenuProps) {
  const panelMode = children !== undefined;
  const nodeId = useFloatingNodeId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const keyboardOpenRef = useRef(false);
  const listRef = useRef<Array<HTMLElement | null>>([]);
  const overlays = useMenuOverlays();
  const descriptionId = useId();
  const side = useContext(SubmenuSide);
  const { refs, floatingStyles, context, placement, isPositioned } = useFloating({
    nodeId,
    open,
    onOpenChange: (next, event) => {
      // Enter or Space on the trigger arrives as a click with no pointer behind it.
      const fromKeyboard = event?.type === "keydown" || (event?.type === "click" && (event as MouseEvent).detail === 0);
      keyboardOpenRef.current = next && fromKeyboard;
      setOpen(next);
    },
    placement: side === "left" ? "left-start" : "right-start",
    strategy: "fixed",
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(8),
      // Choose a side only on the main axis: a flyout near the bottom of the
      // screen slides up (shift, below) rather than flipping on top of its parent.
      flip({
        padding: 8,
        crossAxis: false,
        fallbackPlacements:
          side === "left" ? ["right-start", "bottom-start", "top-start"] : ["left-start", "bottom-start", "top-start"]
      }),
      shift({ padding: 8, crossAxis: true }),
      size({
        padding: 8,
        apply({ availableWidth, availableHeight, elements }) {
          Object.assign(elements.floating.style, {
            maxWidth: `${Math.max(0, availableWidth)}px`,
            maxHeight: `${Math.max(0, Math.min(260, availableHeight))}px`
          });
        }
      })
    ]
  });
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    useHover(context, { handleClose: safePolygon({ blockPointerEvents: false }), mouseOnly: true }),
    useClick(context),
    useRole(context, { role: "menu" }),
    useListNavigation(context, {
      listRef,
      activeIndex,
      onNavigate: setActiveIndex,
      nested: true,
      loop: true,
      enabled: !panelMode
    })
  ]);
  useLayoutEffect(() => {
    if (!open || !isPositioned || !keyboardOpenRef.current) return;
    if (panelMode) {
      panelRef.current?.querySelector<HTMLElement>(panelRows)?.focus();
      keyboardOpenRef.current = false;
      return;
    }
    const index = activeIndex ?? items.findIndex((item) => !item.disabled);
    if (index >= 0) {
      if (activeIndex === null) setActiveIndex(index);
      listRef.current[index]?.focus();
    }
  }, [open, isPositioned, activeIndex, items, panelMode]);
  useEffect(() => {
    const node = refs.floating.current;
    if (!open || !node || !overlays) return;
    overlays.add(node);
    return () => {
      overlays.delete(node);
    };
  }, [open, overlays, refs.floating]);
  const movePanelFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // A nested panel is portalled elsewhere; its keys are its own to handle.
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(panelRows));
    if (!rows.length) return;
    event.preventDefault();
    const current = rows.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    rows[next]?.focus();
  };
  const closeOnKey = (event: React.KeyboardEvent) => {
    if (open && (event.key === "Escape" || event.key === "ArrowLeft")) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      (refs.domReference.current as HTMLElement | null)?.focus();
    }
  };
  return (
    <FloatingNode id={nodeId}>
      <div className="menu-submenu" onKeyDown={closeOnKey}>
        <button
          ref={refs.setReference}
          type="button"
          className={`menu-submenu-trigger${className ? ` ${className}` : ""}`}
          aria-describedby={description ? descriptionId : undefined}
          {...getReferenceProps()}
        >
          {icon}
          {description ? (
            <span className="menu-submenu-copy">
              <span>{label}</span>
              <small id={descriptionId}>{description}</small>
            </span>
          ) : (
            <span>{label}</span>
          )}
          <span className="menu-submenu-caret" aria-hidden="true">
            {open && placement.startsWith("left") ? "‹" : "›"}
          </span>
        </button>
        {open
          ? createPortal(
              <div
                ref={(node) => {
                  panelRef.current = node;
                  refs.setFloating(node);
                }}
                className={`context-menu menu-submenu-panel${panelMode ? " is-panel" : ""}`}
                style={{ ...floatingStyles, visibility: isPositioned ? undefined : "hidden" }}
                aria-label={panelLabel ?? label}
                {...getFloatingProps({
                  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
                    closeOnKey(event);
                    if (panelMode && !event.defaultPrevented) movePanelFocus(event);
                  }
                })}
              >
                {panelMode ? (
                  <SubmenuSide.Provider value={placement.startsWith("left") ? "left" : "right"}>
                    {children}
                  </SubmenuSide.Provider>
                ) : null}
                {panelMode
                  ? null
                  : items.map((item, index) => (
                      <button
                        key={item.id}
                        ref={(node) => {
                          listRef.current[index] = node;
                        }}
                        type="button"
                        role="menuitem"
                        disabled={item.disabled}
                        tabIndex={activeIndex === index ? 0 : -1}
                        {...getItemProps({
                          onClick: () => {
                            setOpen(false);
                            onSelect?.(item.id);
                          }
                        })}
                      >
                        {item.label}
                      </button>
                    ))}
              </div>,
              document.fullscreenElement ?? document.body
            )
          : null}
      </div>
    </FloatingNode>
  );
}
