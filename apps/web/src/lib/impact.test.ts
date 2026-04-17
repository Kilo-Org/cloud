process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';
process.env.TURNSTILE_SECRET_KEY ||= 'test-turnstile-secret';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

describe('impact', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.IMPACT_ACCOUNT_SID = 'impact-account-sid';
    process.env.IMPACT_AUTH_TOKEN = 'impact-auth-token';
    process.env.IMPACT_CAMPAIGN_ID = '50754';
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('hashes email after trimming and lowercasing', async () => {
    const { hashEmailForImpact } = await import('@/lib/impact');

    expect(hashEmailForImpact('  USER@example.com  ')).toBe(
      '63a710569261a24b3766275b7000ce8d7b32e2f7'
    );
  });

  it('builds a minimal visit payload', async () => {
    const { IMPACT_ORDER_ID_MACRO, buildVisitPayload } = await import('@/lib/impact');
    const payload = buildVisitPayload({
      trackingId: 'impact-click-123',
      eventDate: new Date('2026-04-02T12:00:00.000Z'),
    });

    expect(payload).toEqual({
      CampaignId: '50754',
      ActionTrackerId: 71668,
      EventDate: '2026-04-02T12:00:00.000Z',
      ClickId: 'impact-click-123',
      OrderId: IMPACT_ORDER_ID_MACRO,
    });
  });

  it('parses immediate sale success with action mapping', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ActionId: '1000.2000.3000',
          ActionUri: '/Advertisers/impact-account-sid/Actions/1000.2000.3000',
        }),
        { status: 200 }
      )
    );
    global.fetch = fetchMock;

    const { buildSalePayload, sendImpactConversionPayload } = await import('@/lib/impact');
    const result = await sendImpactConversionPayload(
      buildSalePayload({
        trackingId: 'impact-click-123',
        customerId: 'user_123',
        customerEmailHash: 'hashed-email',
        orderId: 'in_123',
        amount: 9,
        currencyCode: 'usd',
        eventDate: new Date('2026-04-02T12:00:00.000Z'),
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
      })
    );

    expect(result).toEqual({
      ok: true,
      delivery: 'immediate',
      actionId: '1000.2000.3000',
      actionUri: '/Advertisers/impact-account-sid/Actions/1000.2000.3000',
      responseBody:
        '{"ActionId":"1000.2000.3000","ActionUri":"/Advertisers/impact-account-sid/Actions/1000.2000.3000"}',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parses queued sale success with submission URI', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          Status: 'QUEUED',
          QueuedUri: '/Advertisers/impact-account-sid/APISubmissions/A-queued-sale',
        }),
        { status: 200 }
      )
    );
    global.fetch = fetchMock;

    const { buildSalePayload, sendImpactConversionPayload } = await import('@/lib/impact');
    const result = await sendImpactConversionPayload(
      buildSalePayload({
        trackingId: 'impact-click-123',
        customerId: 'user_123',
        customerEmailHash: 'hashed-email',
        orderId: 'in_123',
        amount: 9,
        currencyCode: 'usd',
        eventDate: new Date('2026-04-02T12:00:00.000Z'),
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
      })
    );

    expect(result).toEqual({
      ok: true,
      delivery: 'queued',
      submissionUri: '/Advertisers/impact-account-sid/APISubmissions/A-queued-sale',
      responseBody:
        '{"Status":"QUEUED","QueuedUri":"/Advertisers/impact-account-sid/APISubmissions/A-queued-sale"}',
    });
  });

  it('rejects sale success without action mapping or submission uri', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ Status: 'ACCEPTED' }), { status: 200 }));
    global.fetch = fetchMock;

    const { buildSalePayload, sendImpactConversionPayload } = await import('@/lib/impact');
    const result = await sendImpactConversionPayload(
      buildSalePayload({
        trackingId: 'impact-click-123',
        customerId: 'user_123',
        customerEmailHash: 'hashed-email',
        orderId: 'in_123',
        amount: 9,
        currencyCode: 'usd',
        eventDate: new Date('2026-04-02T12:00:00.000Z'),
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
      })
    );

    expect(result).toEqual({
      ok: false,
      failureKind: 'submission_failed',
      responseBody: '{"Status":"ACCEPTED"}',
      error: 'Impact sale success response missing action mapping',
    });
  });

  it('fails queued submission resolution when impact is unconfigured', async () => {
    delete process.env.IMPACT_ACCOUNT_SID;
    delete process.env.IMPACT_AUTH_TOKEN;
    delete process.env.IMPACT_CAMPAIGN_ID;
    jest.resetModules();

    const fetchMock = jest.fn<typeof fetch>();
    global.fetch = fetchMock;

    const { resolveImpactSubmissionUri } = await import('@/lib/impact');
    const result = await resolveImpactSubmissionUri(
      '/Advertisers/impact-account-sid/APISubmissions/A-queued-sale'
    );

    expect(result).toEqual({
      ok: false,
      failureKind: 'submission_failed',
      error: 'Impact is unconfigured; cannot resolve queued submission',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds reversal request with REJECTED disposition code', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          Status: 'QUEUED',
          QueuedUri: '/Advertisers/impact-account-sid/APISubmissions/A-reversal',
        }),
        { status: 200 }
      )
    );
    global.fetch = fetchMock;

    const { reverseImpactAction } = await import('@/lib/impact');
    await reverseImpactAction({ actionId: '1000.2000.3000' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.impact.com/Advertisers/impact-account-sid/Actions'
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'DELETE',
      headers: expect.objectContaining({
        Authorization:
          'Basic ' + Buffer.from('impact-account-sid:impact-auth-token').toString('base64'),
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      }),
      body: expect.stringContaining('ActionId=1000.2000.3000'),
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('DispositionCode=REJECTED');
  });
});
