import { describe, expect, it } from 'vitest';

import { browserHandoffUrl, isRemovedMobileDeepLink } from './deep-link-policy';

// Android's `pathPattern` cannot exclude segments, so the organization root's
// filter also delivers the two web create pages. The app owns no screen for
// them; it opens the browser page each link names.
describe('browserHandoffUrl', () => {
  it.each([
    ['https://app.kilo.ai/organizations/new', 'https://app.kilo.ai/organizations/new'],
    ['https://app.kilo.ai/organizations/create', 'https://app.kilo.ai/organizations/create'],
    ['kiloapp:///organizations/create', 'https://app.kilo.ai/organizations/create'],
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

  // The handoff origin is never the link's raw authority: `evil.com` is the
  // real host of the first link, so echoing it would open the attacker page.
  it('never hands off a URL carrying userinfo or a foreign host', () => {
    expect(browserHandoffUrl('https://app.kilo.ai:pass@evil.com/organizations/new')).toBeNull();
    expect(browserHandoffUrl('https://user@app.kilo.ai/organizations/new')).toBeNull();
    expect(browserHandoffUrl('https://evil.com/organizations/new')).toBeNull();
    expect(browserHandoffUrl('http://localhost@evil.com/organizations/create')).toBeNull();
  });

  it('builds the handoff origin from the validated host only', () => {
    expect(browserHandoffUrl('https://app.kilo.ai:8443/organizations/new')).toBe(
      'https://app.kilo.ai/organizations/new'
    );
    expect(browserHandoffUrl('http://127.0.0.1:3000/organizations/new')).toBe(
      'http://127.0.0.1:3000/organizations/new'
    );
  });

  it('keeps the removed-family policy untouched', () => {
    expect(isRemovedMobileDeepLink('https://app.kilo.ai/claw')).toBe(true);
    expect(isRemovedMobileDeepLink('https://app.kilo.ai/organizations/new')).toBe(false);
  });
});
