import * as Sentry from '@sentry/react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const deliveryMock = vi.hoisted(() => ({ unregisterTokens: vi.fn() }));

vi.mock('@/lib/glanceable/sink-registry', () => ({
  getGlanceableDelivery: () => deliveryMock,
}));

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

/* eslint-disable import/first */
// vi.mock is hoisted by Vitest before the real import resolves.
import { unregisterActivityTokensBestEffort } from '@/lib/auth/logout-activity-unregister';
/* eslint-enable import/first */

/**
 * The logout activity-token step. A failure of any kind must leave the caller a
 * result it can record instead of throwing into the gather phase, and a locked
 * device is device state, not a defect to report.
 */
describe('unregisterActivityTokensBestEffort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deliveryMock.unregisterTokens.mockReset();
  });

  it('reports the unregister result unchanged on success', async () => {
    deliveryMock.unregisterTokens.mockResolvedValue({ ok: true, tokens: [] });

    await expect(unregisterActivityTokensBestEffort()).resolves.toEqual({ ok: true, tokens: [] });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('keeps the failed tokens a failed unregister reports', async () => {
    deliveryMock.unregisterTokens.mockResolvedValue({ ok: false, tokens: ['a1'] });

    await expect(unregisterActivityTokensBestEffort()).resolves.toEqual({
      ok: false,
      tokens: ['a1'],
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('turns a rejection into a failure with no known tokens and reports it', async () => {
    const error = new Error('network down');
    deliveryMock.unregisterTokens.mockRejectedValue(error);

    await expect(unregisterActivityTokensBestEffort()).resolves.toEqual({ ok: false, tokens: [] });
    expect(Sentry.captureException).toHaveBeenCalledWith(error, {
      tags: { 'error.subsystem': 'auth', 'error.operation': 'logout_activity_unregister' },
    });
  });

  it('answers a failure without a report when the device was locked', async () => {
    deliveryMock.unregisterTokens.mockRejectedValue(new Error('User interaction is not allowed.'));

    await expect(unregisterActivityTokensBestEffort()).resolves.toEqual({ ok: false, tokens: [] });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
