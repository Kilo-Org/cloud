import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type {
  GetWorktreeChangesOutput,
  WorktreeChangesSnapshot,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import {
  buildWorktreeChangesTree,
  canOpenWorktreeChanges,
  createWorktreeChangesRefresher,
  deserializeWorktreeChangesViewMode,
  formatWorktreeChangesBaseBranch,
  getWorktreeChangesTotals,
  groupWorktreeChangesByDirectory,
  preserveNewerWorktreeChanges,
  worktreeChangesMessages,
  type WorktreeChangesFile,
  type WorktreeChangesTreeNode,
} from './worktree-changes';

const snapshot: WorktreeChangesSnapshot = {
  schemaVersion: 1,
  revision: 3,
  capturedAt: '2026-08-26T12:00:00.000Z',
  comparison: { baseRef: 'origin/main', mergeBase: 'a'.repeat(40), head: 'b'.repeat(40) },
  files: [
    {
      path: 'src/odd\nfile\tname.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      tracked: true,
      binary: false,
      countsComplete: true,
    },
  ],
  truncated: false,
};

function messages(overrides: Partial<Parameters<typeof worktreeChangesMessages>[0]> = {}) {
  return worktreeChangesMessages({
    snapshot,
    savedReadPending: false,
    savedReadFailed: false,
    refreshPending: false,
    refreshFailed: false,
    refreshStatus: undefined,
    ...overrides,
  });
}

describe('getWorktreeChangesTotals', () => {
  it.each([null, undefined])('returns null for an unavailable snapshot: %p', missing => {
    expect(getWorktreeChangesTotals(missing)).toBeNull();
  });

  it('returns complete zero totals for a saved empty snapshot', () => {
    expect(getWorktreeChangesTotals({ ...snapshot, files: [] })).toEqual({
      fileCount: 0,
      additions: 0,
      deletions: 0,
      countsComplete: true,
    });
  });

  it('sums text changes across statuses and tracking states without mutating the snapshot', () => {
    const mixedSnapshot: WorktreeChangesSnapshot = {
      ...snapshot,
      files: [
        { ...snapshot.files[0] },
        {
          ...snapshot.files[0],
          path: 'src/added.ts',
          status: 'added',
          additions: 5,
          deletions: 0,
        },
        {
          ...snapshot.files[0],
          path: 'src/deleted.ts',
          status: 'deleted',
          additions: 0,
          deletions: 7,
        },
        {
          ...snapshot.files[0],
          path: 'untracked.txt',
          status: 'added',
          additions: 3,
          deletions: 0,
          tracked: false,
        },
        {
          ...snapshot.files[0],
          path: 'image.png',
          additions: 100,
          deletions: 200,
          binary: true,
          countsComplete: false,
        },
      ],
    };
    const original = structuredClone(mixedSnapshot);

    expect(getWorktreeChangesTotals(mixedSnapshot)).toEqual({
      fileCount: 5,
      additions: 10,
      deletions: 8,
      countsComplete: true,
    });
    expect(mixedSnapshot).toEqual(original);
  });

  it.each([true, false])(
    'ignores binary counters and completeness when binary countsComplete is %s',
    countsComplete => {
      expect(
        getWorktreeChangesTotals({
          ...snapshot,
          files: [
            {
              ...snapshot.files[0],
              path: 'untracked.bin',
              status: 'added',
              tracked: false,
              binary: true,
              additions: 100,
              deletions: 200,
              countsComplete,
            },
          ],
        })
      ).toEqual({ fileCount: 1, additions: 0, deletions: 0, countsComplete: true });
    }
  );

  it('preserves known subtotals when the snapshot is truncated', () => {
    expect(getWorktreeChangesTotals({ ...snapshot, truncated: true })).toEqual({
      fileCount: 1,
      additions: 2,
      deletions: 1,
      countsComplete: false,
    });
  });

  it('does not report omitted entries as complete zero totals', () => {
    expect(getWorktreeChangesTotals({ ...snapshot, files: [], truncated: true })).toEqual({
      fileCount: 0,
      additions: 0,
      deletions: 0,
      countsComplete: false,
    });
  });

  it('includes known counts from partial text files alongside complete files', () => {
    expect(
      getWorktreeChangesTotals({
        ...snapshot,
        files: [
          { ...snapshot.files[0], countsComplete: false },
          {
            ...snapshot.files[0],
            path: 'untracked.txt',
            status: 'added',
            additions: 7,
            deletions: 0,
            tracked: false,
          },
        ],
      })
    ).toEqual({ fileCount: 2, additions: 9, deletions: 1, countsComplete: false });
  });

  it('does not report unknown text counts as complete zero totals', () => {
    expect(
      getWorktreeChangesTotals({
        ...snapshot,
        files: [{ ...snapshot.files[0], additions: 0, deletions: 0, countsComplete: false }],
      })
    ).toEqual({ fileCount: 1, additions: 0, deletions: 0, countsComplete: false });
  });
});

describe('worktree changes capability', () => {
  it('uses the control ID rather than a Kilo or legacy session ID', () => {
    expect(canOpenWorktreeChanges('workspace_12345678-1234-4234-9234-123456789abc', false)).toBe(
      true
    );
    expect(canOpenWorktreeChanges('agent_12345678-1234-4234-9234-123456789abc', false)).toBe(false);
    expect(canOpenWorktreeChanges('ses_12345678901234567890123456', false)).toBe(false);
    expect(canOpenWorktreeChanges(null, false)).toBe(false);
    expect(canOpenWorktreeChanges(undefined, false)).toBe(false);
  });

  it('excludes read-only views independently of the session prefix', () => {
    expect(canOpenWorktreeChanges('workspace_12345678-1234-4234-9234-123456789abc', true)).toBe(
      false
    );
  });
});

describe('saved worktree changes cache', () => {
  let queryClient: QueryClient;
  const queryKey = ['worktree-changes', 'personal', 'workspace-a'];

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { structuralSharing: preserveNewerWorktreeChanges, retry: false },
      },
    });
  });

  afterEach(() => queryClient.clear());

  it('accepts newer revisions, preserves unusual paths, and ignores clock ordering', () => {
    const newer = { ...snapshot, revision: 4, capturedAt: '2026-08-26T11:00:00.000Z' };
    expect(preserveNewerWorktreeChanges({ snapshot }, { snapshot: newer })).toEqual({
      snapshot: newer,
    });
  });

  it.each([
    null,
    { ...snapshot, revision: 2 },
    { ...snapshot, capturedAt: '2026-08-26T13:00:00.000Z' },
  ])('does not replace newer or equal saved revisions', incoming => {
    expect(preserveNewerWorktreeChanges({ snapshot }, { snapshot: incoming })).toEqual({
      snapshot,
    });
  });

  it('can initialize saved data from an offline or failed refresh response', () => {
    expect(preserveNewerWorktreeChanges(undefined, { snapshot })).toEqual({ snapshot });
    expect(preserveNewerWorktreeChanges({ snapshot: null }, { snapshot })).toEqual({ snapshot });
    expect(preserveNewerWorktreeChanges(undefined, { snapshot: null })).toEqual({ snapshot: null });
  });

  it('does not let an in-flight saved read overwrite a newer refresh', async () => {
    queryClient.setQueryData(queryKey, { snapshot });
    const read = Promise.withResolvers<GetWorktreeChangesOutput>();
    const pendingRead = queryClient.fetchQuery({ queryKey, queryFn: () => read.promise });
    const newer = { ...snapshot, revision: 4 };
    queryClient.setQueryData(queryKey, { snapshot: newer });
    read.resolve({ snapshot });
    await pendingRead;

    expect(queryClient.getQueryData(queryKey)).toEqual({ snapshot: newer });
  });

  it('keeps delayed responses scoped to their session without a global revision floor', () => {
    const nextSessionKey = ['worktree-changes', 'personal', 'workspace-b'];
    queryClient.setQueryData(queryKey, { snapshot });
    expect(queryClient.getQueryData(nextSessionKey)).toBeUndefined();
    queryClient.setQueryData(nextSessionKey, { snapshot: { ...snapshot, revision: 1 } });
    queryClient.setQueryData(queryKey, { snapshot: { ...snapshot, revision: 4 } });

    expect(queryClient.getQueryData(nextSessionKey)).toEqual({
      snapshot: { ...snapshot, revision: 1 },
    });
  });

  it('does not share data between personal and organization scopes', () => {
    queryClient.setQueryData(queryKey, { snapshot });
    expect(
      queryClient.getQueryData(['worktree-changes', 'organization-a', 'workspace-a'])
    ).toBeUndefined();
  });
});

