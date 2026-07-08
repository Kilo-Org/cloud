import { describe, expect, it } from 'vitest';

import { resolvePendingNotificationNavigation } from './pending-notification-navigation';

describe('pending notification navigation', () => {
  it('does not navigate without a pending link', () => {
    expect(resolvePendingNotificationNavigation(null)).toBeNull();
  });

  it('navigates so the target screen keeps a back stack without duplicate history entries', () => {
    expect(resolvePendingNotificationNavigation('/chat/sandbox/conversation')).toEqual({
      href: '/chat/sandbox/conversation',
      method: 'navigate',
    });
  });
});
