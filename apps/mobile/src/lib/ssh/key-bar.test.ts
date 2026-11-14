import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canHideKeyBarKey,
  DEFAULT_KEY_BAR_LAYOUT,
  isDefaultKeyBarLayout,
  keyBarKeys,
  type KeyBarLayout,
  loadKeyBarLayout,
  moveKeyBarKey,
  moveKeyBarKeyTo,
  parseKeyBarLayout,
  resetKeyBarLayout,
  saveKeyBarLayout,
  serializeKeyBarLayout,
  setKeyBarKeyHidden,
  visibleKeyBarKeys,
} from './key-bar';
import { TERMINAL_KEYS } from './terminal-keys';

const kv = vi.hoisted(() => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: vi.fn((scope: string, key: string) =>
      Promise.resolve(items.get(`${scope}/${key}`) ?? null)
    ),
    setItem: vi.fn((scope: string, key: string, value: string) => {
      items.set(`${scope}/${key}`, value);
      return Promise.resolve();
    }),
    removeItem: vi.fn((scope: string, key: string) => {
      items.delete(`${scope}/${key}`);
      return Promise.resolve();
    }),
  };
});

vi.mock('@/lib/persist/encrypted-kv', () => kv);

const storedLayout = (layout: Record<string, unknown>) => JSON.stringify({ version: 1, ...layout });

const defaultOrder = TERMINAL_KEYS.map(key => key.id);

const orderWithout = (id: string) => defaultOrder.filter(key => key !== id);

beforeEach(() => {
  kv.items.clear();
  kv.getItem.mockClear();
  kv.setItem.mockClear();
  kv.removeItem.mockClear();
});

describe('the default layout', () => {
  it("offers every key in the bar's own order and hides none", () => {
    expect(DEFAULT_KEY_BAR_LAYOUT.order).toEqual(defaultOrder);
    expect(DEFAULT_KEY_BAR_LAYOUT.hidden).toEqual([]);
  });

  it.each([
    ['nothing stored', null],
    ['text that is not JSON', 'not json'],
    ['JSON that is not an object', '[]'],
    [
      'a version this build does not know',
      storedLayout({ order: ['tab'], hidden: [], version: 2 }),
    ],
    ['a field of the wrong type', JSON.stringify({ version: 1, order: 'tab', hidden: [] })],
  ])('reads %s as the default', (_name, stored) => {
    expect(parseKeyBarLayout(stored)).toEqual(DEFAULT_KEY_BAR_LAYOUT);
  });
});

describe('a stored layout', () => {
  it('keeps the stored order and its hidden keys', () => {
    const layout = parseKeyBarLayout(storedLayout({ order: ['tab', 'esc'], hidden: ['esc'] }));

    expect(layout.order.slice(0, 2)).toEqual(['tab', 'esc']);
    expect(layout.order).toEqual(['tab', 'esc', ...orderWithout('tab').filter(id => id !== 'esc')]);
    expect(layout.hidden).toEqual(['esc']);
  });

  it('drops keys it does not know and repeats of a key it does', () => {
    const layout = parseKeyBarLayout(
      storedLayout({ order: ['esc', 'hyper', 'esc', 'tab'], hidden: ['hyper', 'ctrl', 'ctrl'] })
    );

    expect(layout.order.slice(0, 2)).toEqual(['esc', 'tab']);
    expect(layout.order).toHaveLength(defaultOrder.length);
    expect(layout.order).not.toContain('hyper');
    expect(layout.hidden).toEqual(['ctrl']);
  });

  it('puts a key this build added at the end of the stored order', () => {
    const layout = parseKeyBarLayout(storedLayout({ order: orderWithout('dash'), hidden: [] }));

    expect(layout.order.at(-1)).toBe('dash');
  });

  it('falls back to the whole bar when the stored one hides every key', () => {
    const layout = parseKeyBarLayout(storedLayout({ order: defaultOrder, hidden: defaultOrder }));

    expect(layout).toEqual(DEFAULT_KEY_BAR_LAYOUT);
  });

  it('survives the round trip through storage', () => {
    const layout = parseKeyBarLayout(storedLayout({ order: ['dash', 'esc'], hidden: ['tilde'] }));

    expect(parseKeyBarLayout(serializeKeyBarLayout(layout))).toEqual(layout);
  });
});

describe('the bar keys', () => {
  it('paints the stored order and leaves hidden keys out', () => {
    const layout = setKeyBarKeyHidden(moveKeyBarKeyTo(DEFAULT_KEY_BAR_LAYOUT, 0, 2), 'tab', true);

    expect(
      keyBarKeys(layout)
        .slice(0, 3)
        .map(key => key.id)
    ).toEqual(['ctrl', 'alt', 'esc']);
    expect(visibleKeyBarKeys(layout).map(key => key.id)).toEqual([
      'ctrl',
      'alt',
      'esc',
      ...defaultOrder.slice(3).filter(id => id !== 'tab'),
    ]);
  });
});

describe('the default layout check', () => {
  it('holds for the shipped layout and for what it parses to', () => {
    expect(isDefaultKeyBarLayout(DEFAULT_KEY_BAR_LAYOUT)).toBe(true);
    expect(
      isDefaultKeyBarLayout(
        parseKeyBarLayout(storedLayout({ order: DEFAULT_KEY_BAR_LAYOUT.order, hidden: [] }))
      )
    ).toBe(true);
  });

  it('fails for a moved or hidden key', () => {
    expect(isDefaultKeyBarLayout(moveKeyBarKey(DEFAULT_KEY_BAR_LAYOUT, 'esc', 1))).toBe(false);
    expect(isDefaultKeyBarLayout(setKeyBarKeyHidden(DEFAULT_KEY_BAR_LAYOUT, 'esc', true))).toBe(
      false
    );
  });
});