describe('worktree changes refresh coordination', () => {
  const queryKey = ['worktree-changes', 'personal', 'workspace-a'];
  const saved = (revision: number): GetWorktreeChangesOutput => ({
    snapshot: { ...snapshot, revision },
  });
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { structuralSharing: preserveNewerWorktreeChanges, retry: false },
      },
    });
  });

  afterEach(() => queryClient.clear());

  it.each([false, true])(
    'supersedes an initial read once (connection refresh: %s)',
    async connectionRefresh => {
      const initial = Promise.withResolvers<GetWorktreeChangesOutput>();
      const initialStarted = Promise.withResolvers<void>();
      const next = Promise.withResolvers<GetWorktreeChangesOutput>();
      const nextStarted = Promise.withResolvers<void>();
      const signals: AbortSignal[] = [];
      const observer = new QueryObserver(queryClient, {
        queryKey,
        staleTime: Infinity,
        initialData: connectionRefresh ? { snapshot: null } : undefined,
        queryFn: ({ signal }) => {
          signals.push(signal);
          if (signals.length === 1) {
            initialStarted.resolve();
            return initial.promise;
          }
          nextStarted.resolve();
          return next.promise;
        },
      });
      const unsubscribe = observer.subscribe(() => {});
      const refresher = createWorktreeChangesRefresher(queryClient, queryKey);
      try {
        if (connectionRefresh) void refresher.request({ revision: 0, force: true });
        await initialStarted.promise;
        const refreshing = refresher.request({ revision: 4, force: false });
        await nextStarted.promise;
        expect(signals[0].aborted).toBe(true);
        expect(signals[1].aborted).toBe(false);
        next.resolve(saved(4));
        await refreshing;
        initial.resolve(saved(3));
        await initial.promise;
        expect(queryClient.getQueryData(queryKey)).toEqual(saved(4));
        expect(signals).toHaveLength(2);
      } finally {
        initial.resolve(saved(3));
        next.resolve(saved(4));
        refresher.dispose();
        unsubscribe();
      }
    }
  );

  it.each([
    { returnedRevision: 4, reconnected: false, expectedReads: 2 },
    { returnedRevision: 7, reconnected: false, expectedReads: 1 },
    { returnedRevision: 7, reconnected: true, expectedReads: 2 },
  ])(
    'coalesces a burst with reply $returnedRevision and reconnect $reconnected into $expectedReads reads',
    async ({ returnedRevision, reconnected, expectedReads }) => {
      queryClient.setQueryData(queryKey, saved(3));
      const first = Promise.withResolvers<GetWorktreeChangesOutput>();
      const firstStarted = Promise.withResolvers<void>();
      const signals: AbortSignal[] = [];
      const observer = new QueryObserver(queryClient, {
        queryKey,
        staleTime: Infinity,
        queryFn: ({ signal }) => {
          signals.push(signal);
          if (signals.length === 1) {
            firstStarted.resolve();
            return first.promise;
          }
          return Promise.resolve(saved(7));
        },
      });
      const unsubscribe = observer.subscribe(() => {});
      const refresher = createWorktreeChangesRefresher(queryClient, queryKey);
      try {
        const refreshing = refresher.request({ revision: 4, force: false });
        await firstStarted.promise;
        for (const revision of [5, 7, 6]) {
          expect(refresher.request({ revision, force: false })).toBe(refreshing);
        }
        if (reconnected) {
          expect(refresher.request({ revision: 6, force: true })).toBe(refreshing);
        }
        expect(signals).toHaveLength(1);
        expect(signals[0].aborted).toBe(false);
        first.resolve(saved(returnedRevision));
        await refreshing;
        expect(signals).toHaveLength(expectedReads);
        expect(signals.every(signal => !signal.aborted)).toBe(true);
        expect(queryClient.getQueryData(queryKey)).toEqual(saved(7));
      } finally {
        first.resolve(saved(7));
        refresher.dispose();
        unsubscribe();
      }
    }
  );

  it('discards queued reads on disposal without touching another session cache', async () => {
    queryClient.setQueryData(queryKey, saved(3));
    const otherKey = ['worktree-changes', 'organization-b', 'workspace-b'];
    queryClient.setQueryData(otherKey, saved(1));
    const first = Promise.withResolvers<GetWorktreeChangesOutput>();
    const started = Promise.withResolvers<void>();
    const queryFn = jest.fn(() => {
      started.resolve();
      return first.promise;
    });
    const observer = new QueryObserver(queryClient, { queryKey, staleTime: Infinity, queryFn });
    const unsubscribe = observer.subscribe(() => {});
    const refresher = createWorktreeChangesRefresher(queryClient, queryKey);
    try {
      const refreshing = refresher.request({ revision: 4, force: false });
      await started.promise;
      void refresher.request({ revision: 5, force: true });
      refresher.dispose();
      first.resolve(saved(4));
      await refreshing;
      await refresher.request({ revision: 6, force: true });
      expect(queryFn).toHaveBeenCalledTimes(1);
      expect(queryClient.getQueryData(otherKey)).toEqual(saved(1));
    } finally {
      first.resolve(saved(4));
      refresher.dispose();
      unsubscribe();
    }
  });

  it('lets a read retry recover without another ready notification', async () => {
    queryClient.setQueryData(queryKey, saved(3));
    const queryFn = jest
      .fn<Promise<GetWorktreeChangesOutput>, []>()
      .mockRejectedValueOnce(new Error('Transient read failure'))
      .mockResolvedValue(saved(4));
    const observer = new QueryObserver(queryClient, {
      queryKey,
      staleTime: Infinity,
      retry: 2,
      retryDelay: 0,
      queryFn,
    });
    const unsubscribe = observer.subscribe(() => {});
    const refresher = createWorktreeChangesRefresher(queryClient, queryKey);
    try {
      await refresher.request({ revision: 4, force: false });
      expect(queryFn).toHaveBeenCalledTimes(2);
      expect(queryClient.getQueryData(queryKey)).toEqual(saved(4));
    } finally {
      refresher.dispose();
      unsubscribe();
    }
  });
});

