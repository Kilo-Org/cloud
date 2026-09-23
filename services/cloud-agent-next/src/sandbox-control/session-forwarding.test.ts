import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  SANDBOX_CONTROL_FORWARD_OPERATION_LIMIT,
  SANDBOX_EVENT_BATCH_MAX_ITEMS,
} from '../shared/sandbox-control-protocol.js';
import {
  createSessionForwarding,
  SessionForwardingError,
  type SessionForwardRunMember,
  type SessionForwarding,
} from './session-forwarding.js';

type CoalesceItem = { id: string };

function enqueueFrame(
  forwarding: SessionForwarding,
  run: () => Promise<readonly undefined[]>
): Promise<undefined> {
  return forwarding.enqueue<undefined, undefined>({
    sessionId: 'workspace_1',
    identity: null,
    bytes: 1,
    items: 1,
    item: undefined,
    run,
  });
}

/** Holds the first run of `workspace_1` open so later work queues behind it. */
function holdFirstRun(forwarding: SessionForwarding): () => void {
  const release = Promise.withResolvers<void>();
  void enqueueFrame(forwarding, async () => {
    await release.promise;
    return [undefined];
  });
  return () => release.resolve();
}

function coalescedEntry(
  forwarding: SessionForwarding,
  input: {
    id: string;
    identity?: string | null;
    bytes?: number;
    items?: number;
    forward: (
      members: readonly SessionForwardRunMember<CoalesceItem>[]
    ) => Promise<readonly string[]>;
  }
): Promise<string> {
  return forwarding.enqueue<CoalesceItem, string>({
    sessionId: 'workspace_1',
    identity: input.identity === undefined ? 'compatible' : input.identity,
    bytes: input.bytes ?? 1,
    items: input.items ?? 1,
    item: { id: input.id },
    run: input.forward,
  });
}

describe('createSessionForwarding', () => {
  it('keeps later work behind an in-flight run for the same session', async () => {
    const forwarding = createSessionForwarding();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const first = enqueueFrame(forwarding, async () => {
      started.resolve();
      await release.promise;
      return [undefined];
    });
    const secondRun = vi.fn(async () => [undefined] as readonly undefined[]);
    const second = enqueueFrame(forwarding, secondRun);

    await started.promise;
    expect(secondRun).not.toHaveBeenCalled();

    release.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(secondRun).toHaveBeenCalledTimes(1);
  });

  it('continues a session after a failed forwarding attempt', async () => {
    const forwarding = createSessionForwarding();
    const failure = enqueueFrame(forwarding, async () => {
      throw new Error('forwarding failed');
    });
    const recovery = vi.fn(async () => [undefined] as readonly undefined[]);
    const next = enqueueFrame(forwarding, recovery);

    await expect(failure).rejects.toThrow('forwarding failed');
    await expect(next).resolves.toBeUndefined();
    expect(recovery).toHaveBeenCalledTimes(1);
  });

  it('admits up to the forward operation limit and rejects beyond it', async () => {
    const forwarding = createSessionForwarding();
    const release = Promise.withResolvers<void>();
    const admitted: Array<Promise<undefined>> = [];
    for (let index = 0; index < SANDBOX_CONTROL_FORWARD_OPERATION_LIMIT; index++) {
      admitted.push(
        enqueueFrame(forwarding, async () => {
          await release.promise;
          return [undefined];
        })
      );
    }
    const { waiting, inFlight } = forwarding.stats();
    expect(waiting + inFlight).toBe(SANDBOX_CONTROL_FORWARD_OPERATION_LIMIT);

    await expect(enqueueFrame(forwarding, async () => [undefined])).rejects.toMatchObject({
      retryable: true,
    });

    release.resolve();
    await Promise.allSettled(admitted);
    expect(forwarding.stats()).toMatchObject({ waiting: 0, inFlight: 0, bufferedBytes: 0 });
  });

  it('releases capacity after a failed run and admits later work', async () => {
    const forwarding = createSessionForwarding();
    await expect(
      enqueueFrame(forwarding, async () => {
        throw new SessionForwardingError('run failed', false);
      })
    ).rejects.toBeInstanceOf(SessionForwardingError);
    expect(forwarding.stats()).toMatchObject({ waiting: 0, inFlight: 0, bufferedBytes: 0 });

    await expect(enqueueFrame(forwarding, async () => [undefined])).resolves.toBeUndefined();
    expect(forwarding.stats()).toMatchObject({ waiting: 0, inFlight: 0, bufferedBytes: 0 });
  });

  it("rejects an oversized frame before forwarding with stage 'before_forward'", async () => {
    const forwarding = createSessionForwarding();
    const error = await forwarding
      .enqueue<undefined, undefined>({
        sessionId: 'workspace_1',
        identity: null,
        bytes: MAX_SANDBOX_CONTROL_FRAME_BYTES + 1,
        items: 1,
        item: undefined,
        run: async () => [undefined],
      })
      .catch(caught => caught);

    expect(error).toBeInstanceOf(SessionForwardingError);
    expect(error).toMatchObject({ retryable: false, stage: 'before_forward' });
  });

  it("rejects an oversized batch before forwarding with stage 'before_forward'", async () => {
    const forwarding = createSessionForwarding();
    const error = await forwarding
      .enqueue<undefined, undefined>({
        sessionId: 'workspace_1',
        identity: 'compatible',
        bytes: 1,
        items: SANDBOX_EVENT_BATCH_MAX_ITEMS + 1,
        item: undefined,
        run: async () => [undefined],
      })
      .catch(caught => caught);

    expect(error).toBeInstanceOf(SessionForwardingError);
    expect(error).toMatchObject({ retryable: false, stage: 'before_forward' });
  });

  it('exposes the active drain promise and removes the lane after drain', async () => {
    const forwarding = createSessionForwarding();
    const release = Promise.withResolvers<void>();
    const pending = enqueueFrame(forwarding, async () => {
      await release.promise;
      return [undefined];
    });

    const drained = forwarding.get('workspace_1');
    expect(drained).toBeInstanceOf(Promise);

    release.resolve();
    await pending;
    await drained;
    expect(forwarding.get('workspace_1')).toBeUndefined();
    expect(forwarding.stats()).toMatchObject({ waiting: 0, inFlight: 0, bufferedBytes: 0 });
  });
});

