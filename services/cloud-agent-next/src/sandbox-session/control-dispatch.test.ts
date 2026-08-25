import { describe, expect, it } from 'vitest';
import { controlDispatchDisposition } from './control-dispatch.js';

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
});
