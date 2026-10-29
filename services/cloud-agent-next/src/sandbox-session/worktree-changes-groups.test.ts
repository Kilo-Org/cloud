import { describe, expect, it } from 'vitest';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { WorktreeSnapshotCapture } from '../shared/worktree-changes-wire.js';
import type { GroupedWorktreeSnapshot } from '../shared/worktree-groups.js';
import {
  createWorktreeChanges,
  worktreeChangesContext,
  type WorktreeChangesContext,
} from './worktree-changes.js';

const sha = (digit: string) => digit.repeat(40);

function capture(revision: number, baseRef: string, path: string): WorktreeSnapshotCapture {
  return {
    summary: {
      revision,
      comparison: { baseRef, mergeBase: sha('a'), head: sha('b') },
      files: [
        {
          path,
          status: 'modified',
          additions: 1,
          deletions: 1,
          tracked: true,
          binary: false,
          countsComplete: true,
        },
      ],
      truncated: false,
    },
    files: [
      {
        schemaVersion: 1,
        revision,
        path,
        diff: { status: 'available', patch: `diff --git a/${path} b/${path}\n-a\n+b\n` },
        content: { status: 'available', source: 'current', text: 'b\n' },
      },
    ],
  };
}

const grouped = (revision: number): GroupedWorktreeSnapshot => ({
  repositories: [
    {
      directory: '/workspace/web',
      repoFullName: 'acme/web',
      capture: capture(revision, 'refs/remotes/origin/release', 'src/a.ts'),
    },
    {
      directory: '/workspace/api',
      repoFullName: 'acme/api',
      capture: capture(revision, 'refs/remotes/origin/main', 'src/a.ts'),
    },
  ],
});

const context: WorktreeChangesContext = {
  session: { sessionId: 'workspace_1', kiloSessionId: 'ses_1', directory: '/workspace' },
  ownerId: 'user_1',
  sandboxId: 'sandbox_1',
  provider: 'cloudflare',
  repository: { type: 'github', source: 'acme/web' },
  roots: [
    { directory: '/workspace/web', repoFullName: 'acme/web', launch: true },
    { directory: '/workspace/api', repoFullName: 'acme/api', launch: false },
  ],
};
const v1Context: WorktreeChangesContext = {
  session: { sessionId: 'workspace_1', kiloSessionId: 'ses_1', directory: '/workspace/app' },
  ownerId: 'user_1',
  sandboxId: 'sandbox_1',
  provider: 'cloudflare',
  repository: { type: 'github', source: 'acme/web' },
};

function manager(result: (revision: number) => unknown, current = context) {
  const values = new Map<string, unknown>();
  const requested: Array<{ revision: number; baseRef?: string }> = [];
  const changes = createWorktreeChanges({
    storage: {
      kv: {
        get: key => values.get(key),
        put: (key, value) => {
          values.set(key, value);
        },
        delete: key => values.delete(key),
        list: ({ prefix }) => [...values].filter(([key]) => key.startsWith(prefix)),
      },
      transactionSync: callback => callback(),
    },
    readContext: async () => current,
    requestCapture: async (_context, payload) => {
      requested.push(payload);
      return { ok: true, result: result(payload.revision) };
    },
    waitUntil: () => undefined,
  });
  return { changes, requested };
}

