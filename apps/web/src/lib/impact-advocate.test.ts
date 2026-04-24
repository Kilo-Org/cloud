import { afterEach, describe, expect, it, jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

describe('impact advocate', () => {
  const originalEnv = {
    IMPACT_ADVOCATE_ACCOUNT_SID: process.env.IMPACT_ADVOCATE_ACCOUNT_SID,
    IMPACT_ADVOCATE_AUTH_TOKEN: process.env.IMPACT_ADVOCATE_AUTH_TOKEN,
    IMPACT_ADVOCATE_PROGRAM_ID: process.env.IMPACT_ADVOCATE_PROGRAM_ID,
    IMPACT_ADVOCATE_TENANT_ALIAS: process.env.IMPACT_ADVOCATE_TENANT_ALIAS,
    IMPACT_ADVOCATE_WIDGET_ID: process.env.IMPACT_ADVOCATE_WIDGET_ID,
    IMPACT_ACCOUNT_SID: process.env.IMPACT_ACCOUNT_SID,
  };

  afterEach(() => {
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = originalEnv.IMPACT_ADVOCATE_ACCOUNT_SID;
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = originalEnv.IMPACT_ADVOCATE_AUTH_TOKEN;
    process.env.IMPACT_ADVOCATE_PROGRAM_ID = originalEnv.IMPACT_ADVOCATE_PROGRAM_ID;
    process.env.IMPACT_ADVOCATE_TENANT_ALIAS = originalEnv.IMPACT_ADVOCATE_TENANT_ALIAS;
    process.env.IMPACT_ADVOCATE_WIDGET_ID = originalEnv.IMPACT_ADVOCATE_WIDGET_ID;
    process.env.IMPACT_ACCOUNT_SID = originalEnv.IMPACT_ACCOUNT_SID;
    jest.resetModules();
  });

  it('builds register participant payloads with exact cookie attribution', async () => {
    process.env.IMPACT_ADVOCATE_PROGRAM_ID = '51699';
    process.env.IMPACT_ADVOCATE_TENANT_ALIAS = 'kilo';
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = 'secret';
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = 'account-sid';

    const { buildImpactAdvocateRegisterParticipantPayload } = await import('@/lib/impact-advocate');

    expect(
      buildImpactAdvocateRegisterParticipantPayload({
        user: { id: 'user_123', google_user_email: 'referee@example.com' },
        referralCookieValue: 'opaque-cookie-value',
        locale: 'en-US',
        countryCode: 'US',
      })
    ).toEqual({
      id: 'user_123',
      accountId: 'user_123',
      programId: '51699',
      email: 'referee@example.com',
      cookies: 'opaque-cookie-value',
      locale: 'en-US',
      countryCode: 'US',
    });
  });

  it('issues verified access JWTs with the account sid in the kid header', async () => {
    process.env.IMPACT_ADVOCATE_PROGRAM_ID = '51699';
    process.env.IMPACT_ADVOCATE_TENANT_ALIAS = 'tenant-alias';
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = 'secret';
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = 'impact-account-sid';
    process.env.IMPACT_ADVOCATE_WIDGET_ID = 'p/51699/w/referrerWidget';

    const { getImpactAdvocateWidgetId, issueImpactAdvocateVerifiedAccessToken } =
      await import('@/lib/impact-advocate');

    const token = issueImpactAdvocateVerifiedAccessToken(
      { id: 'user_123', google_user_email: 'referrer@example.com' },
      new Date('2026-04-23T12:00:00.000Z')
    );

    expect(token).toBeTruthy();
    expect(getImpactAdvocateWidgetId()).toBe('p/51699/w/referrerWidget');

    const decoded = jwt.decode(token ?? '', { complete: true });
    if (!decoded || typeof decoded !== 'object') {
      throw new Error('Expected a decoded JWT payload');
    }

    expect(decoded.header.kid).toBe('impact-account-sid');
    expect(decoded.payload).toMatchObject({
      iss: 'tenant-alias',
      aud: 'impact-advocate',
      sub: 'user_123',
      user: {
        id: 'user_123',
        accountId: 'user_123',
        email: 'referrer@example.com',
      },
    });
  });
});
