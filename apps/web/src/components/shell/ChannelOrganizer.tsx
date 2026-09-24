import type { CategorySummary, RoomKind, RoomSummary, ServerRoomLayout } from "@voxly/shared";
import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Translate } from "../../app/types.js";
import { ConfirmDialog } from "../../components/ui/Dialogs.js";
import { MoreIcon, PlusIcon } from "../../components/ui/Icons.js";
import { channelGroups, moveCategory, moveCategoryBy, moveRoom, moveRoomBy, roomLayout, type ChannelDropTarget, type ChannelGroup } from "../../lib/channelLayout.js";
import { ContextMenu } from "../ContextMenu.js";
import type { SidebarActionMenuController } from "./SidebarMenus.js";

type DragKind = "category" | "room";
type DropState = { kind: "category"; categoryId: string } | { kind: "room"; roomId: string; categoryId: string | null; after: boolean } | { kind: "group"; categoryId: string | null };
type DragState = {
  kind: DragKind;
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  started: boolean;
  target: DropState | null;
};
type EditorState = {
  kind: "category" | "rename" | "room";
  categoryId: string | null;
  initialName: string;
  roomKind: RoomKind;
  position: { top: number; left: number };
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

function editorPosition(trigger: HTMLElement | null) {
  const rect = trigger?.getBoundingClientRect();
  const width = 248;
  const height = 250;
  return {
    top: rect ? Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - height - 8)) : 72,
    left: rect ? Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) : 24
  };
}

