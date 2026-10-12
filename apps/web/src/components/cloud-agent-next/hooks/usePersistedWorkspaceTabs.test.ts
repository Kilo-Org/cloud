import React, { act, createElement, type Dispatch, type SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import {
  addTerminalTab,
  createWorkspaceTabsState,
  type WorkspaceTabsState,
} from '../workspace-tabs';
import type { usePersistedWorkspaceTabs } from './usePersistedWorkspaceTabs';
import type { useClosedWorktreeChatTabs } from './useClosedWorktreeChatTabs';

Object.assign(globalThis, { React });

const STORAGE_KEY = 'cloud-agent:workspace-tabs:user:owner:personal';
const SCOPE_A = 'worktree:wt-a';
const SCOPE_B = 'worktree:wt-b';

type ProbeState = {
  tabs: WorkspaceTabsState;
  setTabs: Dispatch<SetStateAction<WorkspaceTabsState>>;
};

function installDom() {
  const requireFromHere = createRequire(__filename);
  const loadLinkedom = (): { parseHTML: (html: string) => { window: typeof globalThis } } => {
    try {
      return requireFromHere('linkedom') as {
        parseHTML: (html: string) => { window: typeof globalThis };
      };
    } catch {
      return requireFromHere(
        '../../../../../../node_modules/.pnpm/linkedom@0.18.12/node_modules/linkedom'
      ) as { parseHTML: (html: string) => { window: typeof globalThis } };
    }
  };
  const { window } = loadLinkedom().parseHTML('<html><body><div id="root"></div></body></html>');
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => (storage.has(key) ? (storage.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      storage.set(key, String(value));
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };
  Object.assign(window, { localStorage });

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    localStorage: (globalThis as { localStorage?: unknown }).localStorage,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };

  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  return {
    container: window.document.getElementById('root') as HTMLElement,
    storage,
    cleanup: () => Object.assign(globalThis, previous),
  };
}

describe('usePersistedWorkspaceTabs', () => {
  let usePersistedWorkspaceTabsHook: typeof usePersistedWorkspaceTabs;
  let useClosedWorktreeChatTabsHook: typeof useClosedWorktreeChatTabs;
  let dom: ReturnType<typeof installDom>;
  let root: Root;
  let probe: ProbeState | null;

  beforeAll(async () => {
    dom = installDom();
    ({ usePersistedWorkspaceTabs: usePersistedWorkspaceTabsHook } =
      await import('./usePersistedWorkspaceTabs'));
    ({ useClosedWorktreeChatTabs: useClosedWorktreeChatTabsHook } =
      await import('./useClosedWorktreeChatTabs'));
  });

  afterAll(() => {
    dom.cleanup();
  });

  beforeEach(() => {
    dom.storage.clear();
    probe = null;
    root = createRoot(dom.container);
  });

  afterEach(() => {
    act(() => root.unmount());
    jest.restoreAllMocks();
  });

  function Probe({ storageKey, scope }: { storageKey: string | null; scope: string | null }) {
    const [tabs, setTabs] = usePersistedWorkspaceTabsHook(storageKey, scope);
    probe = { tabs, setTabs };
    return null;
  }

  function render(storageKey: string | null, scope: string | null) {
    act(() => root.render(createElement(Probe, { storageKey, scope })));
  }

  function stored(): WorkspaceTabsState | undefined {
    const raw = dom.storage.get(STORAGE_KEY);
    if (!raw) return undefined;
    return JSON.parse(raw).tabsByScope[SCOPE_A] as WorkspaceTabsState | undefined;
  }

  function dispatchStorage(key: string | null = STORAGE_KEY) {
    const event = new window.Event('storage');
    Object.assign(event, { key });
    act(() => {
      window.dispatchEvent(event);
    });
  }

  it('persists open tabs per scope and restores them when switching back', () => {
    render(STORAGE_KEY, SCOPE_A);
    act(() => probe?.setTabs(state => addTerminalTab(state, 'tty-1', 'ses-1')));
    expect(probe?.tabs.terminals).toHaveLength(1);
    expect(stored()?.terminals).toHaveLength(1);

    render(STORAGE_KEY, SCOPE_B);
    expect(probe?.tabs).toEqual(createWorkspaceTabsState());

    render(STORAGE_KEY, SCOPE_A);
    expect(probe?.tabs.terminals).toEqual([
      { id: 'tty-1', title: 'Terminal 1', cloudAgentSessionId: 'ses-1' },
    ]);
    expect(probe?.tabs.activeTabId).toBe('terminal:tty-1');
  });

  it('restores tabs after a remount, like a page reload', () => {
    render(STORAGE_KEY, SCOPE_A);
    act(() => probe?.setTabs(state => addTerminalTab(state, 'tty-1', 'ses-1')));
    act(() => root.unmount());

    root = createRoot(dom.container);
    render(STORAGE_KEY, SCOPE_A);
    expect(probe?.tabs.terminals).toHaveLength(1);
  });

  it('drops the stored entry when the scope returns to the default state', () => {
    render(STORAGE_KEY, SCOPE_A);
    act(() => probe?.setTabs(state => addTerminalTab(state, 'tty-1', 'ses-1')));
    expect(stored()).toBeDefined();

    act(() => probe?.setTabs(createWorkspaceTabsState()));
    expect(stored()).toBeUndefined();
  });

  it('keeps tabs in memory but does not persist without a storage key', () => {
    render(null, SCOPE_A);
    act(() => probe?.setTabs(state => addTerminalTab(state, 'tty-1', 'ses-1')));
    expect(probe?.tabs.terminals).toHaveLength(1);
    expect(dom.storage.size).toBe(0);
  });

  it('does not resurrect externally closed tabs during a functional update', () => {
    render(STORAGE_KEY, SCOPE_A);
    act(() => probe?.setTabs(state => addTerminalTab(state, 'tty-1', 'ses-1')));
    const otherScope = addTerminalTab(createWorkspaceTabsState(), 'tty-b', 'ses-b');
    dom.storage.set(STORAGE_KEY, JSON.stringify({ tabsByScope: { [SCOPE_B]: otherScope } }));

    act(() => probe?.setTabs(state => addTerminalTab(state, 'tty-2', 'ses-2')));

    expect(probe?.tabs.terminals.map(tab => tab.id)).toEqual(['tty-2']);
    expect(stored()?.terminals.map(tab => tab.id)).toEqual(['tty-2']);
    expect(JSON.parse(dom.storage.get(STORAGE_KEY) ?? '{}').tabsByScope[SCOPE_B]).toEqual(
      otherScope
    );
  });

  it('syncs storage changes and clears while ignoring unrelated keys', () => {
    render(STORAGE_KEY, SCOPE_A);
    const external = addTerminalTab(createWorkspaceTabsState(), 'tty-1', 'ses-1');
    dom.storage.set(STORAGE_KEY, JSON.stringify({ tabsByScope: { [SCOPE_A]: external } }));
    dispatchStorage('unrelated');
    expect(probe?.tabs.terminals).toHaveLength(0);
    dispatchStorage();
    expect(probe?.tabs).toEqual(external);
    dom.storage.delete(STORAGE_KEY);
    dispatchStorage();
    expect(probe?.tabs).toEqual(createWorkspaceTabsState());
    act(() => probe?.setTabs(state => addTerminalTab(state, 'tty-2', 'ses-2')));
    dom.storage.clear();
    dispatchStorage(null);
    expect(probe?.tabs).toEqual(createWorkspaceTabsState());
  });

  it.each(['getItem', 'setItem'] as const)(
    'keeps functional updates in memory when %s throws',
    method => {
      jest.spyOn(window.localStorage, method).mockImplementation(() => {
        throw new Error('unavailable');
      });
      render(STORAGE_KEY, SCOPE_A);
      act(() => probe?.setTabs(state => addTerminalTab(state, 'tty-1', 'ses-1')));
      act(() => probe?.setTabs(state => addTerminalTab(state, 'tty-2', 'ses-2')));
      expect(probe?.tabs.terminals.map(tab => tab.id)).toEqual(['tty-1', 'tty-2']);
    }
  );

  it('keeps tabs in memory without a scope', () => {
    render(STORAGE_KEY, null);
    act(() => probe?.setTabs(state => addTerminalTab(state, 'tty-1', 'ses-1')));
    act(() => probe?.setTabs(state => addTerminalTab(state, 'tty-2', 'ses-2')));
    expect(probe?.tabs.terminals).toHaveLength(2);
    expect(dom.storage.size).toBe(0);
  });

  it('binds a retained setter to its own scope instead of the latest scope ref', () => {
    render(STORAGE_KEY, SCOPE_A);
    const setScopeA = probe?.setTabs;
    render(STORAGE_KEY, SCOPE_B);
    act(() => setScopeA?.(state => addTerminalTab(state, 'tty-a', 'ses-a')));
    expect(stored()?.terminals.map(tab => tab.id)).toEqual(['tty-a']);
    expect(probe?.tabs).toEqual(createWorkspaceTabsState());
  });

  describe('useClosedWorktreeChatTabs', () => {
    let chatProbe: ReturnType<typeof useClosedWorktreeChatTabs> | null;

    function ChatProbe({ storageKey }: { storageKey: string | null }) {
      chatProbe = useClosedWorktreeChatTabsHook(storageKey);
      return null;
    }

    function renderChats(storageKey: string | null = STORAGE_KEY) {
      act(() => root.render(createElement(ChatProbe, { storageKey })));
    }

    it('preserves external closures during a local update without a storage event', () => {
      renderChats();
      dom.storage.set(
        STORAGE_KEY,
        JSON.stringify({
          closedSessionIds: ['ses-external'],
          sessionOrderByWorktree: { 'wt-a': ['ses-1'] },
        })
      );
      act(() => chatProbe?.closeChatTab('ses-local'));
      expect(chatProbe?.closedSessionIds).toEqual(['ses-external', 'ses-local']);
      expect(JSON.parse(dom.storage.get(STORAGE_KEY) ?? '{}')).toEqual({
        closedSessionIds: ['ses-external', 'ses-local'],
        sessionOrderByWorktree: { 'wt-a': ['ses-1'] },
      });
    });

    it('syncs storage changes and clears while ignoring unrelated keys', () => {
      renderChats();
      dom.storage.set(
        STORAGE_KEY,
        JSON.stringify({
          closedSessionIds: ['ses-external'],
          sessionOrderByWorktree: { 'wt-a': ['ses-1'] },
        })
      );
      dispatchStorage('unrelated');
      expect(chatProbe?.closedSessionIds).toEqual([]);
      dispatchStorage();
      expect(chatProbe?.closedSessionIds).toEqual(['ses-external']);
      expect(chatProbe?.sessionOrderByWorktree).toEqual({ 'wt-a': ['ses-1'] });
      dom.storage.delete(STORAGE_KEY);
      dispatchStorage();
      expect(chatProbe?.closedSessionIds).toEqual([]);
      act(() => chatProbe?.closeChatTab('ses-local'));
      dom.storage.clear();
      dispatchStorage(null);
      expect(chatProbe?.closedSessionIds).toEqual([]);
    });

    it.each(['getItem', 'setItem'] as const)('keeps updates in memory when %s throws', method => {
      jest.spyOn(window.localStorage, method).mockImplementation(() => {
        throw new Error('unavailable');
      });
      renderChats();
      act(() => chatProbe?.closeChatTab('ses-1'));
      act(() => chatProbe?.closeChatTab('ses-2'));
      expect(chatProbe?.closedSessionIds).toEqual(['ses-1', 'ses-2']);
    });

    it('keeps updates in memory without a storage key', () => {
      renderChats(null);
      act(() => chatProbe?.closeChatTab('ses-1'));
      act(() => chatProbe?.closeChatTab('ses-2'));
      expect(chatProbe?.closedSessionIds).toEqual(['ses-1', 'ses-2']);
      expect(dom.storage.size).toBe(0);
    });
  });
});