describe('worktree changes messages', () => {
  it('keeps saved content while refresh is pending', () => {
    expect(messages({ refreshPending: true })).toEqual({
      notice: 'Refreshing…',
      empty: null,
    });
  });

  it('labels offline saved data without treating it as empty', () => {
    expect(messages({ refreshStatus: 'offline' })).toEqual({
      notice: 'Offline · showing saved changes.',
      empty: null,
    });
  });

  it.each([{ refreshStatus: 'failed' as const }, { refreshFailed: true }])(
    'preserves saved content when refresh fails',
    failure => {
      expect(messages(failure)).toEqual({
        notice: 'Refresh failed · showing saved changes.',
        empty: null,
      });
    }
  );

  it('preserves saved content when the saved read fails', () => {
    expect(messages({ savedReadFailed: true })).toEqual({
      notice: 'Load failed · showing saved changes.',
      empty: null,
    });
  });

  it.each([
    {
      state: { refreshPending: true, refreshFailed: true, refreshStatus: 'offline' as const },
      notice: 'Refreshing…',
    },
    {
      state: { refreshFailed: true, refreshStatus: 'offline' as const },
      notice: 'Refresh failed · showing saved changes.',
    },
    {
      state: { refreshStatus: 'offline' as const },
      notice: 'Offline · showing saved changes.',
    },
  ])('prioritizes "$notice" over a saved-read failure', ({ state, notice }) => {
    expect(messages({ ...state, savedReadFailed: true })).toEqual({ notice, empty: null });
  });

  it('distinguishes a missing saved snapshot from an unsuccessful saved read', () => {
    expect(messages({ snapshot: null }).empty).toBe('No saved changes yet.');
    expect(messages({ snapshot: undefined, savedReadFailed: true }).empty).toBe(
      'Could not load saved changes.'
    );
    expect(messages({ snapshot: undefined, savedReadPending: true }).empty).toBe(
      'Loading saved changes…'
    );
  });

  it('reports an initial read failure even if the subsequent refresh also fails', () => {
    expect(messages({ snapshot: undefined, savedReadFailed: true, refreshFailed: true })).toEqual({
      notice: 'Refresh failed.',
      empty: 'Could not load saved changes.',
    });
  });

  it('reports an empty successful summary without repeating its timestamp', () => {
    expect(messages({ snapshot: { ...snapshot, files: [] } })).toEqual({
      notice: null,
      empty: 'No changes.',
    });
  });

  it('does not call a truncated summary clean when all entries were omitted', () => {
    expect(messages({ snapshot: { ...snapshot, files: [], truncated: true } }).empty).toBeNull();
  });

  it('distinguishes an offline sandbox with no saved summary', () => {
    expect(messages({ snapshot: null, refreshStatus: 'offline' })).toEqual({
      notice: 'Sandbox offline.',
      empty: 'No saved changes yet.',
    });
  });
});

