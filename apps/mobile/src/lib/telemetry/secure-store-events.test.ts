import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  setBreadcrumbSink,
  setTelemetrySink,
  type TelemetryBreadcrumb,
  type TelemetryEvent,
} from '@/lib/telemetry/error-sink';
import { ProtectedDataUnavailableError } from '@/lib/protected-data';
import {
  isKeychainInteractionRefused,
  reportSecureStoreFailure,
} from '@/lib/telemetry/secure-store-events';

let events: TelemetryEvent[] = [];
let breadcrumbs: TelemetryBreadcrumb[] = [];

beforeEach(() => {
  events = [];
  breadcrumbs = [];
  setTelemetrySink(event => {
    events.push(event);
  });
  setBreadcrumbSink(breadcrumb => {
    breadcrumbs.push(breadcrumb);
  });
});

afterEach(() => {
  setTelemetrySink(null);
  setBreadcrumbSink(null);
});

describe('isKeychainInteractionRefused', () => {
  it('recognizes the fixed message iOS builds for a locked keychain', () => {
    expect(
      isKeychainInteractionRefused(
        new Error(
          "Calling the 'getValueWithKeyAsync' function has failed → Caused by: Error: User interaction is not allowed."
        )
      )
    ).toBe(true);
  });

  it('does not treat another failure or a non-Error as a refusal', () => {
    expect(isKeychainInteractionRefused(new Error('disk error'))).toBe(false);
    expect(isKeychainInteractionRefused({ message: 'User interaction is not allowed' })).toBe(
      false
    );
    expect(isKeychainInteractionRefused(null)).toBe(false);
    expect(isKeychainInteractionRefused('User interaction is not allowed')).toBe(false);
  });
});

describe('reportSecureStoreFailure', () => {
  it('leaves one breadcrumb and no event for a locked keychain', () => {
    reportSecureStoreFailure('read', new Error('User interaction is not allowed'));

    expect(events).toHaveLength(0);
    expect(breadcrumbs).toEqual([
      {
        category: 'secure_store',
        level: 'warning',
        message: 'keychain refused a call while the device was locked',
        data: { operation: 'read' },
      },
    ]);
  });

  it('reports a real failure under the operation fingerprint', () => {
    reportSecureStoreFailure('write', new Error('secure store down'));

    expect(breadcrumbs).toHaveLength(0);
    expect(events.map(event => event.fingerprint)).toEqual([['secure-store-failure', 'write']]);
    expect(events[0]?.tags).toEqual({
      'error.subsystem': 'secure_store',
      'error.operation': 'write',
    });
  });

  it('records nothing when the app never called the keychain', () => {
    reportSecureStoreFailure('read', new ProtectedDataUnavailableError());

    expect(events).toHaveLength(0);
    expect(breadcrumbs).toHaveLength(0);
  });
});
