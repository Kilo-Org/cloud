export type TranscriptGroupIdentity = {
  id: string;
  itemIds: readonly string[];
};

export function reconcileGroupIdentities(
  groups: readonly (readonly string[])[],
  previous: readonly TranscriptGroupIdentity[]
): TranscriptGroupIdentity[] {
  const groupByItem = new Map<string, number>();
  groups.forEach((items, index) => items.forEach(id => groupByItem.set(id, index)));
  const retained = new Map<number, string>();

  for (const group of previous) {
    const index =
      groupByItem.get(group.id) ??
      group.itemIds.map(id => groupByItem.get(id)).find(index => index !== undefined);
    if (index !== undefined && !retained.has(index)) retained.set(index, group.id);
  }

  return groups.map((itemIds, index) => ({
    id: retained.get(index) ?? itemIds[0] ?? '',
    itemIds,
  }));
}
