import { describe, expect, it, vi } from 'vitest';
import {
  ADD_TO_MEMORY_MENU_ID,
  enableActionClickSidePanel,
  openSidePanelInWindow,
  registerAddToMemoryMenu,
} from './side-panel';
import type { NativeContextMenusApi } from './side-panel';

describe('side panel behavior', () => {
  it('opens the native side panel from the extension action click', async () => {
    const calls: { openPanelOnActionClick: boolean }[] = [];

    await enableActionClickSidePanel({
      setPanelBehavior: options => {
        calls.push(options);
      },
    });

    expect(calls).toStrictEqual([{ openPanelOnActionClick: true }]);
  });

  it('ignores browsers without the native side panel API', async () => {
    await expect(enableActionClickSidePanel()).resolves.toBeUndefined();
  });
});

describe('add-to-memory context menu registration', () => {
  it('registers the selection menu idempotently via remove-then-create', async () => {
    const create = vi.fn();
    // eslint-disable-next-line require-await -- async remove fake for sequential await path
    const remove = vi.fn(async () => {});
    const menusApi: NativeContextMenusApi = {
      create,
      onClicked: { addListener: vi.fn() },
      remove,
    };

    await registerAddToMemoryMenu(menusApi);
    await registerAddToMemoryMenu(menusApi);

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith(ADD_TO_MEMORY_MENU_ID);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith({
      contexts: ['selection'],
      id: ADD_TO_MEMORY_MENU_ID,
      title: 'Add to memory',
    });
  });

  it('awaits remove before create so a deferred remove cannot delete a new item', async () => {
    const order: string[] = [];
    const settleBox: { current: (() => void) | undefined } = { current: undefined };
    // eslint-disable-next-line promise/avoid-new -- deferred remove to prove create waits
    const removePending = new Promise<void>(resolve => {
      settleBox.current = resolve;
    });

    const create = vi.fn(() => {
      order.push('create');
    });
    const remove = vi.fn(async () => {
      order.push('remove-start');
      await removePending;
      order.push('remove-settled');
    });
    const menusApi: NativeContextMenusApi = {
      create,
      onClicked: { addListener: vi.fn() },
      remove,
    };

    const registration = registerAddToMemoryMenu(menusApi);

    // Remove has started; create must not run until remove settles.
    expect(order).toStrictEqual(['remove-start']);
    expect(create).not.toHaveBeenCalled();

    settleBox.current?.();
    await registration;

    expect(order).toStrictEqual(['remove-start', 'remove-settled', 'create']);
    expect(create).toHaveBeenCalledWith({
      contexts: ['selection'],
      id: ADD_TO_MEMORY_MENU_ID,
      title: 'Add to memory',
    });
  });

  it('still creates after remove rejects (item may not exist yet)', async () => {
    const create = vi.fn();
    // eslint-disable-next-line require-await -- async remove rejection fake
    const remove = vi.fn(async () => {
      throw new Error('no such menu item');
    });
    const menusApi: NativeContextMenusApi = {
      create,
      onClicked: { addListener: vi.fn() },
      remove,
    };

    await expect(registerAddToMemoryMenu(menusApi)).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledWith({
      contexts: ['selection'],
      id: ADD_TO_MEMORY_MENU_ID,
      title: 'Add to memory',
    });
  });

  it('swallows create errors when the menu id already exists', async () => {
    const menusApi: NativeContextMenusApi = {
      create: vi.fn(() => {
        throw new Error('duplicate id');
      }),
      onClicked: { addListener: vi.fn() },
    };

    await expect(registerAddToMemoryMenu(menusApi)).resolves.toBeUndefined();
  });

  it('no-ops when the menus API is unavailable', async () => {
    await expect(registerAddToMemoryMenu()).resolves.toBeUndefined();
  });
});

describe('side panel open helpers', () => {
  it('prefers sidePanel.open with the tab window id', async () => {
    const open = vi.fn();
    const sidebarOpen = vi.fn();

    await openSidePanelInWindow({
      sidePanelOpen: { open },
      sidebarAction: { open: sidebarOpen },
      windowId: 7,
    });

    expect(open).toHaveBeenCalledWith({ windowId: 7 });
    expect(sidebarOpen).not.toHaveBeenCalled();
  });

  it('falls back to sidebarAction.open', async () => {
    const sidebarOpen = vi.fn();

    await openSidePanelInWindow({
      sidebarAction: { open: sidebarOpen },
      windowId: 3,
    });

    // Oxlint vitest prefer-called-once vs prefer-called-times conflict on count=1.
    // eslint-disable-next-line vitest/prefer-called-once -- matches package call-count style
    expect(sidebarOpen).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when no open API is available', () => {
    expect(
      openSidePanelInWindow({
        windowId: 1,
      })
    ).toBeUndefined();
  });
});
