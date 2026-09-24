import type { CategorySummary, RoomKind, RoomSummary, ServerRoomLayout } from "@voxly/shared";
import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Translate } from "../../app/types.js";
import { ConfirmDialog } from "../../components/ui/Dialogs.js";
import { ChevronIcon, MoreIcon, PlusIcon } from "../../components/ui/Icons.js";
import { channelGroups, moveGroup, moveGroupBy, moveRoom, moveRoomBy, roomLayout, type ChannelDropTarget, type ChannelGroup } from "../../lib/channelLayout.js";
import { ContextMenu } from "../ContextMenu.js";
import type { SidebarActionMenuController } from "./SidebarMenus.js";

type DragKind = "category" | "room";
type DropState = { kind: "category"; categoryId: string | null; after: boolean } | { kind: "room"; roomId: string; categoryId: string | null; after: boolean } | { kind: "group"; categoryId: string | null };
type DragState = {
  kind: DragKind;
  id: string;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  started: boolean;
  target: DropState | null;
};
type EditorState = {
  kind: "choose" | "category" | "rename" | "room";
  categoryId: string | null;
  trigger: HTMLElement | null;
};

const collapsedStoragePrefix = "voxly:collapsed-categories:v1:";

function readCollapsed(serverId: string) {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(`${collapsedStoragePrefix}${serverId}`) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set<string>();
  }
}

