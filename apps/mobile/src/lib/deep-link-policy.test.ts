import { describe, expect, it } from 'vitest';

import { isRemovedMobileDeepLink } from './deep-link-policy';

describe('isRemovedMobileDeepLink', () => {
  it('keeps the removed-family policy', () => {
    expect(isRemovedMobileDeepLink('https://app.kilo.ai/claw')).toBe(true);
    expect(isRemovedMobileDeepLink('kiloapp:///claw/chat/abc')).toBe(true);
  });

  it('leaves the organization create pages to the deep-link table', () => {
    expect(isRemovedMobileDeepLink('https://app.kilo.ai/organizations/new')).toBe(false);
    expect(isRemovedMobileDeepLink('https://app.kilo.ai/organizations/create')).toBe(false);
  });
});
