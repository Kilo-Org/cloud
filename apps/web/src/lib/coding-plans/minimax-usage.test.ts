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
        start_time: 1_781_262_000_000,
        end_time: 1_781_280_000_000,
        current_weekly_remaining_percent: 72,
        current_weekly_status: 1,
        weekly_start_time: 1_781_280_000_000,
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
  it('uses the fixed endpoint and returns normalized subscription quota windows', async () => {
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
      fetchedAt: expect.stringContaining('T'),
      windows: [
        {
          id: 'short_term',
          remainingPercent: 83,
          startsAt: new Date(1_781_262_000_000).toISOString(),
          resetsAt: new Date(1_781_280_000_000).toISOString(),
          period: { unit: 'hour', value: 5 },
        },
        {
          id: 'weekly',
          remainingPercent: 72,
          startsAt: new Date(1_781_280_000_000).toISOString(),
          resetsAt: new Date(1_781_884_800_000).toISOString(),
          period: { unit: 'week', value: 1 },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('provider message');
    expect(JSON.stringify(result)).not.toContain('unknown_secret');
    expect(JSON.stringify(result)).not.toContain('model_name');
    expect(JSON.stringify(result)).not.toContain('status_code');
  });

  it('returns independently valid windows and applies weekly boosts above 100 percent', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse(
        payload({
          model_remains: [
            {
              model_name: 'general',
              current_interval_status: 3,
              current_weekly_remaining_percent: 100,
              current_weekly_status: 1,
              weekly_end_time: 1_781_884_800_000,
              weekly_boost_permille: 1500,
            },
          ],
        })
      )
    );

    await expect(getMiniMaxUsage(API_KEY)).resolves.toMatchObject({
      windows: [
        {
          id: 'weekly',
          remainingPercent: 150,
          period: { unit: 'week', value: 1 },
        },
      ],
    });
  });

  it('normalizes exhausted provider status to zero remaining percent', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      jsonResponse(
        payload({
          model_remains: [
            {
              model_name: 'general',
              current_interval_remaining_percent: 12,
              current_interval_status: 2,
              end_time: 1_781_280_000_000,
            },
          ],
        })
      )
    );

    await expect(getMiniMaxUsage(API_KEY)).resolves.toMatchObject({
      windows: [{ id: 'short_term', remainingPercent: 0 }],
    });
  });

  it.each([
    [
      'missing aggregate pool',
      payload({ model_remains: [{ model_name: 'video', current_interval_remaining_percent: 50 }] }),
    ],
    [
      'ambiguous aggregate pools',
      payload({
        model_remains: [
          { model_name: 'general', current_interval_remaining_percent: 50 },
          { model_name: 'general', current_interval_remaining_percent: 40 },
        ],
      }),
    ],
    [
      'missing reset timestamps',
      payload({
        model_remains: [{ model_name: 'general', current_interval_remaining_percent: 50 }],
      }),
    ],
  ])('rejects %s without exposing provider data', async (_description, body) => {
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(body));

    await expect(getMiniMaxUsage(API_KEY)).rejects.toMatchObject({
      code: 'invalid_schema',
      message: 'MiniMax usage is temporarily unavailable.',
    });
  });

  it('rejects declared and streamed oversized responses', async () => {
    const declaredCancel = jest.fn();
    const streamedCancel = jest.fn();
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel: declaredCancel }), {
          status: 200,
          headers: { 'content-length': String(64 * 1024 + 1) },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(64 * 1024 + 1));
            },
            cancel: streamedCancel,
          }),
          { status: 200 }
        )
      );

    await expect(getMiniMaxUsage(API_KEY)).rejects.toMatchObject({ code: 'too_large' });
    await expect(getMiniMaxUsage(API_KEY)).rejects.toMatchObject({ code: 'too_large' });
    expect(declaredCancel).toHaveBeenCalledTimes(1);
    expect(streamedCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels unsuccessful HTTP response bodies before returning', async () => {
    const cancel = jest.fn();
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        status: 429,
      })
    );

    await expect(getMiniMaxUsage(API_KEY)).rejects.toMatchObject({ code: 'http' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['http', new Response('raw upstream body', { status: 429 })],
    ['invalid_json', new Response('raw invalid json', { status: 200 })],
    ['invalid_schema', jsonResponse({ base_resp: { status_code: 0 }, model_remains: 'wrong' })],
    ['application', jsonResponse({ base_resp: { status_code: 1004, status_msg: 'secret' } })],
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