describe('createSessionForwarding coalescing', () => {
  it('merges consecutive compatible entries into one forward call', async () => {
    const forwarding = createSessionForwarding();
    const release = holdFirstRun(forwarding);
    const forward = vi.fn(async (members: readonly SessionForwardRunMember<CoalesceItem>[]) =>
      members.map(member => `done:${member.item.id}`)
    );
    const first = coalescedEntry(forwarding, { id: 'a', forward });
    const second = coalescedEntry(forwarding, { id: 'b', forward });

    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['done:a', 'done:b']);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward.mock.calls[0]?.[0].map(member => member.item.id)).toEqual(['a', 'b']);
    expect(forwarding.stats()).toMatchObject({ waiting: 0, inFlight: 0, bufferedBytes: 0 });
  });

  it('does not merge entries with a different identity and keeps arrival order', async () => {
    const forwarding = createSessionForwarding();
    const release = holdFirstRun(forwarding);
    const firstForward = vi.fn(async (members: readonly SessionForwardRunMember<CoalesceItem>[]) =>
      members.map(member => `one:${member.item.id}`)
    );
    const secondForward = vi.fn(async (members: readonly SessionForwardRunMember<CoalesceItem>[]) =>
      members.map(member => `two:${member.item.id}`)
    );
    const first = coalescedEntry(forwarding, { id: 'a', identity: 'one', forward: firstForward });
    const second = coalescedEntry(forwarding, { id: 'b', identity: 'two', forward: secondForward });

    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['one:a', 'two:b']);
    expect(firstForward).toHaveBeenCalledTimes(1);
    expect(firstForward.mock.calls[0]?.[0].map(member => member.item.id)).toEqual(['a']);
    expect(secondForward).toHaveBeenCalledTimes(1);
    expect(secondForward.mock.calls[0]?.[0].map(member => member.item.id)).toEqual(['b']);
  });

  it('does not merge across a barrier entry', async () => {
    const forwarding = createSessionForwarding();
    const release = holdFirstRun(forwarding);
    const forward = vi.fn(async (members: readonly SessionForwardRunMember<CoalesceItem>[]) =>
      members.map(member => `merged:${member.item.id}`)
    );
    const barrier = vi.fn(async () => ['barrier'] as readonly string[]);
    const first = coalescedEntry(forwarding, { id: 'a', forward });
    const middle = coalescedEntry(forwarding, { id: 'm', identity: null, forward: barrier });
    const last = coalescedEntry(forwarding, { id: 'b', forward });

    release();
    await expect(Promise.all([first, middle, last])).resolves.toEqual([
      'merged:a',
      'barrier',
      'merged:b',
    ]);
    expect(barrier).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledTimes(2);
    expect(forward.mock.calls[0]?.[0].map(member => member.item.id)).toEqual(['a']);
    expect(forward.mock.calls[1]?.[0].map(member => member.item.id)).toEqual(['b']);
  });

  it('forwards a head and a compatible later entry together with no age-based rejection', async () => {
    const forwarding = createSessionForwarding();
    const release = holdFirstRun(forwarding);
    const forward = vi.fn(async (members: readonly SessionForwardRunMember<CoalesceItem>[]) =>
      members.map(member => `done:${member.item.id}`)
    );
    const head = coalescedEntry(forwarding, { id: 'head', forward });
    const later = coalescedEntry(forwarding, { id: 'later', forward });

    release();
    await expect(Promise.all([head, later])).resolves.toEqual(['done:head', 'done:later']);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward.mock.calls[0]?.[0].map(member => member.item.id)).toEqual(['head', 'later']);
  });

  it('resolves each constituent with its own outcome', async () => {
    const forwarding = createSessionForwarding();
    const release = holdFirstRun(forwarding);
    const forward = vi.fn(async (members: readonly SessionForwardRunMember<CoalesceItem>[]) =>
      members.map(member => (member.item.id === 'a' ? 'applied' : 'rejected'))
    );
    const first = coalescedEntry(forwarding, { id: 'a', forward });
    const second = coalescedEntry(forwarding, { id: 'b', forward });

    release();
    await expect(first).resolves.toBe('applied');
    await expect(second).resolves.toBe('rejected');
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it('splits a run at the combined item limit', async () => {
    const forwarding = createSessionForwarding();
    const release = holdFirstRun(forwarding);
    const forward = vi.fn(async (members: readonly SessionForwardRunMember<CoalesceItem>[]) =>
      members.map(member => member.item.id)
    );
    const pending = ['a', 'b', 'c'].map(id =>
      coalescedEntry(forwarding, { id, items: 30, forward })
    );

    release();
    await expect(Promise.all(pending)).resolves.toEqual(['a', 'b', 'c']);
    expect(forward).toHaveBeenCalledTimes(2);
    expect(forward.mock.calls[0]?.[0].map(member => member.item.id)).toEqual(['a', 'b']);
    expect(forward.mock.calls[1]?.[0].map(member => member.item.id)).toEqual(['c']);
  });

  it('splits a run at the combined byte limit', async () => {
    const forwarding = createSessionForwarding();
    const release = holdFirstRun(forwarding);
    const forward = vi.fn(async (members: readonly SessionForwardRunMember<CoalesceItem>[]) =>
      members.map(member => member.item.id)
    );
    const bytes = MAX_SANDBOX_CONTROL_FRAME_BYTES / 2;
    const pending = ['a', 'b', 'c'].map(id => coalescedEntry(forwarding, { id, bytes, forward }));

    release();
    await expect(Promise.all(pending)).resolves.toEqual(['a', 'b', 'c']);
    expect(forward).toHaveBeenCalledTimes(2);
    expect(forward.mock.calls[0]?.[0].map(member => member.item.id)).toEqual(['a', 'b']);
    expect(forward.mock.calls[1]?.[0].map(member => member.item.id)).toEqual(['c']);
  });

  it('fails every member when the run callback throws synchronously and continues later work', async () => {
    const forwarding = createSessionForwarding();
    const release = holdFirstRun(forwarding);
    const forward = vi.fn((): Promise<readonly string[]> => {
      throw new SessionForwardingError('sync failure', false);
    });
    const first = coalescedEntry(forwarding, { id: 'a', forward });
    const second = coalescedEntry(forwarding, { id: 'b', forward });

    release();
    await expect(first).rejects.toMatchObject({ retryable: false });
    await expect(second).rejects.toMatchObject({ retryable: false });
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forwarding.stats()).toMatchObject({ waiting: 0, inFlight: 0, bufferedBytes: 0 });

    const later = coalescedEntry(forwarding, {
      id: 'c',
      forward: async members => members.map(member => `done:${member.item.id}`),
    });
    await expect(later).resolves.toBe('done:c');
    expect(forwarding.get('workspace_1')).toBeUndefined();
  });

  it('fails every member when the run callback rejects and continues later work', async () => {
    const forwarding = createSessionForwarding();
    const release = holdFirstRun(forwarding);
    const forward = vi.fn(async () => {
      throw new SessionForwardingError('async failure', false);
    });
    const first = coalescedEntry(forwarding, { id: 'a', forward });
    const second = coalescedEntry(forwarding, { id: 'b', forward });

    release();
    await expect(first).rejects.toMatchObject({ retryable: false });
    await expect(second).rejects.toMatchObject({ retryable: false });
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forwarding.stats()).toMatchObject({ waiting: 0, inFlight: 0, bufferedBytes: 0 });

    const later = coalescedEntry(forwarding, {
      id: 'c',
      forward: async members => members.map(member => `done:${member.item.id}`),
    });
    await expect(later).resolves.toBe('done:c');
    expect(forwarding.get('workspace_1')).toBeUndefined();
  });

  it('rejects every member when the run returns a misaligned result array', async () => {
    const forwarding = createSessionForwarding();
    const release = holdFirstRun(forwarding);
    const forward = vi.fn(async () => ['only-one'] as readonly string[]);
    const first = coalescedEntry(forwarding, { id: 'a', forward });
    const second = coalescedEntry(forwarding, { id: 'b', forward });

    release();
    await expect(first).rejects.toMatchObject({ retryable: false, stage: 'after_forward' });
    await expect(second).rejects.toMatchObject({ retryable: false, stage: 'after_forward' });
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forwarding.stats()).toMatchObject({ waiting: 0, inFlight: 0, bufferedBytes: 0 });

    const later = coalescedEntry(forwarding, {
      id: 'c',
      forward: async members => members.map(member => `done:${member.item.id}`),
    });
    await expect(later).resolves.toBe('done:c');
    expect(forwarding.get('workspace_1')).toBeUndefined();
  });
});
