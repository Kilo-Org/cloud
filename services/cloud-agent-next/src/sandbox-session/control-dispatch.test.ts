import { describe, expect, it } from 'vitest';
import { controlDispatchDisposition, observeControlAfterStopping } from './control-dispatch.js';

describe('controlDispatchDisposition', () => {
  it('fails a queued turn when the physical sandbox is failed', () => {
    expect(controlDispatchDisposition({ connection: 'disconnected', physical: 'failed' })).toBe(
      'fail'
    );
    expect(controlDispatchDisposition({ connection: 'ready', physical: 'failed' })).toBe('fail');
  });

  it('fails when the provider record is unknown or stopped', () => {
    expect(controlDispatchDisposition({ connection: 'disconnected', physical: 'unknown' })).toBe(
      'fail'
    );
    expect(controlDispatchDisposition({ connection: 'disconnected', physical: 'stopped' })).toBe(
      'fail'
    );
  });

  it('sends only when the control connection is ready and the sandbox is not failed', () => {
    expect(controlDispatchDisposition({ connection: 'ready', physical: 'running' })).toBe('send');
  });

  it('waits while the same instance is still coming up', () => {
    expect(controlDispatchDisposition({ connection: 'disconnected', physical: 'running' })).toBe(
      'wait'
    );
    expect(controlDispatchDisposition({ connection: 'connected', physical: 'creating' })).toBe(
      'wait'
    );
  });

  it('never sends to a stopping sandbox even when its connection is still ready', () => {
    expect(controlDispatchDisposition({ connection: 'ready', physical: 'stopping' })).toBe('wait');
    expect(controlDispatchDisposition({ connection: 'disconnected', physical: 'stopping' })).toBe(
      'wait'
    );
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
