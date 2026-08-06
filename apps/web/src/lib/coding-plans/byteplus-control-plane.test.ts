jest.mock('@/lib/config.server', () => ({
  BYTEPLUS_CODING_PLAN_ACCESS_KEY_ID: 'test-access',
  BYTEPLUS_CODING_PLAN_SECRET_ACCESS_KEY: 'test-secret',
}));

import {
  getBytePlusSeatUsage,
  listBytePlusSeatsByUsername,
  BytePlusControlPlaneError,
} from '@/lib/coding-plans/byteplus-control-plane';

const FIXED_NOW = new Date('2026-08-06T12:13:14.000Z');

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function listPayload(overrides: Record<string, unknown> = {}) {
  return {
    ResponseMetadata: { RequestId: 'request-id', unknown: 'strip me' },
    Result: {
      Data: [
        {
          SeatID: 'seat-123',
          UserName: 'seat-user',
          BizInfo: 'lite',
          SeatStatus: '2',
          BillingStatus: 2,
          ApiKey: 'inference-key',
          AccountID: 'account-secret',
          IdentityId: 'identity-secret',
          ...overrides,
        },
      ],
      Total: 1,
      BizSummaries: [{ BizInfo: 'Lite', TotalCount: 1 }],
    },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('BytePlus control-plane client', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(FIXED_NOW);
  });

  it('creates a deterministic canonical request and signs fixed provider settings', async () => {
    const request = jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(listPayload()));

    const result = await listBytePlusSeatsByUsername({
      username: 'seat-user',
      bizInfo: 'Lite',
    });
    expect(result).toEqual([
      {
        seatId: 'seat-123',
        bizInfo: 'Lite',
        seatStatus: 2,
        billingStatus: 2,
        apiKey: 'inference-key',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('seat-user');
    expect(JSON.stringify(result)).not.toContain('account-secret');
    expect(JSON.stringify(result)).not.toContain('identity-secret');

    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://ark.ap-southeast-1.byteplusapi.com/?Action=ListSeatInfos&Version=2024-01-01'
    );
    expect(init).toEqual(
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
        redirect: 'error',
        signal: expect.any(AbortSignal),
        body: '{"Filter":{"BillingStatus":[2],"BizInfo":"Lite","SeatStatus":2,"UserName":"seat-user"},"PageNum":1,"PageSize":100,"ProjectName":"default"}',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          host: 'ark.ap-southeast-1.byteplusapi.com',
          'x-content-sha256': 'afc02609705b4a56589bcc2cf5542fa771c24dc4f32d936832128614bdca287b',
          'x-date': '20260806T121314Z',
          Authorization:
            'HMAC-SHA256 Credential=test-access/20260806/ap-southeast-1/ark/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=0539a0ec8623bc99f6174cf118671e65a0827b5b024ba359040cd4b98e2a4eda',
        },
      })
    );
  });

  it('uses exact seat filters and field-picks the live ListSeatInfos response', async () => {
    const request = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse(listPayload({ UserName: 'assigned-user', BizInfo: 'pro' })));

    await listBytePlusSeatsByUsername('assigned-user', 'Pro');

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      Filter: {
        BizInfo: 'Pro',
        UserName: 'assigned-user',
        SeatStatus: 2,
        BillingStatus: [2],
      },
      PageNum: 1,
      PageSize: 100,
      ProjectName: 'default',
    });
  });

  it('parses the validated direct Result usage shape and strips provider fields', async () => {
    const request = jest.spyOn(global, 'fetch').mockImplementation(async () =>
      jsonResponse({
        ResponseMetadata: { RequestId: 'request-id' },
        Result: {
          SeatID: 'seat-123',
          AccountID: 123,
          UserID: 456,
          UserName: 'seat-user',
          ShortTermUsage: 12.5,
          WeeklyUsage: 55,
          MonthlyUsage: 101,
          ShortTermResetMilestone: 1_781_280_000_000,
          WeeklyResetMilestone: 1_781_884_800_000,
          MonthlyResetMilestone: 1_783_000_000_000,
          unknown: 'strip me',
        },
      })
    );

    const result = await getBytePlusSeatUsage('seat-123');
    expect(result).toEqual({
      shortTermUsage: 12.5,
      weeklyUsage: 55,
      monthlyUsage: 101,
      shortTermResetMilestone: 1_781_280_000_000,
      weeklyResetMilestone: 1_781_884_800_000,
      monthlyResetMilestone: 1_783_000_000_000,
    });
    expect(JSON.stringify(result)).not.toContain('seat-user');
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ SeatID: 'seat-123' });
  });

  it('rejects the documented wrapper instead of forwarding an unvalidated response', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse({ Result: { SeatInfoUsage: { ShortTermUsage: 1 } } }));

    await expect(getBytePlusSeatUsage('seat-123')).rejects.toMatchObject({
      code: 'invalid_response',
      message: 'BytePlus Coding Plan service is temporarily unavailable.',
    });
  });

  it.each([
    ['http', new Response('provider secret body', { status: 503 })],
    ['invalid_response', new Response('{not json', { status: 200 })],
    ['application', jsonResponse({ ResponseMetadata: { ErrorMessage: 'provider secret' } })],
    [
      'invalid_response',
      new Response('x'.repeat(65 * 1024), {
        status: 200,
        headers: { 'content-length': String(65 * 1024) },
      }),
    ],
  ] as const)('maps %s failures without provider details', async (code, response) => {
    jest.spyOn(global, 'fetch').mockResolvedValue(response);

    const error = await getBytePlusSeatUsage('seat-secret').catch(value => value);
    expect(error).toBeInstanceOf(BytePlusControlPlaneError);
    expect(error).toMatchObject({
      code,
      message: 'BytePlus Coding Plan service is temporarily unavailable.',
    });
    expect(JSON.stringify(error)).not.toContain('provider secret');
    expect(JSON.stringify(error)).not.toContain('seat-secret');
  });

  it.each([
    ['network', new Error('network body contains test-secret and seat-secret')],
    ['timeout', new DOMException('timed out', 'TimeoutError')],
  ] as const)('maps %s request failures safely', async (code, error) => {
    jest.spyOn(global, 'fetch').mockRejectedValue(error);

    await expect(getBytePlusSeatUsage('seat-secret')).rejects.toMatchObject({
      code,
      message: 'BytePlus Coding Plan service is temporarily unavailable.',
    });
  });
});
