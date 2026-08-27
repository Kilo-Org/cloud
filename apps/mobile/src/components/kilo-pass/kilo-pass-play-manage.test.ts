import { toast } from 'sonner-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openPlaySubscriptionManagement } from './kilo-pass-play-manage';

vi.mock('expo-iap', () => ({
  deepLinkToSubscriptions: vi.fn(),
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const { deepLinkToSubscriptions } = await import('expo-iap');

describe('openPlaySubscriptionManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deep-links to Play subscription management and invalidates after', async () => {
    const invalidateAfter = vi.fn().mockResolvedValue(undefined);
    vi.mocked(deepLinkToSubscriptions).mockResolvedValue(undefined);

    await openPlaySubscriptionManagement({
      skuAndroid: 'kilopass_tier19',
      invalidateAfter,
    });

    expect(deepLinkToSubscriptions).toHaveBeenCalledWith({
      skuAndroid: 'kilopass_tier19',
      packageNameAndroid: 'com.kilocode.kiloapp',
    });
    expect(invalidateAfter).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(invalidateAfter).toHaveBeenCalledTimes(2);
  });

  it('shows the Play management failure toast when the deeplink fails', async () => {
    vi.mocked(deepLinkToSubscriptions).mockRejectedValue(new Error('deeplink failed'));

    await openPlaySubscriptionManagement({
      skuAndroid: 'kilopass_tier19',
      invalidateAfter: vi.fn(),
    });

    expect(toast.error).toHaveBeenCalledWith('deeplink failed');
  });
});