export function ChannelOrganizer({
  serverId,
  categories,
  rooms,
  uncategorizedPosition,
  canManage,
  actionMenu,
  t,
  onCreateCategory,
  onRenameCategory,
  onDeleteCategory,
  onCreateRoom,
  onSaveLayout,
  renderRoom
}: {
  serverId: string;
  categories: CategorySummary[];
  rooms: RoomSummary[];
  uncategorizedPosition: number;
  canManage: boolean;
  actionMenu: SidebarActionMenuController;
  t: Translate;
  onCreateCategory: (name: string) => Promise<void>;
  onRenameCategory: (categoryId: string, name: string) => Promise<void>;
  onDeleteCategory: (categoryId: string) => Promise<void>;
  onCreateRoom: (name: string, kind: RoomKind, categoryId: string | null) => Promise<void>;
  onSaveLayout: (layout: ServerRoomLayout) => Promise<void>;
  renderRoom: (room: RoomSummary, actions: ChannelRoomActions) => ReactNode;
}) {
  const organizerRef = useRef<HTMLDivElement | null>(null);
  const dragCandidateRef = useRef<DragState | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [saving, setSaving] = useState(false);
  const [layoutError, setLayoutError] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorName, setEditorName] = useState("");
  const [editorRoomKind, setEditorRoomKind] = useState<RoomKind>("text");
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CategorySummary | null>(null);
  const [deleteError, setDeleteError] = useState(false);
  const groups = useMemo(() => channelGroups(categories, rooms, uncategorizedPosition), [categories, rooms, uncategorizedPosition]);
  const [localGroups, setLocalGroups] = useState(groups);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(serverId));
  const categoryDropTarget = dragging?.kind === "category" && dragging.target?.kind === "category" ? dragging.target : null;
  const categoryDropPreview = categoryDropTarget && dragging?.kind === "category"
    ? moveGroup(localGroups, dragging.id === "__uncategorized__" ? null : dragging.id, categoryDropTarget.categoryId, categoryDropTarget.after)
    : localGroups;

  useEffect(() => setLocalGroups(groups), [groups]);
  useEffect(() => {
    const organizer = organizerRef.current;
    if (!organizer) return;
    const preventScrollDuringTouchDrag = (event: TouchEvent) => {
      if (dragCandidateRef.current?.started) event.preventDefault();
    };
    organizer.addEventListener("touchmove", preventScrollDuringTouchDrag, { passive: false });
    return () => organizer.removeEventListener("touchmove", preventScrollDuringTouchDrag);
  }, []);
  useEffect(() => setCollapsed(readCollapsed(serverId)), [serverId]);
  useEffect(() => {
    try {
      window.localStorage.setItem(`${collapsedStoragePrefix}${serverId}`, JSON.stringify([...collapsed]));
    } catch {
      // Collapse is a convenience preference; storage denial must not hide rooms.
    }
  }, [collapsed, serverId]);

  useEffect(() => {
    if (!editor) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const input = document.querySelector<HTMLInputElement>(".channel-organizer-editor input[name='organizerName']");
    const firstAction = document.querySelector<HTMLElement>(".channel-organizer-editor [data-autofocus='true']");
    (input ?? firstAction)?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !editorBusy) {
        closeEditor();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = document.querySelector<HTMLElement>(".channel-organizer-editor");
      const focusable = dialog?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])");
      if (!focusable?.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [editor, editorBusy]);

  function closeEditor() {
    const trigger = editor?.trigger;
    setEditor(null);
    setEditorName("");
    setEditorError(false);
    window.setTimeout(() => trigger?.focus(), 0);
  }

  function openEditor(kind: EditorState["kind"], categoryId: string | null, trigger: HTMLElement | null, initialName = "") {
    setEditor({ kind, categoryId, trigger });
    setEditorName(initialName);
    setEditorRoomKind("text");
    setEditorError(false);
  }

  async function submitEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = editorName.trim();
    if (!editor || editor.kind === "choose" || name.length < 2) {
      setEditorError(true);
      return;
    }
    setEditorBusy(true);
    setEditorError(false);
    try {
      if (editor.kind === "room") await onCreateRoom(name, editorRoomKind, editor.categoryId);
      else if (editor.kind === "category") await onCreateCategory(name);
      else if (editor.categoryId) await onRenameCategory(editor.categoryId, name);
      closeEditor();
    } catch {
      setEditorError(true);
    } finally {
      setEditorBusy(false);
    }
  }

  async function persist(next: ChannelGroup[]) {
    if (saving) return;
    setSaving(true);
    setLayoutError(false);
    setLocalGroups(next);
    try {
      await onSaveLayout(roomLayout(next));
    } catch {
      setLocalGroups(groups);
      setLayoutError(true);
    } finally {
      setSaving(false);
    }
  }

  function moveRoomTo(roomId: string, categoryId: string | null) {
    const next = moveRoom(localGroups, roomId, { categoryId });
    if (next !== localGroups) void persist(next);
  }

  function targetAt(x: number, y: number, kind: DragKind): DropState | null {
    const node = document.elementFromPoint(x, y);
    if (!(node instanceof Element)) return null;
    if (kind === "category") {
      const group = node.closest<HTMLElement>("[data-category-id]");
      if (group) {
        const rect = group.getBoundingClientRect();
        return {
          kind: "category",
          categoryId: group.dataset.categoryId || null,
          after: y >= rect.top + rect.height / 2
        };
      }
      return null;
    }
    const roomNode = node.closest<HTMLElement>("[data-drop-room]");
    if (roomNode) {
      const rect = roomNode.getBoundingClientRect();
      return {
        kind: "room",
        roomId: roomNode.dataset.dropRoom ?? "",
        categoryId: roomNode.dataset.dropCategoryId || null,
        after: y >= rect.top + rect.height / 2
      };
    }
    const group = node.closest<HTMLElement>("[data-drop-group]");
    if (group) return { kind: "group", categoryId: group.dataset.dropGroup || null };
    return null;
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!canManage || saving || event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest(".sidebar-menu-trigger, .channel-organizer-tools, .channel-organizer-modal")) return;
    const dragSurface = target.closest<HTMLElement>("[data-drag-kind]");
    if (!dragSurface) return;
    const kind = dragSurface.dataset.dragKind as DragKind;
    const id = dragSurface.dataset.dragId;
    if (!id || (kind !== "category" && kind !== "room")) return;
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    suppressClickRef.current = false;
    dragCandidateRef.current = {
      kind,
      id,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      started: false,
      target: null
    };
    if (event.pointerType === "touch") {
      longPressTimerRef.current = window.setTimeout(() => {
        const candidate = dragCandidateRef.current;
        if (!candidate || candidate.pointerId !== event.pointerId) return;
        const next = { ...candidate, started: true, target: targetAt(candidate.x, candidate.y, candidate.kind) };
        dragCandidateRef.current = next;
        organizerRef.current?.setPointerCapture(candidate.pointerId);
        setDragging(next);
      }, 320);
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const candidate = dragCandidateRef.current;
    if (!candidate || candidate.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY);
    if (!candidate.started && candidate.pointerType === "touch") {
      if (distance >= 6) {
        if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
        dragCandidateRef.current = null;
      }
      return;
    }
    if (!candidate.started && distance < 6) return;
    if (!candidate.started) event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    const rail = organizerRef.current?.closest<HTMLElement>(".rail");
    if (rail) {
      const bounds = rail.getBoundingClientRect();
      if (event.clientY < bounds.top + 32) rail.scrollTop -= 12;
      else if (event.clientY > bounds.bottom - 32) rail.scrollTop += 12;
    }
    const next = {
      ...candidate,
      x: event.clientX,
      y: event.clientY,
      started: true,
      target: targetAt(event.clientX, event.clientY, candidate.kind)
    };
    dragCandidateRef.current = next;
    setDragging(next);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const candidate = dragCandidateRef.current;
    if (!candidate || candidate.pointerId !== event.pointerId) return;
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
    if (candidate.started) event.preventDefault();
    const target = targetAt(event.clientX, event.clientY, candidate.kind);
    dragCandidateRef.current = null;
    setDragging(null);
    if (!candidate.started) return;
    suppressClickRef.current = true;
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    if (!target) return;
    if (candidate.kind === "room") {
      const roomTarget: ChannelDropTarget = target.kind === "room"
        ? { categoryId: target.categoryId, roomId: target.roomId, after: target.after }
        : target.kind === "group" ? { categoryId: target.categoryId } : { categoryId: target.categoryId };
      void persist(moveRoom(localGroups, candidate.id, roomTarget));
      return;
    }
    if (target.kind === "category") {
      const sourceId = candidate.id === "__uncategorized__" ? null : candidate.id;
      const next = moveGroup(localGroups, sourceId, target.categoryId, target.after);
      if (next !== localGroups) void persist(next);
    }
  }

  function onPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragCandidateRef.current?.pointerId !== event.pointerId) return;
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
    dragCandidateRef.current = null;
    setDragging(null);
  }

  function onClickCapture(event: MouseEvent<HTMLDivElement>) {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  function openBackgroundMenu(event: MouseEvent<HTMLDivElement>) {
    if (!canManage || event.defaultPrevented) return;
    const target = event.target as Element;
    if (target.closest("button, a, input, select, [data-drop-room], [data-drop-category]")) return;
    event.preventDefault();
    actionMenu.open({
      key: "channel-layout:background",
      x: event.clientX,
      y: event.clientY,
      menuWidth: 196,
      menuHeight: 88,
      trigger: null
    });
  }

  function toggleCollapsed(categoryId: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  }

  return (
    <div
      className={`channel-organizer ${dragging?.started ? "is-dragging" : ""}`}
      ref={organizerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClickCapture={onClickCapture}
      onContextMenu={openBackgroundMenu}
    >
      {canManage ? <div className="channel-organizer-tools">
        <span className="label">{t("room.channels")}</span>
        <button className="channel-create-trigger" type="button" aria-label={t("organizer.createTitle")} title={t("organizer.createTitle")} onClick={(event) => openEditor("choose", null, event.currentTarget)}>
          <PlusIcon />
        </button>
      </div> : null}
      {actionMenu.active?.key === "channel-layout:background" ? (
        <ContextMenu descriptor={actionMenu.active} label={t("room.channelActions")} onClose={actionMenu.close}>
          <button type="button" role="menuitem" onClick={() => { actionMenu.close(); openEditor("room", null, null); }}>{t("channel.create")}</button>
          <button type="button" role="menuitem" onClick={() => { actionMenu.close(); openEditor("category", null, null); }}>{t("category.create")}</button>
        </ContextMenu>
      ) : null}
      {localGroups.map((group, groupIndex) => {
        const category = group.category;
        const id = category?.id ?? "";
        const label = category?.name ?? t("room.uncategorized");
        const collapseId = category?.id ?? "uncategorized";
        const isCollapsed = category ? collapsed.has(collapseId) : false;
        const isGroupDropTarget = dragging?.target?.kind === "group" && dragging.target.categoryId === (category?.id ?? null);
        const categoryDropClass = categoryDropTarget
          && categoryDropPreview !== localGroups
          && categoryDropTarget.categoryId === (category?.id ?? null)
          ? `is-category-drop-${categoryDropTarget.after ? "after" : "before"}`
          : "";
        const categoryMenuKey = `category:${id || "uncategorized"}`;
        return (
          <section className={`rail-section channel-category ${isGroupDropTarget ? "is-drop-target" : ""} ${categoryDropClass}`} data-category-id={id} key={category?.id ?? "uncategorized"}>
            <div
              className={`rail-section-head channel-category-head ${category ? "" : "channel-uncategorized-head"} ${isGroupDropTarget ? "is-drop-target" : ""}`}
              data-drop-category={id}
              data-drop-group={id}
              data-drag-kind={canManage ? "category" : undefined}
              data-drag-id={canManage ? category?.id ?? "__uncategorized__" : undefined}
              tabIndex={canManage && !category ? 0 : undefined}
              role={canManage && !category ? "group" : undefined}
              aria-label={canManage && !category ? t("category.dragHandle", { category: label }) : undefined}
              aria-keyshortcuts={canManage && !category ? ["ArrowUp", "ArrowDown"].join(" ") : undefined}
              onKeyDown={canManage && !category ? (event) => {
                if (saving || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                event.preventDefault();
                void persist(moveGroupBy(localGroups, null, event.key === "ArrowUp" ? -1 : 1));
              } : undefined}
              onContextMenu={category && canManage ? (event) => {
                event.preventDefault();
                actionMenu.open({ key: categoryMenuKey, x: event.clientX, y: event.clientY, menuWidth: 220, menuHeight: 220, trigger: null });
              } : undefined}
            >
              {category ? <button
                className="channel-category-toggle"
                type="button"
                aria-expanded={!isCollapsed}
                aria-label={t(isCollapsed ? "category.expand" : "category.collapse", { category: label })}
                onClick={() => toggleCollapsed(collapseId)}
              >
                <ChevronIcon direction={isCollapsed ? "right" : "down"} />
                <span className="label">{label}</span>
              </button> : null}
              {category && canManage ? <button
                className="sidebar-menu-trigger category-menu-trigger"
                type="button"
                aria-label={t("category.actionsFor", { category: category.name })}
                aria-haspopup="dialog"
                aria-expanded={actionMenu.active?.key === categoryMenuKey}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  actionMenu.open({ key: categoryMenuKey, x: rect.right - 220, y: rect.bottom + 4, menuWidth: 220, menuHeight: 220, trigger: event.currentTarget });
                }}
              ><MoreIcon /></button> : null}
            </div>
            {category && actionMenu.active?.key === categoryMenuKey ? (
              <ContextMenu descriptor={actionMenu.active} label={t("category.actionsFor", { category: category.name })} onClose={actionMenu.close}>
                <button type="button" role="menuitem" onClick={() => { actionMenu.close(); openEditor("room", category.id, null); }}>{t("channel.createInCategory", { category: category.name })}</button>
                <button type="button" role="menuitem" onClick={() => { actionMenu.close(); openEditor("rename", category.id, null, category.name); }}>{t("category.rename")}</button>
                <button type="button" role="menuitem" disabled={groupIndex === 0 || saving} onClick={() => { actionMenu.close(); void persist(moveGroupBy(localGroups, category.id, -1)); }}>{t("category.moveUp")}</button>
                <button type="button" role="menuitem" disabled={groupIndex >= localGroups.length - 1 || saving} onClick={() => { actionMenu.close(); void persist(moveGroupBy(localGroups, category.id, 1)); }}>{t("category.moveDown")}</button>
                <button className="is-danger" type="button" role="menuitem" onClick={() => { actionMenu.close(); setDeleteTarget(category); }}>{t("category.delete")}</button>
              </ContextMenu>
            ) : null}
            {!isCollapsed ? <div className="channel-category-rooms" data-drop-group={id}>
              {group.rooms.map((room, roomIndex) => (
                <div
                  className={`channel-sort-item ${dragging?.target?.kind === "room" && dragging.target.roomId === room.id ? `is-drop-${dragging.target.after ? "after" : "before"}` : ""}`}
                  data-drop-room={room.id}
                  data-drop-category-id={category?.id ?? ""}
                  key={room.id}
                >
                  {renderRoom(room, {
                    moveTo: (categoryId) => moveRoomTo(room.id, categoryId),
                    moveUp: () => { void persist(moveRoomBy(localGroups, room.id, -1)); },
                    moveDown: () => { void persist(moveRoomBy(localGroups, room.id, 1)); },
                    canMoveUp: roomIndex > 0,
                    canMoveDown: roomIndex < group.rooms.length - 1
                  })}
                </div>
              ))}
              {group.rooms.length === 0 ? <div
                className={`channel-category-empty ${category ? "" : "channel-uncategorized-empty"}`}
                data-drag-kind={canManage && !category ? "category" : undefined}
                data-drag-id={canManage && !category ? "__uncategorized__" : undefined}
                aria-hidden="true"
              /> : null}
            </div> : null}
          </section>
        );
      })}
      {layoutError ? <p className="error-text" role="alert">{t("channel.layoutFailed")}</p> : null}
      {deleteError ? <p className="error-text" role="alert">{t("category.deleteFailed")}</p> : null}
      {deleteTarget ? <ConfirmDialog
        cancelLabel={t("common.cancel")}
        title={t("category.deleteTitle", { category: deleteTarget.name })}
        copy={t("category.deleteCopy")}
        confirmLabel={t("common.delete")}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          setDeleteError(false);
          void onDeleteCategory(target.id).catch(() => setDeleteError(true));
        }}
      /> : null}
      {editor ? createPortal(
        <div className="channel-organizer-modal" onPointerDown={(event) => { if (event.target === event.currentTarget && !editorBusy) closeEditor(); }}>
          <section className="channel-organizer-editor" role="dialog" aria-modal="true" aria-labelledby="channel-organizer-title">
            <header className="channel-organizer-modal-head">
              <h2 id="channel-organizer-title">{t(editor.kind === "choose" ? "organizer.createTitle" : editor.kind === "room" ? "organizer.createChannelTitle" : editor.kind === "category" ? "organizer.createCategoryTitle" : "category.rename")}</h2>
              <button className="icon-btn" type="button" aria-label={t("common.close")} disabled={editorBusy} onClick={closeEditor}>×</button>
            </header>
            {editor.kind === "choose" ? <div className="channel-organizer-choices">
              <button className="channel-organizer-choice" type="button" data-autofocus="true" onClick={() => setEditor((current) => current ? { ...current, kind: "category" } : current)}>
                <strong>{t("organizer.chooseCategory")}</strong>
                <span>{t("category.name")}</span>
              </button>
              <button className="channel-organizer-choice" type="button" onClick={() => setEditor((current) => current ? { ...current, kind: "room" } : current)}>
                <strong>{t("organizer.chooseChannel")}</strong>
                <span>{t("channel.type")}</span>
              </button>
            </div> : <form onSubmit={(event) => void submitEditor(event)}>
              {editor.kind === "room" ? <>
                <label className="form-field">
                  <span>{t("channel.type")}</span>
                  <select className="input" value={editorRoomKind} onChange={(event) => setEditorRoomKind(event.currentTarget.value as RoomKind)}>
                    <option value="text">{t("channel.typeText")}</option>
                    <option value="voice">{t("channel.typeVoice")}</option>
                  </select>
                </label>
                <label className="form-field">
                  <span>{t(editorRoomKind === "text" ? "channel.textName" : "channel.voiceName")}</span>
                  <input className="input" data-autofocus="true" name="organizerName" value={editorName} onChange={(event) => setEditorName(event.currentTarget.value)} maxLength={64} minLength={2} required autoComplete="off" />
                </label>
              </> : <label className="form-field">
                <span>{t("category.name")}</span>
                <input className="input" data-autofocus="true" name="organizerName" value={editorName} onChange={(event) => setEditorName(event.currentTarget.value)} maxLength={64} minLength={2} required autoComplete="off" />
              </label>}
              {editorError ? <p className="error-text" role="alert">{t(editorName.trim().length < 2 ? "channel.nameTooShort" : editor.kind === "room" ? "channel.createFailed" : editor.kind === "category" ? "category.createFailed" : "category.renameFailed")}</p> : null}
              <div className="channel-create-actions">
                <button className="btn btn-ghost" type="button" disabled={editorBusy} onClick={() => {
                  if (editor.kind === "rename") closeEditor();
                  else { setEditor({ ...editor, kind: "choose" }); setEditorName(""); setEditorError(false); }
                }}>{t(editor.kind === "rename" ? "common.cancel" : "organizer.back")}</button>
                <button className="btn btn-primary" type="submit" disabled={editorBusy}>{t(editorBusy ? "channel.creating" : editor.kind === "rename" ? "common.save" : "channel.create")}</button>
              </div>
            </form>}
          </section>
        </div>,
        document.body
      ) : null}
    </div>
  );
}

export interface ChannelRoomActions {
  moveTo: (categoryId: string | null) => void;
  moveUp: () => void;
  moveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}
