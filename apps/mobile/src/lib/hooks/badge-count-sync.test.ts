import { describe, expect, it, vi } from 'vitest';

import { syncDeviceBadgeCountFromBadges } from './badge-count-sync';

describe('syncDeviceBadgeCountFromBadges', () => {
  it('sets the device badge to the server instance total', async () => {
    const setBadgeCount = vi.fn(async () => {
      await Promise.resolve();
      return true;
    });

    await syncDeviceBadgeCountFromBadges(
      {
        instances: [
          { sandboxId: 'sandbox-1', unreadCount: 2 },
          { sandboxId: 'sandbox-2', unreadCount: 3 },
        ],
        conversations: [],
      },
      setBadgeCount
    );

    expect(setBadgeCount).toHaveBeenCalledWith(5);
  });

  it('clears the device badge when server counts total zero', async () => {
    const setBadgeCount = vi.fn(async () => {
      await Promise.resolve();
      return true;
    });

    await syncDeviceBadgeCountFromBadges({ instances: [], conversations: [] }, setBadgeCount);

    expect(setBadgeCount).toHaveBeenCalledWith(0);
  });
});
