/* eslint-disable require-await, unicorn/no-useless-undefined, vitest/max-expects, vitest/prefer-mock-return-shorthand -- fakes must return promises like the browser API, and one test body checks one state-machine transition end to end */
import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_TAB_GROUP_COLOR,
  browserTabGroupEndedTitle,
  browserTabGroupTitle,
  createBrowserTabGroupController,
} from './browser-tab-groups';
import type { BrowserTabGroupUpdate } from './browser-tab-groups';

const createGroupMock = (id: number) =>
  vi.fn(async (_options: { readonly tabIds: number[] }) => id);

const createUpdateMock = () =>
  vi.fn(async (_groupId: number, _props: BrowserTabGroupUpdate) => undefined);

describe('tab group titles', () => {
  it('builds the exact live title and the ended title', () => {
    expect(browserTabGroupTitle('Report')).toBe('Kilo · Report');
    expect(browserTabGroupEndedTitle()).toBe('Kilo · ended');
    expect(BROWSER_TAB_GROUP_COLOR).toBe('grey');
  });
});

describe('browser tab groups', () => {
  it('opens a session group titled Kilo · <title> without a colour', async () => {
    const group = createGroupMock(9);
    const update = createUpdateMock();
    const controller = createBrowserTabGroupController({ api: { group, update } });

    await expect(
      controller.openSession({ controllerId: 'c1', sessionHandle: 's1', title: 'Report' })
    ).resolves.toStrictEqual({ groupId: 9 });

    expect(group).toHaveBeenCalledWith({ tabIds: [] });
    expect(update).toHaveBeenCalledExactlyOnceWith(9, { title: 'Kilo · Report' });
    expect(controller.listSessions()).toStrictEqual([
      { ended: false, groupId: 9, sessionHandle: 's1', tabs: [], title: 'Report' },
    ]);
  });

  it('records a session without a group when tabs.group is missing', async () => {
    const controller = createBrowserTabGroupController({ api: {} });

    await expect(
      controller.openSession({ controllerId: 'c1', sessionHandle: 's1', title: 'Report' })
    ).resolves.toStrictEqual({});

    expect(controller.listSessions()).toStrictEqual([
      { ended: false, sessionHandle: 's1', tabs: [], title: 'Report' },
    ]);
    expect(controller.tabsForSession('s1')).toStrictEqual([]);
  });

  it('keeps the session without a group when tabs.group rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const group = vi.fn(async (_options: { readonly tabIds: number[] }) => {
      throw new Error('no tabs');
    });
    const controller = createBrowserTabGroupController({ api: { group } });

    await expect(
      controller.openSession({ controllerId: 'c1', sessionHandle: 's1', title: 'Report' })
    ).resolves.toStrictEqual({});

    expect(controller.listSessions()).toStrictEqual([
      { ended: false, sessionHandle: 's1', tabs: [], title: 'Report' },
    ]);
    warn.mockRestore();
  });

  it('validates the group id instead of trusting it', async () => {
    const group = createGroupMock(Number.NaN);
    const controller = createBrowserTabGroupController({ api: { group } });

    await expect(
      controller.openSession({ controllerId: 'c1', sessionHandle: 's1', title: 'Report' })
    ).resolves.toStrictEqual({});
  });

  it('records the group id even when tabGroups.update is missing', async () => {
    const group = createGroupMock(4);
    const controller = createBrowserTabGroupController({ api: { group } });

    await expect(
      controller.openSession({ controllerId: 'c1', sessionHandle: 's1', title: 'Report' })
    ).resolves.toStrictEqual({ groupId: 4 });
  });

  it('groups and records an explicitly shared tab', async () => {
    const group = createGroupMock(6);
    const controller = createBrowserTabGroupController({ api: { group } });
    await controller.openSession({ controllerId: 'c1', sessionHandle: 's1', title: 'Report' });

    await expect(
      controller.shareActiveTab({ sessionHandle: 's1', tabId: 11 })
    ).resolves.toStrictEqual({ groupId: 6, tabId: 11 });

    expect(group).toHaveBeenLastCalledWith({ tabIds: [11] });
    expect(controller.tabsForSession('s1')).toStrictEqual([11]);
    expect(controller.sessionForTab(11)).toBe('s1');
    expect(controller.isTabAllowed('s1', 11)).toBe(true);
  });

  it('records a shared tab without a group when tabs.group is missing', async () => {
    const controller = createBrowserTabGroupController({ api: {} });
    await controller.openSession({ controllerId: 'c1', sessionHandle: 's1', title: 'Report' });

    await expect(
      controller.shareActiveTab({ sessionHandle: 's1', tabId: 12 })
    ).resolves.toStrictEqual({ tabId: 12 });
    expect(controller.tabsForSession('s1')).toStrictEqual([12]);
  });

  it('resolves the active tab in the last focused window when no tab is named', async () => {
    const tabQuery = vi.fn(
      async (_query: {
        readonly active?: boolean | undefined;
        readonly lastFocusedWindow?: boolean | undefined;
      }) => [{ active: true, id: 21, windowId: 3 }]
    );
    const controller = createBrowserTabGroupController({ api: { tabQuery } });
    await controller.openSession({ controllerId: 'c1', sessionHandle: 's1', title: 'Report' });

    await expect(controller.shareActiveTab({ sessionHandle: 's1' })).resolves.toStrictEqual({
      tabId: 21,
    });
    expect(tabQuery).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(controller.tabsForSession('s1')).toStrictEqual([21]);
  });

  it('still records the shared tab when tabs.group rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const group = vi.fn(async (_options: { readonly tabIds: number[] }) => {
      throw new Error('group failed');
    });
    const controller = createBrowserTabGroupController({ api: { group } });
    await controller.openSession({ controllerId: 'c1', sessionHandle: 's1', title: 'Report' });

    await expect(
      controller.shareActiveTab({ sessionHandle: 's1', tabId: 13 })
    ).resolves.toStrictEqual({ tabId: 13 });
    expect(controller.tabsForSession('s1')).toStrictEqual([13]);
    warn.mockRestore();
  });

  it('ends a session, collapses its group, and stops targeting its tabs', async () => {
    const group = createGroupMock(3);
    const update = createUpdateMock();
    const controller = createBrowserTabGroupController({ api: { group, update } });
    await controller.openSession({ controllerId: 'c1', sessionHandle: 's1', title: 'Report' });
    await controller.shareActiveTab({ sessionHandle: 's1', tabId: 17 });
    update.mockClear();

    await controller.closeSession({ sessionHandle: 's1' });

    expect(update).toHaveBeenCalledWith(3, {
      collapsed: true,
      color: 'grey',
      title: 'Kilo · ended',
    });
    expect(controller.tabsForSession('s1')).toStrictEqual([]);
    expect(controller.isTabAllowed('s1', 17)).toBe(false);
    expect(controller.sessionForTab(17)).toBeUndefined();
    // The group still exists, so the recorded ids survive on the ended session.
    expect(controller.listSessions()).toStrictEqual([
      { ended: true, groupId: 3, sessionHandle: 's1', tabs: [17], title: 'Report' },
    ]);
  });

  it('resolves closeSession for an unknown session without throwing', async () => {
    const update = createUpdateMock();
    const controller = createBrowserTabGroupController({ api: { update } });

    await expect(controller.closeSession({ sessionHandle: 'ghost' })).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('ends a session when tabGroups.update is missing', async () => {
    const group = createGroupMock(5);
    const controller = createBrowserTabGroupController({ api: { group } });
    await controller.openSession({ controllerId: 'c1', sessionHandle: 's1', title: 'Report' });
    await controller.shareActiveTab({ sessionHandle: 's1', tabId: 19 });

    await controller.closeSession({ sessionHandle: 's1' });

    expect(controller.tabsForSession('s1')).toStrictEqual([]);
    expect(controller.listSessions()[0]?.ended).toBe(true);
  });

  it('adopts the most recently ended session and re-enables its tabs', async () => {
    let nextGroupId = 1;
    const group = vi.fn(async (_options: { readonly tabIds: number[] }) => nextGroupId++);
    const update = createUpdateMock();
    const controller = createBrowserTabGroupController({ api: { group, update } });
    await controller.openSession({ controllerId: 'c1', sessionHandle: 'a', title: 'Alpha' });
    await controller.openSession({ controllerId: 'c1', sessionHandle: 'b', title: 'Beta' });
    await controller.shareActiveTab({ sessionHandle: 'a', tabId: 31 });
    await controller.shareActiveTab({ sessionHandle: 'b', tabId: 32 });
    await controller.closeSession({ sessionHandle: 'a' });
    await controller.closeSession({ sessionHandle: 'b' });
    update.mockClear();

    await expect(controller.adoptEnded({ sessionHandle: 'c' })).resolves.toStrictEqual({
      groupId: 2,
    });

    expect(update).toHaveBeenCalledWith(2, { collapsed: false, title: 'Kilo · Beta' });
    expect(controller.tabsForSession('b')).toStrictEqual([32]);
    expect(controller.isTabAllowed('b', 32)).toBe(true);
    expect(controller.sessionForTab(32)).toBe('b');
    // Alpha stays ended and untargetable.
    expect(controller.tabsForSession('a')).toStrictEqual([]);
    expect(controller.listSessions().map(session => session.ended)).toStrictEqual([true, false]);
  });

  it('creates an empty active session when nothing has ended', async () => {
    const controller = createBrowserTabGroupController({ api: {} });

    await expect(controller.adoptEnded({ sessionHandle: 'fresh' })).resolves.toStrictEqual({});
    expect(controller.listSessions()).toStrictEqual([
      { ended: false, sessionHandle: 'fresh', tabs: [], title: 'fresh' },
    ]);
  });

  it('tolerates unknown handles across the read and adopt surface', async () => {
    const tabQuery = vi.fn(async () => [{ active: true, id: 44 }]);
    const controller = createBrowserTabGroupController({ api: { tabQuery } });

    expect(controller.tabsForSession('ghost')).toStrictEqual([]);
    expect(controller.sessionForTab(44)).toBeUndefined();
    expect(controller.isTabAllowed('ghost', 44)).toBe(false);
    await expect(controller.adoptEnded({ sessionHandle: 'ghost' })).resolves.toStrictEqual({});
    await expect(
      controller.shareActiveTab({ sessionHandle: 'nobody', tabId: 44 })
    ).resolves.toStrictEqual({ tabId: 44 });
    expect(controller.tabsForSession('nobody')).toStrictEqual([]);
  });

  it('adds a reported tab to the session that owns its group', async () => {
    let nextGroupId = 1;
    const group = vi.fn(async (_options: { readonly tabIds: number[] }) => nextGroupId++);
    const controller = createBrowserTabGroupController({ api: { group } });
    await controller.openSession({ controllerId: 'c1', sessionHandle: 'a', title: 'Alpha' });
    await controller.openSession({ controllerId: 'c1', sessionHandle: 'b', title: 'Beta' });

    controller.noteTabAdded(51, 1);
    controller.noteTabAdded(52, 2);
    controller.noteTabAdded(53);

    expect(controller.tabsForSession('a')).toStrictEqual([51]);
    expect(controller.tabsForSession('b')).toStrictEqual([52]);
  });

  it('does not re-add a tab to a session whose group has ended', async () => {
    const group = createGroupMock(8);
    const controller = createBrowserTabGroupController({ api: { group } });
    await controller.openSession({ controllerId: 'c1', sessionHandle: 's1', title: 'Report' });
    await controller.closeSession({ sessionHandle: 's1' });

    controller.noteTabAdded(61, 8);

    expect(controller.tabsForSession('s1')).toStrictEqual([]);
    expect(controller.listSessions()[0]?.tabs).toStrictEqual([]);
    expect(controller.sessionForTab(61)).toBeUndefined();
  });

  it('drops a closed tab from the session and the reverse lookup', async () => {
    const controller = createBrowserTabGroupController({ api: {} });
    await controller.openSession({ controllerId: 'c1', sessionHandle: 's1', title: 'Report' });
    await controller.shareActiveTab({ sessionHandle: 's1', tabId: 71 });

    controller.noteTabRemoved(71);

    expect(controller.tabsForSession('s1')).toStrictEqual([]);
    expect(controller.sessionForTab(71)).toBeUndefined();
    expect(controller.listSessions()[0]?.tabs).toStrictEqual([]);
  });

  it('returns tab id snapshots a caller cannot mutate', async () => {
    const controller = createBrowserTabGroupController({ api: {} });
    await controller.openSession({ controllerId: 'c1', sessionHandle: 's1', title: 'Report' });
    await controller.shareActiveTab({ sessionHandle: 's1', tabId: 81 });

    controller.tabsForSession('s1').push(82);

    expect(controller.tabsForSession('s1')).toStrictEqual([81]);
    expect(controller.isTabAllowed('s1', 82)).toBe(false);
  });
});
