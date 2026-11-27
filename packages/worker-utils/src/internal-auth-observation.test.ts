import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  INTERNAL_AUTH_OBSERVATION_EVENT,
  INTERNAL_AUTH_OBSERVATION_FLAG,
  INTERNAL_CALLERS,
  callerLabel,
  isInternalAuthObservationEnabled,
  observeInternalAuth,
  resetInternalAuthObservation,
} from './internal-auth-observation';

const START = new Date('2026-11-27T12:00:05.000Z');
const START_MINUTE = Math.floor(START.getTime() / 60_000) * 60;

let log: MockInstance<typeof console.log>;

function lines(): Record<string, unknown>[] {
  return log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

function totalCount(): number {
  return lines().reduce((sum, line) => sum + Number(line.count), 0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  resetInternalAuthObservation();
  delete process.env[INTERNAL_AUTH_OBSERVATION_FLAG];
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
  vi.useRealTimers();
  resetInternalAuthObservation();
  delete process.env[INTERNAL_AUTH_OBSERVATION_FLAG];
});

describe('internal auth observation', () => {
  it('writes one immediate line with fixed labels for the first accepted request', () => {
    observeInternalAuth('web', 'usage_record', 'legacy_shared_secret', 'usage-ingest');

    expect(lines()).toEqual([
      {
        event: INTERNAL_AUTH_OBSERVATION_EVENT,
        v: 1,
        receiver: 'web',
        route: 'usage_record',
        auth: 'legacy_shared_secret',
        caller: 'usage-ingest',
        count: 1,
        minute: START_MINUTE,
      },
    ]);
  });

  it('aggregates the rest of the minute into one line when the minute turns', () => {
    for (let i = 0; i < 5; i++) observeInternalAuth('web', 'usage_record', 'legacy_shared_secret');
    expect(lines()).toHaveLength(1);

    vi.setSystemTime(new Date(START.getTime() + 60_000));
    observeInternalAuth('web', 'usage_record', 'legacy_shared_secret');

    expect(lines().map(line => [line.minute, line.count])).toEqual([
      [START_MINUTE, 1],
      [START_MINUTE, 4],
      [START_MINUTE + 60, 1],
    ]);
    expect(totalCount()).toBe(6);
  });

  it('keeps receivers, routes, methods and callers in separate buckets', () => {
    observeInternalAuth('o11y', 'api_metrics_write', 'legacy_shared_secret', 'ai-gateway');
    observeInternalAuth('o11y', 'api_metrics_write', 'sts', 'ai-gateway');
    observeInternalAuth('o11y', 'alerting_read', 'sts', 'web');
    observeInternalAuth('o11y', 'api_metrics_write', 'legacy_shared_secret', 'unknown');

    expect(lines().map(line => [line.receiver, line.route, line.auth, line.caller])).toEqual([
      ['o11y', 'api_metrics_write', 'legacy_shared_secret', 'ai-gateway'],
      ['o11y', 'api_metrics_write', 'sts', 'ai-gateway'],
      ['o11y', 'alerting_read', 'sts', 'web'],
      ['o11y', 'api_metrics_write', 'legacy_shared_secret', 'unknown'],
    ]);
  });

  it('defaults the caller to unknown', () => {
    observeInternalAuth('web', 'usage_record', 'legacy_shared_secret');
    expect(lines()[0].caller).toBe('unknown');
  });

  it('is on by default and off only for exactly false', () => {
    expect(isInternalAuthObservationEnabled()).toBe(true);

    process.env[INTERNAL_AUTH_OBSERVATION_FLAG] = 'false';
    expect(isInternalAuthObservationEnabled()).toBe(false);
    observeInternalAuth('web', 'usage_record', 'legacy_shared_secret');
    expect(lines()).toHaveLength(0);

    for (const value of ['', 'true', '0', 'no', 'FALSE', ' false']) {
      process.env[INTERNAL_AUTH_OBSERVATION_FLAG] = value;
      expect(isInternalAuthObservationEnabled()).toBe(true);
    }
  });

  it('splits a bucket at the memory cap without losing a count', () => {
    for (let route = 0; route < 513; route++) {
      observeInternalAuth('web', `route_${route}`, 'legacy_shared_secret');
    }
    expect(totalCount()).toBe(513);
    expect(lines()).toHaveLength(513);
  });

  it('never throws, even when the log itself throws', () => {
    log.mockImplementation(() => {
      throw new Error('log sink down');
    });

    expect(() => observeInternalAuth('web', 'usage_record', 'sts')).not.toThrow();
  });

  it('drops a line rather than the request when serialization fails', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      // The receiver is a plain string at every call site; this proves the guard, not a real input.
      observeInternalAuth(circular as unknown as string, 'usage_record', 'sts')
    ).not.toThrow();
  });
});

describe('callerLabel', () => {
  it('keeps only an allowlisted workload name', () => {
    for (const name of INTERNAL_CALLERS) expect(callerLabel(name)).toBe(name);
    expect(callerLabel('usage-ingest')).toBe('usage-ingest');
  });

  it('labels anything else unknown', () => {
    for (const value of [undefined, null, '', 'USAGE-INGEST', ' usage-ingest', 'anyone', 'web\n']) {
      expect(callerLabel(value)).toBe('unknown');
    }
  });
});
