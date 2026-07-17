import { describe, expect, it } from 'vitest';
import { GitLabCredentialBrokerRequestSchema } from './gitlab-credential-broker-handler.js';

describe('GitLabCredentialBrokerRequestSchema', () => {
  it.each([
    { credential: 'integration', integrationId: '2d397344-f0e9-4f5d-a822-e005209d1c88' },
    {
      credential: 'project-exact',
      integrationId: '2d397344-f0e9-4f5d-a822-e005209d1c88',
      projectId: '42',
    },
  ])('accepts the strict $credential selector', selector => {
    expect(GitLabCredentialBrokerRequestSchema.safeParse(selector).success).toBe(true);
  });

  it('rejects actor claims and fallback-shaped fields from request JSON', () => {
    expect(
      GitLabCredentialBrokerRequestSchema.safeParse({
        credential: 'integration',
        integrationId: '2d397344-f0e9-4f5d-a822-e005209d1c88',
        userId: 'attacker',
        projectId: '42',
      }).success
    ).toBe(false);
  });
});
