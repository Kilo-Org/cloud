import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ControlPlaneWorktreeDeletionRequestFrame,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import {
  createWorktreeKiloCleanupClient,
  deleteWorktree,
  type WorktreeKiloCleanupClient,
} from '../control/delete-worktree.js';
import {
  forgetOutstandingRuleset,
  readOutstandingRuleset,
  rememberOutstandingRuleset,
} from '../kilo-api.js';
import { resetSessionDirectoryState } from '../control/session-directories.js';
import { resetDirectoryOperationState } from '../control/worktree-operations.js';
import {
  controlDiagnosticFieldsSchema,
  type ControlDiagnosticFields,
} from '../../../src/shared/control-diagnostics.js';
import {
  createControlPlaneWorktreeDeletion,
  type ControlPlaneWorktreeDeletionDeps,
} from './worktree-deletion.js';

const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111' as const;
const directory = `/workspace/oauth-user/worktrees/${worktreeId}`;
const sessionId = (index: number) => `ses_${String(index).padStart(26, '0')}`;

function deletionRequest(
  type: 'worktree.prepareDeletion' | 'worktree.delete',
  requestId: string,
  sessionIds: string[] = [sessionId(0)]
): ControlPlaneWorktreeDeletionRequestFrame {
  return { type, requestId, payload: { worktreeId, directory, sessionIds } };
}

afterEach(() => {
  resetDirectoryOperationState();
  resetSessionDirectoryState();
});

function fixture() {
  const sessions = new Map<string, { id: string; directory: string }>();
  const retired: string[] = [];
  const client: WorktreeKiloCleanupClient = {
    listSessionIds: async dir =>
      [...sessions.values()]
        .filter(session => session.directory === dir)
        .map(session => session.id),
    getSession: async (_dir, id) => sessions.get(id) ?? null,
    children: async () => [],
    abortSession: async () => undefined,
    stopSessionProcesses: async () => undefined,
    deleteSession: async (_dir, id) => {
      sessions.delete(id);
    },
    closeTerminals: async () => undefined,
    disposeDirectory: async () => undefined,
  };
  return { sessions, retired, client };
}

function harness(overrides: Partial<ControlPlaneWorktreeDeletionDeps> = {}) {
  const frames: ControlPlaneWrapperFrame[] = [];
  const f = fixture();
  const adapter = createControlPlaneWorktreeDeletion({
    emit: frame => frames.push(frame),
    clients: () => [f.client],
    retireDirectory: async dir => {
      f.retired.push(dir);
    },
    ...overrides,
  });
  return { adapter, frames, fixture: f };
}

function deferred() {
  return Promise.withResolvers<void>();
}

describe('worktree cleanup timing', () => {
  test.each([false, true])('retains aggregate timing fields on failure=%s', async fail => {
    const f = fixture();
    f.sessions.set(sessionId(0), { id: sessionId(0), directory });
    const diagnostics: ControlDiagnosticFields[] = [];
    const run = deleteWorktree(
      { worktreeId, directory, sessionIds: [sessionId(0)] },
      {
        clients: [f.client],
        onDiagnostic: (_event, fields) =>
          diagnostics.push(controlDiagnosticFieldsSchema.parse(fields)),
        assertDirectory: async () => undefined,
        removeDirectory: async () => {
          if (fail) throw new Error('filesystem unavailable');
        },
      }
    );
    if (fail) {
      const error = await run.then(
        () => null,
        error => error
      );
      expect(error).toEqual(new Error('filesystem unavailable'));
    } else await run;
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      operation: 'worktree.prepareDeletion',
      manifestDiscoveryMs: expect.any(Number),
      sessionAbortMs: expect.any(Number),
    });
    expect(diagnostics[1]).toMatchObject({
      operation: 'worktree.delete',
      phase: fail ? 'failed' : 'completed',
      ok: !fail,
      processCleanupMs: expect.any(Number),
      terminalCleanupMs: expect.any(Number),
      sessionDeleteMs: expect.any(Number),
      sessionDeleteConfirmationMs: expect.any(Number),
      directoryDisposeMs: expect.any(Number),
      runtimeRetirementMs: expect.any(Number),
      directoryValidationMs: expect.any(Number),
      directoryRemovalMs: expect.any(Number),
    });
    if (fail) expect(diagnostics[1].rootDetachMs).toBeUndefined();
    else expect(diagnostics[1].rootDetachMs).toBeGreaterThanOrEqual(0);
  });
});

async function flushMicrotasks() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

