import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  type ResponseFrame,
} from '../shared/sandbox-control-protocol.js';
import {
  ControlRequestError,
  controlDispatchDisposition,
  controlRequestResult,
  deliveryErrorLogFields,
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
  it('preserves validated application rejections separately from transport exceptions', () => {
    const error = {
      code: 'session_busy',
      message: 'Session has work in progress',
      retryable: true,
    };
    const response: ResponseFrame = { type: 'response', requestId: 'request', ok: false, error };
    let failure: unknown;
    try {
      controlRequestResult(response);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ControlRequestError);
    expect(failure).toMatchObject(error);
    expect(isRetryableDeliveryError(failure)).toBe(true);
    expect(Object.assign(new Error(error.message), error)).not.toBeInstanceOf(ControlRequestError);
  });

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

describe('deliveryErrorLogFields', () => {
  it.each(['session_busy', 'not_ready', 'runtime_unhealthy'])(
    'logs only the allowlisted %s code and retry classification',
    code => {
      const error = Object.assign(
        new ControlRequestError({ code, message: 'sensitive-message', retryable: true }),
        {
          cause: 'sensitive-cause',
          stack: 'sensitive-stack',
          auth: 'sensitive-auth',
          env: 'sensitive-env',
        }
      );
      expect(deliveryErrorLogFields(error)).toEqual({ errorCode: code, retryable: true });
    }
  );

  it('does not log an arbitrary response code', () => {
    expect(
      deliveryErrorLogFields(
        new ControlRequestError({
          code: 'sensitive-untrusted-code',
          message: 'sensitive-message',
          retryable: false,
        })
      )
    ).toEqual({ errorCode: 'unknown_control_error', retryable: false });
  });

  it.each([false, true])(
    'classifies transport exceptions without copying fields when overloaded=%s',
    overloaded => {
      const error = Object.assign(new Error('sensitive-message'), {
        code: 'session_busy',
        retryable: true,
        overloaded,
        stack: 'sensitive-stack',
        cause: 'sensitive-cause',
      });
      expect(deliveryErrorLogFields(error)).toEqual({
        errorCode: 'transport_or_internal_error',
        retryable: !overloaded,
      });
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

  it('preserves a confirmed rejection that arrives at the head deadline', async () => {
    const rejection = new ControlRequestError({
      code: 'session_busy',
      message: 'Session has work in progress',
      retryable: true,
    });
    const failure = withDeliveryDeadline(
      () => new Promise<never>((_resolve, reject) => setTimeout(() => reject(rejection), 1_000)),
      Date.now() + 1_000
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await failure).toBe(rejection);
  });

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
