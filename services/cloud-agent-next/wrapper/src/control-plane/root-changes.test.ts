import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_WORKTREE_SNAPSHOT_BYTES } from '../../../src/shared/worktree-changes-wire.js';
import type { WorktreeSnapshotCapture } from '../../../src/shared/worktree-changes-wire.js';
import type {
  ControlPlaneKiloRequestFrame,
  ControlPlaneWorktreeRequestFrame,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import {
  flattenGroupedSnapshot,
  groupedWorktreeSnapshotSchema,
} from '../../../src/shared/worktree-groups.js';
import type { WrapperKiloClient } from '../kilo-api.js';
import { collectWorktreeSnapshot } from '../control/worktree-changes.js';
import { resetDirectoryOperationState } from '../control/worktree-operations.js';
import { createControlPlaneKiloRequests } from './kilo-requests.js';
import { captureRootSnapshots, fitSnapshotBudget, rootBaseRef } from './root-changes.js';
import { createControlPlaneWorktreeChanges } from './worktree-changes.js';
import type { RouteRoot } from './workspace-roots.js';

const SESSION = {
  sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
  kiloSessionId: 'ses_12345678901234567890123456',
};

describe('the changes of a multi-repository route', () => {
  let workspace: string;
  let roots: RouteRoot[];

  const env = (directory: string) => ({
    PATH: process.env.PATH,
    HOME: directory,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  });

  /** A repository on `main` with a recorded remote default, as a clone has. */
  async function repository(leaf: string) {
    const directory = join(workspace, leaf);
    await mkdir(directory);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: directory, env: env(workspace), encoding: 'utf8' });
    const commit = (message: string) =>
      git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', message);
    git('init', '-q', '-b', 'main');
    await writeFile(join(directory, 'shared.txt'), 'before\n');
    git('add', '.');
    commit('Initial');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    return { directory, git, commit };
  }

  beforeEach(async () => {
    workspace = await realpath(await mkdtemp(join(tmpdir(), 'root-changes-')));
    // web: a requested branch with its own upstream commit. api: the generated branch.
    const web = await repository('web');
    await writeFile(join(web.directory, 'upstream.txt'), 'upstream\n');
    web.git('add', '.');
    web.commit('Upstream release work');
    web.git('update-ref', 'refs/remotes/origin/release', 'HEAD');
    await writeFile(join(web.directory, 'shared.txt'), 'after in web\n');
    const api = await repository('api');
    await writeFile(join(api.directory, 'committed.txt'), 'committed in api\n');
    api.git('add', '.');
    api.commit('Work on the generated branch');
    await writeFile(join(api.directory, 'shared.txt'), 'after in api\n');
    roots = [
      { directory: web.directory, repoFullName: 'acme/web', requestedBranch: 'release' },
      { directory: api.directory, repoFullName: 'acme/api', requestedBranch: undefined },
    ];
  });

  afterEach(async () => {
    resetDirectoryOperationState();
    await rm(workspace, { recursive: true, force: true });
  });

  it('compares a requested branch with that branch and the others with the default', () => {
    expect(
      rootBaseRef({ directory: '/w/a', repoFullName: 'a/a', requestedBranch: 'release' })
    ).toBe('refs/remotes/origin/release');
    expect(
      rootBaseRef({ directory: '/w/a', repoFullName: 'a/a', requestedBranch: undefined })
    ).toBe(undefined);
    expect(
      rootBaseRef({ directory: '/w/a', repoFullName: 'a/a', requestedBranch: 'refs/pull/1/head' })
    ).toBe(undefined);
  });

  it('captures each repository against its own base, with repository-relative paths', async () => {
    const grouped = await captureRootSnapshots({
      roots,
      revision: 3,
      capture: (directory, payload) => collectWorktreeSnapshot(directory, payload),
    });

    const parsedBudget = groupedWorktreeSnapshotSchema.safeParse(grouped);
    expect(parsedBudget.success).toBe(true);
    const [web, api] = grouped.repositories;
    expect(web?.repoFullName).toBe('acme/web');
    expect(web?.capture.summary.comparison.baseRef).toBe('refs/remotes/origin/release');
    expect(web?.capture.summary.files.map(file => file.path)).toEqual(['shared.txt']);
    expect(api?.repoFullName).toBe('acme/api');
    expect(api?.capture.summary.comparison.baseRef).toBe('refs/remotes/origin/main');
    expect(api?.capture.summary.files.map(file => file.path).sort()).toEqual([
      'committed.txt',
      'shared.txt',
    ]);
  });

  it('fails the whole capture when one repository fails, and names no partial result', async () => {
    await rm(join(roots[1]!.directory, '.git'), { recursive: true });
    const failure = await captureRootSnapshots({
      roots,
      revision: 1,
      capture: (directory, payload) => collectWorktreeSnapshot(directory, payload),
    }).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
  });

  it('answers a worktree snapshot with the grouped result, which saves as a flat list', async () => {
    const frames: ControlPlaneWrapperFrame[] = [];
    const adapter = createControlPlaneWorktreeChanges({
      emit: frame => frames.push(frame),
      isPrepared: () => true,
      roots: () => roots,
      captureSnapshot: (directory, payload) => collectWorktreeSnapshot(directory, payload),
    });
    const request: ControlPlaneWorktreeRequestFrame = {
      type: 'worktree.snapshot',
      requestId: 'req_1',
      session: { ...SESSION, directory: workspace },
      payload: { revision: 4 },
    };

    await adapter.handle(request);

    const [result] = frames;
    if (result?.type !== 'worktree.result' || !result.ok) {
      throw new Error(`Expected a result: ${JSON.stringify(result)}`);
    }
    const grouped = groupedWorktreeSnapshotSchema.parse(result.result);
    expect(grouped.repositories.map(group => group.directory)).toEqual(roots.map(r => r.directory));
    const flat = flattenGroupedSnapshot(
      grouped,
      workspace,
      roots.map(root => ({
        directory: root.directory,
        repoFullName: root.repoFullName!,
        launch: false,
      }))
    );
    expect(flat?.capture.summary.files.map(file => file.path).sort()).toEqual([
      'api/committed.txt',
      'api/shared.txt',
      'web/shared.txt',
    ]);
  });

  it('has no summary capture for a multi-repository route', async () => {
    const frames: ControlPlaneWrapperFrame[] = [];
    const adapter = createControlPlaneWorktreeChanges({
      emit: frame => frames.push(frame),
      isPrepared: () => true,
      roots: () => roots,
    });
    await adapter.handle({
      type: 'worktree.summary',
      requestId: 'req_2',
      session: { ...SESSION, directory: workspace },
      payload: { revision: 1 },
    });
    expect(frames).toEqual([
      {
        type: 'worktree.result',
        requestId: 'req_2',
        ok: false,
        error: {
          code: 'unsupported',
          message: 'A multi-repository route has no summary',
          retryable: false,
        },
      },
    ]);
  });

  it('runs the native diff fallback once for each repository, below the cwd', async () => {
    const emitted: ControlPlaneWrapperFrame[] = [];
    const captureSnapshot = mock(collectWorktreeSnapshot);
    const nativeClient = { getSessionDiff: mock(async () => []) } as unknown as WrapperKiloClient;
    const handler = createControlPlaneKiloRequests({
      emit: frame => emitted.push(frame),
      preparedRoute: () => ({ runtimeKey: 'runtime_1', directory: workspace, roots }),
      clientFor: () => nativeClient,
      captureSnapshot: (directory, payload, signal) =>
        captureSnapshot(directory, payload, undefined, signal),
    });
    const request: ControlPlaneKiloRequestFrame = {
      type: 'kilo.request',
      requestId: 'req_3',
      session: { ...SESSION, directory: workspace },
      // The request names the launch repository's base; each root uses its own.
      operation: { name: 'session.diff', baseRef: 'refs/remotes/origin/other' },
    };

    await handler.handle(request);

    expect(nativeClient.getSessionDiff).toHaveBeenCalledTimes(1);
    expect(
      captureSnapshot.mock.calls.map(([directory, payload]) => [directory, payload.baseRef])
    ).toEqual([
      [roots[0]?.directory, 'refs/remotes/origin/release'],
      [roots[1]?.directory, undefined],
    ]);
    const [result] = emitted;
    if (result?.type !== 'kilo.result' || !result.ok || !Array.isArray(result.result)) {
      throw new Error(`Expected a diff array: ${JSON.stringify(result)}`);
    }
    expect(result.result.map((file: { file: string }) => file.file).sort()).toEqual([
      'api/committed.txt',
      'api/shared.txt',
      'web/shared.txt',
    ]);
  });

  it('keeps the files of a one-repository route unprefixed in the native fallback', async () => {
    const [web] = roots;
    const emitted: ControlPlaneWrapperFrame[] = [];
    const handler = createControlPlaneKiloRequests({
      emit: frame => emitted.push(frame),
      preparedRoute: () => ({
        runtimeKey: 'runtime_1',
        directory: web!.directory,
        roots: [web!],
      }),
      clientFor: () => ({ getSessionDiff: mock(async () => []) }) as unknown as WrapperKiloClient,
    });
    await handler.handle({
      type: 'kilo.request',
      requestId: 'req_4',
      session: { ...SESSION, directory: web!.directory },
      operation: { name: 'session.diff' },
    });
    expect(emitted[0]).toMatchObject({ ok: true, result: [{ file: 'shared.txt' }] });
  });
});

