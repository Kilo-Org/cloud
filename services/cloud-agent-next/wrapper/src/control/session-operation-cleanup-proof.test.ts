import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { fakeKilo, session } from './control-test-fixtures';
import { createOwnedProcessScope } from './owned-processes';
import { SessionOperationCleanup, type NativeOperationTarget } from './session-operation-cleanup';
import {
  forgetAttachedRoot,
  rememberAttachedRoot,
  rememberChildSession,
  resetSessionDirectoryState,
} from './session-directories';
import type { WrapperKiloClient } from '../kilo-api';

type Statuses = Awaited<ReturnType<WrapperKiloClient['getSessionStatuses']>>;

beforeEach(() => {
  resetSessionDirectoryState();
  rememberAttachedRoot(session.kiloSessionId, session.directory);
});

afterEach(() => {
  jest.useRealTimers();
  resetSessionDirectoryState();
});

function fixture(overrides: Partial<WrapperKiloClient> = {}) {
  const client = fakeKilo({ getSessionStatuses: async () => ({}), ...overrides });
  const target = { runtimeId: 'native_exact', client };
  const processes = createOwnedProcessScope();
  const stop = jest.spyOn(processes, 'stop').mockResolvedValue(true);
  const verify = jest.fn(
    async (observed: NativeOperationTarget, deadlineAt: number) =>
      observed === target && Date.now() < deadlineAt
  );
  const confirmed = jest.fn();
  let current = true;
  const cleanup = new SessionOperationCleanup(
    session,
    processes,
    verify,
    confirmed,
    observed => current && observed === target
  );
  return {
    cleanup,
    target,
    stop,
    verify,
    confirmed,
    replaceRuntime: () => {
      current = false;
    },
    run: (deadlineAt = Date.now() + 150) =>
      cleanup.cleanup({
        deadlineAt,
        target,
        completionEvidence: 'unconfirmed',
        cancel: () => {},
      }),
  };
}