describe('groupWorktreeChangesByDirectory', () => {
  it('does not create empty folder groups', () => {
    expect(groupWorktreeChangesByDirectory([])).toEqual([]);
  });

  it('groups only direct siblings under their complete parent paths', () => {
    const files: WorktreeChangesFile[] = [
      'src/b.ts',
      'src/nested/a.ts',
      'README',
      'src/a.ts',
      'tests/src/a.ts',
    ].map(path => ({ ...snapshot.files[0], path }));

    expect(groupWorktreeChangesByDirectory(files)).toEqual([
      { directory: '', files: [files[2]] },
      { directory: 'src', files: [files[3], files[0]] },
      { directory: 'src/nested', files: [files[1]] },
      { directory: 'tests/src', files: [files[4]] },
    ]);
  });

  it('sorts directories and files deterministically with repository-root files first', () => {
    const files: WorktreeChangesFile[] = [
      'z/z.ts',
      'a/z.ts',
      'Z.ts',
      'a/a.ts',
      'a.ts',
      'é/file.ts',
      'A/file.ts',
      'a/Z.ts',
    ].map(path => ({ ...snapshot.files[0], path }));
    const groups = groupWorktreeChangesByDirectory(files);

    expect(groups.map(group => group.directory)).toEqual(['', 'A', 'a', 'z', 'é']);
    expect(groups[0].files.map(file => file.path)).toEqual(['Z.ts', 'a.ts']);
    expect(groups[2].files.map(file => file.path)).toEqual(['a/Z.ts', 'a/a.ts', 'a/z.ts']);
    expect(groupWorktreeChangesByDirectory(files.toReversed())).toEqual(groups);
  });

  it('preserves unusual paths and metadata without mutating files or treating backslashes as separators', () => {
    const binary = Object.freeze({
      ...snapshot.files[0],
      path: '__proto__/constructor/odd\\file\t\n雪.ts',
      binary: true,
      countsComplete: false,
    });
    const root = Object.freeze({
      ...snapshot.files[0],
      path: 'root\\file\t\n雪.ts',
      tracked: false,
    });
    const dotfile = Object.freeze({ ...snapshot.files[0], path: '.changeset/fix.md' });
    const files = Object.freeze([binary, root, dotfile]);
    const groups = groupWorktreeChangesByDirectory(files);

    expect(groups).toEqual([
      { directory: '', files: [root] },
      { directory: '.changeset', files: [dotfile] },
      { directory: '__proto__/constructor', files: [binary] },
    ]);
    expect(groups[2].files[0]).toBe(binary);
    expect(files).toEqual([binary, root, dotfile]);
  });

  it('keeps a deleted file distinct from added files in a folder with the same name', () => {
    const deleted: WorktreeChangesFile = {
      ...snapshot.files[0],
      path: 'a',
      status: 'deleted',
      additions: 0,
    };
    const added: WorktreeChangesFile = {
      ...snapshot.files[0],
      path: 'a/b',
      status: 'added',
      deletions: 0,
      tracked: false,
    };

    expect(groupWorktreeChangesByDirectory([added, deleted])).toEqual([
      { directory: '', files: [deleted] },
      { directory: 'a', files: [added] },
    ]);
  });
});