function batchedDeletionFixture(count: number) {
  const f = fixture();
  const ids = Array.from({ length: count }, (_, index) => sessionId(index));
  const lookups = ids.map(deferred);
  const lookupStarted = ids.map(deferred);
  const stops = ids.map(deferred);
  const stopStarted = ids.map(deferred);
  const deletions = ids.map(deferred);
  const deletionStarted = ids.map(deferred);
  const events: string[] = [];
  const reads = new Map<string, number>();
  let activeLookups = 0;
  let activeStops = 0;
  let maxLookups = 0;
  let maxStops = 0;
  let lookupCount = 0;
  let stopCount = 0;
  for (const id of ids) f.sessions.set(id, { id, directory });
  const client: WorktreeKiloCleanupClient = {
    ...f.client,
    getSession: async (dir, id) => {
      const read = (reads.get(id) ?? 0) + 1;
      reads.set(id, read);
      if (read === 2) {
        const index = ids.indexOf(id);
        activeLookups++;
        lookupCount++;
        maxLookups = Math.max(maxLookups, activeLookups);
        lookupStarted[index].resolve();
        try {
          await lookups[index].promise;
        } finally {
          activeLookups--;
        }
      }
      return f.client.getSession(dir, id);
    },
    abortSession: async (_dir, id) => {
      events.push(`abort:${id}`);
    },
    children: async (_dir, id) => {
      events.push(`children:${id}`);
      return [];
    },
    stopSessionProcesses: async (_dir, id) => {
      const index = ids.indexOf(id);
      activeStops++;
      stopCount++;
      maxStops = Math.max(maxStops, activeStops);
      stopStarted[index].resolve();
      try {
        await stops[index].promise;
      } finally {
        activeStops--;
      }
    },
    closeTerminals: async () => {
      events.push('terminals');
    },
    deleteSession: async (dir, id) => {
      events.push(`delete:${id}`);
      const index = ids.indexOf(id);
      deletionStarted[index].resolve();
      await deletions[index].promise;
      await f.client.deleteSession(dir, id);
    },
    disposeDirectory: async () => {
      events.push('dispose');
    },
  };
  const run = () =>
    deleteWorktree(
      { worktreeId, directory, sessionIds: ids },
      {
        clients: [client],
        assertDirectory: async () => {
          events.push('validate');
        },
        detachTerminals: async () => {
          events.push('detachTerminals');
        },
        retireDirectory: async () => {
          events.push('retire');
        },
        removeDirectory: async () => {
          events.push('remove');
        },
      }
    );
  return {
    ids,
    lookups,
    lookupStarted,
    stops,
    stopStarted,
    deletions,
    deletionStarted,
    events,
    run,
    maxLookups: () => maxLookups,
    maxStops: () => maxStops,
    lookupCount: () => lookupCount,
    stopCount: () => stopCount,
  };
}

