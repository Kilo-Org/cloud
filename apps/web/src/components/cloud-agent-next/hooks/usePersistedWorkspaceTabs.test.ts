import React, { act, createElement, type Dispatch, type SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import {
  addTerminalTab,
  createWorkspaceTabsState,
  type WorkspaceTabsState,
} from '../workspace-tabs';
import type { usePersistedWorkspaceTabs } from './usePersistedWorkspaceTabs';

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
  let dom: ReturnType<typeof installDom>;
  let root: Root;
  let probe: ProbeState | null;

  beforeAll(async () => {
    dom = installDom();
    ({ usePersistedWorkspaceTabs: usePersistedWorkspaceTabsHook } =
      await import('./usePersistedWorkspaceTabs'));
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
});
