import {
  CHAT_TAB_ID,
  createWorkspaceTabsState,
  fileTabId,
  terminalTabId,
  type WorkspaceTabsState,
} from './workspace-tabs';
import {
  getWorkspaceTabsForScope,
  getWorkspaceTabsStorageKey,
  isDefaultWorkspaceTabs,
  parseWorkspaceTabsByScope,
  setWorkspaceTabsForScope,
} from './workspace-tabs-storage';

function tabs(overrides: Partial<WorkspaceTabsState> = {}): WorkspaceTabsState {
  return { ...createWorkspaceTabsState(), ...overrides };
}

describe('getWorkspaceTabsStorageKey', () => {
  it('requires a user', () => {
    expect(getWorkspaceTabsStorageKey(null)).toBeNull();
    expect(getWorkspaceTabsStorageKey(undefined, 'org-a')).toBeNull();
    expect(getWorkspaceTabsStorageKey('')).toBeNull();
  });

  it('isolates the personal and organization contexts per user', () => {
    const keys = [
      getWorkspaceTabsStorageKey('user-a'),
      getWorkspaceTabsStorageKey('user-b'),
      getWorkspaceTabsStorageKey('user-a', 'org-a'),
      getWorkspaceTabsStorageKey('user-a', 'org-b'),
      getWorkspaceTabsStorageKey('user-b', 'org-a'),
      getWorkspaceTabsStorageKey('user-a', null),
    ];

    expect(keys[0]).toBe(keys[5]);
    expect(new Set(keys).size).toBe(5);
    expect(keys[0]).toContain('cloud-agent:workspace-tabs:user:');
    expect(keys[0]).toContain(':personal');
    expect(keys[2]).toContain('organization:org-a');
  });

  it('cannot be spoofed by separators inside identifiers', () => {
    expect(getWorkspaceTabsStorageKey('user-a:organization:org-a', 'org-b')).not.toBe(
      getWorkspaceTabsStorageKey('user-a', 'org-a:organization:org-b')
    );
  });
});

describe('parseWorkspaceTabsByScope', () => {
  it('returns an empty map for missing, malformed, or unexpected payloads', () => {
    expect(parseWorkspaceTabsByScope(null)).toEqual({});
    expect(parseWorkspaceTabsByScope('')).toEqual({});
    expect(parseWorkspaceTabsByScope('not json')).toEqual({});
    expect(parseWorkspaceTabsByScope('[]')).toEqual({});
    expect(parseWorkspaceTabsByScope('{"tabsByScope":42}')).toEqual({});
  });

  it('round-trips valid per-scope tabs', () => {
    const state = {
      tabsByScope: {
        'worktree:wt-1': tabs({
          activeTabId: terminalTabId('tty-1'),
          terminals: [{ id: 'tty-1', title: 'Terminal 1', cloudAgentSessionId: 'ses-1' }],
          files: [{ path: 'src/main.ts', mode: 'diff' as const }],
          nextTerminalNumber: 2,
        }),
      },
    };

    expect(parseWorkspaceTabsByScope(JSON.stringify(state))).toEqual(state.tabsByScope);
  });

  it('drops malformed scopes and duplicate tabs', () => {
    const validScopeTabs = tabs({
      terminals: [
        { id: 'tty-1', title: 'Terminal 1', cloudAgentSessionId: 'ses-1' },
        { id: 'tty-1', title: 'Terminal 1', cloudAgentSessionId: 'ses-1' },
      ],
      files: [{ path: 'a.ts' }, { path: 'a.ts' }],
    });
    const raw = `{
      "tabsByScope": {
        "__proto__": ${JSON.stringify(tabs())},
        "not-a-scope": ${JSON.stringify(tabs())},
        "worktree:wt-1": ${JSON.stringify(validScopeTabs)}
      }
    }`;

    const parsed = parseWorkspaceTabsByScope(raw);
    expect(Object.keys(parsed)).toEqual(['worktree:wt-1']);
    expect(parsed['worktree:wt-1'].terminals).toEqual([
      { id: 'tty-1', title: 'Terminal 1', cloudAgentSessionId: 'ses-1' },
    ]);
    expect(parsed['worktree:wt-1'].files).toEqual([{ path: 'a.ts' }]);
  });

  it('falls back to chat when the persisted active tab no longer exists', () => {
    const parsed = parseWorkspaceTabsByScope(
      JSON.stringify({
        tabsByScope: {
          'worktree:wt-1': tabs({ activeTabId: terminalTabId('gone') }),
          'worktree:wt-2': tabs({ activeTabId: fileTabId('gone.ts') }),
        },
      })
    );

    expect(parsed['worktree:wt-1'].activeTabId).toBe(CHAT_TAB_ID);
    expect(parsed['worktree:wt-2'].activeTabId).toBe(CHAT_TAB_ID);
  });

  it('keeps a persisted active tab that still exists', () => {
    const parsed = parseWorkspaceTabsByScope(
      JSON.stringify({
        tabsByScope: {
          'session:ses-1': tabs({
            activeTabId: fileTabId('src/main.ts'),
            files: [{ path: 'src/main.ts' }],
          }),
        },
      })
    );

    expect(parsed['session:ses-1'].activeTabId).toBe(fileTabId('src/main.ts'));
  });

  it('repairs terminal numbering so labels cannot collide', () => {
    const parsed = parseWorkspaceTabsByScope(
      JSON.stringify({
        tabsByScope: {
          'worktree:wt-1': tabs({
            terminals: [
              { id: 'a', title: 'Terminal 4', cloudAgentSessionId: 'ses-1' },
              { id: 'b', title: 'Terminal 2', cloudAgentSessionId: 'ses-1' },
            ],
            nextTerminalNumber: 1,
          }),
        },
      })
    );

    expect(parsed['worktree:wt-1'].nextTerminalNumber).toBe(5);
  });
});