describe('formatWorktreeChangesBaseBranch', () => {
  it.each([
    ['refs/remotes/origin/master', 'master'],
    ['refs/remotes/origin/main', 'main'],
    ['refs/remotes/origin/feature/a', 'feature/a'],
    ['refs/remotes/upstream/release/2026', 'release/2026'],
    ['refs/remotes/origin/origin/topic', 'origin/topic'],
    ['refs/remotes/origin/refs/remotes/upstream/topic', 'refs/remotes/upstream/topic'],
    ['main', 'main'],
    ['feature/a', 'feature/a'],
    ['refs/tags/v1', 'refs/tags/v1'],
  ])('formats %s without losing branch path segments', (baseRef, branch) => {
    expect(formatWorktreeChangesBaseBranch(baseRef)).toBe(branch);
  });
});

describe('deserializeWorktreeChangesViewMode', () => {
  it.each(['flat', 'tree'])('restores the JSON-serialized %s preference', mode => {
    expect(deserializeWorktreeChangesViewMode(JSON.stringify(mode))).toBe(mode);
  });

  it('accepts JSON whitespace around a valid preference', () => {
    expect(deserializeWorktreeChangesViewMode(' \n"tree"\t ')).toBe('tree');
  });

  it.each([
    '',
    'flat',
    'tree',
    'undefined',
    '{',
    '"tree',
    'null',
    'true',
    '1',
    '""',
    '"list"',
    '"Tree"',
    '" tree "',
    '["tree"]',
    '{"viewMode":"tree"}',
  ])('defaults to flat for invalid persisted data: %p', value => {
    expect(deserializeWorktreeChangesViewMode(value)).toBe('flat');
  });
});

