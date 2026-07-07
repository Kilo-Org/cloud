import { isCronAuthorizationValid } from '@/lib/cron-auth';

describe('cron authorization', () => {
  it('accepts only the exact bearer secret', () => {
    expect(isCronAuthorizationValid('Bearer cron-secret', 'cron-secret')).toBe(true);
    expect(isCronAuthorizationValid('Bearer wrong-secret', 'cron-secret')).toBe(false);
    expect(isCronAuthorizationValid('Bearer cron-secret-extra', 'cron-secret')).toBe(false);
    expect(isCronAuthorizationValid(null, 'cron-secret')).toBe(false);
  });
});