describe('the snapshot budget of a multi-repository route', () => {
  const sha = (digit: string) => digit.repeat(40);
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

  /** A capture of `count` files that each hold about 400 KB, as a codemod leaves. */
  function bigCapture(count: number, revision: number): WorktreeSnapshotCapture {
    const paths = Array.from({ length: count }, (_, index) => `file-${index}.ts`);
    return {
      summary: {
        revision,
        comparison: { baseRef: 'refs/remotes/origin/main', mergeBase: sha('a'), head: sha('b') },
        files: paths.map(path => ({
          path,
          status: 'modified' as const,
          additions: 1,
          deletions: 1,
          tracked: true,
          binary: false,
          countsComplete: true,
        })),
        truncated: false,
      },
      files: paths.map(path => ({
        schemaVersion: 1 as const,
        revision,
        path,
        diff: {
          status: 'available' as const,
          patch: `diff --git a/${path} b/${path}\n+${'x'.repeat(300_000)}\n`,
        },
        content: {
          status: 'available' as const,
          source: 'current' as const,
          text: 'y'.repeat(90_000),
        },
      })),
    };
  }

  const roots: RouteRoot[] = [
    { directory: '/workspace/web', repoFullName: 'acme/web', requestedBranch: undefined },
    { directory: '/workspace/api', repoFullName: 'acme/api', requestedBranch: undefined },
  ];

  it('omits the records past the total budget instead of failing the capture', async () => {
    // Each repository is inside its own budget (about 6 MB); together they are not.
    const grouped = await captureRootSnapshots({
      roots,
      revision: 5,
      capture: async () => bigCapture(15, 5),
    });

    expect(bytes(grouped)).toBeLessThanOrEqual(MAX_WORKTREE_SNAPSHOT_BYTES);
    const parsedBudget = groupedWorktreeSnapshotSchema.safeParse(grouped);
    expect(parsedBudget.success).toBe(true);
    const [web, api] = grouped.repositories;
    // Every listed file keeps its record. The first repository is complete.
    expect(web?.capture.summary.files).toHaveLength(15);
    expect(web?.capture.files.every(file => file.diff.status === 'available')).toBe(true);
    const omitted = api?.capture.files.filter(file => file.diff.status === 'omitted') ?? [];
    expect(omitted.length).toBeGreaterThan(0);
    expect(
      omitted.every(
        file => file.diff.status === 'omitted' && file.diff.reason === 'budget_exhausted'
      )
    ).toBe(true);
    expect(api?.capture.files).toHaveLength(15);
  });

  it('answers the worktree snapshot with a result, not a protocol error', async () => {
    const frames: ControlPlaneWrapperFrame[] = [];
    const adapter = createControlPlaneWorktreeChanges({
      emit: frame => frames.push(frame),
      isPrepared: () => true,
      roots: () => roots,
      captureSnapshot: async () => bigCapture(15, 5),
    });
    await adapter.handle({
      type: 'worktree.snapshot',
      requestId: 'req_budget',
      session: { ...SESSION, directory: '/workspace' },
      payload: { revision: 5 },
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'worktree.result', ok: true });
  });

  it('leaves a result inside the budget as it is', () => {
    const grouped = {
      repositories: roots.map(root => ({
        directory: root.directory,
        repoFullName: root.repoFullName!,
        capture: bigCapture(1, 5),
      })),
    };
    expect(fitSnapshotBudget(grouped)).toBe(grouped);
  });
});
