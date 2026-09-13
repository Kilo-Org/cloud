import { CancelledError } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isAlreadyReportedNetworkError, reportAppError } from '@/lib/telemetry/app-error-reporting';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';

let events: TelemetryEvent[] = [];

beforeEach(() => {
  events = [];
  setTelemetrySink(event => {
    events.push(event);
  });
});

afterEach(() => {
  setTelemetrySink(null);
});

describe('isAlreadyReportedNetworkError', () => {
  it('skips a tRPC client error by name', () => {
    const error = new Error('client');
    error.name = 'TRPCClientError';
    expect(isAlreadyReportedNetworkError(error)).toBe(true);
  });

  it.each([
    { data: { code: 'INTERNAL_SERVER_ERROR' } },
    { shape: { data: { code: 'FORBIDDEN' } } },
    { code: 'NOT_FOUND' },
  ])('skips a tRPC-shaped error %j', metadata => {
    expect(isAlreadyReportedNetworkError(Object.assign(new Error('trpc'), metadata))).toBe(true);
  });

  it('skips a react-query CancelledError', () => {
    expect(isAlreadyReportedNetworkError(new CancelledError())).toBe(true);
  });

  it('skips a RequestDeadlineError', () => {
    const error = new Error('deadline');
    error.name = 'RequestDeadlineError';
    expect(isAlreadyReportedNetworkError(error)).toBe(true);
  });

  it('does not skip a plain Error', () => {
    expect(isAlreadyReportedNetworkError(new Error('plain'))).toBe(false);
  });

  it('does not skip a non-Error throw and never throws on null', () => {
    expect(isAlreadyReportedNetworkError('plain string')).toBe(false);
    expect(isAlreadyReportedNetworkError(null)).toBe(false);
    expect(isAlreadyReportedNetworkError(undefined)).toBe(false);
  });
});

describe('reportAppError', () => {
  it('reports a plain Error at error level with tags and a stable fingerprint', () => {
    const error = new Error('boom');
    const queryKey: unknown[] = [['session', 'list'], { type: 'query' }];

    reportAppError(error, { source: 'query', queryKey });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'error',
      error,
      tags: { 'error.subsystem': 'app', 'error.source': 'query' },
      fingerprint: ['app-error', 'query', 'Error', 'boom'],
    });
    expect(events[0]?.extra).toEqual({ queryKey: JSON.stringify(queryKey) });
  });

  it('reports a non-Error throw', () => {
    reportAppError('string failure', { source: 'mutation' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'error',
      error: 'string failure',
      tags: { 'error.subsystem': 'app', 'error.source': 'mutation' },
      fingerprint: ['app-error', 'mutation', 'unknown', 'string failure'],
    });
  });

  it('does not report an already-reported tRPC-shaped error', () => {
    reportAppError(Object.assign(new Error('trpc'), { data: { code: 'FORBIDDEN' } }), {
      source: 'query',
    });
    expect(events).toEqual([]);
  });

  it('does not report a CancelledError', () => {
    reportAppError(new CancelledError(), { source: 'query' });
    expect(events).toEqual([]);
  });

  it('never throws on a circular or hostile query key and still reports', () => {
    const circular: unknown[] = [];
    circular.push(circular);
    const hostile = {
      get boom(): never {
        throw new Error('hostile getter');
      },
    };

    expect(() => {
      reportAppError(new Error('x'), { source: 'query', queryKey: circular });
    }).not.toThrow();
    expect(() => {
      reportAppError(new Error('y'), { source: 'query', queryKey: hostile });
    }).not.toThrow();

    expect(events).toHaveLength(2);
    expect(typeof events[0]?.extra?.queryKey).toBe('string');
    expect(typeof events[1]?.extra?.queryKey).toBe('string');
  });
});