describe('moving a key', () => {
  it('moves it one place in either direction', () => {
    expect(moveKeyBarKey(DEFAULT_KEY_BAR_LAYOUT, 'esc', 1).order.slice(0, 2)).toEqual([
      'ctrl',
      'esc',
    ]);
    expect(moveKeyBarKey(DEFAULT_KEY_BAR_LAYOUT, 'dash', -1).order.slice(-2)).toEqual([
      'dash',
      'slash',
    ]);
  });

  it('moves nothing at either end', () => {
    expect(moveKeyBarKey(DEFAULT_KEY_BAR_LAYOUT, 'esc', -1)).toBe(DEFAULT_KEY_BAR_LAYOUT);
    expect(moveKeyBarKey(DEFAULT_KEY_BAR_LAYOUT, 'dash', 1)).toBe(DEFAULT_KEY_BAR_LAYOUT);
  });

  it('moves a key into a place a drag chose', () => {
    const layout = moveKeyBarKeyTo(DEFAULT_KEY_BAR_LAYOUT, 0, 3);

    expect(layout.order.slice(0, 4)).toEqual(['ctrl', 'alt', 'tab', 'esc']);
    expect(layout.order).toHaveLength(defaultOrder.length);
  });

  it('ignores a place it is already in and a place outside the bar', () => {
    expect(moveKeyBarKeyTo(DEFAULT_KEY_BAR_LAYOUT, 2, 2)).toBe(DEFAULT_KEY_BAR_LAYOUT);
    expect(moveKeyBarKeyTo(DEFAULT_KEY_BAR_LAYOUT, 0, defaultOrder.length)).toBe(
      DEFAULT_KEY_BAR_LAYOUT
    );
    expect(moveKeyBarKeyTo(DEFAULT_KEY_BAR_LAYOUT, -1, 0)).toBe(DEFAULT_KEY_BAR_LAYOUT);
  });
});

describe('hiding a key', () => {
  it('takes it off the bar and keeps its place', () => {
    const hidden = setKeyBarKeyHidden(DEFAULT_KEY_BAR_LAYOUT, 'tab', true);

    expect(hidden.hidden).toEqual(['tab']);
    expect(hidden.order).toBe(DEFAULT_KEY_BAR_LAYOUT.order);
    expect(visibleKeyBarKeys(hidden).map(key => key.id)).not.toContain('tab');
  });

  it('puts it back where it was', () => {
    const hidden = setKeyBarKeyHidden(DEFAULT_KEY_BAR_LAYOUT, 'up', true);
    const shown = setKeyBarKeyHidden(hidden, 'up', false);

    expect(shown.hidden).toEqual([]);
    expect(visibleKeyBarKeys(shown).map(key => key.id)).toEqual(defaultOrder);
  });

  it('keeps the last key on the bar', () => {
    let onlyEsc = DEFAULT_KEY_BAR_LAYOUT;
    for (const id of defaultOrder) {
      if (id !== 'esc') {
        onlyEsc = setKeyBarKeyHidden(onlyEsc, id, true);
      }
    }

    expect(visibleKeyBarKeys(onlyEsc).map(key => key.id)).toEqual(['esc']);
    expect(canHideKeyBarKey(onlyEsc, 'esc')).toBe(false);
    expect(setKeyBarKeyHidden(onlyEsc, 'esc', true)).toBe(onlyEsc);
  });

  it('allows hiding a key while another one is still shown', () => {
    expect(canHideKeyBarKey(DEFAULT_KEY_BAR_LAYOUT, 'esc')).toBe(true);
  });

  it('ignores a key the layout does not hold and a state it is already in', () => {
    expect(setKeyBarKeyHidden(DEFAULT_KEY_BAR_LAYOUT, 'tab', false)).toBe(DEFAULT_KEY_BAR_LAYOUT);

    const singleKey: KeyBarLayout = { order: ['tab'], hidden: [] };

    expect(setKeyBarKeyHidden(singleKey, 'esc', true)).toBe(singleKey);
  });
});

describe('storing the layout', () => {
  it('reads the default before this device saved one', async () => {
    await expect(loadKeyBarLayout()).resolves.toEqual(DEFAULT_KEY_BAR_LAYOUT);
  });

  it('writes what the next read finds', async () => {
    const layout = setKeyBarKeyHidden(
      moveKeyBarKey(DEFAULT_KEY_BAR_LAYOUT, 'tab', -1),
      'dash',
      true
    );

    await saveKeyBarLayout(layout);

    expect(kv.setItem).toHaveBeenCalledWith('ssh-key-bar', 'layout', serializeKeyBarLayout(layout));
    await expect(loadKeyBarLayout()).resolves.toEqual(layout);
  });

  it('reads a stored layout after a restart', async () => {
    const layout = setKeyBarKeyHidden(moveKeyBarKeyTo(DEFAULT_KEY_BAR_LAYOUT, 0, 2), 'left', true);
    await saveKeyBarLayout(layout);

    kv.getItem.mockClear();

    await expect(loadKeyBarLayout()).resolves.toEqual(layout);
    expect(kv.getItem).toHaveBeenCalledWith('ssh-key-bar', 'layout');
  });

  it('restores the default by dropping the stored layout', async () => {
    await saveKeyBarLayout(setKeyBarKeyHidden(DEFAULT_KEY_BAR_LAYOUT, 'esc', true));

    await resetKeyBarLayout();

    expect(kv.removeItem).toHaveBeenCalledWith('ssh-key-bar', 'layout');
    await expect(loadKeyBarLayout()).resolves.toEqual(DEFAULT_KEY_BAR_LAYOUT);
  });
});
