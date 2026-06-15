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
    IMPACT_ADVOCATE_KILOCLAW_PROGRAM_ID: process.env.IMPACT_ADVOCATE_KILOCLAW_PROGRAM_ID,
    IMPACT_ADVOCATE_KILOCLAW_WIDGET_ID: process.env.IMPACT_ADVOCATE_KILOCLAW_WIDGET_ID,
    IMPACT_ADVOCATE_KILO_PASS_PROGRAM_ID: process.env.IMPACT_ADVOCATE_KILO_PASS_PROGRAM_ID,
    IMPACT_ADVOCATE_KILO_PASS_WIDGET_ID: process.env.IMPACT_ADVOCATE_KILO_PASS_WIDGET_ID,
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
    process.env.IMPACT_ADVOCATE_KILOCLAW_PROGRAM_ID =
      originalEnv.IMPACT_ADVOCATE_KILOCLAW_PROGRAM_ID;
    process.env.IMPACT_ADVOCATE_KILOCLAW_WIDGET_ID = originalEnv.IMPACT_ADVOCATE_KILOCLAW_WIDGET_ID;
    process.env.IMPACT_ADVOCATE_KILO_PASS_PROGRAM_ID =
      originalEnv.IMPACT_ADVOCATE_KILO_PASS_PROGRAM_ID;
    process.env.IMPACT_ADVOCATE_KILO_PASS_WIDGET_ID =
      originalEnv.IMPACT_ADVOCATE_KILO_PASS_WIDGET_ID;
    process.env.IMPACT_ACCOUNT_SID = originalEnv.IMPACT_ACCOUNT_SID;
    jest.resetModules();
  });

  it('builds register participant payloads with exact cookie attribution', async () => {
    process.env.IMPACT_ADVOCATE_KILOCLAW_PROGRAM_ID = '51699';
    process.env.IMPACT_ADVOCATE_TENANT_ALIAS = 'kilo';
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = 'secret';
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = 'account-sid';

    const { buildImpactAdvocateRegisterParticipantPayload } = await import('@/lib/impact/advocate');

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
    process.env.IMPACT_ADVOCATE_KILOCLAW_PROGRAM_ID = '51699';
    process.env.IMPACT_ADVOCATE_TENANT_ALIAS = 'tenant-alias';
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = 'secret';
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = 'impact-account-sid';
    process.env.IMPACT_ADVOCATE_KILOCLAW_WIDGET_ID = '51699';

    const { getImpactAdvocateWidgetId } = await import('@/lib/impact/advocate');

    expect(getImpactAdvocateWidgetId()).toBe('p/51699/w/referrerWidget');
  });

  it('uses KiloClaw-scoped Advocate config for widget and token issuance', async () => {
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = 'kiloclaw-account';
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = 'kiloclaw-secret';
    process.env.IMPACT_ADVOCATE_KILOCLAW_PROGRAM_ID = '51699-scoped';
    process.env.IMPACT_ADVOCATE_TENANT_ALIAS = 'kiloclaw-tenant';
    process.env.IMPACT_ADVOCATE_KILOCLAW_WIDGET_ID = '51699-scoped';

    const {
      getImpactAdvocateProgramId,
      getImpactAdvocateWidgetId,
      issueImpactAdvocateVerifiedAccessToken,
    } = await import('@/lib/impact/advocate');

    expect(getImpactAdvocateProgramId()).toBe('51699-scoped');
    expect(getImpactAdvocateWidgetId()).toBe('p/51699-scoped/w/referrerWidget');

    const token = issueImpactAdvocateVerifiedAccessToken(
      { id: 'user_123', google_user_email: 'referrer@example.com' },
      new Date('2026-04-23T12:00:00.000Z')
    );
    const decoded = jwt.decode(token ?? '', { complete: true });
    expect(decoded && typeof decoded === 'object' ? decoded.header.kid : null).toBe(
      'kiloclaw-account'
    );
  });

  it('does not configure KiloClaw from legacy unscoped program/widget config', async () => {
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = 'legacy-account';
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = 'legacy-secret';
    process.env.IMPACT_ADVOCATE_PROGRAM_ID = '51699';
    process.env.IMPACT_ADVOCATE_TENANT_ALIAS = 'legacy-tenant';
    process.env.IMPACT_ADVOCATE_WIDGET_ID = '51699';

    const {
      getImpactAdvocateProgramId,
      getImpactAdvocateWidgetId,
      isImpactAdvocateConfigured,
      issueImpactAdvocateVerifiedAccessToken,
    } = await import('@/lib/impact/advocate');

    expect(isImpactAdvocateConfigured()).toBe(false);
    expect(getImpactAdvocateProgramId()).toBeNull();
    expect(getImpactAdvocateWidgetId()).toBeNull();
    expect(
      issueImpactAdvocateVerifiedAccessToken(
        { id: 'user_123', google_user_email: 'referrer@example.com' },
        new Date('2026-04-23T12:00:00.000Z')
      )
    ).toBeNull();
  });

  it('does not use KiloClaw config for Kilo Pass', async () => {
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = 'fallback-account';
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = 'fallback-secret';
    process.env.IMPACT_ADVOCATE_KILOCLAW_PROGRAM_ID = '51699';
    process.env.IMPACT_ADVOCATE_TENANT_ALIAS = 'fallback-tenant';
    process.env.IMPACT_ADVOCATE_KILOCLAW_WIDGET_ID = 'p/51699/w/referrerWidget';

    const {
      getImpactAdvocateWidgetId,
      isImpactAdvocateConfigured,
      issueImpactAdvocateVerifiedAccessToken,
    } = await import('@/lib/impact/advocate');

    const scope = { product: 'kilo_pass' as const };
    expect(isImpactAdvocateConfigured(scope)).toBe(false);
    expect(getImpactAdvocateWidgetId(scope)).toBeNull();
    expect(
      issueImpactAdvocateVerifiedAccessToken(
        { id: 'user_123', google_user_email: 'referrer@example.com' },
        new Date('2026-04-23T12:00:00.000Z'),
        scope
      )
    ).toBeNull();
  });

  it('uses Kilo Pass-scoped program and widget config for token issuance', async () => {
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = 'shared-account';
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = 'shared-secret';
    process.env.IMPACT_ADVOCATE_KILO_PASS_PROGRAM_ID = '52766';
    process.env.IMPACT_ADVOCATE_TENANT_ALIAS = 'shared-tenant';
    process.env.IMPACT_ADVOCATE_KILO_PASS_WIDGET_ID = 'p/52766/w/referrerWidget';

    const {
      getImpactAdvocateProgramId,
      getImpactAdvocateWidgetId,
      issueImpactAdvocateVerifiedAccessToken,
    } = await import('@/lib/impact/advocate');

    const scope = { product: 'kilo_pass' as const };
    expect(getImpactAdvocateProgramId(scope)).toBe('52766');
    expect(getImpactAdvocateWidgetId(scope)).toBe('p/52766/w/referrerWidget');

    const token = issueImpactAdvocateVerifiedAccessToken(
      { id: 'user_123', google_user_email: 'referrer@example.com' },
      new Date('2026-04-23T12:00:00.000Z'),
      scope
    );
    const decoded = jwt.decode(token ?? '', { complete: true });
    expect(decoded && typeof decoded === 'object' ? decoded.header.kid : null).toBe(
      'shared-account'
    );
  });

  it('rejects Kilo Pass Advocate config that reuses KiloClaw program or widget IDs', async () => {
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = 'shared-account';
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = 'shared-secret';
    process.env.IMPACT_ADVOCATE_KILOCLAW_PROGRAM_ID = '51699';
    process.env.IMPACT_ADVOCATE_TENANT_ALIAS = 'shared-tenant';
    process.env.IMPACT_ADVOCATE_KILOCLAW_WIDGET_ID = 'p/51699/w/referrerWidget';

    const scope = { product: 'kilo_pass' as const };

    process.env.IMPACT_ADVOCATE_KILO_PASS_PROGRAM_ID = '51699';
    process.env.IMPACT_ADVOCATE_KILO_PASS_WIDGET_ID = 'p/52766/w/referrerWidget';
    jest.resetModules();
    let advocate = await import('@/lib/impact/advocate');
    expect(advocate.isImpactAdvocateConfigured(scope)).toBe(false);
    expect(advocate.getImpactAdvocateProgramId(scope)).toBeNull();
    expect(advocate.getImpactAdvocateWidgetId(scope)).toBeNull();

    process.env.IMPACT_ADVOCATE_KILO_PASS_PROGRAM_ID = '52766';
    process.env.IMPACT_ADVOCATE_KILO_PASS_WIDGET_ID = 'p/51699/w/referrerWidget';
    jest.resetModules();
    advocate = await import('@/lib/impact/advocate');
    expect(advocate.isImpactAdvocateConfigured(scope)).toBe(false);
    expect(advocate.getImpactAdvocateProgramId(scope)).toBeNull();
    expect(advocate.getImpactAdvocateWidgetId(scope)).toBeNull();
  });

  it('logs debug data without tokens, credentials, authorization headers, cookie values, or email identities', async () => {
    process.env.IMPACT_ADVOCATE_KILOCLAW_PROGRAM_ID = '51699';
    process.env.IMPACT_ADVOCATE_TENANT_ALIAS = 'tenant-alias';
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = 'secret';
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = 'impact-account-sid';
    process.env.IMPACT_ADVOCATE_KILOCLAW_WIDGET_ID = 'p/51699/w/referrerWidget';
    process.env.IMPACT_ADVOCATE_DEBUG_LOGGING = 'true';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const {
      buildImpactAdvocateRegisterParticipantPayload,
      issueImpactAdvocateVerifiedAccessToken,
    } = await import('@/lib/impact/advocate');

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
    expect(loggedData).toContain('[omitted: email identity is PII]');
    expect(loggedData).not.toContain('referee@example.com');
    expect(loggedData).not.toContain('referrer@example.com');
    expect(loggedData).toContain('impact-account-sid');
    expect(loggedData).toContain('segmentLengths');
    expect(loggedData).toContain('[omitted: cookie value is sensitive]');
    expect(loggedData).not.toContain('opaque-cookie-value');
    expect(loggedData).not.toContain('secret');
  });

  it('issues verified access JWTs with the account sid in the kid header', async () => {
    process.env.IMPACT_ADVOCATE_KILOCLAW_PROGRAM_ID = '51699';
    process.env.IMPACT_ADVOCATE_TENANT_ALIAS = 'tenant-alias';
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = 'secret';
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = 'impact-account-sid';
    process.env.IMPACT_ADVOCATE_KILOCLAW_WIDGET_ID = 'p/51699/w/referrerWidget';

    const { getImpactAdvocateWidgetId, issueImpactAdvocateVerifiedAccessToken } =
      await import('@/lib/impact/advocate');

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

  it('looks up account rewards with account and user filters', async () => {
    process.env.IMPACT_ADVOCATE_KILOCLAW_PROGRAM_ID = '51699';
    process.env.IMPACT_ADVOCATE_TENANT_ALIAS = 'tenant-alias';
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = 'secret';
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = 'impact-account-sid';
    process.env.IMPACT_ADVOCATE_KILOCLAW_WIDGET_ID = 'p/51699/w/referrerWidget';
    process.env.IMPACT_ADVOCATE_DEBUG_LOGGING = 'true';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ rewards: [{ id: 'reward-123', type: 'CREDIT' }] }), {
        status: 200,
      })
    );
    global.fetch = fetchMock;

    const { sendImpactAdvocateRewardLookupPayload } = await import('@/lib/impact/advocate');
    const result = await sendImpactAdvocateRewardLookupPayload({
      accountId: 'user@example.com',
      userId: 'user@example.com',
      rewardTypeFilter: 'CREDIT',
    });

    expect(result).toEqual({
      ok: true,
      statusCode: 200,
      responseBody: '{"rewards":[{"id":"reward-123","type":"CREDIT"}]}',
      rewards: [{ id: 'reward-123', type: 'CREDIT' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://app.referralsaasquatch.com/api/v1/tenant-alias/reward?accountId=user%40example.com&userId=user%40example.com&rewardTypeFilter=CREDIT'
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: expect.objectContaining({
        Authorization: 'Basic ' + Buffer.from('impact-account-sid:secret').toString('base64'),
        Accept: 'application/json',
      }),
    });
    const loggedData = JSON.stringify(logSpy.mock.calls);
    expect(loggedData).toContain('accountId=redacted');
    expect(loggedData).toContain('userId=redacted');
    expect(loggedData).not.toContain('user@example.com');
  });

  it('redeems a credit reward with amount and unit', async () => {
    process.env.IMPACT_ADVOCATE_KILOCLAW_PROGRAM_ID = '51699';
    process.env.IMPACT_ADVOCATE_TENANT_ALIAS = 'tenant-alias';
    process.env.IMPACT_ADVOCATE_AUTH_TOKEN = 'secret';
    process.env.IMPACT_ADVOCATE_ACCOUNT_SID = 'impact-account-sid';
    process.env.IMPACT_ADVOCATE_KILOCLAW_WIDGET_ID = 'p/51699/w/referrerWidget';
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    global.fetch = fetchMock;

    const { sendImpactAdvocateRewardRedemptionPayload } = await import('@/lib/impact/advocate');
    const result = await sendImpactAdvocateRewardRedemptionPayload({
      rewardId: 'reward-123',
      amount: 1,
      unit: 'MONTH',
    });

    expect(result).toEqual({ ok: true, statusCode: 200, responseBody: '{"ok":true}' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://app.referralsaasquatch.com/api/v1/tenant-alias/credit/reward-123/redeem'
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Basic ' + Buffer.from('impact-account-sid:secret').toString('base64'),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      }),
      body: '{"amount":1,"unit":"MONTH"}',
    });
  });

  it('strips legacy programId and normalises locale at send time', async () => {
    const { sanitizeRegisterParticipantPayloadForWire } = await import('@/lib/impact/advocate');

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

  describe('extractAdvocateReferralCodeFromUpsertResponse', () => {
    it('returns the program-scoped code from a SaaSquatch upsert response', async () => {
      const { extractAdvocateReferralCodeFromUpsertResponse } =
        await import('@/lib/impact/advocate');

      const body = JSON.stringify({
        id: 'hash',
        email: 'referee@example.com',
        referralCodes: { '51699': 'REFEREE15914', '99999': 'OTHER42' },
        referable: true,
      });

      expect(extractAdvocateReferralCodeFromUpsertResponse(body, '51699')).toBe('REFEREE15914');
      expect(extractAdvocateReferralCodeFromUpsertResponse(body, '99999')).toBe('OTHER42');
    });

    it('returns null for missing program, malformed JSON, empty bodies, or non-string codes', async () => {
      const { extractAdvocateReferralCodeFromUpsertResponse } =
        await import('@/lib/impact/advocate');

      expect(extractAdvocateReferralCodeFromUpsertResponse(null, '51699')).toBeNull();
      expect(extractAdvocateReferralCodeFromUpsertResponse('', '51699')).toBeNull();
      expect(extractAdvocateReferralCodeFromUpsertResponse('not json', '51699')).toBeNull();
      expect(extractAdvocateReferralCodeFromUpsertResponse('null', '51699')).toBeNull();
      expect(extractAdvocateReferralCodeFromUpsertResponse('{}', '51699')).toBeNull();
      expect(
        extractAdvocateReferralCodeFromUpsertResponse(
          JSON.stringify({ referralCodes: { '51699': '   ' } }),
          '51699'
        )
      ).toBeNull();
      expect(
        extractAdvocateReferralCodeFromUpsertResponse(
          JSON.stringify({ referralCodes: { '51699': 12345 } }),
          '51699'
        )
      ).toBeNull();
      expect(
        extractAdvocateReferralCodeFromUpsertResponse(
          JSON.stringify({ referralCodes: { '99999': 'OTHER42' } }),
          '51699'
        )
      ).toBeNull();
    });
  });
});
