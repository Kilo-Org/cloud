import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildGlanceableSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

const logoutMock = vi.hoisted(() => ({
  attemptLogoutReconciliation: vi.fn(),
  awaitLogoutReconciliationSettled: vi.fn(),
}));

const trpcMock = vi.hoisted(() => ({
  registerActivityToken: { mutate: vi.fn() },
}));

const activityMock = vi.hoisted(() => ({
  getPushToken: vi.fn(),
}));

/* eslint-disable import/first */
vi.mock('@/lib/auth/logout-reconciliation', () => logoutMock);
vi.mock('@/lib/trpc', () => ({
  trpcClient: { user: { registerActivityToken: trpcMock.registerActivityToken } },
}));
vi.mock('expo-widgets', () => ({
  addPushToStartTokenListener: vi.fn(),
}));
vi.mock('@/glanceable-ios/active-agents-live-activity', () => ({
  ActiveAgentsLiveActivity: {
    getInstances: () => [activityMock],
  },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

import { getGlanceableDelivery } from './sink-registry';
// Import side effect: registers the real iOS delivery under the mocks above.
import './delivery-registration';
/* eslint-enable import/first */

const NOW = 1_750_000_000_000;

function snapshot() {
  return buildGlanceableSnapshot({
    sessions: [{ status: 'busy' }],
    userId: 'u1',
    organizationId: null,
    now: NOW,
    previousRevision: 0,
  });
}

describe('delivery registerTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activityMock.getPushToken.mockResolvedValue('token-1');
    trpcMock.registerActivityToken.mutate.mockResolvedValue({ success: true });
    logoutMock.attemptLogoutReconciliation.mockResolvedValue({ kind: 'no-tombstone' });
    logoutMock.awaitLogoutReconciliationSettled.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not register the activity token while logout reconciliation for this sign-in is still running', async () => {
    const gate = { release: null as (() => void) | null };
    const settledGate = new Promise<void>(resolve => {
      gate.release = resolve;
    });
    logoutMock.attemptLogoutReconciliation.mockReturnValue({ kind: 'in-flight' });
    logoutMock.awaitLogoutReconciliationSettled.mockImplementation(async () => {
      await settledGate;
    });

    getGlanceableDelivery().registerTokens(snapshot(), null, 'u1');

    // Flush microtasks and a macrotask: logout reconciliation is still in
    // flight, so the activity token must not have registered.
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });

    expect(logoutMock.attemptLogoutReconciliation).toHaveBeenCalledWith('u1');
    expect(trpcMock.registerActivityToken.mutate).not.toHaveBeenCalled();

    gate.release?.();
    await vi.waitFor(() => {
      expect(trpcMock.registerActivityToken.mutate).toHaveBeenCalledWith({
        token: 'token-1',
        kind: 'ios_activity',
        platform: 'ios',
        organizationId: null,
      });
    });
  });
});
