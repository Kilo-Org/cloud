import type { WorktreeFileRecord } from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import { getWorktreeFileViewMode } from './worktree-file';
import {
  CHAT_TAB_ID,
  addTerminalTab as addOwnedTerminalTab,
  clearFileTabs,
  closeFileTab,
  closeTerminalTab,
  createWorkspaceTabsState,
  fileTabId,
  openFileTab,
  resetWorkspaceTabs,
  selectWorkspaceTab,
  setFileTabMode,
  terminalIdFromTabId,
  terminalTabId,
  type WorktreeFileViewMode,
} from './workspace-tabs';

function addTerminalTab(state: ReturnType<typeof createWorkspaceTabsState>, id: string) {
  return addOwnedTerminalTab(state, id, 'workspace-fixture');
}

describe('cloud agent workspace tabs', () => {
  it('starts on chat without terminals or files', () => {
    expect(createWorkspaceTabsState()).toEqual({
      activeTabId: CHAT_TAB_ID,
      terminals: [],
      files: [],
      nextTerminalNumber: 1,
    });
  });

  it('adds terminal tabs with stable ids and human labels', () => {
    const first = addTerminalTab(createWorkspaceTabsState(), 'tab-a');
    const second = addTerminalTab(first, 'tab-b');

    expect(second).toEqual({
      activeTabId: terminalTabId('tab-b'),
      nextTerminalNumber: 3,
      terminals: [
        { id: 'tab-a', title: 'Terminal 1', cloudAgentSessionId: 'workspace-fixture' },
        { id: 'tab-b', title: 'Terminal 2', cloudAgentSessionId: 'workspace-fixture' },
      ],
      files: [],
    });
  });

  it('distinguishes chat, terminals, and files even when paths resemble tab IDs', () => {
    expect(terminalIdFromTabId(CHAT_TAB_ID)).toBeNull();
    expect(terminalIdFromTabId(terminalTabId('tab-a'))).toBe('tab-a');
    expect(terminalIdFromTabId(fileTabId('terminal:tab-a'))).toBeNull();
    expect(fileTabId('chat')).not.toBe(CHAT_TAB_ID);
    expect(fileTabId('tab-a')).not.toBe(terminalTabId('tab-a'));
  });

  it('selects only chat and existing terminal or file tabs', () => {
    const state = openFileTab(
      addTerminalTab(createWorkspaceTabsState(), 'tab-a'),
      'src/with space.ts'
    );
    const chat = selectWorkspaceTab(state, CHAT_TAB_ID);

    expect(chat.activeTabId).toBe(CHAT_TAB_ID);
    expect(selectWorkspaceTab(chat, terminalTabId('tab-a')).activeTabId).toBe(
      terminalTabId('tab-a')
    );
    expect(selectWorkspaceTab(chat, fileTabId('src/with space.ts')).activeTabId).toBe(
      fileTabId('src/with space.ts')
    );
    expect(selectWorkspaceTab(state, state.activeTabId)).toBe(state);
    for (const missing of [
      'changes',
      'unknown',
      terminalTabId('missing'),
      fileTabId('missing'),
      'src/with space.ts',
    ]) {
      expect(selectWorkspaceTab(state, missing)).toBe(state);
    }
    expect(chat.files).toBe(state.files);
    expect(chat.terminals).toBe(state.terminals);
  });

  it('keeps the current tab when a background terminal closes', () => {
    const state = selectWorkspaceTab(
      addTerminalTab(addTerminalTab(createWorkspaceTabsState(), 'tab-a'), 'tab-b'),
      terminalTabId('tab-a')
    );

    expect(closeTerminalTab(state, 'tab-b')).toEqual({
      activeTabId: terminalTabId('tab-a'),
      nextTerminalNumber: 3,
      terminals: [{ id: 'tab-a', title: 'Terminal 1', cloudAgentSessionId: 'workspace-fixture' }],
      files: [],
    });
  });

  it('uses the left neighbor as the focus target when the active terminal closes', () => {
    const state = addTerminalTab(addTerminalTab(createWorkspaceTabsState(), 'tab-a'), 'tab-b');

    expect(closeTerminalTab(state, 'tab-b')).toEqual({
      activeTabId: terminalTabId('tab-a'),
      nextTerminalNumber: 3,
      terminals: [{ id: 'tab-a', title: 'Terminal 1', cloudAgentSessionId: 'workspace-fixture' }],
      files: [],
    });
  });

  it('uses the next terminal when the first active terminal closes', () => {
    const state = selectWorkspaceTab(
      addTerminalTab(addTerminalTab(createWorkspaceTabsState(), 'tab-a'), 'tab-b'),
      terminalTabId('tab-a')
    );

    expect(closeTerminalTab(state, 'tab-a').activeTabId).toBe(terminalTabId('tab-b'));
  });

  it('returns to chat when the last terminal closes', () => {
    const state = addTerminalTab(createWorkspaceTabsState(), 'tab-a');

    expect(closeTerminalTab(state, 'tab-a')).toEqual(createWorkspaceTabsState());
  });

  it('clears all tab metadata and modes on a session or organization reset', () => {
    const state = setFileTabMode(
      openFileTab(
        addTerminalTab(addTerminalTab(createWorkspaceTabsState(), 'tab-a'), 'tab-b'),
        'README.md'
      ),
      'README.md',
      'expanded'
    );
    const reset = resetWorkspaceTabs(state);
    const reopened = openFileTab(reset, 'README.md');

    expect(reset).toEqual(createWorkspaceTabsState());
    expect(reopened.files).toEqual([{ path: 'README.md' }]);
    expect(reopened.terminals).toEqual([]);
    expect(addTerminalTab(reopened, 'tab-c').terminals).toEqual([
      { id: 'tab-c', title: 'Terminal 1', cloudAgentSessionId: 'workspace-fixture' },
    ]);
    expect(state.files).toEqual([{ path: 'README.md', mode: 'expanded' }]);
  });
});

