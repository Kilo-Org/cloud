import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { KILO_CONTROL_REQUEST_TIMEOUT_MS } from './sandbox-control-runtime';
import { createNativeObservations } from './native-observations';
import type { WrapperKiloClient } from '../kilo-api';
import type { WorktreeKiloRuntime } from './worktree-runtime';

type FakeRoot = {
  kiloSessionId: string;
  directory: string | undefined;
  revision: symbol | undefined;
};

function fakeKilo(overrides: Partial<WrapperKiloClient> = {}): WrapperKiloClient {
  return {
    getSession: async id => ({ id }),
    ensureSession: async () => undefined,
    sendPrompt: async () => ({ info: {} as never, parts: [] }),
    sendPromptAsync: async () => {},
    sendCommand: async () => ({ info: {} as never, parts: [] }),
    summarizeSession: async () => true,
    generateCommitMessage: async () => ({ message: 'test' }),
    abortSession: async () => true,
    answerPermission: async () => true,
    answerQuestion: async () => true,
    rejectQuestion: async () => true,
    getSessionStatuses: async () => ({}),
    getQuestions: async () => [],
    getPermissions: async () => [],
    ...overrides,
  } as WrapperKiloClient;
}

function fakeRuntime(
  directory: string,
  kiloClient: WrapperKiloClient,
  signal?: AbortSignal
): WorktreeKiloRuntime {
  return {
    scopeId: 'scope_1',
    directory,
    env: {},
    kiloClient,
    signal: signal ?? new AbortController().signal,
  };
}

