import { describe, expect, it } from 'vitest';

import { resolvePendingNotificationNavigation } from './pending-notification-navigation';

describe('pending notification navigation', () => {
  it('does not navigate without a pending link', () => {
    expect(resolvePendingNotificationNavigation(null)).toBeNull();
  });

  it('replaces the current route instead of pushing a duplicate history entry', () => {
    expect(resolvePendingNotificationNavigation('/chat/sandbox/conversation')).toEqual({
      href: '/chat/sandbox/conversation',
      method: 'replace',
    });
  });
});
