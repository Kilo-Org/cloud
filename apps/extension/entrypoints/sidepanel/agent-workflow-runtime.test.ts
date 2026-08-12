/* eslint-disable max-lines, vitest/prefer-called-once, jest/no-conditional-in-test -- navigation test cases cover all feature states */
import { describe, expect, it, vi } from 'vitest';
import {
  WORKFLOW_NAVIGATION_TIMEOUT_MS,
  WORKFLOW_PAGE_EVAL_TIMEOUT_MS,
} from '@/src/shared/agent-workflows';
import { EVAL_TAB_MESSAGE } from '@/src/shared/tab-debugger';

type TabListener = (tabId: number, changeInfo: object, tabInfo: object) => void;

const mocks = vi.hoisted(() => ({
  _fireOnUpdated: (tabId: number, changeInfo: object, tab?: object): void => {
    const listenersCopy = [...mocks._onUpdatedListeners];
    for (const listener of listenersCopy) {
      listener(tabId, changeInfo, tab ?? {});
    }
  },
  _onUpdatedListeners: [] as TabListener[],
  _resetOnUpdated: (): void => {
    mocks._onUpdatedListeners.length = 0;
  },
  addListener: vi.fn((listener: TabListener) => {
    mocks._onUpdatedListeners.push(listener);
  }),
  removeListener: vi.fn((listener: TabListener) => {
    const index = mocks._onUpdatedListeners.indexOf(listener);
    if (index !== -1) {
      mocks._onUpdatedListeners.splice(index, 1);
    }
  }),
  sendMessage: vi.fn(),
  tabsGet: vi.fn(),
  tabsUpdate: vi.fn(),
}));

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('#imports', () => ({
  browser: {
    runtime: { sendMessage: mocks.sendMessage },
    tabs: {
      get: mocks.tabsGet,
      onUpdated: {
        addListener: mocks.addListener,
        removeListener: mocks.removeListener,
      },
      update: mocks.tabsUpdate,
    },
  },
}));

// eslint-disable-next-line import/first
import { evalInTab, getTabUrl, navigateTab } from './agent-workflow-runtime';

describe('workflow eval', () => {
  it('sends eval message with WORKFLOW_PAGE_EVAL_TIMEOUT_MS', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, value: 42 },
      type: EVAL_TAB_MESSAGE,
    });

    await expect(evalInTab(7, 'return 42;')).resolves.toStrictEqual({ ok: true, value: 42 });
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      code: 'return 42;',
      tabId: 7,
      timeoutMs: WORKFLOW_PAGE_EVAL_TIMEOUT_MS,
      type: EVAL_TAB_MESSAGE,
    });
  });

  it('returns error when sendMessage fails', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockRejectedValueOnce(new Error('disconnected'));

    await expect(evalInTab(7, 'return 1;')).resolves.toStrictEqual({
      error: 'disconnected',
      ok: false,
    });
  });

  it('returns error when response is invalid', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({ unexpected: true });

    await expect(evalInTab(7, 'return 1;')).resolves.toStrictEqual({
      error: 'Extension background returned an invalid response.',
      ok: false,
    });
  });

  it('returns error when background reports failure', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      error: 'tab closed',
      ok: false,
    });

    await expect(evalInTab(7, 'return 1;')).resolves.toStrictEqual({
      error: 'tab closed',
      ok: false,
    });
  });

  it('returns error when response type is wrong', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, value: 42 },
      type: 'kilo.tabs.snapshot',
    });

    await expect(evalInTab(7, 'return 42;')).resolves.toStrictEqual({
      error: 'Extension background returned the wrong response.',
      ok: false,
    });
  });
});

describe('workflow getTabUrl', () => {
  it('returns the tab URL', async () => {
    mocks.tabsGet.mockReset();
    mocks.tabsGet.mockResolvedValueOnce({ id: 7, url: 'https://example.com/page' });

    await expect(getTabUrl(7)).resolves.toBe('https://example.com/page');
  });

  it('throws when URL is undefined', async () => {
    mocks.tabsGet.mockReset();
    mocks.tabsGet.mockResolvedValueOnce({ id: 7 });

    await expect(getTabUrl(7)).rejects.toThrow('Tab URL is unavailable.');
  });
});