describe('direct worktree deletion batches', () => {
  test('bounds both phases at eight and preserves preparation and deletion barriers', async () => {
    const f = batchedDeletionFixture(17);
    const result = f.run();
    await f.lookupStarted[7].promise;
    expect(f.events).toEqual([
      'validate',
      ...f.ids.flatMap(id => [`abort:${id}`, `children:${id}`]),
    ]);
    for (const offset of [0, 8, 16]) {
      const end = Math.min(offset + 8, f.ids.length);
      await f.lookupStarted[end - 1].promise;
      for (let index = end - 1; index > offset; index--) f.lookups[index].resolve();
      await flushMicrotasks();
      expect(f.maxLookups()).toBe(8);
      expect(f.lookupCount()).toBe(end);
      expect(f.stopCount()).toBe(0);
      expect(f.events).not.toContain('terminals');
      f.lookups[offset].resolve();
    }
    await f.stopStarted[7].promise;
    for (const offset of [0, 8, 16]) {
      const end = Math.min(offset + 8, f.ids.length);
      await f.stopStarted[end - 1].promise;
      for (let index = end - 1; index > offset; index--) f.stops[index].resolve();
      await flushMicrotasks();
      expect(f.maxStops()).toBe(8);
      expect(f.stopCount()).toBe(end);
      expect(f.events).not.toContain('detachTerminals');
      expect(f.events).not.toContain('remove');
      f.stops[offset].resolve();
    }
    for (let index = f.ids.length - 1; index >= 0; index--) {
      await f.deletionStarted[index].promise;
      await flushMicrotasks();
      expect(f.events.filter(event => event.startsWith('delete:'))).toEqual(
        f.ids
          .slice(index)
          .reverse()
          .map(id => `delete:${id}`)
      );
      expect(f.events).not.toContain('remove');
      f.deletions[index].resolve();
    }
    expect(await result).toEqual({ deleted: true, sessionIds: f.ids });
    expect(f.events.slice(1 + f.ids.length * 2)).toEqual([
      'detachTerminals',
      'terminals',
      ...[...f.ids].reverse().map(id => `delete:${id}`),
      'dispose',
      'retire',
      'validate',
      'remove',
    ]);
  });

  for (const phase of ['lookup', 'process'] as const) {
    test(`${phase} failure also waits for sibling owners of the same session`, async () => {
      const f = fixture();
      const id = sessionId(0);
      f.sessions.set(id, { id, directory });
      const gates = [deferred(), deferred()];
      const started = [deferred(), deferred()];
      const events: string[] = [];
      const failure = new Error(`${phase} owner failed`);
      const clients = gates.map((gate, index): WorktreeKiloCleanupClient => {
        let reads = 0;
        return {
          ...f.client,
          getSession: async (dir, session) => {
            if (++reads === 2 && phase === 'lookup') {
              started[index].resolve();
              await gate.promise;
            }
            return f.client.getSession(dir, session);
          },
          stopSessionProcesses: async () => {
            started[index].resolve();
            await gate.promise;
          },
          closeTerminals: async () => {
            events.push('terminals');
          },
          deleteSession: async () => {
            events.push('delete');
          },
          disposeDirectory: async () => {
            events.push('dispose');
          },
        };
      });
      let settled = false;
      const result = deleteWorktree(
        { worktreeId, directory, sessionIds: [id] },
        {
          clients,
          assertDirectory: async () => undefined,
          removeDirectory: async () => {
            events.push('remove');
          },
        }
      ).then(
        () => {
          settled = true;
          return null;
        },
        error => {
          settled = true;
          return error;
        }
      );
      await Promise.all(started.map(signal => signal.promise));
      gates[0].reject(failure);
      await flushMicrotasks();
      expect(settled).toBe(false);
      expect(events).toEqual([]);
      gates[1].resolve();
      expect(await result).toBe(failure);
      expect(events).toEqual([]);
    });

    test(`${phase} failure waits for batch siblings and prevents later cleanup and removal`, async () => {
      const f = batchedDeletionFixture(9);
      let settled = false;
      const failure = new Error(`${phase} failed`);
      const result = f.run().then(
        () => {
          settled = true;
          return null;
        },
        error => {
          settled = true;
          return error;
        }
      );
      await f.lookupStarted[7].promise;
      if (phase === 'process') {
        for (const lookup of f.lookups.slice(0, 8)) lookup.resolve();
        await f.lookupStarted[8].promise;
        f.lookups[8].resolve();
        await f.stopStarted[7].promise;
      }
      const gates = phase === 'lookup' ? f.lookups : f.stops;
      gates[0].reject(failure);
      for (const gate of gates.slice(1, 7)) gate.resolve();
      await gates[0].promise.catch(() => undefined);
      await flushMicrotasks();
      expect(settled).toBe(false);
      expect(phase === 'lookup' ? f.lookupCount() : f.stopCount()).toBe(8);
      expect(f.events).not.toContain('detachTerminals');
      expect(f.events).not.toContain('remove');
      gates[7].resolve();
      expect(await result).toBe(failure);
      expect(phase === 'lookup' ? f.lookupCount() : f.stopCount()).toBe(8);
      expect(f.maxLookups()).toBe(8);
      expect(f.maxStops()).toBe(phase === 'process' ? 8 : 0);
      expect(f.events.some(event => event.startsWith('delete:'))).toBe(false);
      expect(f.events).not.toContain('dispose');
      expect(f.events).not.toContain('retire');
      expect(f.events).not.toContain('remove');
    });
  }
});

describe('control-plane wrapper worktree deletion (R2)', () => {
  test('answers a prepareDeletion with the discovered session manifest', async () => {
    const { adapter, frames, fixture: f } = harness();
    f.sessions.set(sessionId(0), { id: sessionId(0), directory });
    f.sessions.set(sessionId(1), { id: sessionId(1), directory });

    await adapter.handle(deletionRequest('worktree.prepareDeletion', 'req-prep', [sessionId(0)]));

    expect(frames).toEqual([
      {
        type: 'worktree.result',
        requestId: 'req-prep',
        ok: true,
        result: { prepared: true, sessionIds: [sessionId(0), sessionId(1)] },
      },
    ]);
  });

  test('answers a delete with the confirmed manifest and retires the runtime', async () => {
    const { adapter, frames, fixture: f } = harness();
    f.sessions.set(sessionId(0), { id: sessionId(0), directory });

    await adapter.handle(deletionRequest('worktree.delete', 'req-del'));

    expect(f.retired).toEqual([directory]);
    expect(frames).toEqual([
      {
        type: 'worktree.result',
        requestId: 'req-del',
        ok: true,
        result: { deleted: true, sessionIds: [sessionId(0)] },
      },
    ]);
  });

  test('detaches directory terminals before deleting', async () => {
    const detached: string[] = [];
    const { adapter, fixture: f } = harness({
      detachTerminals: async dir => {
        detached.push(dir);
      },
    });
    f.sessions.set(sessionId(0), { id: sessionId(0), directory });

    await adapter.handle(deletionRequest('worktree.delete', 'req-terms'));

    expect(detached).toEqual([directory]);
  });

  test('reports a failed cleanup as a retryable not_ready result', async () => {
    const { adapter, frames } = harness({
      clients: () => {
        throw new Error('Kilo cleanup is unavailable');
      },
    });

    await adapter.handle(deletionRequest('worktree.delete', 'req-fail'));

    expect(frames).toEqual([
      {
        type: 'worktree.result',
        requestId: 'req-fail',
        ok: false,
        error: { code: 'not_ready', message: 'Kilo cleanup is unavailable', retryable: true },
      },
    ]);
  });

  test('rejects an invalid worktree directory without touching Kilo', async () => {
    const { adapter, frames } = harness();

    await adapter.handle({
      type: 'worktree.prepareDeletion',
      requestId: 'req-invalid',
      payload: { worktreeId, directory: '/etc', sessionIds: [sessionId(0)] },
    });

    expect(frames).toMatchObject([
      { type: 'worktree.result', requestId: 'req-invalid', ok: false, error: { retryable: true } },
    ]);
  });
});

