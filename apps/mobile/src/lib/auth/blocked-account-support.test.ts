import { describe, expect, it } from 'vitest';

import { buildBlockedAccountSupportLink } from './blocked-account-support';

describe('buildBlockedAccountSupportLink', () => {
  it('returns the bare address when nothing is given', () => {
    expect(buildBlockedAccountSupportLink({})).toBe('mailto:hi@kilo.ai');
  });

  it('carries the subject when only the subject is given', () => {
    expect(buildBlockedAccountSupportLink({ subject: 'Account blocked' })).toBe(
      'mailto:hi@kilo.ai?subject=Account%20blocked'
    );
  });

  it('encodes the subject and the account line when both are given', () => {
    expect(
      buildBlockedAccountSupportLink({ subject: 'Account blocked', email: 'person@example.com' })
    ).toBe('mailto:hi@kilo.ai?subject=Account%20blocked&body=Account%3A%20person%40example.com');
  });

  it('omits an empty email instead of writing a placeholder', () => {
    expect(buildBlockedAccountSupportLink({ subject: 'Account blocked', email: '' })).toBe(
      'mailto:hi@kilo.ai?subject=Account%20blocked'
    );
  });
});
