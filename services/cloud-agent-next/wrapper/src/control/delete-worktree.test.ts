import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import {
  createWorktreeKiloCleanupClient,
  deleteWorktree,
  prepareWorktreeDeletion,
  validateWorktreeDirectory,
  type WorktreeKiloCleanupClient,
} from './delete-worktree';
import { runDirectoryOperation, resetDirectoryOperationState } from './worktree-operations';
import {
  rememberAttachedRoot,
  resetSessionDirectoryState,
  rootForSession,
} from './session-directories';
import { createControlTerminalRuntime } from './terminal-runtime';
import type { WorktreeKiloRuntime } from './worktree-runtime';
import type { WrapperKiloClient, WrapperPty } from '../kilo-api';

const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const directory = `/workspace/oauth-user/worktrees/${worktreeId}`;
const otherDirectory =
  '/workspace/oauth-user/worktrees/worktree_22222222-2222-4222-8222-222222222222';
const sessionId = (index: number) => `ses_${String(index).padStart(26, '0')}`;

afterEach(() => {
  resetDirectoryOperationState();
  resetSessionDirectoryState();
});

function fixture() {
  const sessions = new Map<
    string,
    { id: string; directory: string; parent?: string; active: boolean }
  >();
  const processes = new Set<string>();
  const directories = new Set([directory, otherDirectory]);
  const terminals = new Set([directory, otherDirectory]);
  const disposed: string[] = [];
  const retired: string[] = [];
  const aborted: string[] = [];
  let failDeletion: string | undefined;
  const client: WorktreeKiloCleanupClient = {
    listSessionIds: async dir =>
      [...sessions.values()]
        .filter(session => session.directory === dir && !session.parent)
        .map(session => session.id),
    getSession: async (_dir, id) => sessions.get(id) ?? null,
    children: async (_dir, id) => [...sessions.values()].filter(session => session.parent === id),
    abortSession: async (_dir, id) => {
      const session = sessions.get(id);
      if (session) session.active = false;
      aborted.push(id);
    },
    stopSessionProcesses: async (_dir, id) => {
      processes.delete(id);
    },
    deleteSession: async (_dir, id) => {
      if (id === failDeletion) throw new Error('Kilo temporarily unavailable');
      sessions.delete(id);
    },
    closeTerminals: async dir => {
      terminals.delete(dir);
    },
    disposeDirectory: async dir => {
      disposed.push(dir);
    },
  };
  return {
    sessions,
    processes,
    directories,
    terminals,
    disposed,
    retired,
    aborted,
    client,
    deps: {
      client,
      assertDirectory: async () => undefined,
      retireDirectory: async (dir: string) => {
        retired.push(dir);
      },
      removeDirectory: async (dir: string) => {
        directories.delete(dir);
      },
    },
    fail: (id?: string) => {
      failDeletion = id;
    },
    add: (id: string, dir = directory, parent?: string) => {
      sessions.set(id, { id, directory: dir, parent, active: true });
      processes.add(id);
    },
  };
}

