import { describe, expect, it } from 'vitest';
import {
  MAX_WORKTREE_CHANGES_FILES,
  MAX_WORKTREE_CHANGES_BYTES,
  worktreeRecoverySchema,
  worktreeSnapshotCaptureSchema,
  type WorktreeSnapshotCapture,
} from './worktree-changes-wire.js';
import {
  flattenGroupedSnapshot,
  groupedWorktreeSnapshotSchema,
  parseReportedSnapshot,
  type GroupedWorktreeSnapshot,
  type RouteRepository,
} from './worktree-groups.js';

const sha = (digit: string) => digit.repeat(40);

function capture(
  revision: number,
  baseRef: string,
  paths: string[],
  truncated = false
): WorktreeSnapshotCapture {
  return {
    summary: {
      revision,
      comparison: { baseRef, mergeBase: sha('a'), head: sha('b') },
      files: paths.map(path => ({
        path,
        status: 'modified' as const,
        additions: 1,
        deletions: 0,
        tracked: true,
        binary: false,
        countsComplete: true,
      })),
      truncated,
    },
    files: paths.map(path => ({
      schemaVersion: 1 as const,
      revision,
      path,
      diff: { status: 'available' as const, patch: `diff --git a/${path} b/${path}\n+x\n` },
      content: { status: 'available' as const, source: 'current' as const, text: 'x\n' },
    })),
  };
}

const grouped = (
  repositories: Array<{ directory: string; repoFullName: string; capture: WorktreeSnapshotCapture }>
): GroupedWorktreeSnapshot => ({ repositories });