describe('createNativeObservations', () => {
  let roots: FakeRoot[];
  let runtimes: Map<string, WorktreeKiloRuntime>;
  let reconciled: Array<{ statuses: unknown; roots: readonly string[] }>;

  beforeEach(() => {
    roots = [];
    runtimes = new Map();
    reconciled = [];
  });

  afterEach(() => {
    roots = [];
    runtimes.clear();
    reconciled = [];
  });

  function createObservations(signal?: AbortSignal) {
    return createNativeObservations({
      signal,
      roots: () => roots,
      getRuntime: directory => runtimes.get(directory),
      reconcileActivity: (statuses, r) => reconciled.push({ statuses, roots: r }),
    });
  }

  it('coalesces concurrent refresh calls and shares the pending result', async () => {
    let reads = 0;
    const answer =
      Promise.withResolvers<Awaited<ReturnType<WrapperKiloClient['getSessionStatuses']>>>();
    const client = fakeKilo({
      getSessionStatuses: async () => {
        reads++;
        return answer.promise;
      },
    });
    const runtime = fakeRuntime('/workspace', client);
    runtimes.set('/workspace', runtime);
    const revision = Symbol();
    roots = [{ kiloSessionId: 'kilo_1', directory: '/workspace', revision }];
    const obs = createObservations();
    const first = obs.refresh();
    const second = obs.refresh();
    answer.resolve({ kilo_1: { type: 'busy' } });
    await Promise.all([first, second]);
    expect(reads).toBe(1);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.roots).toEqual(['kilo_1']);
  });

  it('reconciles activity from successful native status reads', async () => {
    const client = fakeKilo({
      getSessionStatuses: async () => ({ kilo_1: { type: 'idle' } }),
    });
    const runtime = fakeRuntime('/workspace', client);
    runtimes.set('/workspace', runtime);
    roots = [{ kiloSessionId: 'kilo_1', directory: '/workspace', revision: Symbol() }];
    const obs = createObservations();
    await obs.refresh();
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.statuses).toEqual({ kilo_1: { type: 'idle' } });
  });

  it('preserves cached activity on failed native reads', async () => {
    const client = fakeKilo({
      getSessionStatuses: async () => {
        throw new Error('native read failed');
      },
    });
    const runtime = fakeRuntime('/workspace', client);
    runtimes.set('/workspace', runtime);
    roots = [{ kiloSessionId: 'kilo_1', directory: '/workspace', revision: Symbol() }];
    const obs = createObservations();
    await obs.refresh();
    expect(reconciled).toHaveLength(0);
  });

  it('excludes root from reconciliation when revision changes during read', async () => {
    const originalRevision = Symbol();
    const answer =
      Promise.withResolvers<Awaited<ReturnType<WrapperKiloClient['getSessionStatuses']>>>();
    const client = fakeKilo({ getSessionStatuses: () => answer.promise });
    const runtime = fakeRuntime('/workspace', client);
    runtimes.set('/workspace', runtime);
    roots = [{ kiloSessionId: 'kilo_1', directory: '/workspace', revision: originalRevision }];
    const obs = createObservations();
    const pending = obs.refresh();
    roots = [{ kiloSessionId: 'kilo_1', directory: '/workspace', revision: Symbol() }];
    answer.resolve({ kilo_1: { type: 'idle' } });
    await pending;
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.roots).toEqual([]);
  });

  it('discards result when runtime identity changes during read', async () => {
    const answer =
      Promise.withResolvers<Awaited<ReturnType<WrapperKiloClient['getSessionStatuses']>>>();
    const client = fakeKilo({ getSessionStatuses: () => answer.promise });
    const runtime = fakeRuntime('/workspace', client);
    runtimes.set('/workspace', runtime);
    roots = [{ kiloSessionId: 'kilo_1', directory: '/workspace', revision: Symbol() }];
    const obs = createObservations();
    const pending = obs.refresh();
    runtimes.set('/workspace', fakeRuntime('/workspace', fakeKilo()));
    answer.resolve({ kilo_1: { type: 'idle' } });
    await pending;
    expect(reconciled).toHaveLength(0);
  });

  it('forgets a directory when no roots reference it', async () => {
    const client = fakeKilo({ getSessionStatuses: async () => ({ kilo_1: { type: 'idle' } }) });
    const runtime = fakeRuntime('/workspace', client);
    runtimes.set('/workspace', runtime);
    roots = [{ kiloSessionId: 'kilo_1', directory: '/workspace', revision: Symbol() }];
    const obs = createObservations();
    await obs.refresh();
    expect(reconciled).toHaveLength(1);
    roots = [];
    reconciled = [];
    await obs.refresh();
    expect(reconciled).toHaveLength(0);
  });

  it.each(['client', 'revision', 'root'] as const)(
    'starts new scope after %s changes without applying old work or clearing new work',
    async change => {
      const first = Promise.withResolvers<Record<string, { type: string }>>();
      const second = Promise.withResolvers<Record<string, { type: string }>>();
      let reads = 0;
      const read = () => (++reads === 1 ? first.promise : second.promise);
      const runtime = fakeRuntime('/workspace', fakeKilo({ getSessionStatuses: read }));
      runtimes.set('/workspace', runtime);
      roots = [{ kiloSessionId: 'kilo_1', directory: '/workspace', revision: Symbol() }];
      const obs = createObservations();
      const old = obs.refresh();
      if (change === 'client')
        Object.assign(runtime, { kiloClient: fakeKilo({ getSessionStatuses: read }) });
      else
        roots = [
          {
            directory: '/workspace',
            kiloSessionId: change === 'root' ? 'kilo_2' : 'kilo_1',
            revision: Symbol(),
          },
        ];
      const current = obs.refresh();
      expect(reads).toBe(2);
      first.resolve({ kilo_1: { type: 'idle' } });
      await old;
      expect(reconciled).toEqual([]);
      const joined = obs.refresh();
      expect(reads).toBe(2);
      second.resolve({ kilo_1: { type: 'busy' } });
      await Promise.all([current, joined]);
      expect(reconciled).toHaveLength(1);
    }
  );

  it('applies unrelated runtime observations without waiting for a stalled runtime', async () => {
    const blocked = Promise.withResolvers<Record<string, { type: string }>>();
    runtimes.set(
      '/slow',
      fakeRuntime('/slow', fakeKilo({ getSessionStatuses: () => blocked.promise }))
    );
    runtimes.set(
      '/fast',
      fakeRuntime(
        '/fast',
        fakeKilo({ getSessionStatuses: async () => ({ fast: { type: 'busy' } }) })
      )
    );
    roots = [
      { kiloSessionId: 'slow', directory: '/slow', revision: Symbol() },
      { kiloSessionId: 'fast', directory: '/fast', revision: Symbol() },
    ];
    const pending = createObservations().refresh();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(reconciled).toEqual([{ statuses: { fast: { type: 'busy' } }, roots: ['fast'] }]);
    blocked.resolve({ slow: { type: 'idle' } });
    await pending;
  });

  it.each(['deadline', 'cancel'] as const)(
    'releases bounded sampling after %s even when the native read ignores abort',
    async end => {
      const timers = spyOn(globalThis, 'setTimeout');
      const blocked = Promise.withResolvers<Record<string, { type: string }>>();
      const abort = new AbortController();
      let readSignal: AbortSignal | undefined;
      let reads = 0;
      runtimes.set(
        '/workspace',
        fakeRuntime(
          '/workspace',
          fakeKilo({
            getSessionStatuses: (_directory, signal) => {
              readSignal = signal;
              reads++;
              return blocked.promise;
            },
          })
        )
      );
      roots = [{ kiloSessionId: 'kilo_1', directory: '/workspace', revision: Symbol() }];
      const obs = createObservations();
      try {
        const first = obs.refresh(abort.signal);
        const joined = obs.refresh(abort.signal);
        expect(reads).toBe(1);
        expect(
          timers.mock.calls.filter(([, ms]) => ms === KILO_CONTROL_REQUEST_TIMEOUT_MS)
        ).toHaveLength(1);
        if (end === 'cancel') abort.abort();
        else {
          const deadline = timers.mock.calls.find(
            ([, ms]) => ms === KILO_CONTROL_REQUEST_TIMEOUT_MS
          )?.[0];
          if (typeof deadline !== 'function') throw new Error('Missing native read deadline');
          deadline();
        }
        await Promise.all([first, joined]);
        expect(readSignal?.aborted).toBe(true);
        expect(reconciled).toEqual([]);
        blocked.resolve({ kilo_1: { type: 'idle' } });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(reconciled).toEqual([]);
        await obs.refresh();
        expect(reads).toBe(2);
      } finally {
        abort.abort();
        blocked.resolve({});
        timers.mockRestore();
      }
    }
  );

  it('skips refresh when aborted', async () => {
    let reads = 0;
    const client = fakeKilo({
      getSessionStatuses: async () => {
        reads++;
        return {};
      },
    });
    runtimes.set('/workspace', fakeRuntime('/workspace', client));
    roots = [{ kiloSessionId: 'kilo_1', directory: '/workspace', revision: Symbol() }];
    const abort = new AbortController();
    abort.abort();
    const obs = createObservations(abort.signal);
    await obs.refresh();
    expect(reads).toBe(0);
  });
});
