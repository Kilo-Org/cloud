import { describe, expect, it } from 'vitest';

import {
  classifyDeviceSessionsState,
  type DeviceSession,
  deviceSessionLabel,
  sortDeviceSessions,
} from '@/lib/device-sessions';

function makeSession(overrides: Partial<DeviceSession> & { id: string }): DeviceSession {
  return {
    user_agent: 'Kilo-Code/1.2.3',
    created_at: '2026-04-29 01:16:12.945+00',
    last_seen_at: '2026-04-29 01:16:12.945+00',
    isCurrent: false,
    ...overrides,
  };
}

describe('deviceSessionLabel', () => {
  it('falls back to Unknown device for a missing or empty user agent', () => {
    expect(deviceSessionLabel(null)).toBe('Unknown device');
    expect(deviceSessionLabel(undefined)).toBe('Unknown device');
    expect(deviceSessionLabel('')).toBe('Unknown device');
    expect(deviceSessionLabel('   ')).toBe('Unknown device');
  });

  it('maps browser requests to Web browser', () => {
    expect(
      deviceSessionLabel(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
      )
    ).toBe('Web browser');
  });

  it('keeps the first product token for app and tool user agents', () => {
    expect(deviceSessionLabel('Kilo-Code/1.2.3 (darwin; arm64)')).toBe('Kilo-Code');
    expect(deviceSessionLabel('axios/1.7.0')).toBe('axios');
  });
});

describe('sortDeviceSessions', () => {
  it('puts the current device first and preserves the server order of the rest', () => {
    const oldest = makeSession({ id: 'a', last_seen_at: '2026-04-01 00:00:00.000+00' });
    const current = makeSession({ id: 'b', isCurrent: true });
    const newest = makeSession({ id: 'c', last_seen_at: '2026-05-01 00:00:00.000+00' });

    expect(sortDeviceSessions([oldest, current, newest]).map(s => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('does not reorder when there is no current row', () => {
    const first = makeSession({ id: 'a' });
    const second = makeSession({ id: 'b' });

    expect(sortDeviceSessions([first, second]).map(s => s.id)).toEqual(['a', 'b']);
  });

  it('returns a copy and leaves the input list untouched', () => {
    const first = makeSession({ id: 'a' });
    const current = makeSession({ id: 'b', isCurrent: true });
    const input = [first, current];

    const output = sortDeviceSessions(input);

    expect(output).not.toBe(input);
    expect(input.map(s => s.id)).toEqual(['a', 'b']);
  });
});

describe('classifyDeviceSessionsState', () => {
  const rows = [makeSession({ id: 'a' })];

  it.each([
    {
      name: 'loading ahead of stale data',
      args: { isLoading: true, isError: false, data: rows },
      expected: 'loading',
    },
    {
      name: 'a query error as retryable error',
      args: { isLoading: false, isError: true, data: undefined },
      expected: 'error',
    },
    {
      name: 'zero rows as empty',
      args: { isLoading: false, isError: false, data: [] },
      expected: 'empty',
    },
    {
      name: 'rows with a current row as happy',
      args: {
        isLoading: false,
        isError: false,
        data: [makeSession({ id: 'b', isCurrent: true }), ...rows],
      },
      expected: 'happy',
    },
    {
      name: 'rows without a current row as no-current, never empty',
      args: { isLoading: false, isError: false, data: rows },
      expected: 'no-current',
    },
  ])('classifies $name', ({ args, expected }) => {
    expect(classifyDeviceSessionsState(args)).toBe(expected);
  });
});
