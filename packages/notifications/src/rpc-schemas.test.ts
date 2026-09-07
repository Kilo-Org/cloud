import { describe, expect, it } from 'vitest';
import { refreshGlanceableSessionsInputSchema } from './rpc-schemas';

describe('refreshGlanceableSessionsInputSchema', () => {
  it.each([
    { userId: '', cliSessionIds: ['ses_1'] },
    { userId: 'usr_1', cliSessionIds: [] },
    { userId: 'usr_1', cliSessionIds: [''] },
    { userId: 'usr_1', cliSessionIds: [42] },
  ])('rejects invalid refresh identity: %j', input => {
    expect(refreshGlanceableSessionsInputSchema.safeParse(input).success).toBe(false);
  });

  it('accepts OAuth user IDs without imposing UUID validation', () => {
    expect(
      refreshGlanceableSessionsInputSchema.safeParse({
        userId: 'oauth/github/123',
        cliSessionIds: ['ses_1', 'ses_2'],
      }).success
    ).toBe(true);
  });

  it('does not forward caller-supplied counts or organization scope', () => {
    const parsed = refreshGlanceableSessionsInputSchema.parse({
      userId: 'usr_1',
      cliSessionIds: ['ses_1'],
      organizationId: 'org_foreign',
      running: 100,
    });
    expect(parsed).not.toHaveProperty('organizationId');
    expect(parsed).not.toHaveProperty('running');
  });
});
