import { getMiniMaxUsage, MiniMaxUsageError } from '@/lib/coding-plans/minimax-usage';

const API_KEY = 'sk-cp-managed-secret';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    base_resp: { status_code: 0, status_msg: 'provider message' },
    model_remains: [
      {
        model_name: 'general',
        current_interval_remaining_percent: 83,
        current_interval_status: 1,
        end_time: 1_781_280_000_000,
        current_weekly_remaining_percent: 72,
        current_weekly_status: 1,
        weekly_end_time: 1_781_884_800_000,
        unknown_secret: 'strip me',
      },
    ],
    unknown_top_level: 'strip me',
    ...overrides,
  };
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('MiniMax managed usage transport', () => {
  it('uses the fixed endpoint and returns only allowlisted native fields', async () => {
    const request = jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(payload()));

    const result = await getMiniMaxUsage(API_KEY);

    expect(request).toHaveBeenCalledWith(
      'https://api.minimax.io/v1/token_plan/remains',
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        signal: expect.any(AbortSignal),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
      })
    );
    expect(result).toEqual({
      base_resp: { status_code: 0 },
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: 83,
          current_interval_status: 1,
          end_time: 1_781_280_000_000,
          current_weekly_remaining_percent: 72,
          current_weekly_status: 1,
          weekly_end_time: 1_781_884_800_000,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('provider message');
    expect(JSON.stringify(result)).not.toContain('unknown_secret');
  });

  it('rejects declared and streamed oversized responses', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response('{}', { status: 200, headers: { 'content-length': String(64 * 1024 + 1) } })
      )
      .mockResolvedValueOnce(new Response('x'.repeat(64 * 1024 + 1), { status: 200 }));

    await expect(getMiniMaxUsage(API_KEY)).rejects.toMatchObject({ code: 'too_large' });
    await expect(getMiniMaxUsage(API_KEY)).rejects.toMatchObject({ code: 'too_large' });
  });

  it.each([
    ['http', new Response('raw upstream body', { status: 429 })],
    ['invalid_json', new Response('raw invalid json', { status: 200 })],
    ['invalid_schema', jsonResponse({ base_resp: { status_code: 0 }, model_remains: 'wrong' })],
    [
      'application',
      jsonResponse(payload({ base_resp: { status_code: 1004, status_msg: 'secret' } })),
    ],
  ] as const)('maps %s failures without exposing provider data', async (code, response) => {
    jest.spyOn(global, 'fetch').mockResolvedValue(response);

    await expect(getMiniMaxUsage(API_KEY)).rejects.toEqual(
      expect.objectContaining({
        code,
        message: 'MiniMax usage is temporarily unavailable.',
      })
    );
  });

  it('maps request failures to a safe network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error(`network body ${API_KEY}`));

    const error = await getMiniMaxUsage(API_KEY).catch(value => value);
    expect(error).toBeInstanceOf(MiniMaxUsageError);
    expect(error).toMatchObject({
      code: 'network',
      message: 'MiniMax usage is temporarily unavailable.',
    });
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });
});
