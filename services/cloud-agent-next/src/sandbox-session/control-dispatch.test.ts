import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  type ResponseFrame,
} from '../shared/sandbox-control-protocol.js';
import {
  controlDispatchDisposition,
  controlRequestResult,
  isRetryableDeliveryError,
  observeControlAfterStopping,
  SESSION_DELIVERY_TIMEOUT_MS,
  withDeliveryDeadline,
} from './control-dispatch.js';

describe('controlDispatchDisposition', () => {
  it.each([
    ['failed', 'disconnected', { action: 'fail', reason: 'environment_failed' }],
    ['failed', 'ready', { action: 'fail', reason: 'environment_failed' }],
    ['unknown', 'disconnected', { action: 'fail', reason: 'provider_unknown' }],
    ['stopped', 'disconnected', { action: 'fail', reason: 'environment_failed' }],
    ['running', 'ready', { action: 'send' }],
    ['running', 'disconnected', { action: 'wait' }],
    ['creating', 'connected', { action: 'wait' }],
    ['stopping', 'ready', { action: 'wait' }],
    ['stopping', 'disconnected', { action: 'wait' }],
  ] as const)('classifies %s/%s with its failure reason', (physical, connection, expected) => {
    expect(controlDispatchDisposition({ physical, connection })).toEqual(expected);
  });
});

describe('controlRequestResult', () => {
  it.each([undefined, { retryable: true }, { code: '', message: 'Invalid', retryable: true }])(
    'does not turn a malformed rejection %j into a retryable failure',
    error => {
      const response = {
        type: 'response',
        requestId: 'request',
        ok: false,
        error,
      } as ResponseFrame;
      let failure: unknown;
      try {
        controlRequestResult(response);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(isRetryableDeliveryError(failure)).toBe(false);
    }
  );
});

describe('withDeliveryDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not start an operation after the head deadline', async () => {
    const operation = vi.fn(async () => 'delivered');
    await expect(withDeliveryDeadline(operation, Date.now())).rejects.toThrow(
      'Session delivery deadline exceeded'
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it('clamps the attach allowance to the remaining head budget', async () => {
    const result = withDeliveryDeadline(
      () => new Promise<void>(() => undefined),
      Date.now() + 1_000,
      SANDBOX_CONTROL_ATTACH_TIMEOUT_MS
    );
    const failure = expect(result).rejects.toThrow('Session delivery operation timed out');
    await vi.advanceTimersByTimeAsync(1_000);
    await failure;
  });

  it.each([SANDBOX_CONTROL_REQUEST_TIMEOUT_MS, SANDBOX_CONTROL_ATTACH_TIMEOUT_MS])(
    'does not retry a peer timeout at the %i ms operation cutoff',
    async timeoutMs => {
      const peerError = Object.assign(new Error('Peer request timed out'), {
        retryable: true,
        overloaded: false,
      });
      const failure = withDeliveryDeadline(
        () =>
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(peerError), timeoutMs)),
        Date.now() + SESSION_DELIVERY_TIMEOUT_MS,
        timeoutMs
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(timeoutMs);
      expect(await failure).toMatchObject({ message: 'Session delivery operation timed out' });
      expect(isRetryableDeliveryError(await failure)).toBe(false);
    }
  );

  it('preserves an explicit transient failure before the operation cutoff', async () => {
    const failure = Object.assign(new Error('Transient control failure'), {
      retryable: true,
      overloaded: false,
    });
    await expect(
      withDeliveryDeadline(() => Promise.reject(failure), Date.now() + SESSION_DELIVERY_TIMEOUT_MS)
    ).rejects.toBe(failure);
  });
});

describe('observeControlAfterStopping', () => {
  it('polls until the stopping sandbox becomes stopped', async () => {
    let now = 0;
    let observations = 0;

    const status = await observeControlAfterStopping(
      { connection: 'ready', physical: 'stopping' },
      async () => {
        observations += 1;
        return {
          connection: 'disconnected',
          physical: observations === 1 ? 'stopping' : 'stopped',
        };
      },
      {
        retryMs: 5_000,
        deadline: 120_000,
        now: () => now,
        sleep: async milliseconds => {
          now += milliseconds;
        },
      }
    );

    expect(status).toEqual({ connection: 'disconnected', physical: 'stopped' });
    expect(observations).toBe(2);
    expect(now).toBe(10_000);
  });

  it('stops observing when the bounded startup deadline expires', async () => {
    let now = 0;
    let observations = 0;

    const status = await observeControlAfterStopping(
      { connection: 'ready', physical: 'stopping' },
      async () => {
        observations += 1;
        return { connection: 'ready', physical: 'stopping' };
      },
      {
        retryMs: 5_000,
        deadline: 12_000,
        now: () => now,
        sleep: async milliseconds => {
          now += milliseconds;
        },
      }
    );

    expect(status).toBeUndefined();
    expect(observations).toBe(3);
    expect(now).toBe(12_000);
  });
});
