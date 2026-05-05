import { afterEach, describe, expect, it, jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

describe('impact advocate', () => {
  const originalEnv = {
    IMPACT_ADVOCATE_ACCOUNT_SID: process.env.IMPACT_ADVOCATE_ACCOUNT_SID,
    IMPACT_ADVOCATE_AUTH_TOKEN: process.env.IMPACT_ADVOCATE_AUTH_TOKEN,
    IMPACT_ADVOCATE_DEBUG_LOGGING: process.env.IMPACT_ADVOCATE_DEBUG_LOGGING,
    IMPACT_ADVOCATE_PROGRAM_ID: process.env.IMPACT_ADVOCATE_PROGRAM_ID,
    IMPACT_ADVOCATE_TENANT_ALIAS: process.env.IMPACT_ADVOCATE_TENANT_ALIAS,
    IMPACT_ADVOCATE_WIDGET_ID: process.env.IMPACT_ADVOCATE_WIDGET_ID,
    IMPACT_ACCOUNT_SID: process.env.IMPACT_ACCOUNT_SID,
  };

  afterEach(() => {
    jest.restoreAllMocks();
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = originalEnv.IMPACT_ADVOCATE_ACCOUNT_SID;
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = originalEnv.IMPACT_ADVOCATE_AUTH_TOKEN;
    process.env.IMPACT_ADVOCATE_DEBUG_LOGGING = originalEnv.IMPACT_ADVOCATE_DEBUG_LOGGING;
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
      id: 'referee@example.com',
      accountId: 'referee@example.com',
      email: 'referee@example.com',
      cookies: 'opaque-cookie-value',
      // SaaSquatch wants en_US, not en-US.
      locale: 'en_US',
      countryCode: 'US',
    });
  });

  it('normalizes bare widget IDs to the full Impact embed widget path', async () => {
    process.env.IMPACT_ADVOCATE_PROGRAM_ID = '51699';
    process.env.IMPACT_ADVOCATE_TENANT_ALIAS = 'tenant-alias';
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = 'secret';
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = 'impact-account-sid';
    process.env.IMPACT_ADVOCATE_WIDGET_ID = '51699';

    const { getImpactAdvocateWidgetId } = await import('@/lib/impact-advocate');

    expect(getImpactAdvocateWidgetId()).toBe('p/51699/w/referrerWidget');
  });

  it('logs debug data without tokens, credentials, authorization headers, or cookie values', async () => {
    process.env.IMPACT_ADVOCATE_PROGRAM_ID = '51699';
    process.env.IMPACT_ADVOCATE_TENANT_ALIAS = 'tenant-alias';
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = 'secret';
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = 'impact-account-sid';
    process.env.IMPACT_ADVOCATE_DEBUG_LOGGING = 'true';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const {
      buildImpactAdvocateRegisterParticipantPayload,
      issueImpactAdvocateVerifiedAccessToken,
    } = await import('@/lib/impact-advocate');

    buildImpactAdvocateRegisterParticipantPayload({
      user: { id: 'user_123', google_user_email: 'referee@example.com' },
      referralCookieValue: 'opaque-cookie-value',
    });
    issueImpactAdvocateVerifiedAccessToken(
      { id: 'user_456', google_user_email: 'referrer@example.com' },
      new Date('2026-04-23T12:00:00.000Z')
    );

    const loggedData = JSON.stringify(logSpy.mock.calls);
    expect(loggedData).toContain('[impact-advocate] built register participant payload');
    expect(loggedData).toContain('[impact-advocate] issued verified access token');
    expect(loggedData).toContain('referee@example.com');
    expect(loggedData).toContain('referrer@example.com');
    expect(loggedData).toContain('impact-account-sid');
    expect(loggedData).toContain('segmentLengths');
    expect(loggedData).toContain('[omitted: cookie value is sensitive]');
    expect(loggedData).not.toContain('opaque-cookie-value');
    expect(loggedData).not.toContain('secret');
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
    expect(decoded.payload).toEqual({
      user: {
        id: 'referrer@example.com',
        accountId: 'referrer@example.com',
        email: 'referrer@example.com',
        referable: false,
      },
      exp: Math.floor(new Date('2026-04-23T12:00:00.000Z').getTime() / 1000) + 60 * 60,
    });
  });

  it('strips legacy programId and normalises locale at send time', async () => {
    const { sanitizeRegisterParticipantPayloadForWire } = await import('@/lib/impact-advocate');

    // Legacy persisted shape: extra programId, BCP 47 locale, plus an unknown
    // garbage field. Sanitiser must produce SaaSquatch-acceptable JSON.
    const sanitized = sanitizeRegisterParticipantPayloadForWire({
      id: 'referee@example.com',
      accountId: 'referee@example.com',
      email: 'referee@example.com',
      cookies: 'sq-cookie',
      locale: 'en-US',
      countryCode: 'US',
      programId: '51699',
      garbage: 'should be dropped',
    });

    expect(sanitized).toEqual({
      id: 'referee@example.com',
      accountId: 'referee@example.com',
      email: 'referee@example.com',
      cookies: 'sq-cookie',
      locale: 'en_US',
      countryCode: 'US',
    });
  });
});
