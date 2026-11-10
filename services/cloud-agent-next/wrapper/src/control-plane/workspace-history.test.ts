import { describe, expect, it, mock } from 'bun:test';
import type { ControlPlaneRouteSpec } from '../../../src/shared/control-plane-protocol.js';
import type { Harness } from './harness.js';
import { createWorkspaceHistoryPreloader } from './workspace-history.js';
import { createKilo2Harness } from './kilo2-harness.js';
import { createKilo2Lifecycle } from './kilo2-lifecycle.js';

const sessions = Array.from({ length: 5 }, (_, index) => ({
  sessionId: `workspace_${index}`,
  kiloSessionId: `ses_${String(index).repeat(26)}`,
}));
const spec: ControlPlaneRouteSpec = {
  ...sessions[0],
  directory: '/workspace/project',
  attemptId: 'attempt',
  kilo: {
    scopeId: 'worktree_6a7199ec-d6d7-4788-b5a5-d74960f401e3',
    token: 'test-token',
    targets: {
      backendBaseUrl: 'https://backend.test',
      providerBaseUrl: 'https://provider.test',
      sessionIngestBaseUrl: 'https://ingest.test',
    },
  },
};

function setup(open = mock(async (_input: Parameters<Harness['open']>[0]) => true)) {
  const readRecent = mock(async () => sessions);
  const readPage = mock(async (_request: unknown) => ({}));
  const log = mock((_message: string) => {});
  const preloader = createWorkspaceHistoryPreloader({ readRecent, readPage, log });
  const client = { open } as unknown as Harness;
  return { preloader, client, readRecent, readPage, log, open };
}