describe('a V2 route in the saved worktree changes', () => {
  it('saves the repositories as one list with a path that names a single file', async () => {
    const { changes } = manager(grouped);

    const refreshed = await changes.refresh();

    expect(refreshed.status).toBe('refreshed');
    const { snapshot } = await changes.get();
    expect(snapshot?.files.map(file => file.path)).toEqual(['web/src/a.ts', 'api/src/a.ts']);
    expect(snapshot?.comparison.baseRef).toBe('refs/remotes/origin/release');
    const revision = snapshot?.revision ?? 0;
    const file = changes.getFile({ path: 'api/src/a.ts', expectedRevision: revision });
    expect(file).toMatchObject({ status: 'available', file: { path: 'api/src/a.ts' } });
  });

  it('saves the identity and the comparison of every repository', async () => {
    const { changes } = manager(grouped);
    await changes.refresh();

    const { snapshot } = await changes.get();
    expect(snapshot?.repositories).toEqual([
      {
        path: 'web',
        repoFullName: 'acme/web',
        comparison: { baseRef: 'refs/remotes/origin/release', mergeBase: sha('a'), head: sha('b') },
        truncated: false,
      },
      {
        path: 'api',
        repoFullName: 'acme/api',
        comparison: { baseRef: 'refs/remotes/origin/main', mergeBase: sha('a'), head: sha('b') },
        truncated: false,
      },
    ]);
  });

  it('fails the refresh for a repository that is not a root of the route', async () => {
    const { changes } = manager(revision => ({
      repositories: [{ ...grouped(revision).repositories[0]!, directory: '/workspace/other' }],
    }));
    expect((await changes.refresh()).status).toBe('failed');
  });

  it('saves recovery with the cwd-relative path and the repository-relative patch', async () => {
    const { changes } = manager(grouped);
    await changes.refresh();

    expect(changes.recovery()?.files).toEqual([
      {
        path: 'web/src/a.ts',
        status: 'modified',
        patch: 'diff --git a/src/a.ts b/src/a.ts\n-a\n+b\n',
      },
      {
        path: 'api/src/a.ts',
        status: 'modified',
        patch: 'diff --git a/src/a.ts b/src/a.ts\n-a\n+b\n',
      },
    ]);
  });

  it('fails the refresh when the repositories disagree on the revision', async () => {
    const { changes } = manager(revision => ({
      repositories: [
        { ...grouped(revision).repositories[0]! },
        { ...grouped(revision + 1).repositories[1]! },
      ],
    }));
    expect((await changes.refresh()).status).toBe('failed');
  });

  it('still saves a V1 capture as it reports it, without repositories', async () => {
    const { changes } = manager(
      revision => capture(revision, 'refs/remotes/origin/main', 'a.ts'),
      v1Context
    );
    await changes.refresh();
    const { snapshot } = await changes.get();
    expect(snapshot?.files.map(file => file.path)).toEqual(['a.ts']);
    expect(snapshot).not.toHaveProperty('repositories');
  });

  it('refuses a grouped result on a V1 route', async () => {
    const { changes } = manager(grouped, v1Context);
    expect((await changes.refresh()).status).toBe('failed');
  });
});

const WEB = {
  identity: { platform: 'github', repoFullName: 'acme/web' },
  repoFullName: 'acme/web',
  leaf: 'web',
  branch: 'kilo/s',
};
const API = {
  identity: { platform: 'github', repoFullName: 'acme/api' },
  repoFullName: 'acme/api',
  leaf: 'api',
  branch: 'kilo/s',
};

describe('worktreeChangesContext', () => {
  function metadata(environment: unknown, upstreamBranch: string | undefined): SessionMetadata {
    return {
      identity: { sessionId: 'workspace_1', userId: 'user_1' },
      auth: { kiloSessionId: 'ses_1' },
      workspace: { sandboxId: 'sandbox_1' },
      repository: { type: 'github', repo: 'acme/web', upstreamBranch },
      environment,
    } as unknown as SessionMetadata;
  }

  it('compares a V1 route with its requested branch', () => {
    expect(worktreeChangesContext(metadata(undefined, 'release'), '/workspace/app')?.baseRef).toBe(
      'refs/remotes/origin/release'
    );
  });

  it('leaves the base of a V2 route to the wrapper, which picks one for each repository', () => {
    const v2 = metadata({ repositories: [WEB, API] }, 'release');
    expect(worktreeChangesContext(v2, '/workspace')?.baseRef).toBeUndefined();
  });

  it('lists the roots of a V2 route, with the launch repository, and none for V1', () => {
    const v2 = metadata({ repositories: [API, WEB] }, undefined);
    expect(worktreeChangesContext(v2, '/workspace')?.roots).toEqual([
      { directory: '/workspace/api', repoFullName: 'acme/api', launch: false },
      { directory: '/workspace/web', repoFullName: 'acme/web', launch: true },
    ]);
    expect(
      worktreeChangesContext(metadata(undefined, undefined), '/workspace/app')
    ).not.toHaveProperty('roots');
  });
});