describe('buildWorktreeChangesTree', () => {
  it('returns an empty tree for no changes', () => {
    expect(buildWorktreeChangesTree([])).toEqual([]);
  });

  it('groups nested paths while keeping root files and repeated names distinct', () => {
    const files: WorktreeChangesFile[] = [
      'index.ts',
      'src/index.ts',
      'src/src/index.ts',
      'tests/src/index.ts',
    ].map(path => ({ ...snapshot.files[0], path }));

    expect(buildWorktreeChangesTree(files)).toEqual([
      {
        kind: 'directory',
        name: 'src',
        path: 'src',
        children: [
          {
            kind: 'directory',
            name: 'src',
            path: 'src/src',
            children: [
              { kind: 'file', name: 'index.ts', path: 'src/src/index.ts', file: files[2] },
            ],
          },
          { kind: 'file', name: 'index.ts', path: 'src/index.ts', file: files[1] },
        ],
      },
      {
        kind: 'directory',
        name: 'tests',
        path: 'tests',
        children: [
          {
            kind: 'directory',
            name: 'src',
            path: 'tests/src',
            children: [
              { kind: 'file', name: 'index.ts', path: 'tests/src/index.ts', file: files[3] },
            ],
          },
        ],
      },
      { kind: 'file', name: 'index.ts', path: 'index.ts', file: files[0] },
    ]);
  });

  it('sorts directories first and names deterministically at every level', () => {
    const files: WorktreeChangesFile[] = [
      'z.ts',
      'beta/z.ts',
      'alpha/z.ts',
      'beta/a.ts',
      'a.ts',
      'beta/zeta/z.ts',
      'beta/alpha/z.ts',
      'Z.ts',
      'é.ts',
    ].map(path => ({ ...snapshot.files[0], path }));
    const tree = buildWorktreeChangesTree(files);

    expect(tree.map(({ kind, name }) => [kind, name])).toEqual([
      ['directory', 'alpha'],
      ['directory', 'beta'],
      ['file', 'Z.ts'],
      ['file', 'a.ts'],
      ['file', 'z.ts'],
      ['file', 'é.ts'],
    ]);
    expect(tree[1]).toMatchObject({
      children: [
        { kind: 'directory', name: 'alpha' },
        { kind: 'directory', name: 'zeta' },
        { kind: 'file', name: 'a.ts' },
        { kind: 'file', name: 'z.ts' },
      ],
    });
    expect(buildWorktreeChangesTree(files.toReversed())).toEqual(tree);
  });

  it('preserves exact paths and metadata without splitting backslashes or mutating input', () => {
    const rootFile: WorktreeChangesFile = Object.freeze({
      path: 'root\\file\t\n雪.ts',
      status: 'deleted',
      additions: 0,
      deletions: 17,
      tracked: true,
      binary: true,
      countsComplete: false,
    });
    const nestedFile: WorktreeChangesFile = Object.freeze({
      path: ' \tdir\\name\n / e\u0301\\雪\t\n.ts ',
      status: 'added',
      additions: 12,
      deletions: 0,
      tracked: false,
      binary: false,
      countsComplete: true,
    });
    const files = Object.freeze([rootFile, nestedFile]);

    expect(buildWorktreeChangesTree(files)).toEqual([
      {
        kind: 'directory',
        name: ' \tdir\\name\n ',
        path: ' \tdir\\name\n ',
        children: [
          {
            kind: 'file',
            name: ' e\u0301\\雪\t\n.ts ',
            path: nestedFile.path,
            file: nestedFile,
          },
        ],
      },
      { kind: 'file', name: rootFile.path, path: rootFile.path, file: rootFile },
    ]);
    expect(files).toEqual([rootFile, nestedFile]);
  });

  it('keeps a deleted file alongside an added child at the same directory path in either order', () => {
    const deleted: WorktreeChangesFile = {
      ...snapshot.files[0],
      path: 'a',
      status: 'deleted',
      additions: 0,
    };
    const added: WorktreeChangesFile = {
      ...snapshot.files[0],
      path: 'a/b',
      status: 'added',
      deletions: 0,
      tracked: false,
    };
    const expected: WorktreeChangesTreeNode[] = [
      {
        kind: 'directory',
        name: 'a',
        path: 'a',
        children: [{ kind: 'file', name: 'b', path: 'a/b', file: added }],
      },
      { kind: 'file', name: 'a', path: 'a', file: deleted },
    ];

    expect(buildWorktreeChangesTree([deleted, added])).toEqual(expected);
    expect(buildWorktreeChangesTree([added, deleted])).toEqual(expected);
  });

  it('treats prototype property names as ordinary path segments', () => {
    const files: WorktreeChangesFile[] = [
      '__proto__/constructor/toString',
      'constructor/__proto__',
    ].map(path => ({ ...snapshot.files[0], path }));

    expect(buildWorktreeChangesTree(files)).toEqual([
      {
        kind: 'directory',
        name: '__proto__',
        path: '__proto__',
        children: [
          {
            kind: 'directory',
            name: 'constructor',
            path: '__proto__/constructor',
            children: [
              {
                kind: 'file',
                name: 'toString',
                path: '__proto__/constructor/toString',
                file: files[0],
              },
            ],
          },
        ],
      },
      {
        kind: 'directory',
        name: 'constructor',
        path: 'constructor',
        children: [
          {
            kind: 'file',
            name: '__proto__',
            path: 'constructor/__proto__',
            file: files[1],
          },
        ],
      },
    ]);
  });
});