describe('workflow navigateTab', () => {
  const resetMocks = (): void => {
    mocks.tabsGet.mockReset();
    mocks.tabsUpdate.mockReset();
    mocks.addListener.mockClear();
    mocks.removeListener.mockClear();
    mocks._resetOnUpdated();
  };

  it('resolves immediately when already at target URL with complete status', async () => {
    resetMocks();
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'complete',
      url: 'https://example.com/page?q=1#section',
    });

    await navigateTab(7, 'https://example.com/page?q=1');

    expect(mocks.tabsUpdate).not.toHaveBeenCalled();
    expect(mocks.addListener).not.toHaveBeenCalled();
  });

  it('ignores hash in same-URL fast path', async () => {
    resetMocks();
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'complete',
      url: 'https://example.com/page#different-hash',
    });

    await navigateTab(7, 'https://example.com/page#other');

    expect(mocks.tabsUpdate).not.toHaveBeenCalled();
  });

  it('resolves via the onUpdated listener when a matching complete event arrives', async () => {
    resetMocks();
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://other.example/',
    });

    mocks.tabsUpdate.mockResolvedValueOnce({ id: 7 });

    // Post-update re-read: tab is still loading, not at the target URL.
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://other.example/',
    });

    // Listener tabs.get returns the completed target URL.
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'complete',
      url: 'https://example.com/dest?x=1',
    });

    const navPromise = navigateTab(7, 'https://example.com/dest?x=1');

    // Wait for the listener to be registered.
    await vi.waitFor(() => {
      expect(mocks.addListener).toHaveBeenCalledTimes(1);
    });

    // Fire the onUpdated event.
    mocks._fireOnUpdated(7, { status: 'complete' });

    await expect(navPromise).resolves.toBeUndefined();
    expect(mocks.tabsUpdate).toHaveBeenCalledWith(7, { url: 'https://example.com/dest?x=1' });
    expect(mocks.removeListener).toHaveBeenCalledTimes(1);
  });

  it('ignores onUpdated events for other tabs and prevents tabs.get calls', async () => {
    resetMocks();
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://other.example/',
    });

    mocks.tabsUpdate.mockResolvedValueOnce({ id: 7 });

    // Post-update re-read: tab is still at the wrong URL, not complete.
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://other.example/',
    });

    // Listener tabs.get returns the completed target URL.
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'complete',
      url: 'https://example.com/dest',
    });

    const navPromise = navigateTab(7, 'https://example.com/dest');

    await vi.waitFor(() => {
      expect(mocks.addListener).toHaveBeenCalledTimes(1);
    });

    // Fire event for a different tab — the guard must prevent tabs.get.
    mocks._fireOnUpdated(9, { status: 'complete' });

    // The guard must have filtered the event: tabs.get was called only twice before
    // (initial fast-path check and post-update re-read). If the guard were missing,
    // TabsGet would have been called a third time, consuming the mock meant for the
    // Matching event below and causing a timeout.
    expect(mocks.tabsGet).toHaveBeenCalledTimes(2);

    // Fire the matching event.
    mocks._fireOnUpdated(7, { status: 'complete' });

    await expect(navPromise).resolves.toBeUndefined();
    expect(mocks.removeListener).toHaveBeenCalledTimes(1);
  });

  it('ignores onUpdated events with non-complete status', async () => {
    resetMocks();
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://other.example/',
    });

    mocks.tabsUpdate.mockResolvedValueOnce({ id: 7 });

    // Post-update re-read: tab is still loading, not complete.
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://other.example/',
    });

    // Listener tabs.get returns the completed target URL.
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'complete',
      url: 'https://example.com/dest',
    });

    const navPromise = navigateTab(7, 'https://example.com/dest');

    await vi.waitFor(() => {
      expect(mocks.addListener).toHaveBeenCalledTimes(1);
    });

    // Fire a non-complete event (e.g. "loading" for an intermediate redirect).
    mocks._fireOnUpdated(7, { status: 'loading' });

    // The non-complete guard must have prevented tabs.get: only the initial
    // Fast-path check and the post-update re-read consumed mocks so far.
    // If the guard were missing, the loading event would consume the next
    // TabsGet mock meant for the complete event below, causing a timeout.
    expect(mocks.tabsGet).toHaveBeenCalledTimes(2);

    // Fire the complete event.
    mocks._fireOnUpdated(7, { status: 'complete' });

    await expect(navPromise).resolves.toBeUndefined();
  });

  it('ignores onUpdated events where tab URL does not match target', async () => {
    resetMocks();
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://other.example/',
    });

    mocks.tabsUpdate.mockResolvedValueOnce({ id: 7 });

    // Post-update re-read: tab is still loading, not at the target URL.
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://other.example/',
    });

    // First onUpdated event: listener tabs.get returns an intermediate non-matching URL.
    // Second onUpdated event: listener tabs.get returns the matching URL.
    mocks.tabsGet
      .mockResolvedValueOnce({
        id: 7,
        status: 'complete',
        url: 'https://other.example/intermediate',
      })
      .mockResolvedValueOnce({
        id: 7,
        status: 'complete',
        url: 'https://example.com/dest',
      });

    const navPromise = navigateTab(7, 'https://example.com/dest');

    await vi.waitFor(() => {
      expect(mocks.addListener).toHaveBeenCalledTimes(1);
    });

    // First complete — intermediate URL, must be ignored.
    mocks._fireOnUpdated(7, { status: 'complete' });

    // Second complete — matching URL, must resolve.
    mocks._fireOnUpdated(7, { status: 'complete' });

    await expect(navPromise).resolves.toBeUndefined();
  });

  it('matches URLs ignoring hash only', async () => {
    resetMocks();
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://other.example/',
    });

    mocks.tabsUpdate.mockResolvedValueOnce({ id: 7 });

    // Post-update re-read: tab is still loading, not at the target URL.
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://other.example/',
    });

    // Listener tabs.get returns a URL that differs only in the hash fragment.
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'complete',
      url: 'https://example.com/dest?q=1#some-anchor',
    });

    const navPromise = navigateTab(7, 'https://example.com/dest?q=1#different-anchor');

    await vi.waitFor(() => {
      expect(mocks.addListener).toHaveBeenCalledTimes(1);
    });

    mocks._fireOnUpdated(7, { status: 'complete' });

    await expect(navPromise).resolves.toBeUndefined();
  });

  it('rejects on timeout and removes the listener', async () => {
    resetMocks();
    vi.useFakeTimers();

    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://other.example/',
    });

    mocks.tabsUpdate.mockResolvedValueOnce({ id: 7 });

    const navPromise = navigateTab(7, 'https://example.com/dest');

    // Attach a catch handler synchronously to suppress the Node.js
    // Unhandled-rejection warning when fake timers fire the rejection
    // Before the outer await registers its handler.
    // eslint-disable-next-line promise/prefer-await-to-then
    navPromise.catch(() => {});

    // Advance time past the navigation timeout.
    await vi.advanceTimersByTimeAsync(WORKFLOW_NAVIGATION_TIMEOUT_MS + 100);

    await expect(navPromise).rejects.toThrow('timed out: the page never finished loading.');
    expect(mocks.removeListener).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('removes the listener even when tabs.get inside the listener throws', async () => {
    resetMocks();
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://other.example/',
    });

    mocks.tabsUpdate.mockResolvedValueOnce({ id: 7 });

    // Post-update fresh tabs.get returns a non-matching URL so the
    // Rejection mock below is consumed by the listener, not the post-update handler.
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://other.example/',
    });

    // Tabs.get inside the listener throws.
    mocks.tabsGet.mockRejectedValueOnce(new Error('tab closed'));

    const navPromise = navigateTab(7, 'https://example.com/dest');

    await vi.waitFor(() => {
      expect(mocks.addListener).toHaveBeenCalledTimes(1);
    });

    mocks._fireOnUpdated(7, { status: 'complete' });

    await expect(navPromise).rejects.toThrow('tab closed');
    expect(mocks.removeListener).toHaveBeenCalledTimes(1);
  });

  it('does not re-navigate when same URL is already complete', async () => {
    resetMocks();
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'complete',
      url: 'https://example.com/page',
    });

    await navigateTab(7, 'https://example.com/page');

    expect(mocks.tabsUpdate).not.toHaveBeenCalled();
  });

  it('resolves via post-update fresh tabs.get when tab completed without onUpdated', async () => {
    resetMocks();
    // Fast-path check: tab is at a different URL, not complete.
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://other.example/',
    });

    // Tabs.update resolves. Its return value is a snapshot and is not used
    // For the matching check — the fresh tabs.get below provides the real state.
    mocks.tabsUpdate.mockResolvedValueOnce({ id: 7 });

    // Post-update fresh tabs.get returns a tab already complete at the target URL.
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'complete',
      url: 'https://example.com/dest',
    });

    const navPromise = navigateTab(7, 'https://example.com/dest');

    // No onUpdated event is fired — the fresh re-read resolves the promise.
    await expect(navPromise).resolves.toBeUndefined();

    expect(mocks.tabsUpdate).toHaveBeenCalledWith(7, { url: 'https://example.com/dest' });
    expect(mocks.addListener).toHaveBeenCalledTimes(1);
    expect(mocks.removeListener).toHaveBeenCalledTimes(1);
  });

  it('removes listener when post-update fresh tabs.get throws', async () => {
    // The post-update fresh tabs.get error path must clean up
    // The listener. No onUpdated event is fired.
    resetMocks();
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://other.example/',
    });

    mocks.tabsUpdate.mockResolvedValueOnce({ id: 7 });

    // Post-update fresh tabs.get throws.
    mocks.tabsGet.mockRejectedValueOnce(new Error('tab closed'));

    await expect(navigateTab(7, 'https://example.com/dest')).rejects.toThrow('tab closed');

    expect(mocks.addListener).toHaveBeenCalledTimes(1);
    expect(mocks.removeListener).toHaveBeenCalledTimes(1);
  });

  it('registers listener before calling tabs.update', async () => {
    resetMocks();
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://other.example/',
    });

    // Tabs.update returns a loading tab so the post-update check does not resolve.
    mocks.tabsUpdate.mockResolvedValueOnce({ id: 7, status: 'loading' });

    const navPromise = navigateTab(7, 'https://example.com/dest');

    // Wait for the listener to be registered and tabs.update to be called.
    await vi.waitFor(() => {
      expect(mocks.addListener).toHaveBeenCalledTimes(1);
      expect(mocks.tabsUpdate).toHaveBeenCalledTimes(1);
    });

    // Verify addListener was called before tabsUpdate.
    const addListenerOrder = mocks.addListener.mock.invocationCallOrder?.[0] ?? 0;
    const tabsUpdateOrder = mocks.tabsUpdate.mock.invocationCallOrder?.[0] ?? 0;
    expect(addListenerOrder).toBeLessThan(tabsUpdateOrder);

    // Clean up: fire the matching event so the promise resolves.
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'complete',
      url: 'https://example.com/dest',
    });

    mocks._fireOnUpdated(7, { status: 'complete' });

    await expect(navPromise).resolves.toBeUndefined();
  });

  it('rejects when tabs.update fails', async () => {
    resetMocks();
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://other.example/',
    });

    mocks.tabsUpdate.mockRejectedValueOnce(new Error('tab removed'));

    await expect(navigateTab(7, 'https://example.com/dest')).rejects.toThrow('tab removed');

    expect(mocks.addListener).toHaveBeenCalledTimes(1);
    expect(mocks.removeListener).toHaveBeenCalledTimes(1);
  });

  it('re-navigates when tab is at same URL but status is not complete', async () => {
    resetMocks();
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://example.com/page',
    });

    mocks.tabsUpdate.mockResolvedValueOnce({ id: 7 });

    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'complete',
      url: 'https://example.com/page',
    });

    const navPromise = navigateTab(7, 'https://example.com/page');

    await vi.waitFor(() => {
      expect(mocks.addListener).toHaveBeenCalledTimes(1);
    });

    expect(mocks.tabsUpdate).toHaveBeenCalledWith(7, { url: 'https://example.com/page' });

    mocks._fireOnUpdated(7, { status: 'complete' });

    await expect(navPromise).resolves.toBeUndefined();
  });
});

describe('workflow navigateTab redirects', () => {
  it('resolves when the tab completes on a redirect target instead of the requested URL', async () => {
    mocks.sendMessage.mockReset();
    mocks.tabsGet.mockReset();
    mocks.tabsUpdate.mockReset();
    mocks.addListener.mockClear();
    mocks.removeListener.mockClear();
    mocks._resetOnUpdated();

    // Pre-navigation read: the tab sits on the form page.
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'complete',
      url: 'https://example.com/form-page',
    });
    mocks.tabsUpdate.mockResolvedValueOnce({ id: 7 });
    // Post-update re-read: still loading.
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'loading',
      url: 'https://example.com/search?q=x',
    });
    // Listener read: the server redirected to a different results URL.
    mocks.tabsGet.mockResolvedValueOnce({
      id: 7,
      status: 'complete',
      url: 'https://example.com/results/42',
    });

    const navPromise = navigateTab(7, 'https://example.com/search?q=x');

    await vi.waitFor(() => {
      expect(mocks.addListener).toHaveBeenCalledTimes(1);
    });
    mocks._fireOnUpdated(7, { status: 'complete' });

    await expect(navPromise).resolves.toBeUndefined();
    expect(mocks.removeListener).toHaveBeenCalledTimes(1);
  });
});
