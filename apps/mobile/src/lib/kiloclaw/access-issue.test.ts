import { describe, expect, it, vi } from 'vitest';

import { resolveAccessIssueUrl, SUPPORT_EMAIL } from './access-issue';

vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://kilo.test' }));

describe('resolveAccessIssueUrl', () => {
  it('sends billing subcases to the claw billing page', () => {
    expect(resolveAccessIssueUrl('trial_expired')).toBe('https://kilo.test/claw');
    expect(resolveAccessIssueUrl('subscription_canceled')).toBe('https://kilo.test/claw');
    expect(resolveAccessIssueUrl('subscription_past_due')).toBe('https://kilo.test/claw');
  });

  it('sends self-serve access subcases to the site', () => {
    expect(resolveAccessIssueUrl('multiple_current_conflict')).toBe('https://kilo.test');
    expect(resolveAccessIssueUrl('non_canonical_earlybird')).toBe('https://kilo.test');
  });

  it('sends quarantined to the support inbox, the only path that can restore it', () => {
    expect(resolveAccessIssueUrl('quarantined')).toBe(`mailto:${SUPPORT_EMAIL}`);
  });
});
