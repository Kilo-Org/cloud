import { describe, expect, it } from 'vitest';

import { resolvePendingNavigation } from './pending-navigation';

describe('pending navigation', () => {
  it('does not navigate without a pending link', () => {
    expect(resolvePendingNavigation(null)).toBeNull();
  });

  it('navigates so the target screen keeps a back stack without duplicate history entries', () => {
    expect(resolvePendingNavigation('/chat/sandbox/conversation')).toEqual({
      href: '/chat/sandbox/conversation',
      method: 'navigate',
    });
  });
});