function startCleanupStub() {
  const deleted = new Set<string>();
  const sessions = new Map<string, string>();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const target = /^\/session\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
      if (url.pathname === '/api/session' && request.method === 'GET') {
        return Response.json({ data: [], cursor: {} });
      }
      if (target && request.method === 'GET' && target[2] === '/children') {
        return Response.json([]);
      }
      if (target && request.method === 'GET') {
        const id = decodeURIComponent(target[1]);
        const sessionDirectory = sessions.get(id);
        if (deleted.has(id) || sessionDirectory === undefined) {
          return Response.json(
            { _tag: 'SessionNotFoundError', sessionID: id, message: 'not found' },
            { status: 404 }
          );
        }
        return Response.json({ id, directory: sessionDirectory });
      }
      if (target && target[2] === '/abort' && request.method === 'POST') {
        return Response.json(true);
      }
      if (url.pathname === '/pty' && request.method === 'GET') {
        return Response.json([]);
      }
      if (url.pathname === '/instance/dispose' && request.method === 'POST') {
        return Response.json(true);
      }
      if (/^\/background-process\/session\/[^/]+\/stop$/.test(url.pathname)) {
        return Response.json(true);
      }
      if (target && request.method === 'DELETE') {
        deleted.add(decodeURIComponent(target[1]));
        return Response.json(true);
      }
      return new Response(null, { status: 404 });
    },
  });
  return {
    server,
    sessions,
    deleted,
    client: createWorktreeKiloCleanupClient({ url: server.url.toString() }),
  };
}

describe('worktree deletion clears the session ruleset marker', () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  test('deleting the worktree removes the marker of its session', async () => {
    const id = sessionId(0);
    const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
    // Outstanding markers live under $HOME, so the test owns their directory.
    const home = mkdtempSync(join(tmpdir(), 'worktree-delete-home-'));
    homes.push(home);
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    const stub = startCleanupStub();
    stub.sessions.set(id, directory);
    try {
      await rememberOutstandingRuleset(id, permission);
      expect(await readOutstandingRuleset(id)).toEqual(permission);

      await deleteWorktree(
        { worktreeId, directory, sessionIds: [id] },
        { clients: [stub.client], removeDirectory: async () => undefined }
      );

      expect(stub.deleted.has(id)).toBe(true);
      expect(await readOutstandingRuleset(id)).toBeUndefined();
    } finally {
      await stub.server.stop(true);
      await forgetOutstandingRuleset(id).catch(() => undefined);
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  test('a marker that cannot be removed does not fail the deletion', async () => {
    const id = sessionId(1);
    const permission = [{ permission: 'edit', pattern: '*', action: 'deny' as const }];
    const home = mkdtempSync(join(tmpdir(), 'worktree-delete-home-'));
    homes.push(home);
    const rulesets = join(home, '.kilo-control', 'rulesets');
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    let readOnly = false;
    const stub = startCleanupStub();
    stub.sessions.set(id, directory);
    try {
      await rememberOutstandingRuleset(id, permission);
      chmodSync(rulesets, 0o500);
      readOnly = true;

      const result = await deleteWorktree(
        { worktreeId, directory, sessionIds: [id] },
        { clients: [stub.client], removeDirectory: async () => undefined }
      );

      expect(result).toEqual({ deleted: true, sessionIds: [id] });
      expect(stub.deleted.has(id)).toBe(true);
      expect(await readOutstandingRuleset(id)).toEqual(permission);
    } finally {
      if (readOnly) chmodSync(rulesets, 0o700);
      await stub.server.stop(true);
      await forgetOutstandingRuleset(id).catch(() => undefined);
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});