describe('Kilo 7.4.20 cleanup HTTP compatibility', () => {
  test('awaits confirmed legacy cancellation and deletes lazy and never-run sessions without the unavailable v2 wait', async () => {
    const f = fixture();
    f.add(sessionId(0));
    f.add(sessionId(2), directory, sessionId(0));
    f.add(sessionId(3), otherDirectory);
    const input = { worktreeId, directory, sessionIds: [sessionId(0), sessionId(1), sessionId(2)] };
    const abortStarted = Promise.withResolvers<void>();
    const finishAbort = Promise.withResolvers<void>();
    const server = Bun.serve({
      port: 0,
      fetch: async request => {
        const url = new URL(request.url);
        const dir = url.searchParams.get('directory');
        const id = url.pathname.split('/')[2];
        if (url.pathname.startsWith('/api/session/') && url.pathname.endsWith('/wait')) {
          return Response.json({}, { status: 503 });
        }
        if (dir !== directory) return Response.json({}, { status: 400 });
        if (url.pathname === '/api/session') {
          return Response.json(
            url.searchParams.has('cursor')
              ? { data: [], cursor: { previous: null, next: null } }
              : {
                  data: [...f.sessions.values()].filter(session => session.directory === dir),
                  cursor: { previous: 'previous-page', next: 'next-page' },
                }
          );
        }
        if (url.pathname.startsWith('/session/')) {
          if (url.pathname.endsWith('/abort')) {
            abortStarted.resolve();
            await finishAbort.promise;
            await f.client.abortSession(dir, id);
            return Response.json(true);
          }
          if (url.pathname.endsWith('/children')) {
            return Response.json(await f.client.children(dir, id));
          }
          if (request.method === 'DELETE') {
            await f.client.deleteSession(dir, id);
            return Response.json(true);
          }
          const session = await f.client.getSession(dir, id);
          return Response.json(session ?? {}, { status: session ? 200 : 404 });
        }
        if (url.pathname.startsWith('/background-process/session/')) {
          await f.client.stopSessionProcesses(dir, url.pathname.split('/')[3]);
          return Response.json(true);
        }
        if (url.pathname === '/interactive-terminal') return Response.json([]);
        if (url.pathname === '/pty') {
          return Response.json(f.terminals.has(dir) ? [{ id: 'pty_qa' }] : []);
        }
        if (url.pathname === '/pty/pty_qa' && request.method === 'DELETE') {
          await f.client.closeTerminals(dir);
          return Response.json(true);
        }
        if (url.pathname === '/instance/dispose') {
          await f.client.disposeDirectory(dir);
          return Response.json(true);
        }
        return Response.json({}, { status: 404 });
      },
    });
    try {
      const deletion = deleteWorktree(input, {
        ...f.deps,
        client: createWorktreeKiloCleanupClient(server.url.toString()),
      });
      await abortStarted.promise;
      expect(f.sessions.get(sessionId(0))?.active).toBe(true);
      expect(f.directories.has(directory)).toBe(true);
      expect(f.terminals.has(directory)).toBe(true);
      finishAbort.resolve();
      expect(await deletion).toEqual({ deleted: true, sessionIds: input.sessionIds });
      expect([...f.sessions.keys()]).toEqual([sessionId(3)]);
      expect(f.sessions.get(sessionId(3))?.active).toBe(true);
      expect([...f.processes]).toEqual([sessionId(3)]);
      expect([...f.terminals]).toEqual([otherDirectory]);
      expect([...f.directories]).toEqual([otherDirectory]);
      expect(f.disposed).toEqual([directory]);
    } finally {
      finishAbort.resolve();
      await server.stop(true);
    }
  });

  test.each([
    { status: 503, body: true },
    { status: 200, body: false },
    { status: 200, body: null },
    { status: 204, body: null },
  ])('fails closed when abort is unconfirmed: %j', async ({ status, body }) => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        status === 204 ? new Response(null, { status }) : Response.json(body, { status }),
    });
    try {
      await rejects(
        createWorktreeKiloCleanupClient(server.url.toString()).abortSession(
          directory,
          sessionId(0)
        ),
        /not confirmed/
      );
    } finally {
      await server.stop(true);
    }
  });
});

describe('Kilo session DELETE confirmation', () => {
  test.each([200, 204])('rejects an empty successful DELETE response: %s', async status => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status }) });
    try {
      await rejects(
        createWorktreeKiloCleanupClient(server.url.toString()).deleteSession(
          directory,
          sessionId(0)
        ),
        /not confirmed/
      );
    } finally {
      await server.stop(true);
    }
  });

  test('accepts a missing session as already deleted', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
    try {
      await createWorktreeKiloCleanupClient(server.url.toString()).deleteSession(
        directory,
        sessionId(0)
      );
    } finally {
      await server.stop(true);
    }
  });
});