export function ChannelOrganizer({
  serverId,
  categories,
  rooms,
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
  canManage: boolean;
  actionMenu: SidebarActionMenuController;
  t: Translate;
  onCreateCategory: (name: string) => Promise<void>;
  onRenameCategory: (categoryId: string, name: string) => Promise<void>;
  onDeleteCategory: (categoryId: string) => Promise<void>;
  onCreateRoom: (name: string, kind: RoomKind, categoryId: string | null) => Promise<void>;
  onSaveLayout: (layout: ServerRoomLayout) => Promise<void>;
  renderRoom: (room: RoomSummary, dragHandle: ReactNode, actions: ChannelRoomActions) => ReactNode;
}) {
  const organizerRef = useRef<HTMLDivElement | null>(null);
  const dragCandidateRef = useRef<DragState | null>(null);
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
  const groups = useMemo(() => channelGroups(categories, rooms), [categories, rooms]);
  const [localGroups, setLocalGroups] = useState(groups);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(serverId));

  useEffect(() => setLocalGroups(groups), [groups]);
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
    const input = document.querySelector<HTMLInputElement>(".channel-organizer-editor input[name='organizerName']");
    input?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeEditor();
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const form = document.querySelector(".channel-organizer-editor");
      if (form && !form.contains(event.target as Node) && !editor.trigger?.contains(event.target as Node)) closeEditor();
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [editor]);

  function closeEditor() {
    const trigger = editor?.trigger;
    setEditor(null);
    setEditorName("");
    setEditorError(false);
    window.setTimeout(() => trigger?.focus(), 0);
  }

  function openEditor(kind: EditorState["kind"], categoryId: string | null, trigger: HTMLElement | null, initialName = "") {
    setEditor({ kind, categoryId, initialName, roomKind: "text", position: editorPosition(trigger), trigger });
    setEditorName(initialName);
    setEditorRoomKind("text");
    setEditorError(false);
  }

  async function submitEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = editorName.trim();
    if (!editor || name.length < 2) {
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
      const header = node.closest<HTMLElement>("[data-drop-category]");
      const id = header?.dataset.dropCategory;
      if (id) return { kind: "category", categoryId: id };
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
    const handle = (event.target as Element).closest<HTMLElement>("[data-drag-kind]");
    if (!handle) return;
    const kind = handle.dataset.dragKind as DragKind;
    const id = handle.dataset.dragId;
    if (!id || (kind !== "category" && kind !== "room")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragCandidateRef.current = {
      kind,
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      started: false,
      target: null
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const candidate = dragCandidateRef.current;
    if (!candidate || candidate.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY);
    if (!candidate.started && distance < 6) return;
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
    if (candidate.started) event.preventDefault();
    const target = targetAt(event.clientX, event.clientY, candidate.kind);
    dragCandidateRef.current = null;
    setDragging(null);
    if (!candidate.started || !target) return;
    if (candidate.kind === "room") {
      const roomTarget: ChannelDropTarget = target.kind === "room"
        ? { categoryId: target.categoryId, roomId: target.roomId, after: target.after }
        : target.kind === "group" ? { categoryId: target.categoryId } : { categoryId: target.categoryId };
      void persist(moveRoom(localGroups, candidate.id, roomTarget));
      return;
    }
    if (target.kind === "category") {
      const targetNode = Array.from(organizerRef.current?.querySelectorAll<HTMLElement>("[data-drop-category]") ?? [])
        .find((node) => node.dataset.dropCategory === target.categoryId);
      const after = Boolean(targetNode && event.clientY >= targetNode.getBoundingClientRect().top + targetNode.getBoundingClientRect().height / 2);
      void persist(moveCategory(localGroups, candidate.id, target.categoryId, after));
    }
  }

  function onPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragCandidateRef.current?.pointerId !== event.pointerId) return;
    dragCandidateRef.current = null;
    setDragging(null);
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

  function roomHandle(room: RoomSummary) {
    if (!canManage) return null;
    return <button
      className="channel-drag-handle"
      type="button"
      data-drag-kind="room"
      data-drag-id={room.id}
      aria-label={t("channel.dragHandle", { channel: room.name })}
      aria-disabled={saving}
      aria-keyshortcuts={["ArrowUp", "ArrowDown"].join(" ")}
      title={t("channel.dragHandle", { channel: room.name })}
      onKeyDown={(event) => {
        if (saving || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        void persist(moveRoomBy(localGroups, room.id, event.key === "ArrowUp" ? -1 : 1));
      }}
    >⋮⋮</button>;
  }

  return (
    <div
      className={`channel-organizer ${dragging?.started ? "is-dragging" : ""}`}
      ref={organizerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={openBackgroundMenu}
    >
      {canManage ? <div className="channel-organizer-tools">
        <span className="label">{t("room.channels")}</span>
        <button className="channel-create-trigger category-create-trigger" type="button" aria-label={t("category.create")} onClick={(event) => openEditor("category", null, event.currentTarget)}>
          <PlusIcon /><span>{t("category.create")}</span>
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
        const isCollapsed = category ? collapsed.has(category.id) : false;
        const isGroupDropTarget = dragging?.target?.kind === "group" && dragging.target.categoryId === (category?.id ?? null);
        const categoryMenuKey = `category:${id || "uncategorized"}`;
        const categoryHandle = category && canManage ? <button
          className="channel-drag-handle category-drag-handle"
          type="button"
          data-drag-kind="category"
          data-drag-id={category.id}
          aria-label={t("category.dragHandle", { category: category.name })}
          aria-disabled={saving}
          aria-keyshortcuts={["ArrowUp", "ArrowDown"].join(" ")}
          title={t("category.dragHandle", { category: category.name })}
          onKeyDown={(event) => {
            if (saving || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
            event.preventDefault();
            void persist(moveCategoryBy(localGroups, category.id, event.key === "ArrowUp" ? -1 : 1));
          }}
        >⋮⋮</button> : null;
        return (
          <section className={`rail-section channel-category ${isGroupDropTarget ? "is-drop-target" : ""}`} data-category-id={id} key={category?.id ?? "uncategorized"}>
            <div
              className={`rail-section-head channel-category-head ${isGroupDropTarget || (dragging?.target?.kind === "category" && dragging.target.categoryId === category?.id) ? "is-drop-target" : ""}`}
              data-drop-category={id}
              data-drop-group={id}
              onContextMenu={category && canManage ? (event) => {
                event.preventDefault();
                actionMenu.open({ key: categoryMenuKey, x: event.clientX, y: event.clientY, menuWidth: 196, menuHeight: 184, trigger: null });
              } : undefined}
            >
              {category ? categoryHandle : null}
              {category ? <button
                className="channel-category-toggle"
                type="button"
                aria-expanded={!isCollapsed}
                aria-label={t(isCollapsed ? "category.expand" : "category.collapse", { category: label })}
                onClick={() => toggleCollapsed(category.id)}
              >
                <span className={`channel-category-chevron ${isCollapsed ? "is-collapsed" : ""}`} aria-hidden="true">⌄</span>
                <span className="label">{label}</span>
              </button> : <span className="label channel-uncategorized-label">{label}</span>}
              {canManage ? <button
                className="channel-create-trigger"
                type="button"
                aria-label={t("channel.createInCategory", { category: label })}
                title={t("channel.createInCategory", { category: label })}
                onClick={(event) => openEditor("room", category?.id ?? null, event.currentTarget)}
              ><PlusIcon /></button> : null}
              {category && canManage ? <button
                className="sidebar-menu-trigger category-menu-trigger"
                type="button"
                aria-label={t("category.actionsFor", { category: category.name })}
                aria-haspopup="dialog"
                aria-expanded={actionMenu.active?.key === categoryMenuKey}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  actionMenu.open({ key: categoryMenuKey, x: rect.right - 196, y: rect.bottom + 4, menuWidth: 196, menuHeight: 184, trigger: event.currentTarget });
                }}
              ><MoreIcon /></button> : null}
            </div>
            {category && actionMenu.active?.key === categoryMenuKey ? (
              <ContextMenu descriptor={actionMenu.active} label={t("category.actionsFor", { category: category.name })} onClose={actionMenu.close}>
                <button type="button" role="menuitem" onClick={() => { actionMenu.close(); openEditor("rename", category.id, null, category.name); }}>{t("category.rename")}</button>
                <button type="button" role="menuitem" disabled={groupIndex <= 1 || saving} onClick={() => { actionMenu.close(); void persist(moveCategoryBy(localGroups, category.id, -1)); }}>{t("category.moveUp")}</button>
                <button type="button" role="menuitem" disabled={groupIndex >= localGroups.length - 1 || saving} onClick={() => { actionMenu.close(); void persist(moveCategoryBy(localGroups, category.id, 1)); }}>{t("category.moveDown")}</button>
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
                  {renderRoom(room, roomHandle(room), {
                    moveTo: (categoryId) => moveRoomTo(room.id, categoryId),
                    moveUp: () => { void persist(moveRoomBy(localGroups, room.id, -1)); },
                    moveDown: () => { void persist(moveRoomBy(localGroups, room.id, 1)); },
                    canMoveUp: roomIndex > 0,
                    canMoveDown: roomIndex < group.rooms.length - 1
                  })}
                </div>
              ))}
              {group.rooms.length === 0 ? <div className="channel-category-empty" aria-hidden="true" /> : null}
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
        <div className="channel-organizer-editor" role="dialog" aria-modal="false" aria-label={t(editor.kind === "room" ? "channel.create" : editor.kind === "category" ? "category.create" : "category.rename")} style={editor.position}>
          <form onSubmit={(event) => void submitEditor(event)}>
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
                <input className="input" name="organizerName" value={editorName} onChange={(event) => setEditorName(event.currentTarget.value)} maxLength={64} minLength={2} required autoComplete="off" />
              </label>
            </> : <label className="form-field">
              <span>{t("category.name")}</span>
              <input className="input" name="organizerName" value={editorName} onChange={(event) => setEditorName(event.currentTarget.value)} maxLength={64} minLength={2} required autoComplete="off" />
            </label>}
            {editorError ? <p className="error-text" role="alert">{t(editorName.trim().length < 2 ? "channel.nameTooShort" : editor.kind === "room" ? "channel.createFailed" : editor.kind === "category" ? "category.createFailed" : "category.renameFailed")}</p> : null}
            <div className="channel-create-actions">
              <button className="btn btn-ghost" type="button" disabled={editorBusy} onClick={closeEditor}>{t("common.cancel")}</button>
              <button className="btn btn-primary" type="submit" disabled={editorBusy}>{t(editorBusy ? "channel.creating" : "channel.create")}</button>
            </div>
          </form>
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