describe('native cancellation proof', () => {
  it('accepts native empty-map idle only with exact process proof after acknowledged abort', async () => {
    const abort = jest.fn(async () => true);
    const f = fixture({ abortSession: abort });
    const deadline = Date.now() + 1_000;
    expect(await f.run(deadline)).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(f.stop).toHaveBeenCalledWith(deadline);
    expect(f.verify).toHaveBeenCalledWith(f.target, deadline);
    expect(f.cleanup.cleanupState).toBe('confirmed');
    expect(f.confirmed).toHaveBeenCalledTimes(1);
    expect(await f.run(deadline + 10_000)).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('does not require an unrelated known busy root to become idle', async () => {
    rememberAttachedRoot('root_b', session.directory);
    const f = fixture({ getSessionStatuses: async () => ({ root_b: { type: 'busy' } }) });
    expect(await f.run()).toBe(true);
  });

  it.each(['busy', 'retry', 'offline'])(
    'waits for relevant %s status to become native idle',
    async type => {
      let reads = 0;
      const f = fixture({
        getSessionStatuses: async () => {
          reads++;
          if (reads === 1) {
            expect(f.verify).not.toHaveBeenCalled();
            return { [session.kiloSessionId]: { type } };
          }
          return {};
        },
      });
      expect(await f.run(Date.now() + 1_000)).toBe(true);
      expect(reads).toBe(2);
    }
  );

  it.each(['busy', 'retry', 'offline'])(
    'does not confirm persistent relevant %s status',
    async type => {
      const f = fixture({
        getSessionStatuses: async () => ({ [session.kiloSessionId]: { type } }),
      });
      expect(await f.run()).toBe(false);
      expect(f.verify).not.toHaveBeenCalled();
    }
  );

  it.each(['child', 'unknown'])('fails closed for an active %s with no idle proof', async id => {
    if (id === 'child') rememberChildSession({ childId: id, parentId: session.kiloSessionId });
    const f = fixture({ getSessionStatuses: async () => ({ [id]: { type: 'busy' } }) });
    expect(await f.run()).toBe(false);
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('fails closed for a descendant in an unobserved directory', async () => {
    rememberChildSession({
      childId: 'child',
      parentId: session.kiloSessionId,
      directory: '/other',
    });
    expect(await fixture().run()).toBe(false);
  });

  it.each(['operation', 'native'])(
    'requires %s owned-process proof despite native idle',
    async scope => {
      const f = fixture();
      if (scope === 'operation') f.stop.mockResolvedValue(false);
      else f.verify.mockResolvedValue(false);
      expect(await f.run()).toBe(false);
      expect(f.confirmed).not.toHaveBeenCalled();
    }
  );

  it.each(['failed', 'undefined'])(
    'does not turn a %s native status read into idle',
    async failure => {
      const f = fixture({
        getSessionStatuses: async () => {
          if (failure === 'failed') throw new Error('status unavailable');
          return undefined as unknown as Statuses;
        },
      });
      expect(await f.run()).toBe(false);
      expect(f.verify).not.toHaveBeenCalled();
    }
  );

  it.each(['missing', 'wrong_id', 'wrong_directory'])(
    'rejects %s native session existence proof',
    async failure => {
      const f = fixture({
        getSessionDetails: async () => {
          if (failure === 'missing') throw new Error('Session not found');
          return {
            id: failure === 'wrong_id' ? 'other' : session.kiloSessionId,
            directory: failure === 'wrong_directory' ? '/other' : session.directory,
          };
        },
      });
      expect(await f.run()).toBe(false);
      expect(f.verify).not.toHaveBeenCalled();
    }
  );

  it('waits for an owned descendant to disappear from the native active map', async () => {
    rememberChildSession({ childId: 'child', parentId: session.kiloSessionId });
    let reads = 0;
    const f = fixture({
      getSessionStatuses: async (): Promise<Statuses> =>
        ++reads === 1 ? { child: { type: 'busy' } } : {},
    });
    expect(await f.run()).toBe(true);
    expect(reads).toBe(2);
  });

  it('rejects runtime replacement while process proof is pending', async () => {
    const f = fixture();
    f.verify.mockImplementation(async () => {
      f.replaceRuntime();
      return true;
    });
    expect(await f.run()).toBe(false);
  });

  it('aborts a hung status read at the original deadline', async () => {
    let readSignal: AbortSignal | undefined;
    const f = fixture({
      getSessionStatuses: (_directory, signal) => {
        readSignal = signal;
        return new Promise(() => {});
      },
    });
    const deadline = Date.now() + 100;
    expect(await f.run(deadline)).toBe(false);
    expect(readSignal?.aborted).toBe(true);
    expect(f.cleanup.cleanupDeadline).toBe(deadline);
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('does not give status observation a new budget after a delayed abort', async () => {
    const abort = Promise.withResolvers<boolean>();
    let reads = 0;
    const f = fixture({
      abortSession: () => abort.promise,
      getSessionStatuses: async () => {
        reads++;
        return { [session.kiloSessionId]: { type: 'busy' } };
      },
    });
    const deadline = Date.now() + 150;
    const pending = f.run(deadline);
    await new Promise(resolve => setTimeout(resolve, 100));
    abort.resolve(true);
    expect(await pending).toBe(false);
    expect(reads).toBeGreaterThan(0);
    expect(Date.now()).toBeLessThan(deadline + 75);
    expect(f.cleanup.cleanupDeadline).toBe(deadline);
  });

  it('rejects stale runtime identity before abort', async () => {
    const abort = jest.fn(async () => true);
    const f = fixture({ abortSession: abort });
    f.replaceRuntime();
    expect(await f.run()).toBe(false);
    expect(abort).not.toHaveBeenCalled();
  });

  it('rejects runtime replacement during status observation', async () => {
    const f = fixture({
      getSessionStatuses: async () => {
        f.replaceRuntime();
        return {};
      },
    });
    expect(await f.run()).toBe(false);
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('rejects attachment replacement during status observation', async () => {
    const f = fixture({
      getSessionStatuses: async () => {
        forgetAttachedRoot(session.kiloSessionId);
        rememberAttachedRoot(session.kiloSessionId, session.directory);
        return {};
      },
    });
    expect(await f.run()).toBe(false);
  });

  it('does not infer existence from an empty map for an unknown session', async () => {
    forgetAttachedRoot(session.kiloSessionId);
    expect(await fixture().run()).toBe(false);
  });

  it('retains the original cleanup deadline and abort acknowledgement while polling', async () => {
    const abort = jest.fn(async () => true);
    const f = fixture({
      abortSession: abort,
      getSessionStatuses: async () => ({ [session.kiloSessionId]: { type: 'busy' } }),
    });
    const deadline = Date.now() + 150;
    const first = f.run(deadline);
    expect(await f.run(deadline + 10_000)).toBe(false);
    expect(await first).toBe(false);
    expect(f.cleanup.cleanupDeadline).toBe(deadline);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(f.cleanup.cleanupState).toBe('unconfirmed');
    expect(await f.run(deadline + 20_000)).toBe(false);
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