describe('workspace tabs scope map', () => {
  it('reads an empty state for unknown or missing scopes', () => {
    expect(getWorkspaceTabsForScope({}, 'worktree:wt-1')).toEqual(createWorkspaceTabsState());
    expect(getWorkspaceTabsForScope({}, null)).toEqual(createWorkspaceTabsState());
  });

  it('stores and replaces tabs per scope without touching siblings', () => {
    const first = tabs({ terminals: [{ id: 'a', title: 'Terminal 1', cloudAgentSessionId: 's' }] });
    const other = tabs({ files: [{ path: 'a.ts' }] });

    const map = setWorkspaceTabsForScope({}, 'worktree:wt-1', first);
    const withSibling = setWorkspaceTabsForScope(map, 'worktree:wt-2', other);

    expect(getWorkspaceTabsForScope(withSibling, 'worktree:wt-1')).toEqual(first);
    expect(getWorkspaceTabsForScope(withSibling, 'worktree:wt-2')).toEqual(other);
  });

  it('drops a scope once it returns to the default state', () => {
    const map = setWorkspaceTabsForScope({}, 'worktree:wt-1', tabs({ files: [{ path: 'a.ts' }] }));

    const cleared = setWorkspaceTabsForScope(map, 'worktree:wt-1', createWorkspaceTabsState());
    expect(cleared).toEqual({});
  });

  it('ignores writes without a scope', () => {
    const map = setWorkspaceTabsForScope({}, null, tabs({ files: [{ path: 'a.ts' }] }));
    expect(map).toEqual({});
  });
});

describe('isDefaultWorkspaceTabs', () => {
  it('only treats a pristine chat-only state as default', () => {
    expect(isDefaultWorkspaceTabs(createWorkspaceTabsState())).toBe(true);
    expect(isDefaultWorkspaceTabs(tabs({ nextTerminalNumber: 2 }))).toBe(false);
    expect(
      isDefaultWorkspaceTabs(
        tabs({ terminals: [{ id: 'a', title: 'Terminal 1', cloudAgentSessionId: 's' }] })
      )
    ).toBe(false);
  });
});