describe('groupedWorktreeSnapshotSchema', () => {
  const valid = grouped([
    {
      directory: '/workspace/web',
      repoFullName: 'acme/web',
      capture: capture(1, 'refs/remotes/origin/main', ['a.ts']),
    },
  ]);

  it('accepts one entry for each repository with repository-relative paths', () => {
    expect(groupedWorktreeSnapshotSchema.safeParse(valid).success).toBe(true);
  });

  it('is strict, and requires at least one repository', () => {
    expect(groupedWorktreeSnapshotSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(groupedWorktreeSnapshotSchema.safeParse({ repositories: [] }).success).toBe(false);
  });

  it('is not the bare snapshot a V1 route returns', () => {
    expect(groupedWorktreeSnapshotSchema.safeParse(valid.repositories[0]?.capture).success).toBe(
      false
    );
  });
});

describe('flattenGroupedSnapshot', () => {
  const web = {
    directory: '/workspace/web',
    repoFullName: 'acme/web',
    capture: capture(7, 'refs/remotes/origin/release', ['src/a.ts']),
  };
  const api = {
    directory: '/workspace/api',
    repoFullName: 'acme/api',
    capture: capture(7, 'refs/remotes/origin/main', ['src/a.ts', 'b.ts']),
  };
  const route = [
    { directory: '/workspace/web', repoFullName: 'acme/web', launch: false },
    { directory: '/workspace/api', repoFullName: 'acme/api', launch: true },
  ];
  const flatten = (
    value: GroupedWorktreeSnapshot,
    cwd = '/workspace',
    members: RouteRepository[] = route
  ) => flattenGroupedSnapshot(value, cwd, members);

  it('prefixes each path with its repository below the cwd, so equal paths stay apart', () => {
    const flat = flatten(grouped([web, api]));
    expect(flat?.capture.summary.files.map(file => file.path)).toEqual([
      'web/src/a.ts',
      'api/src/a.ts',
      'api/b.ts',
    ]);
    expect(flat?.capture.files.map(file => file.path)).toEqual(
      flat?.capture.summary.files.map(file => file.path)
    );
    expect(worktreeSnapshotCaptureSchema.safeParse(flat?.capture).success).toBe(true);
    expect(flat?.capture.summary.revision).toBe(7);
  });

  it('keeps the identity and the comparison of every repository', () => {
    const flat = flatten(grouped([web, api]));
    expect(flat?.repositories).toEqual([
      {
        path: 'web',
        repoFullName: 'acme/web',
        comparison: web.capture.summary.comparison,
        truncated: false,
      },
      {
        path: 'api',
        repoFullName: 'acme/api',
        comparison: api.capture.summary.comparison,
        truncated: false,
      },
    ]);
  });

  it('keeps both scoped records when a committed file is edited again', () => {
    const scoped = capture(7, 'refs/remotes/origin/main', ['same.txt', 'same.txt']);
    const scopes = ['uncommitted', 'against-base-branch'] as const;
    scoped.summary.files = scoped.summary.files.map((file, index) => ({
      ...file,
      scope: scopes[index],
    }));
    scoped.files = scoped.files.map((file, index) => ({
      ...file,
      scope: scopes[index],
      diff: { status: 'available', patch: `patch ${scopes[index]}` },
    }));
    const flat = flatten(grouped([{ ...web, capture: scoped }]));
    expect(flat?.capture.files.map(file => [file.path, file.scope, file.diff])).toEqual(
      scopes.map(scope => ['web/same.txt', scope, { status: 'available', patch: `patch ${scope}` }])
    );
    expect(worktreeSnapshotCaptureSchema.safeParse(flat?.capture).success).toBe(true);
  });

  it('prefixes net recovery paths without changing repository-relative patches', () => {
    const withRecovery = [web, api].map(group => ({
      ...group,
      capture: {
        ...group.capture,
        recovery: {
          files: [{ path: 'src/a.ts', status: 'modified' as const, patch: group.repoFullName }],
        },
      },
    }));
    const flat = flatten(grouped(withRecovery));
    expect(flat?.capture.recovery?.files).toEqual([
      { path: 'web/src/a.ts', status: 'modified', patch: 'acme/web' },
      { path: 'api/src/a.ts', status: 'modified', patch: 'acme/api' },
    ]);
    expect(worktreeSnapshotCaptureSchema.safeParse(flat?.capture).success).toBe(true);
  });

  it('bounds aggregate recovery while retaining file metadata when patches do not fit', () => {
    const patch = 'x'.repeat(MAX_WORKTREE_CHANGES_BYTES / 2);
    const flat = flatten(
      grouped(
        [web, api].map(group => ({
          ...group,
          capture: {
            ...group.capture,
            recovery: { files: [{ path: 'a.ts', status: 'modified' as const, patch }] },
          },
        }))
      )
    );
    expect(flat?.capture.recovery?.files).toEqual([
      { path: 'web/a.ts', status: 'modified', patch },
      { path: 'api/a.ts', status: 'modified' },
    ]);
    expect(worktreeRecoverySchema.safeParse(flat?.capture.recovery).success).toBe(true);
    expect(worktreeSnapshotCaptureSchema.safeParse(flat?.capture).success).toBe(true);
  });

  it('limits recovery file counts independently of display files', () => {
    const flat = flatten(
      grouped(
        [web, api].map(group => ({
          ...group,
          capture: {
            ...group.capture,
            recovery: {
              files: Array.from({ length: MAX_WORKTREE_CHANGES_FILES }, (_, index) => ({
                path: `f${index}`,
                status: 'modified' as const,
              })),
            },
          },
        }))
      )
    );
    expect(flat?.capture.recovery?.files).toHaveLength(MAX_WORKTREE_CHANGES_FILES);
    expect(worktreeRecoverySchema.safeParse(flat?.capture.recovery).success).toBe(true);
  });

  it('preserves absent and explicitly empty net recovery', () => {
    expect(flatten(grouped([web, api]))?.capture).not.toHaveProperty('recovery');
    expect(
      flatten(grouped([{ ...web, capture: { ...web.capture, recovery: { files: [] } } }]))?.capture
        .recovery
    ).toEqual({ files: [] });
  });

  it('takes the top-level comparison from the launch repository, not the first', () => {
    const flat = flatten(grouped([web, api]));
    expect(flat?.capture.summary.comparison.baseRef).toBe('refs/remotes/origin/main');
  });

  it('names a repository from the route, not from what the wrapper reported', () => {
    const flat = flatten(grouped([{ ...web, repoFullName: 'evil/other' }]));
    expect(flat?.repositories?.[0]?.repoFullName).toBe('acme/web');
  });

  it('refuses a repository that is not a root of the route', () => {
    expect(flatten(grouped([{ ...web, directory: '/workspace/elsewhere' }]))).toBeNull();
  });

  it('leaves the paths of a one-repository route as they are', () => {
    const flat = flatten(grouped([web]), '/workspace/web', [route[0]!]);
    expect(flat?.capture.summary.files.map(file => file.path)).toEqual(['src/a.ts']);
    expect(flat?.repositories?.[0]?.path).toBe('');
  });

  it('refuses repositories that disagree on the revision', () => {
    const stale = { ...api, capture: capture(6, 'x', ['b.ts']) };
    expect(flatten(grouped([web, stale]))).toBeNull();
  });

  it('keeps the saved limits and marks the repositories that lost files truncated', () => {
    const many = Array.from({ length: MAX_WORKTREE_CHANGES_FILES }, (_, index) => `f${index}.ts`);
    const flat = flatten(
      grouped([
        { ...web, capture: capture(7, 'b', many) },
        { ...api, capture: capture(7, 'b', ['extra.ts']) },
      ])
    );
    expect(flat?.capture.summary.files).toHaveLength(MAX_WORKTREE_CHANGES_FILES);
    expect(flat?.capture.files).toHaveLength(MAX_WORKTREE_CHANGES_FILES);
    expect(flat?.capture.summary.truncated).toBe(true);
    expect(flat?.repositories?.map(repository => repository.truncated)).toEqual([false, true]);
    expect(worktreeSnapshotCaptureSchema.safeParse(flat?.capture).success).toBe(true);
  });

  it('carries a repository truncation into the result', () => {
    const flat = flatten(grouped([{ ...web, capture: capture(7, 'b', ['a.ts'], true) }]));
    expect(flat?.capture.summary.truncated).toBe(true);
    expect(flat?.repositories?.[0]?.truncated).toBe(true);
  });
});

describe('parseReportedSnapshot', () => {
  const bare = capture(2, 'refs/remotes/origin/main', ['a.ts']);
  const route = [{ directory: '/workspace/web', repoFullName: 'acme/web', launch: true }];
  const group = grouped([{ directory: '/workspace/web', repoFullName: 'x/y', capture: bare }]);

  it('gives a V1 route its bare capture, without repositories', () => {
    const reported = parseReportedSnapshot(bare, '/workspace/app', undefined);
    expect(reported).toEqual({ capture: bare });
    expect(reported).not.toHaveProperty('repositories');
  });

  it('refuses a grouped result on a V1 route, and a bare one on a V2 route', () => {
    expect(parseReportedSnapshot(group, '/workspace/app', undefined)).toBeNull();
    expect(parseReportedSnapshot(bare, '/workspace/web', route)).toBeNull();
  });

  it('flattens a grouped result on a V2 route', () => {
    expect(parseReportedSnapshot(group, '/workspace/web', route)?.repositories).toHaveLength(1);
  });
});
