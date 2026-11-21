import { describe, expect, it } from 'vitest';
import { sentryIdentityFromBilling } from './sentry-identity.js';

describe('sentryIdentityFromBilling', () => {
  const personal = { type: 'user', id: 'personal-user' } as const;
  const org = { type: 'org', id: 'org-one' } as const;
  const user = { type: 'user', id: 'member-user' } as const;
  const bot = { type: 'bot', id: 'bot-one' } as const;
  const sessionId = 'workspace_one';

  it.each([
    {
      name: 'personal user',
      billing: { subject: personal, actor: user },
      userId: personal.id,
      orgId: '(personal)',
    },
    {
      name: 'personal automation without a billing member',
      billing: { subject: personal, actor: bot },
      userId: personal.id,
      orgId: '(personal)',
    },
    {
      name: 'organization user',
      billing: { subject: org, actor: user },
      userId: user.id,
      orgId: org.id,
    },
    {
      name: 'organization automation with a billing member',
      billing: { subject: org, actor: bot, metadata: { billingUserId: user.id } },
      userId: user.id,
      orgId: org.id,
    },
    {
      name: 'organization automation without a billing member',
      billing: { subject: org, actor: bot },
      userId: undefined,
      orgId: org.id,
    },
  ])('maps $name to the known identity', ({ billing, userId, orgId }) => {
    expect(sentryIdentityFromBilling({ ...billing, sessionId })).toStrictEqual({
      userId,
      orgId,
      sessionId,
    });
  });
});
