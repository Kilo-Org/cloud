process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';
process.env.TURNSTILE_SECRET_KEY ||= 'test-turnstile-secret';

import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';

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

  it('sends JSON conversions with basic auth and maps trackingId to ClickId', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    } as Response);
    global.fetch = fetchMock;

    const { trackSale } = await import('@/lib/impact');
    await trackSale({
      trackingId: 'impact-click-123',
      customerId: 'user_123',
      customerEmail: 'user@example.com',
      orderId: 'in_123',
      amount: 9,
      currencyCode: 'usd',
      eventDate: new Date('2026-04-02T12:00:00.000Z'),
      itemCategory: 'kiloclaw-standard',
      itemName: 'KiloClaw Standard Plan',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.impact.com/Advertisers/impact-account-sid/Conversions'
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization:
          'Basic ' + Buffer.from('impact-account-sid:impact-auth-token').toString('base64'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }),
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"ActionTrackerId":71659');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"OrderId":"in_123"');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"ClickId":"impact-click-123"');
  });
});
