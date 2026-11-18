import { describe, expect, it } from 'vitest';
import english from '@/i18n/locales/en.json';

import {
  classifyDeviceSessionsState,
  type DeviceSession,
  deviceSessionLabel,
  sortDeviceSessions,
} from '@/lib/device-sessions';

function makeSession(overrides: Partial<DeviceSession> & { id: string }): DeviceSession {
  return {
    kind: 'cli',
    platform: null,
    clientName: null,
    created_at: '2026-04-29 01:16:12.945+00',
    last_seen_at: '2026-04-29 01:16:12.945+00',
    isCurrent: false,
    ...overrides,
  };
}

describe('deviceSessionLabel', () => {
  it('names the platform of an Android app session', () => {
    expect(deviceSessionLabel({ kind: 'app', platform: 'android', clientName: null })).toBe(
      english.deviceSessions.kiloAppAndroid
    );
  });

  it('names the platform of an iOS app session', () => {
    expect(deviceSessionLabel({ kind: 'app', platform: 'ios', clientName: null })).toBe(
      english.deviceSessions.kiloAppIos
    );
  });

  it('keeps the app label defined for an app session without a platform', () => {
    expect(deviceSessionLabel({ kind: 'app', platform: null, clientName: null })).toBe(
      english.deviceSessions.kiloApp
    );
  });

  it('titles a CLI session with the CLI name', () => {
    expect(deviceSessionLabel({ kind: 'cli', platform: null, clientName: null })).toBe(
      english.deviceSessions.kiloCli
    );
  });

  it('maps a browser session to Web browser', () => {
    expect(deviceSessionLabel({ kind: 'browser', platform: null, clientName: null })).toBe(
      english.deviceSessions.webBrowser
    );
  });

  it('titles any other client by the product token the server extracted', () => {
    expect(deviceSessionLabel({ kind: 'other', platform: null, clientName: 'axios' })).toBe(
      'axios'
    );
  });

  it('falls back for a session with no classified client name', () => {
    expect(deviceSessionLabel({ kind: 'other', platform: null, clientName: null })).toBe(
      english.deviceSessions.unknownDevice
    );
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
      args: { isPending: true, isError: false, data: rows },
      expected: 'loading',
    },
    {
      // Cold open, first render: the observer has not started fetching yet so
      // React Query's `isLoading` would be false, but `isPending` is true.
      name: 'the first render before the request settles as loading, not empty',
      args: { isPending: true, isError: false, data: undefined },
      expected: 'loading',
    },
    {
      name: 'a query error as retryable error',
      args: { isPending: false, isError: true, data: undefined },
      expected: 'error',
    },
    {
      name: 'zero rows as empty',
      args: { isPending: false, isError: false, data: [] },
      expected: 'empty',
    },
    {
      name: 'rows with a current row as happy',
      args: {
        isPending: false,
        isError: false,
        data: [makeSession({ id: 'b', isCurrent: true }), ...rows],
      },
      expected: 'happy',
    },
    {
      name: 'rows without a current row as no-current, never empty',
      args: { isPending: false, isError: false, data: rows },
      expected: 'no-current',
    },
  ])('classifies $name', ({ args, expected }) => {
    expect(classifyDeviceSessionsState(args)).toBe(expected);
  });
});
