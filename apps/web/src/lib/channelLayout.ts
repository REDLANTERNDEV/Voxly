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

export function channelGroups(categories: CategorySummary[], rooms: RoomSummary[], uncategorizedPosition = 0): ChannelGroup[] {
  return [
    { category: null, position: uncategorizedPosition, rooms: rooms.filter((room) => room.categoryId === null) },
    ...categories.map((category) => ({ category, position: category.position, rooms: rooms.filter((room) => room.categoryId === category.id) }))
  ].sort((a, b) => a.position - b.position)
    .map(({ category, rooms: groupedRooms }) => ({
      category,
      rooms: groupedRooms.sort((a, b) => a.position - b.position)
    }));
}

export function roomLayout(groups: ChannelGroup[]): ServerRoomLayout {
  return {
    groups: groups.map((group) => ({
      categoryId: group.category?.id ?? null,
      roomIds: group.rooms.map((room) => room.id)
    }))
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

export function moveGroup(groups: ChannelGroup[], categoryId: string | null, targetId: string | null, after = false): ChannelGroup[] {
  const sourceIndex = groups.findIndex((group) => group.category?.id === categoryId || (group.category === null && categoryId === null));
  const targetIndex = groups.findIndex((group) => group.category?.id === targetId || (group.category === null && targetId === null));
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return groups;
  const next = [...groups];
  const [source] = next.splice(sourceIndex, 1);
  const adjustedTarget = next.findIndex((group) => group.category?.id === targetId || (group.category === null && targetId === null));
  next.splice(adjustedTarget + (after ? 1 : 0), 0, source);
  if (next.every((group, index) => group.category?.id === groups[index]?.category?.id)) return groups;
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

export function moveGroupBy(groups: ChannelGroup[], categoryId: string | null, offset: -1 | 1): ChannelGroup[] {
  const sourceIndex = groups.findIndex((group) => group.category?.id === categoryId || (group.category === null && categoryId === null));
  const targetIndex = sourceIndex + offset;
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= groups.length) return groups;
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