describe('scoped worktree runtime deletion', () => {
  test.each([true, false])(
    'awaits terminal detachment and runtime retirement before removing the checkout: live=%s',
    async live => {
      const f = fixture();
      if (live) {
        f.add(sessionId(0));
        f.add(sessionId(1), directory, sessionId(0));
      }
      f.add(sessionId(2), otherDirectory);
      rememberAttachedRoot(sessionId(0), directory);
      rememberAttachedRoot(sessionId(2), otherDirectory);
      const detaching = Promise.withResolvers<void>();
      const detached = Promise.withResolvers<void>();
      const retiring = Promise.withResolvers<void>();
      const retired = Promise.withResolvers<void>();
      const homes = new Set([directory, otherDirectory]);
      const input = { worktreeId, directory, sessionIds: [sessionId(0), sessionId(1)] };
      const deletion = deleteWorktree(input, {
        ...f.deps,
        client: live ? f.client : undefined,
        detachTerminals: async dir => {
          expect(dir).toBe(directory);
          detaching.resolve();
          await detached.promise;
        },
        retireDirectory: async dir => {
          expect(dir).toBe(directory);
          expect([...f.sessions.keys()]).toEqual([sessionId(2)]);
          expect([...f.processes]).toEqual([sessionId(2)]);
          expect(f.disposed).toEqual(live ? [directory] : []);
          expect([...f.terminals]).toEqual(live ? [otherDirectory] : [directory, otherDirectory]);
          expect(f.directories.has(directory)).toBe(true);
          retiring.resolve();
          await retired.promise;
          homes.delete(dir);
        },
        removeDirectory: async dir => {
          expect(homes.has(dir)).toBe(false);
          await f.deps.removeDirectory(dir);
        },
      });
      try {
        await detaching.promise;
        expect(homes.has(directory)).toBe(true);
        expect(f.disposed).toEqual([]);
        expect(f.directories.has(directory)).toBe(true);
        expect(rootForSession(sessionId(0))).toBe(sessionId(0));
        detached.resolve();
        await retiring.promise;
        expect(homes.has(directory)).toBe(true);
        expect(f.directories.has(directory)).toBe(true);
        expect(rootForSession(sessionId(0))).toBe(sessionId(0));
        retired.resolve();
        expect(await deletion).toEqual({ deleted: true, sessionIds: input.sessionIds });
        expect([...homes]).toEqual([otherDirectory]);
        expect([...f.directories]).toEqual([otherDirectory]);
        expect(rootForSession(sessionId(0))).toBeUndefined();
        expect(rootForSession(sessionId(2))).toBe(sessionId(2));
        expect(f.sessions.get(sessionId(2))?.active).toBe(true);
      } finally {
        detached.resolve();
        retired.resolve();
        await deletion;
      }
    }
  );

  test.each(['never-started', 'already-retired'])(
    'idempotently deletes a %s checkout without a Kilo client',
    async state => {
      const f = fixture();
      if (state === 'already-retired') f.directories.delete(directory);
      f.add(sessionId(2), otherDirectory);
      rememberAttachedRoot(sessionId(0), directory);
      rememberAttachedRoot(sessionId(2), otherDirectory);
      const input = { worktreeId, directory, sessionIds: [sessionId(0)] };
      const deps = { ...f.deps, client: undefined };
      expect(await prepareWorktreeDeletion(input, deps)).toEqual(input.sessionIds);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await deleteWorktree(input, deps)).toEqual({
          deleted: true,
          sessionIds: input.sessionIds,
        });
      }
      expect(f.aborted).toEqual([]);
      expect(f.disposed).toEqual([]);
      expect(f.retired).toEqual([directory, directory]);
      expect([...f.directories]).toEqual([otherDirectory]);
      expect(rootForSession(sessionId(0))).toBeUndefined();
      expect(rootForSession(sessionId(2))).toBe(sessionId(2));
      expect(f.sessions.get(sessionId(2))?.active).toBe(true);
    }
  );

  test.each([true, false])(
    'keeps the checkout when runtime retirement fails and allows a clientless retry: live=%s',
    async live => {
      const f = fixture();
      if (live) f.add(sessionId(0));
      rememberAttachedRoot(sessionId(0), directory);
      const input = { worktreeId, directory, sessionIds: [sessionId(0)] };
      await rejects(
        deleteWorktree(input, {
          ...f.deps,
          client: live ? f.client : undefined,
          retireDirectory: async () => {
            throw new Error('Runtime retirement failed');
          },
        }),
        /Runtime retirement failed/
      );
      expect(f.directories.has(directory)).toBe(true);
      expect(rootForSession(sessionId(0))).toBe(sessionId(0));
      expect(await deleteWorktree(input, { ...f.deps, client: undefined })).toEqual({
        deleted: true,
        sessionIds: input.sessionIds,
      });
      expect(f.directories.has(directory)).toBe(false);
      expect(rootForSession(sessionId(0))).toBeUndefined();
    }
  );

  test('keeps the checkout and runtime when clientless terminal detachment fails', async () => {
    const f = fixture();
    rememberAttachedRoot(sessionId(0), directory);
    await rejects(
      deleteWorktree(
        { worktreeId, directory, sessionIds: [sessionId(0)] },
        {
          ...f.deps,
          client: undefined,
          detachTerminals: async () => {
            throw new Error('Terminal detachment failed');
          },
        }
      ),
      /Terminal detachment failed/
    );
    expect(f.retired).toEqual([]);
    expect(f.directories.has(directory)).toBe(true);
    expect(rootForSession(sessionId(0))).toBe(sessionId(0));
  });

  test('checks filesystem safety without a Kilo client', async () => {
    const f = fixture();
    const stat = spyOn(fs, 'lstat').mockResolvedValue({
      isSymbolicLink: () => true,
      isDirectory: () => true,
    } as Stats);
    try {
      await rejects(
        deleteWorktree(
          { worktreeId, directory, sessionIds: [] },
          { ...f.deps, client: undefined, assertDirectory: undefined }
        ),
        /Invalid worktree directory/
      );
      expect(f.retired).toEqual([]);
      expect(f.directories.has(directory)).toBe(true);
    } finally {
      stat.mockRestore();
    }
  });

  test('removes more than 200 roots and deep descendants while preserving another checkout and its resources', async () => {
    const f = fixture();
    for (let index = 0; index < 205; index++) f.add(sessionId(index));
    for (let index = 205; index < 225; index++)
      f.add(sessionId(index), directory, sessionId(index === 205 ? 0 : index - 1));
    f.add(sessionId(999), otherDirectory);
    const input = {
      worktreeId,
      directory,
      sessionIds: Array.from({ length: 205 }, (_, index) => sessionId(index)),
    };
    const manifest = await prepareWorktreeDeletion(input, f.deps);
    expect(manifest).toHaveLength(225);
    const deleted = await deleteWorktree({ ...input, sessionIds: manifest }, f.deps);
    expect(deleted.sessionIds).toHaveLength(225);
    expect([...f.sessions.keys()]).toEqual([sessionId(999)]);
    expect([...f.processes]).toEqual([sessionId(999)]);
    expect([...f.terminals]).toEqual([otherDirectory]);
    expect([...f.directories]).toEqual([otherDirectory]);
    expect(f.disposed).toEqual([directory]);
    expect(f.sessions.get(sessionId(999))?.active).toBe(true);
  });

  test('awaits pending wrapper PTYs and clears only the deleted checkout terminal state', async () => {
    const f = fixture();
    f.add(sessionId(0));
    f.add(sessionId(1));
    f.add(sessionId(2), otherDirectory);
    const roots = [
      { sessionId: 'workspace_first', kiloSessionId: sessionId(0), directory },
      { sessionId: 'workspace_sibling', kiloSessionId: sessionId(1), directory },
      { sessionId: 'workspace_other', kiloSessionId: sessionId(2), directory: otherDirectory },
    ] as const;
    const ptys = new Map<string, WrapperPty>();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    let blockCreation = false;
    let count = 0;
    const kiloClient = {
      serverUrl: 'http://127.0.0.1:1',
      createPty: async input => {
        const id = `pty_${++count}`;
        if (blockCreation && input.cwd === directory) {
          started.resolve();
          await release.promise;
        }
        const pty: WrapperPty = {
          id,
          title: 'Workspace terminal',
          command: '/bin/bash',
          args: [],
          cwd: input.cwd,
          status: 'running',
          pid: count,
        };
        ptys.set(id, pty);
        return pty;
      },
      resizePty: async (id, _size, dir) => {
        const pty = ptys.get(id);
        if (!pty || pty.cwd !== dir) throw new Error('PTY not found');
        return pty;
      },
      deletePty: async (id, dir) => ptys.get(id)?.cwd === dir && ptys.delete(id),
    } as WrapperKiloClient;
    const kiloRuntime: WorktreeKiloRuntime = {
      scopeId: 'test-scope',
      runtimeId: 'native_1',
      directory,
      env: {},
      kiloClient,
      signal: new AbortController().signal,
    };
    const otherKiloRuntime: WorktreeKiloRuntime = {
      scopeId: 'test-scope-other',
      runtimeId: 'native_2',
      directory: otherDirectory,
      env: {},
      kiloClient,
      signal: new AbortController().signal,
    };
    const runtime = createControlTerminalRuntime({
      controlUrl: 'ws://127.0.0.1:1/sandbox-control/sandbox',
      wrapperInstanceId: crypto.randomUUID(),
      getKiloRuntime: dir =>
        dir === directory ? kiloRuntime : dir === otherDirectory ? otherKiloRuntime : undefined,
    });

    try {
      for (const root of roots) {
        rememberAttachedRoot(root.kiloSessionId, root.directory);
        runtime.rememberAttachedSession(root);
      }
      await runtime.create(roots[0], { operationId: crypto.randomUUID() });
      const other = await runtime.create(roots[2], { operationId: crypto.randomUUID() });
      blockCreation = true;
      const creation = runtime.create(roots[1], { operationId: crypto.randomUUID() });
      const creationFailure = rejects(creation, /no longer attached/);
      await started.promise;

      const deletion = deleteWorktree(
        { worktreeId, directory, sessionIds: [sessionId(0), sessionId(1)] },
        {
          ...f.deps,
          detachTerminals: dir => {
            const cleanup = runtime.detachDirectory(dir);
            cleanupStarted.resolve();
            return cleanup;
          },
        }
      );
      await cleanupStarted.promise;
      expect(f.directories.has(directory)).toBe(true);
      expect(rootForSession(sessionId(0))).toBe(sessionId(0));
      expect(rootForSession(sessionId(1))).toBe(sessionId(1));

      release.resolve();
      await creationFailure;
      expect(await deletion).toEqual({ deleted: true, sessionIds: [sessionId(0), sessionId(1)] });
      expect([...ptys.values()]).toEqual([other.pty]);
      expect([...f.directories]).toEqual([otherDirectory]);
      expect(rootForSession(sessionId(2))).toBe(sessionId(2));
      expect(await runtime.resize(roots[2], { ptyId: other.pty.id, cols: 100, rows: 30 })).toEqual(
        other
      );
      await rejects(runtime.create(roots[0], { operationId: crypto.randomUUID() }), /not attached/);
    } finally {
      release.resolve();
      runtime.shutdown();
    }
  });

  test('removes an unopened checkout even when Kilo has no session records', async () => {
    const f = fixture();
    const input = { worktreeId, directory, sessionIds: [sessionId(0)] };
    expect(await deleteWorktree(input, f.deps)).toEqual({
      deleted: true,
      sessionIds: [sessionId(0)],
    });
    expect(f.directories.has(directory)).toBe(false);
    expect(f.directories.has(otherDirectory)).toBe(true);
  });

  test('requires discovered descendants to be journaled before deleting transcripts', async () => {
    const f = fixture();
    f.add(sessionId(0));
    f.add(sessionId(1), directory, sessionId(0));
    await rejects(
      deleteWorktree({ worktreeId, directory, sessionIds: [sessionId(0)] }, f.deps),
      /manifest changed/
    );
    expect(f.sessions.size).toBe(2);
    expect(f.retired).toEqual([]);
    expect(f.directories.has(directory)).toBe(true);
  });

  test('does not report success after a partial delete and resumes with the complete journal', async () => {
    const f = fixture();
    f.add(sessionId(0));
    f.add(sessionId(1), directory, sessionId(0));
    const input = { worktreeId, directory, sessionIds: [sessionId(0), sessionId(1)] };
    f.fail(sessionId(0));
    await rejects(deleteWorktree(input, f.deps), /temporarily unavailable/);
    expect(f.sessions.has(sessionId(1))).toBe(false);
    expect(f.retired).toEqual([]);
    expect(f.directories.has(directory)).toBe(true);
    f.fail();
    expect(await deleteWorktree(input, f.deps)).toEqual({
      deleted: true,
      sessionIds: input.sessionIds,
    });
    expect(f.sessions.size).toBe(0);
    expect(f.directories.has(directory)).toBe(false);
  });

  test('verifies Kilo deletion rather than trusting a successful deletion response', async () => {
    const f = fixture();
    f.add(sessionId(0));
    f.client.deleteSession = async () => undefined;
    await rejects(
      deleteWorktree({ worktreeId, directory, sessionIds: [sessionId(0)] }, f.deps),
      /not confirmed/
    );
    expect(f.disposed).toEqual([]);
    expect(f.retired).toEqual([]);
    expect(f.directories.has(directory)).toBe(true);
  });

  test('rejects a mismatched session directory without deleting the unrelated session', async () => {
    const f = fixture();
    f.add(sessionId(0), otherDirectory);
    await rejects(
      prepareWorktreeDeletion({ worktreeId, directory, sessionIds: [sessionId(0)] }, f.deps),
      /directory conflict/
    );
    expect(f.sessions.get(sessionId(0))?.active).toBe(true);
    expect(f.directories.has(otherDirectory)).toBe(true);
  });

  test.each([true, false])(
    'rejects a journaled root attached to another directory even without a Kilo record: live=%s',
    async live => {
      const f = fixture();
      rememberAttachedRoot(sessionId(0), otherDirectory);
      await rejects(
        deleteWorktree(
          { worktreeId, directory, sessionIds: [sessionId(0)] },
          { ...f.deps, client: live ? f.client : undefined }
        ),
        /directory conflict/
      );
      expect(rootForSession(sessionId(0), otherDirectory)).toBe(sessionId(0));
      expect(f.aborted).toEqual([]);
      expect(f.retired).toEqual([]);
      expect([...f.directories]).toEqual([directory, otherDirectory]);
    }
  );

  test('rejects descendants belonging to another checkout before deleting any sessions', async () => {
    const f = fixture();
    f.add(sessionId(0));
    f.add(sessionId(1), otherDirectory, sessionId(0));
    await rejects(
      deleteWorktree({ worktreeId, directory, sessionIds: [sessionId(0), sessionId(1)] }, f.deps),
      /child directory conflict/
    );
    expect(f.sessions.get(sessionId(1))?.active).toBe(true);
    expect(f.sessions.size).toBe(2);
    expect(f.retired).toEqual([]);
    expect([...f.directories]).toEqual([directory, otherDirectory]);
  });

  test.each([
    '/workspace',
    '/workspace/owner/worktrees/../other',
    `${directory}/`,
    `${directory}/nested`,
    '/tmp/worktrees/' + worktreeId,
  ])('rejects noncanonical cleanup path %s', async unsafe => {
    const input = { worktreeId, directory: unsafe, sessionIds: [] };
    expect(() =>
      validateWorktreeDirectory({ worktreeId, directory: unsafe, sessionIds: [] })
    ).toThrow('Invalid worktree directory');
    await rejects(prepareWorktreeDeletion(input, {}), /Invalid worktree directory/);
  });

  test.each([true, false])(
    'waits for an in-flight directory operation and permanently fences later operations for that directory only: live=%s',
    async live => {
      const f = fixture();
      const deps = { ...f.deps, client: live ? f.client : undefined };
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const inflight = runDirectoryOperation(directory, async () => {
        started.resolve();
        await release.promise;
      });
      await started.promise;
      let prepared = false;
      const cleanup = prepareWorktreeDeletion(
        { worktreeId, directory, sessionIds: [sessionId(0)] },
        deps
      ).then(ids => {
        prepared = true;
        return ids;
      });
      await Promise.resolve();
      expect(prepared).toBe(false);
      await rejects(
        runDirectoryOperation(directory, async () => undefined),
        /worktree_deleting/
      );
      expect(await runDirectoryOperation(otherDirectory, async () => 'preserved')).toBe(
        'preserved'
      );
      release.resolve();
      await inflight;
      const ids = await cleanup;
      await deleteWorktree({ worktreeId, directory, sessionIds: ids }, deps);
      expect(f.directories.has(directory)).toBe(false);
      await rejects(
        runDirectoryOperation(directory, async () => undefined),
        /worktree_deleting/
      );
    }
  );
});
