import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxTerminalRecord } from '../sandbox-session/terminal-bridge.js';
import { createTerminalRevocations } from './revocations.js';

const record: SandboxTerminalRecord = {
  ptyId: 'pty_fixture',
  ownerId: 'user_fixture',
  sessionId: 'workspace_fixture',
  kiloSessionId: 'ses_fixture',
  directory: '/workspace/app',
  sandboxId: 'sbx_fixture',
  wrapperId: 'wrapper_fixture',
  state: 'running',
};

function fixture() {
  const values = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    delete: async (key: string) => values.delete(key),
    list: async ({ prefix }: { prefix: string }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
  };
  const request = vi.fn(async () => true);
  const getWrapperId = vi.fn(async (): Promise<string | undefined> => record.wrapperId);
  const reportUnconfirmed = vi.fn();
  const create = () =>
    createTerminalRevocations({
      storage: storage as unknown as DurableObjectStorage,
      closeTerminal: request,
      getWrapperId,
      reportUnconfirmed,
    });
  return { revocations: create(), create, request, getWrapperId, reportUnconfirmed };
}

describe('durable terminal revocation cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('removes the obligation only after confirmed PTY closure', async () => {
    const { revocations, request } = fixture();
    await revocations.enqueue(record);
    await revocations.drain();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        ptyId: record.ptyId,
        session: {
          sessionId: record.sessionId,
          kiloSessionId: record.kiloSessionId,
          directory: record.directory,
        },
      })
    );
    expect(await revocations.hasUnconfirmed()).toBe(false);
    expect(await revocations.nextAttemptAt()).toBeNull();
  });

  it('retries a failed closure after eviction without resetting the attempt budget', async () => {
    const { revocations, create, request } = fixture();
    request.mockRejectedValueOnce(new Error('transport unavailable'));
    await revocations.enqueue(record);
    await revocations.drain();
    expect(await revocations.hasUnconfirmed()).toBe(true);
    expect(await revocations.nextAttemptAt()).toBe(1_005_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await create().drain();
    expect(await revocations.hasUnconfirmed()).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('bounds failed attempts and retains the unconfirmed outcome', async () => {
    const { revocations, create, request, reportUnconfirmed } = fixture();
    request.mockResolvedValue(false);
    await revocations.enqueue(record);
    for (let attempt = 0; attempt < 5; attempt++) {
      await create().enqueue(record);
      await create().drain();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(request).toHaveBeenCalledTimes(3);
    expect(reportUnconfirmed).toHaveBeenCalledOnce();
    expect(await revocations.hasUnconfirmed()).toBe(true);
    expect(await revocations.nextAttemptAt()).toBeNull();
  });

  it('never closes a reused PTY id on a replacement wrapper', async () => {
    const { revocations, getWrapperId, request } = fixture();
    await revocations.enqueue(record);
    getWrapperId.mockResolvedValue('replacement_wrapper');
    await revocations.drain();
    expect(request).not.toHaveBeenCalled();
    expect(await revocations.hasUnconfirmed()).toBe(false);
  });

  it('does not treat a missing wrapper connection as proof of termination', async () => {
    const { revocations, getWrapperId, request } = fixture();
    await revocations.enqueue(record);
    getWrapperId.mockResolvedValue(undefined);
    await revocations.drain();
    expect(request).not.toHaveBeenCalled();
    expect(await revocations.hasUnconfirmed()).toBe(true);
    expect(await revocations.nextAttemptAt()).toBeNull();
  });

  it('resumes after wrapper outages without consuming the close-attempt budget', async () => {
    const { revocations, create, getWrapperId, request, reportUnconfirmed } = fixture();
    await revocations.enqueue(record);
    getWrapperId.mockResolvedValue(undefined);
    for (let probe = 0; probe < 5; probe++) {
      await create().drain();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(request).not.toHaveBeenCalled();
    expect(reportUnconfirmed).not.toHaveBeenCalled();
    expect(await revocations.hasUnconfirmed()).toBe(true);
    expect(await revocations.nextAttemptAt()).toBeNull();

    getWrapperId.mockResolvedValue(record.wrapperId);
    request.mockResolvedValue(false);
    for (let attempt = 0; attempt < 4; attempt++) {
      await create().drain();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(request).toHaveBeenCalledTimes(3);
    expect(reportUnconfirmed).toHaveBeenCalledOnce();
    expect(await revocations.nextAttemptAt()).toBeNull();
  });

  it('recovers a paused obligation when the same wrapper returns', async () => {
    const { revocations, create, getWrapperId, request } = fixture();
    await revocations.enqueue(record);
    getWrapperId.mockResolvedValue(undefined);
    await revocations.drain();
    getWrapperId.mockResolvedValue(record.wrapperId);
    await create().drain();
    expect(request).toHaveBeenCalledOnce();
    expect(await revocations.hasUnconfirmed()).toBe(false);
  });

  it('retains a stalled close as unconfirmed and permits a bounded retry', async () => {
    const { revocations, request } = fixture();
    request.mockImplementationOnce(() => new Promise(() => {}));
    await revocations.enqueue(record);
    const draining = revocations.drain();
    await vi.advanceTimersByTimeAsync(5_000);
    await draining;
    expect(await revocations.hasUnconfirmed()).toBe(true);
    await revocations.drain();
    expect(await revocations.hasUnconfirmed()).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