describe('workspace history preload', () => {
  it('imports recent siblings in parallel, once per live runtime, without restoring files', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const open = mock(async (input: Parameters<Harness['open']>[0]) => {
      if (open.mock.calls.length === 4) started.resolve();
      await input.readHistoryPage?.('older');
      await release.promise;
      return true;
    });
    const h = setup(open);
    const signal = new AbortController().signal;
    const first = h.preloader.preload(h.client, spec, { HOME: '/workspace/home' }, signal);
    const sibling = h.preloader.preload(h.client, { ...spec, ...sessions[1] }, {}, signal);
    await started.promise;
    expect(h.readRecent).toHaveBeenCalledTimes(1);
    expect(open.mock.calls.map(([input]) => input.sessionId)).toEqual(
      sessions.slice(1).map(session => session.kiloSessionId)
    );
    for (const [input] of open.mock.calls) {
      expect(input.restoreFiles).toBe(false);
      expect(input.directory).toBe(spec.directory);
      expect(input.env.HOME).toBe('/workspace/home');
    }
    expect(h.readPage.mock.calls).toHaveLength(4);
    expect(h.readPage.mock.calls[0][0]).toMatchObject({
      ...sessions[1],
      cursor: 'older',
      workspaceSessionId: spec.sessionId,
    });
    release.resolve();
    await Promise.all([first, sibling]);
    await h.preloader.preload(h.client, spec, {}, signal);
    expect(h.readRecent).toHaveBeenCalledTimes(1);
    await h.preloader.preload({ open } as unknown as Harness, spec, {}, signal);
    expect(h.readRecent).toHaveBeenCalledTimes(2);
  });

  it('retries a transient import once and keeps other imports independent of a permanent failure', async () => {
    const attempts = new Map<string, number>();
    const h = setup(
      mock(async input => {
        const attempt = (attempts.get(input.sessionId) ?? 0) + 1;
        attempts.set(input.sessionId, attempt);
        if (input.sessionId === sessions[1].kiloSessionId && attempt === 1)
          throw new Error('transient');
        if (input.sessionId === sessions[2].kiloSessionId) throw new Error('permanent');
        return true;
      })
    );
    await h.preloader.preload(h.client, spec, {}, new AbortController().signal);
    expect([...attempts.values()]).toEqual([2, 2, 1, 1]);
    expect(h.log).toHaveBeenCalledWith('workspace history preload sessions=4 failures=1');
  });

  it('does not turn discovery failure or cancellation into a preparation failure', async () => {
    const h = setup();
    h.readRecent.mockImplementation(async () => {
      throw new Error('unavailable');
    });
    await h.preloader.preload(h.client, spec, {}, new AbortController().signal);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(
      'workspace history preload incomplete; continuing session preparation'
    );

    const hung = setup();
    const started = Promise.withResolvers<void>();
    hung.readRecent.mockImplementation(async () => {
      started.resolve();
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const waiting = hung.preloader.preload(hung.client, spec, {}, controller.signal);
    await started.promise;
    controller.abort();
    await waiting;
    expect(hung.open).not.toHaveBeenCalled();
  });

  it('deduplicates an on-demand open racing a preload of the same session', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const h = setup(
      mock(async input => {
        if (input.sessionId === sessions[1].kiloSessionId) {
          started.resolve();
          await release.promise;
        }
        return true;
      })
    );
    const preload = h.preloader.preload(h.client, spec, {}, new AbortController().signal);
    await started.promise;
    const onDemand = h.preloader.open(h.client, {
      sessionId: sessions[1].kiloSessionId,
      directory: spec.directory,
      env: {},
      restoreFiles: false,
      onRestore() {},
    });
    release.resolve();
    await Promise.all([preload, onDemand]);
    expect(
      h.open.mock.calls.filter(([input]) => input.sessionId === sessions[1].kiloSessionId)
    ).toHaveLength(1);
  });

  it('does not leave a cancelled preload blocking a later on-demand restore', async () => {
    const started = Promise.withResolvers<void>();
    let hang = true;
    const h = setup(
      mock(async input => {
        if (hang && input.sessionId === sessions[1].kiloSessionId) {
          started.resolve();
          return new Promise<boolean>(() => {});
        }
        return true;
      })
    );
    const controller = new AbortController();
    const preload = h.preloader.preload(h.client, spec, {}, controller.signal);
    await started.promise;
    controller.abort();
    await preload;
    hang = false;
    expect(
      await h.preloader.open(h.client, {
        sessionId: sessions[1].kiloSessionId,
        directory: spec.directory,
        env: {},
        restoreFiles: false,
        onRestore() {},
      })
    ).toBe(true);
  });

  it.each([
    { ...spec, runtimeIsolation: 'per-session' as const },
    {
      ...spec,
      workspaceSnapshot: {
        workspaceId: 'worktree_6a7199ec-d6d7-4788-b5a5-d74960f401e3' as const,
        directory: spec.directory,
        sourceAllocationId: 'old',
      },
    },
    { ...spec, kilo: { ...spec.kilo!, scopeId: 'session-scope' } },
  ])('skips snapshot restores and non-shared runtimes (%j)', async route => {
    const h = setup();
    await h.preloader.preload(h.client, route, {}, new AbortController().signal);
    expect(h.readRecent).not.toHaveBeenCalled();
  });

  it('imports native v2 history and titles into the shared runtime before completing startup', async () => {
    const imported: unknown[] = [];
    const importsStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/session/')) return new Response(null, { status: 404 });
        if (url.pathname === '/api/location') return Response.json({ project: { id: 'project' } });
        if (url.pathname === '/api/experimental/session/import') {
          imported.push(await request.json());
          if (imported.length === 4) importsStarted.resolve();
          await release.promise;
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      },
    });
    try {
      const client = createKilo2Harness({
        server: { url: server.url.toString() },
        directory: spec.directory,
        lifecycle: createKilo2Lifecycle(),
      });
      const preloader = createWorkspaceHistoryPreloader({
        readRecent: async () => sessions,
        readPage: async request => ({
          kind: 'success',
          source: { version: 'v2', session: { id: request.kiloSessionId } },
          info: { id: request.kiloSessionId, title: `Chat ${request.sessionId}` },
          messages: [
            {
              message: {
                id: `msg_${'a'.repeat(26)}`,
                type: 'user',
                text: 'Previous work',
                time: { created: 1 },
              },
            },
          ],
          nextCursor: null,
          omittedItemCount: 0,
        }),
        log() {},
      });
      const preload = preloader.preload(client, spec, {}, new AbortController().signal);
      await importsStarted.promise;
      expect(imported).toHaveLength(4);
      for (const session of sessions.slice(1)) {
        expect(imported).toContainEqual(
          expect.objectContaining({
            location: { directory: spec.directory },
            info: expect.objectContaining({
              id: session.kiloSessionId,
              title: `Chat ${session.sessionId}`,
            }),
            messages: [expect.objectContaining({ text: 'Previous work' })],
          })
        );
      }
      release.resolve();
      await preload;
    } finally {
      release.resolve();
      await server.stop(true);
    }
  });

  it('bounds a hung preload to ten seconds and cancels its history reads', async () => {
    const h = setup(mock(async () => new Promise<boolean>(() => {})));
    const startedAt = Date.now();
    await h.preloader.preload(h.client, spec, {}, new AbortController().signal);
    expect(Date.now() - startedAt).toBeLessThan(12_000);
    expect(h.open.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(h.log).toHaveBeenCalledWith(
      'workspace history preload incomplete; continuing session preparation'
    );
  }, 15_000);
});
