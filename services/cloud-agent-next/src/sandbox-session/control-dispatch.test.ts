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
  reconstructControlRequestError,
  SESSION_DELIVERY_TIMEOUT_MS,
  withDeliveryDeadline,
} from './control-dispatch.js';

describe('controlDispatchDisposition', () => {
  it.each([
    ['failed', 'disconnected', { action: 'wait' }],
    ['failed', 'ready', { action: 'wait' }],
    ['unknown', 'disconnected', { action: 'fail', reason: 'provider_unknown' }],
    ['stopped', 'disconnected', { action: 'wait' }],
    ['running', 'ready', { action: 'send' }],
    ['running', 'disconnected', { action: 'wait' }],
    ['creating', 'connected', { action: 'wait' }],
    ['stopping', 'ready', { action: 'wait' }],
    ['stopping', 'disconnected', { action: 'wait' }],
  ] as const)('classifies %s/%s with its failure reason', (physical, connection, expected) => {
    expect(controlDispatchDisposition({ physical, connection })).toEqual(expected);
  });

  it('keeps provider_unknown fail-closed and stopped/failed waiting', () => {
    expect(controlDispatchDisposition({ physical: 'unknown', connection: 'ready' })).toEqual({
      action: 'fail',
      reason: 'provider_unknown',
    });
    expect(controlDispatchDisposition({ physical: 'stopped', connection: 'ready' })).toEqual({
      action: 'wait',
    });
    expect(controlDispatchDisposition({ physical: 'failed', connection: 'ready' })).toEqual({
      action: 'wait',
    });
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
    expect(failure).toMatchObject({ ...error, rejectionReceived: true });
    expect(isRetryableDeliveryError(failure)).toBe(true);
    expect(Object.assign(new Error(error.message), error)).not.toBeInstanceOf(ControlRequestError);
    expect(new ControlRequestError(error).rejectionReceived).toBeUndefined();
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

describe('reconstructControlRequestError', () => {
  it('rebuilds a local ControlRequestError from serialized RPC fields only', () => {
    // Own fields only: no ControlRequestError prototype, no rejectionReceived.
    const wire = {
      name: 'ControlRequestError',
      code: 'not_ready',
      message: 'Sandbox runtime is not ready',
      retryable: true,
      admission: 'not-admitted' as const,
    };

    const reconstructed = reconstructControlRequestError(wire);

    expect(reconstructed).toBeInstanceOf(ControlRequestError);
    expect(reconstructed).toMatchObject({
      code: 'not_ready',
      message: 'Sandbox runtime is not ready',
      retryable: true,
      admission: 'not-admitted',
    });
    expect(reconstructed).not.toBe(wire);
    expect((reconstructed as ControlRequestError).rejectionReceived).toBeUndefined();
  });

  it('does not reconstruct a rejection whose fields are only inherited', () => {
    const inherited = Object.create({
      code: 'not_ready',
      message: 'Sandbox runtime is not ready',
      retryable: true,
      admission: 'not-admitted' as const,
    });

    expect(reconstructControlRequestError(inherited)).toBe(inherited);
  });

  it('does not copy a wire rejection flag from a serialized wrapper-style rejection', () => {
    const wire = Object.assign(new Error('Sandbox runtime is not ready'), {
      name: 'ControlRequestError',
      code: 'not_ready',
      retryable: true,
      admission: 'not-admitted',
      rejectionReceived: true,
    });

    const reconstructed = reconstructControlRequestError(wire) as ControlRequestError;

    expect(reconstructed).toBeInstanceOf(ControlRequestError);
    expect(reconstructed).toMatchObject({ code: 'not_ready', admission: 'not-admitted' });
    expect(reconstructed.rejectionReceived).toBeUndefined();
  });

  it('returns an already-local ControlRequestError unchanged', () => {
    const local = new ControlRequestError({ code: 'not_ready', message: 'x', retryable: true });
    expect(reconstructControlRequestError(local)).toBe(local);
  });

  it.each([new Error('boom'), { retryable: true }, undefined, null, 'not_ready'])(
    'passes a malformed rejection %j through unchanged',
    malformed => {
      expect(reconstructControlRequestError(malformed)).toBe(malformed);
    }
  );
});

describe('deliveryErrorLogFields', () => {
  it.each(['session_busy', 'not_ready', 'runtime_unhealthy'])(
    'logs the public message with the allowlisted %s code and retry classification',
    code => {
      const error = Object.assign(
        new ControlRequestError({ code, message: 'Public control error', retryable: true }),
        {
          cause: 'sensitive-cause',
          stack: 'sensitive-stack',
          auth: 'sensitive-auth',
          env: 'sensitive-env',
        }
      );
      expect(deliveryErrorLogFields(error)).toEqual({
        errorCode: code,
        errorMessage: 'Public control error',
        retryable: true,
      });
    }
  );

  it('does not log an arbitrary response code', () => {
    expect(
      deliveryErrorLogFields(
        new ControlRequestError({
          code: 'sensitive-untrusted-code',
          message: 'Public control error',
          retryable: false,
        })
      )
    ).toEqual({
      errorCode: 'unknown_control_error',
      errorMessage: 'Public control error',
      retryable: false,
    });
  });

  it('logs the detail for an unclassified transport or internal error', () => {
    expect(deliveryErrorLogFields(new Error('some transport detail'))).toEqual({
      errorCode: 'transport_or_internal_error',
      errorMessage: 'some transport detail',
      retryable: false,
    });
  });

  it('stringifies a non-Error thrown value for an unclassified error', () => {
    expect(deliveryErrorLogFields('boom')).toEqual({
      errorCode: 'transport_or_internal_error',
      errorMessage: 'boom',
      retryable: false,
    });
  });

  it('logs the message of a passed-through malformed rejection', () => {
    const malformed = { code: '', message: 'Invalid rejection', retryable: true };
    expect(deliveryErrorLogFields(malformed)).toEqual({
      errorCode: 'transport_or_internal_error',
      errorMessage: 'Invalid rejection',
      retryable: true,
    });
  });

  it('falls back for a non-Error object whose message is not a string', () => {
    const error = { message: { nested: true } };
    expect(deliveryErrorLogFields(error)).toEqual({
      errorCode: 'transport_or_internal_error',
      errorMessage: '[object Object]',
      retryable: false,
    });
  });

  it('refuses an inherited message for a non-Error value', () => {
    const error = Object.create({ message: 'inherited' });
    expect(deliveryErrorLogFields(error)).toEqual({
      errorCode: 'transport_or_internal_error',
      errorMessage: '[object Object]',
      retryable: false,
    });
  });

  it('falls back for a non-Error object whose message read throws', () => {
    const error = {
      get message(): string {
        throw new Error('message exploded');
      },
    };
    expect(() => deliveryErrorLogFields(error)).not.toThrow();
    expect(deliveryErrorLogFields(error)).toEqual({
      errorCode: 'transport_or_internal_error',
      errorMessage: '[unserializable error]',
      retryable: false,
    });
  });

  it('falls back for a null-prototype value that cannot be stringified', () => {
    expect(() => deliveryErrorLogFields(Object.create(null))).not.toThrow();
    expect(deliveryErrorLogFields(Object.create(null))).toEqual({
      errorCode: 'transport_or_internal_error',
      errorMessage: '[unserializable error]',
      retryable: false,
    });
  });

  it('falls back for a thrown value whose string conversion throws', () => {
    const error = {
      toString() {
        throw new Error('toString exploded');
      },
    };
    expect(() => deliveryErrorLogFields(error)).not.toThrow();
    expect(deliveryErrorLogFields(error)).toEqual({
      errorCode: 'transport_or_internal_error',
      errorMessage: '[unserializable error]',
      retryable: false,
    });
  });

  it.each([false, true])(
    'classifies a transport exception with its detail when overloaded=%s',
    overloaded => {
      const error = Object.assign(new Error('transport detail'), {
        code: 'session_busy',
        retryable: true,
        overloaded,
        stack: 'sensitive-stack',
        cause: 'sensitive-cause',
      });
      expect(deliveryErrorLogFields(error)).toEqual({
        errorCode: 'transport_or_internal_error',
        errorMessage: 'transport detail',
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
