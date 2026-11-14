import { z } from 'zod';

import { getItem, removeItem, setItem } from '@/lib/persist/encrypted-kv';

import { TERMINAL_KEYS, type TerminalKey, type TerminalKeyId } from './terminal-keys';

/** Where the bar's per-device layout lives. */
const LAYOUT_SCOPE = 'ssh-key-bar';
const LAYOUT_ITEM = 'layout';
const STORED_VERSION = 1;

export type KeyBarLayout = Readonly<{
  order: readonly TerminalKeyId[];
  hidden: readonly TerminalKeyId[];
}>;

export const DEFAULT_KEY_BAR_LAYOUT: KeyBarLayout = {
  order: TERMINAL_KEYS.map(key => key.id),
  hidden: [],
};

const KEY_BY_ID = new Map<string, TerminalKey>(TERMINAL_KEYS.map(key => [key.id, key]));

const storedLayoutSchema = z.object({
  version: z.literal(STORED_VERSION),
  order: z.array(z.string()),
  hidden: z.array(z.string()),
});

function normalizeOrder(stored: readonly string[]): TerminalKeyId[] {
  const known = stored.filter((id): id is TerminalKeyId => KEY_BY_ID.has(id));
  const seen = new Set(known);
  return [...seen, ...TERMINAL_KEYS.map(key => key.id).filter(id => !seen.has(id))];
}

/**
 * The stored layout, or the default one.
 *
 * A key this build no longer offers is dropped, a key it added lands at the
 * end, and a layout that hides every key falls back to the whole bar: a stored
 * layout from another build never leaves the bar without a single terminal
 * key.
 */
export function parseKeyBarLayout(stored: string | null): KeyBarLayout {
  if (stored === null) {
    return DEFAULT_KEY_BAR_LAYOUT;
  }
  try {
    const parsed = storedLayoutSchema.safeParse(JSON.parse(stored));
    if (!parsed.success) {
      return DEFAULT_KEY_BAR_LAYOUT;
    }
    const order = normalizeOrder(parsed.data.order);
    const hiddenIds = new Set(parsed.data.hidden.filter(id => KEY_BY_ID.has(id)));
    const hidden = order.filter(id => hiddenIds.has(id));
    return hidden.length === order.length ? DEFAULT_KEY_BAR_LAYOUT : { order, hidden };
  } catch {
    return DEFAULT_KEY_BAR_LAYOUT;
  }
}

export function serializeKeyBarLayout(layout: KeyBarLayout): string {
  return JSON.stringify({ version: STORED_VERSION, order: layout.order, hidden: layout.hidden });
}

/** Whether the layout is the one the bar shipped with. */
export function isDefaultKeyBarLayout(layout: KeyBarLayout): boolean {
  return (
    layout.hidden.length === 0 &&
    layout.order.length === DEFAULT_KEY_BAR_LAYOUT.order.length &&
    layout.order.every((id, index) => DEFAULT_KEY_BAR_LAYOUT.order[index] === id)
  );
}

/** Every key, hidden ones included, in the stored order. */
export function keyBarKeys(layout: KeyBarLayout): TerminalKey[] {
  return layout.order.flatMap(id => KEY_BY_ID.get(id) ?? []);
}

/** The keys the bar paints, in the stored order. */
export function visibleKeyBarKeys(layout: KeyBarLayout): TerminalKey[] {
  const hidden = new Set(layout.hidden);
  return keyBarKeys(layout).filter(key => !hidden.has(key.id));
}

export function moveKeyBarKey(
  layout: KeyBarLayout,
  id: TerminalKeyId,
  offset: -1 | 1
): KeyBarLayout {
  const from = layout.order.indexOf(id);
  return from === -1 ? layout : moveKeyBarKeyTo(layout, from, from + offset);
}

export function moveKeyBarKeyTo(layout: KeyBarLayout, from: number, to: number): KeyBarLayout {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= layout.order.length ||
    to >= layout.order.length
  ) {
    return layout;
  }
  const order = [...layout.order];
  const moved = order.splice(from, 1)[0];
  if (moved === undefined) {
    return layout;
  }
  order.splice(to, 0, moved);
  return { order, hidden: layout.hidden };
}

/** Whether the bar keeps a terminal key once this one is switched off. */
export function canHideKeyBarKey(layout: KeyBarLayout, id: TerminalKeyId): boolean {
  return layout.hidden.includes(id) || visibleKeyBarKeys(layout).length > 1;
}

export function setKeyBarKeyHidden(
  layout: KeyBarLayout,
  id: TerminalKeyId,
  hidden: boolean
): KeyBarLayout {
  if (!layout.order.includes(id) || hidden === layout.hidden.includes(id)) {
    return layout;
  }
  if (hidden && !canHideKeyBarKey(layout, id)) {
    return layout;
  }
  const next = hidden ? [...layout.hidden, id] : layout.hidden.filter(key => key !== id);
  return { order: layout.order, hidden: next };
}

export async function loadKeyBarLayout(): Promise<KeyBarLayout> {
  return parseKeyBarLayout(await getItem(LAYOUT_SCOPE, LAYOUT_ITEM));
}

export async function saveKeyBarLayout(layout: KeyBarLayout): Promise<void> {
  await setItem(LAYOUT_SCOPE, LAYOUT_ITEM, serializeKeyBarLayout(layout));
}

/** Drops the stored layout, so the bar reads the default order again. */
export async function resetKeyBarLayout(): Promise<void> {
  await removeItem(LAYOUT_SCOPE, LAYOUT_ITEM);
}
