import { describe, expect, it } from 'vitest';

import { browserHandoffUrl, isRemovedMobileDeepLink } from './deep-link-policy';

// Android's `pathPattern` cannot exclude segments, so the organization root's
// filter also delivers the two web create pages. The app owns no screen for
// them; it opens the browser page each link names.
describe('browserHandoffUrl', () => {
  it.each([
    ['https://app.kilo.ai/organizations/new', 'https://app.kilo.ai/organizations/new'],
    ['https://app.kilo.ai/organizations/create', 'https://app.kilo.ai/organizations/create'],
  ])('%s → %s', (raw, expected) => {
    expect(browserHandoffUrl(raw)).toBe(expected);
  });

  it('drops the query and fragment', () => {
    expect(browserHandoffUrl('https://app.kilo.ai/organizations/new?plan=teams#name')).toBe(
      'https://app.kilo.ai/organizations/new'
    );
  });

  it('keeps a non-production origin', () => {
    expect(browserHandoffUrl('http://localhost:3000/organizations/create')).toBe(
      'http://localhost:3000/organizations/create'
    );
  });

  it('leaves the organization root and every deeper page to the table', () => {
    expect(browserHandoffUrl('https://app.kilo.ai/organizations/org_1')).toBeNull();
    expect(browserHandoffUrl('https://app.kilo.ai/organizations/org_1/guardrails')).toBeNull();
  });

  it('ignores other routes, foreign hosts and malformed encodings', () => {
    expect(browserHandoffUrl('https://app.kilo.ai/profile')).toBeNull();
    expect(browserHandoffUrl('https://example.com/organizations/new')).toBeNull();
    expect(browserHandoffUrl('https://app.kilo.ai/organizations/%E0%A4%A')).toBeNull();
  });

  it('keeps the removed-family policy untouched', () => {
    expect(isRemovedMobileDeepLink('https://app.kilo.ai/claw')).toBe(true);
    expect(isRemovedMobileDeepLink('https://app.kilo.ai/organizations/new')).toBe(false);
  });
});
