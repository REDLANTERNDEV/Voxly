import type { CategorySummary, RoomSummary, ServerRoomLayout } from "@voxly/shared";

export interface ChannelGroup {
  category: CategorySummary | null;
  rooms: RoomSummary[];
}

export type ChannelDropTarget = {
  categoryId: string | null;
  roomId?: string;
  after?: boolean;
};

export function channelGroups(categories: CategorySummary[], rooms: RoomSummary[]): ChannelGroup[] {
  const groups: ChannelGroup[] = [{
    category: null,
    rooms: rooms.filter((room) => room.categoryId === null).sort((a, b) => a.position - b.position)
  }];
  for (const category of [...categories].sort((a, b) => a.position - b.position)) {
    groups.push({
      category,
      rooms: rooms.filter((room) => room.categoryId === category.id).sort((a, b) => a.position - b.position)
    });
  }
  return groups;
}

export function roomLayout(groups: ChannelGroup[]): ServerRoomLayout {
  return {
    uncategorizedRoomIds: groups.find((group) => group.category === null)?.rooms.map((room) => room.id) ?? [],
    categories: groups.filter((group): group is ChannelGroup & { category: CategorySummary } => group.category !== null)
      .map((group) => ({ categoryId: group.category.id, roomIds: group.rooms.map((room) => room.id) }))
  };
}

export function moveRoom(groups: ChannelGroup[], roomId: string, target: ChannelDropTarget): ChannelGroup[] {
  const sourceGroup = groups.find((group) => group.rooms.some((room) => room.id === roomId));
  const targetGroup = groups.find((group) => group.category?.id === target.categoryId || (group.category === null && target.categoryId === null));
  if (!sourceGroup || !targetGroup) return groups;
  if (target.roomId === roomId) return groups;

  const room = sourceGroup.rooms.find((item) => item.id === roomId)!;
  const next = groups.map((group) => ({ ...group, rooms: group.rooms.filter((item) => item.id !== roomId) }));
  const nextTarget = next.find((group) => group.category?.id === target.categoryId || (group.category === null && target.categoryId === null))!;
  const insertion = target.roomId ? nextTarget.rooms.findIndex((item) => item.id === target.roomId) : -1;
  const index = insertion < 0 ? nextTarget.rooms.length : insertion + (target.after ? 1 : 0);
  const moved = { ...room, categoryId: target.categoryId };
  nextTarget.rooms.splice(index, 0, moved);
  return normalizeGroups(next);
}

export function moveCategory(groups: ChannelGroup[], categoryId: string, targetId: string, after = false): ChannelGroup[] {
  const sourceIndex = groups.findIndex((group) => group.category?.id === categoryId);
  const targetIndex = groups.findIndex((group) => group.category?.id === targetId);
  if (sourceIndex < 1 || targetIndex < 1 || sourceIndex === targetIndex) return groups;
  const next = [...groups];
  const [source] = next.splice(sourceIndex, 1);
  const adjustedTarget = next.findIndex((group) => group.category?.id === targetId);
  next.splice(adjustedTarget + (after ? 1 : 0), 0, source);
  return normalizeGroups(next);
}

export function moveRoomBy(groups: ChannelGroup[], roomId: string, offset: -1 | 1): ChannelGroup[] {
  const groupIndex = groups.findIndex((group) => group.rooms.some((room) => room.id === roomId));
  if (groupIndex < 0) return groups;
  const group = groups[groupIndex];
  const roomIndex = group.rooms.findIndex((room) => room.id === roomId);
  const targetIndex = roomIndex + offset;
  if (targetIndex < 0 || targetIndex >= group.rooms.length) return groups;
  const rooms = [...group.rooms];
  [rooms[roomIndex], rooms[targetIndex]] = [rooms[targetIndex], rooms[roomIndex]];
  const next = [...groups];
  next[groupIndex] = { ...group, rooms };
  return normalizeGroups(next);
}

export function moveCategoryBy(groups: ChannelGroup[], categoryId: string, offset: -1 | 1): ChannelGroup[] {
  const sourceIndex = groups.findIndex((group) => group.category?.id === categoryId);
  const targetIndex = sourceIndex + offset;
  if (sourceIndex < 1 || targetIndex < 1 || targetIndex >= groups.length) return groups;
  const next = [...groups];
  [next[sourceIndex], next[targetIndex]] = [next[targetIndex], next[sourceIndex]];
  return normalizeGroups(next);
}

function normalizeGroups(groups: ChannelGroup[]): ChannelGroup[] {
  let position = 10;
  return groups.map((group, groupIndex) => {
    const category = group.category ? { ...group.category, position: groupIndex * 10 } : null;
    const rooms = group.rooms.map((room) => {
      const next = { ...room, categoryId: category?.id ?? null, position };
      position += 10;
      return next;
    });
    return { category, rooms };
  });
}
