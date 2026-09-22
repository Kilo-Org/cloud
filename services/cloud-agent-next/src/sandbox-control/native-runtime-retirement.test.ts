import { describe, expect, it } from 'vitest';
import type { PhysicalRecord } from './physical-lifecycle.js';
import type { SessionRoute } from './session-routes.js';
import {
  createNativeRuntimeRetirement,
  holdsNativeRetirementFenceForSession,
  type NativeRuntimeRetirementConnection,
} from './native-runtime-retirement.js';

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const NATIVE_RUNTIME_ID = '22222222-2222-4222-8222-222222222222';
const WRAPPER_INSTANCE_ID = '33333333-3333-4333-8333-333333333333';
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';
const PROVIDER_REF = 'provider_ref_1';
const DIRECTORY = '/workspace/session';

const physical: PhysicalRecord = {
  state: 'running',
  providerRef: PROVIDER_REF,
  createIntent: null,
  stopTombstone: null,
  resumable: false,
};

const connection: NativeRuntimeRetirementConnection = {
  connectionId: CONNECTION_ID,
  providerInstanceId: PROVIDER_REF,
  wrapperInstanceId: WRAPPER_INSTANCE_ID,
};

const route: SessionRoute = {
  sessionId: SESSION_ID,
  kiloSessionId: 'kilo_root',
  directory: DIRECTORY,
  ownerId: 'user_1',
  lastState: null,
  lastStateAt: null,
  idleForMs: null,
  waitingOn: null,
  nativeRuntimeId: NATIVE_RUNTIME_ID,
};

function receipt(reason = 'maintenance') {
  const created = createNativeRuntimeRetirement(
    physical,
    connection,
    [route],
    reason,
    Date.now() + 60_000,
    Date.now() + 120_000
  );
  if (!created) throw new Error('Expected a native runtime retirement receipt');
  return created;
}

describe('holdsNativeRetirementFenceForSession', () => {
  it('holds the fence for a matching recipient, allocation, and connection lifetime', () => {
    expect(
      holdsNativeRetirementFenceForSession([receipt()], physical, connection, SESSION_ID)
    ).toBe(true);
  });

  it('does not hold the fence for a completed and delivered receipt', () => {
    const delivered = {
      ...receipt(),
      state: 'completed' as const,
      notificationState: 'delivered' as const,
    };
    expect(
      holdsNativeRetirementFenceForSession([delivered], physical, connection, SESSION_ID)
    ).toBe(false);
  });

  it('does not hold the fence for a different recipient session', () => {
    expect(
      holdsNativeRetirementFenceForSession(
        [receipt()],
        physical,
        connection,
        'workspace_99999999-9999-4999-8999-999999999999'
      )
    ).toBe(false);
  });

  it('does not hold the fence for a mismatched connection lifetime', () => {
    const otherLifetime: NativeRuntimeRetirementConnection = {
      connectionId: '55555555-5555-4555-8555-555555555555',
      providerInstanceId: PROVIDER_REF,
      wrapperInstanceId: '66666666-6666-4666-8666-666666666666',
    };
    expect(
      holdsNativeRetirementFenceForSession([receipt()], physical, otherLifetime, SESSION_ID)
    ).toBe(false);
  });
});