describe('saved file tabs', () => {
  const savedFile: WorktreeFileRecord = {
    schemaVersion: 1,
    revision: 1,
    path: 'README.md',
    diff: {
      status: 'available',
      patch: 'diff --git a/README.md b/README.md\nold mode 100644\nnew mode 100755\n',
    },
    content: { status: 'available', source: 'current', text: '# Saved file\n' },
  };

  it('clears selected-session files without replacing worktree terminal owners or selection', () => {
    const terminal = addOwnedTerminalTab(createWorkspaceTabsState(), 'pty', 'workspace-original');
    const files = setFileTabMode(openFileTab(terminal, 'README.md'), 'README.md', 'preview');
    const cleared = clearFileTabs(files);
    expect(cleared.files).toEqual([]);
    expect(cleared.activeTabId).toBe(CHAT_TAB_ID);
    expect(cleared.terminals).toBe(terminal.terminals);
    expect(clearFileTabs(selectWorkspaceTab(files, terminalTabId('pty'))).activeTabId).toBe(
      terminalTabId('pty')
    );
    expect(openFileTab(cleared, 'README.md').files).toEqual([{ path: 'README.md' }]);
  });

  it('opens files without choosing a mode before saved data is available, then defaults to diff', () => {
    const state = openFileTab(openFileTab(createWorkspaceTabsState(), 'README.md'), 'src/main.ts');

    expect(state.activeTabId).toBe(fileTabId('src/main.ts'));
    expect(state.files).toEqual([{ path: 'README.md' }, { path: 'src/main.ts' }]);
    for (const tab of state.files) {
      expect(getWorktreeFileViewMode({ ...savedFile, path: tab.path }, tab.mode)).toBe('diff');
    }
  });

  it('preserves exact paths and deduplicates only identical paths', () => {
    const paths = [
      'src/index.ts',
      'tests/index.ts',
      'Src/index.ts',
      'src/e\u0301.ts',
      'src/é.ts',
      'src/with space.ts',
      'src/with%20space.ts',
      'src\\index.ts',
      'src/odd"]#:\n\t雪.ts',
      '__proto__/constructor.ts',
      'chat',
      'terminal:tab-a',
    ];
    const opened = paths.reduce(openFileTab, createWorkspaceTabsState());
    const reopened = paths.toReversed().reduce(openFileTab, opened);

    expect(opened.files).toEqual(paths.map(path => ({ path })));
    expect(reopened.files).toBe(opened.files);
    expect(reopened.activeTabId).toBe(fileTabId(paths[0]));
    expect(new Set(paths.map(fileTabId)).size).toBe(paths.length);
    for (const path of paths) {
      expect(fileTabId(path)).not.toMatch(/\s/);
      expect(selectWorkspaceTab(opened, fileTabId(path)).activeTabId).toBe(fileTabId(path));
    }
  });

  const modes = ['diff', 'expanded', 'preview'] satisfies WorktreeFileViewMode[];
  it.each(modes)('reopens the existing file with its selected %s mode', mode => {
    const state = setFileTabMode(
      openFileTab(createWorkspaceTabsState(), 'README.md'),
      'README.md',
      mode
    );
    const other = openFileTab(state, 'src/main.ts');
    const reopened = openFileTab(other, 'README.md');

    expect(reopened.activeTabId).toBe(fileTabId('README.md'));
    expect(reopened.files).toBe(other.files);
    expect(reopened.files).toEqual([{ path: 'README.md', mode }, { path: 'src/main.ts' }]);
    expect(openFileTab(reopened, 'README.md')).toBe(reopened);
  });

  it('updates a file mode without changing the selection or another file', () => {
    const state = openFileTab(openFileTab(createWorkspaceTabsState(), 'README.md'), 'src/main.ts');
    const updated = setFileTabMode(state, 'README.md', 'expanded');

    expect(updated.activeTabId).toBe(state.activeTabId);
    expect(updated.files).toEqual([
      { path: 'README.md', mode: 'expanded' },
      { path: 'src/main.ts' },
    ]);
    expect(updated.files[1]).toBe(state.files[1]);
    expect(state.files).toEqual([{ path: 'README.md' }, { path: 'src/main.ts' }]);
    expect(setFileTabMode(updated, 'README.md', 'expanded')).toBe(updated);
    expect(setFileTabMode(updated, 'missing.md', 'preview')).toBe(updated);
  });

  it.each(['expanded', 'preview'] satisfies WorktreeFileViewMode[])(
    'retains the diff fallback from %s when a new revision omits full content',
    mode => {
      const selected = setFileTabMode(
        openFileTab(createWorkspaceTabsState(), 'README.md'),
        'README.md',
        mode
      );
      const nextRevision: WorktreeFileRecord = {
        ...savedFile,
        revision: 2,
        content: { status: 'unavailable', reason: 'too_large' },
      };
      const fallback = setFileTabMode(
        selected,
        'README.md',
        getWorktreeFileViewMode(nextRevision, mode)
      );
      const reopened = openFileTab(selectWorkspaceTab(fallback, CHAT_TAB_ID), 'README.md');

      expect(reopened.files).toEqual([{ path: 'README.md', mode: 'diff' }]);
      expect(getWorktreeFileViewMode(savedFile, reopened.files[0].mode)).toBe('diff');
    }
  );

  it('preserves terminal identity and numbering while files open, select, and close', () => {
    const terminals = addTerminalTab(addTerminalTab(createWorkspaceTabsState(), 'tab-a'), 'tab-b');
    const opened = openFileTab(terminals, 'README.md');
    const selected = selectWorkspaceTab(opened, terminalTabId('tab-a'));
    const closed = closeFileTab(openFileTab(selected, 'README.md'), 'README.md');

    for (const state of [opened, selected, closed]) {
      expect(state.terminals).toBe(terminals.terminals);
      expect(state.nextTerminalNumber).toBe(terminals.nextTerminalNumber);
    }
    expect(closed.activeTabId).toBe(terminalTabId('tab-b'));
    expect(addTerminalTab(closed, 'tab-c').terminals[2]).toEqual({
      id: 'tab-c',
      title: 'Terminal 3',
      cloudAgentSessionId: 'workspace-fixture',
    });
  });

  it('preserves file modes while terminals are added and closed', () => {
    const files = setFileTabMode(
      openFileTab(createWorkspaceTabsState(), 'README.md'),
      'README.md',
      'preview'
    );
    const first = addTerminalTab(files, 'tab-a');
    const second = addTerminalTab(first, 'tab-b');
    const closed = closeTerminalTab(second, 'tab-b');
    const lastClosed = closeTerminalTab(closed, 'tab-a');

    for (const state of [first, second, closed, lastClosed]) {
      expect(state.files).toBe(files.files);
    }
    expect(closed.activeTabId).toBe(terminalTabId('tab-a'));
    expect(lastClosed.activeTabId).toBe(fileTabId('README.md'));
    expect(lastClosed.nextTerminalNumber).toBe(1);
  });

  it('keeps the file focus target when its last background terminal closes', () => {
    const state = openFileTab(
      addTerminalTab(addTerminalTab(createWorkspaceTabsState(), 'tab-a'), 'tab-b'),
      'README.md'
    );
    const closed = closeTerminalTab(closeTerminalTab(state, 'tab-a'), 'tab-b');

    expect(closed.activeTabId).toBe(state.activeTabId);
    expect(closed.files).toBe(state.files);
    expect(addTerminalTab(closed, 'tab-c').terminals).toEqual([
      { id: 'tab-c', title: 'Terminal 1', cloudAgentSessionId: 'workspace-fixture' },
    ]);
  });

  it.each([CHAT_TAB_ID, terminalTabId('tab-a'), fileTabId('src/main.ts')])(
    'keeps %s as the focus target when a background file closes',
    activeTabId => {
      const state = selectWorkspaceTab(
        openFileTab(
          openFileTab(addTerminalTab(createWorkspaceTabsState(), 'tab-a'), 'README.md'),
          'src/main.ts'
        ),
        activeTabId
      );
      const closed = closeFileTab(state, 'README.md');

      expect(closed.activeTabId).toBe(activeTabId);
      expect(closed.files).toEqual([{ path: 'src/main.ts' }]);
      expect(closed.terminals).toBe(state.terminals);
      expect(closed.nextTerminalNumber).toBe(state.nextTerminalNumber);
    }
  );

  it.each([
    ['first.ts', terminalTabId('tab-a')],
    ['second.ts', fileTabId('first.ts')],
    ['third.ts', fileTabId('second.ts')],
  ])('uses the left neighbor as the focus target when %s closes', (path, focusTarget) => {
    const state = selectWorkspaceTab(
      ['first.ts', 'second.ts', 'third.ts'].reduce(
        openFileTab,
        addTerminalTab(createWorkspaceTabsState(), 'tab-a')
      ),
      fileTabId(path)
    );

    expect(closeFileTab(state, path).activeTabId).toBe(focusTarget);
  });

  it('uses the next file when the first active file has no terminal neighbor', () => {
    const state = selectWorkspaceTab(
      openFileTab(openFileTab(createWorkspaceTabsState(), 'README.md'), 'src/main.ts'),
      fileTabId('README.md')
    );

    expect(closeFileTab(state, 'README.md').activeTabId).toBe(fileTabId('src/main.ts'));
  });

  it('returns to chat when the last file closes and reopens it without stale metadata', () => {
    const state = setFileTabMode(
      openFileTab(createWorkspaceTabsState(), 'README.md'),
      'README.md',
      'expanded'
    );
    const closed = closeFileTab(state, 'README.md');

    expect(closed).toEqual(createWorkspaceTabsState());
    expect(openFileTab(closed, 'README.md').files).toEqual([{ path: 'README.md' }]);
  });

  it('ignores missing file or terminal close requests', () => {
    const state = openFileTab(addTerminalTab(createWorkspaceTabsState(), 'tab-a'), 'README.md');

    expect(closeFileTab(state, 'missing.md')).toBe(state);
    expect(closeTerminalTab(state, 'missing')).toBe(state);
  });
});
