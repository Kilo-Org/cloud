import * as z from 'zod';
import {
  GATEWAY_USAGE_COLUMNS,
  GatewayUsageRangeSchema,
  gatewayUsageToTsv,
  queryGatewayUsageRange,
  type GatewayUsageProgress,
  type GatewayUsageRangeInput,
  type GatewayUsageRow,
} from './gateway-usage-report';

const row: GatewayUsageRow = {
  date: '2024-02-28',
  provider: 'openrouter',
  is_byok: false,
  users: '123',
  logged_in_users: '100',
  input_tokens: '9007199254740993',
  output_tokens: '200',
  cache_read_tokens: '300',
  cache_write_tokens: '400',
  cost: '1234567.890123',
  market_cost: '7654321.123456',
};

const range: GatewayUsageRangeInput = {
  startDate: '2024-02-28',
  endDate: '2024-03-01',
  model: 'test-model',
};

function createOptions() {
  const controller = new AbortController();
  return {
    controller,
    signal: controller.signal,
    fetchDay: jest
      .fn<Promise<GatewayUsageRow[]>, [{ date: string; model: string }, AbortSignal]>()
      .mockResolvedValue([]),
    onProgress: jest.fn<void, [GatewayUsageProgress]>(),
  };
}

describe('GatewayUsageRangeSchema', () => {
  it('accepts the full date range and trims the model before checking its length', () => {
    expect(
      GatewayUsageRangeSchema.parse({
        startDate: '2000-01-01',
        endDate: '9999-12-31',
        model: ` \t${'x'.repeat(256)}\n `,
      })
    ).toEqual({ startDate: '2000-01-01', endDate: '9999-12-31', model: 'x'.repeat(256) });
    expect(GatewayUsageRangeSchema.parse({ ...range, model: ' x ' }).model).toBe('x');
  });

  describe.each(['startDate', 'endDate'] as const)('%s validation', field => {
    it.each([
      '',
      '1999-12-31',
      '10000-01-01',
      '+010000-01-01',
      '2023-02-29',
      '2100-02-29',
      '2024-02-30',
      '2024-04-31',
      '2024-00-01',
      '2024-13-01',
      '2024-01-00',
      '2024-01-32',
      '2024-2-01',
      '2024-02-1',
      '2024-02-28T00:00:00Z',
      ' 2024-02-28 ',
    ])('rejects %j without fetching or reporting progress', async date => {
      const input = {
        startDate: '2000-01-01',
        endDate: '9999-12-31',
        model: range.model,
        [field]: date,
      };
      const options = createOptions();
      expect(GatewayUsageRangeSchema.safeParse(input).success).toBe(false);
      await expect(queryGatewayUsageRange(input, options)).rejects.toBeInstanceOf(z.ZodError);
      expect(options.fetchDay).not.toHaveBeenCalled();
      expect(options.onProgress).not.toHaveBeenCalled();
    });
  });

  it('rejects reversed dates on endDate without fetching', async () => {
    const input = { ...range, startDate: range.endDate, endDate: range.startDate };
    const options = createOptions();
    const parsed = GatewayUsageRangeSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: ['endDate'],
        message: 'End date must be on or after start date',
      }),
    ]);
    await expect(queryGatewayUsageRange(input, options)).rejects.toBeInstanceOf(z.ZodError);
    expect(options.fetchDay).not.toHaveBeenCalled();
    expect(options.onProgress).not.toHaveBeenCalled();
  });

  it.each(['', ' \t\n ', 'x'.repeat(257)])(
    'rejects invalid model %j without fetching',
    async model => {
      const options = createOptions();
      await expect(queryGatewayUsageRange({ ...range, model }, options)).rejects.toBeInstanceOf(
        z.ZodError
      );
      expect(options.fetchDay).not.toHaveBeenCalled();
      expect(options.onProgress).not.toHaveBeenCalled();
    }
  );
});

describe('queryGatewayUsageRange', () => {
  it.each([
    { name: 'single day', dates: ['2026-09-03'] },
    { name: 'leap day', dates: ['2024-02-28', '2024-02-29', '2024-03-01'] },
    { name: 'leap century', dates: ['2000-02-28', '2000-02-29', '2000-03-01'] },
    { name: 'non-leap February', dates: ['2025-02-28', '2025-03-01'] },
    { name: 'non-leap century', dates: ['2100-02-28', '2100-03-01'] },
    { name: 'month boundary', dates: ['2026-04-30', '2026-05-01'] },
    { name: 'year boundary', dates: ['2025-12-31', '2026-01-01'] },
    { name: 'spring DST boundary', dates: ['2026-03-07', '2026-03-08', '2026-03-09'] },
    { name: 'autumn DST boundary', dates: ['2026-10-31', '2026-11-01', '2026-11-02'] },
    { name: 'minimum date', dates: ['2000-01-01', '2000-01-02'] },
    { name: 'maximum date', dates: ['9999-12-30', '9999-12-31'] },
  ])('queries each UTC day inclusively across $name', async ({ dates }) => {
    const options = createOptions();
    const input = { startDate: dates[0], endDate: dates[dates.length - 1], model: ' test-model ' };
    await expect(queryGatewayUsageRange(input, options)).resolves.toEqual([]);
    expect(options.fetchDay.mock.calls).toEqual(
      dates.map(date => [{ date, model: 'test-model' }, options.signal])
    );
    expect(options.onProgress.mock.calls.map(([progress]) => progress)).toEqual(
      dates.flatMap((date, index) => [
        { date, completedDays: index, totalDays: dates.length },
        { date, completedDays: index + 1, totalDays: dates.length },
      ])
    );
  });

  it('fully awaits each day before scheduling the next and preserves row ordering', async () => {
    const first = Promise.withResolvers<GatewayUsageRow[]>();
    const second = Promise.withResolvers<GatewayUsageRow[]>();
    const third = Promise.withResolvers<GatewayUsageRow[]>();
    const options = createOptions();
    options.fetchDay
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const secondRow = { ...row, date: '2024-02-29' };
    const thirdRow = { ...row, date: '2024-03-01' };
    const otherProvider = { ...thirdRow, provider: 'other-provider' };
    const result = queryGatewayUsageRange(range, options);

    await Promise.resolve();
    expect(options.fetchDay).toHaveBeenCalledTimes(1);
    expect(options.onProgress.mock.calls).toEqual([
      [{ date: '2024-02-28', completedDays: 0, totalDays: 3 }],
    ]);

    first.resolve([row]);
    await first.promise;
    expect(options.fetchDay).toHaveBeenCalledTimes(2);
    expect(options.fetchDay).toHaveBeenNthCalledWith(
      2,
      { date: '2024-02-29', model: range.model },
      options.signal
    );
    expect(options.onProgress).toHaveBeenLastCalledWith({
      date: '2024-02-29',
      completedDays: 1,
      totalDays: 3,
    });

    second.resolve([secondRow]);
    await second.promise;
    expect(options.fetchDay).toHaveBeenCalledTimes(3);
    expect(options.fetchDay).toHaveBeenNthCalledWith(
      3,
      { date: '2024-03-01', model: range.model },
      options.signal
    );
    expect(options.onProgress).toHaveBeenLastCalledWith({
      date: '2024-03-01',
      completedDays: 2,
      totalDays: 3,
    });

    third.resolve([thirdRow, otherProvider]);
    await expect(result).resolves.toEqual([row, secondRow, thirdRow, otherProvider]);
    expect(options.fetchDay).toHaveBeenCalledTimes(3);
    expect(options.onProgress).toHaveBeenLastCalledWith({
      date: '2024-03-01',
      completedDays: 3,
      totalDays: 3,
    });
  });

  it('reports progress before each fetch and after completion, including empty days', async () => {
    const options = createOptions();
    const events: (GatewayUsageProgress | string)[] = [];
    options.onProgress.mockImplementation(progress => {
      events.push(progress);
    });
    options.fetchDay.mockImplementation(async ({ date }) => {
      events.push(`fetch ${date}`);
      return date === row.date ? [row] : [];
    });

    await expect(queryGatewayUsageRange(range, options)).resolves.toEqual([row]);
    expect(events).toEqual([
      { date: '2024-02-28', completedDays: 0, totalDays: 3 },
      'fetch 2024-02-28',
      { date: '2024-02-28', completedDays: 1, totalDays: 3 },
      { date: '2024-02-29', completedDays: 1, totalDays: 3 },
      'fetch 2024-02-29',
      { date: '2024-02-29', completedDays: 2, totalDays: 3 },
      { date: '2024-03-01', completedDays: 2, totalDays: 3 },
      'fetch 2024-03-01',
      { date: '2024-03-01', completedDays: 3, totalDays: 3 },
    ]);
  });

  it('keeps daily distinct user counts separate and preserves numeric string precision', async () => {
    const options = createOptions();
    const secondRow = { ...row, date: '2024-02-29', cost: '0.000000000000000001' };
    options.fetchDay.mockResolvedValueOnce([row]).mockResolvedValueOnce([secondRow]);

    const rows = await queryGatewayUsageRange({ ...range, endDate: secondRow.date }, options);
    expect(rows).toEqual([row, secondRow]);
    expect(rows[0]).toBe(row);
    expect(rows[1]).toBe(secondRow);
    expect(rows.map(result => result.users)).toEqual(['123', '123']);
    expect(rows.map(result => result.input_tokens)).toEqual([
      '9007199254740993',
      '9007199254740993',
    ]);
    expect(gatewayUsageToTsv(rows)).toBe(
      `${GATEWAY_USAGE_COLUMNS.join('\t')}\n` +
        '2024-02-28\topenrouter\tfalse\t123\t100\t9007199254740993\t200\t300\t400\t1234567.890123\t7654321.123456\n' +
        '2024-02-29\topenrouter\tfalse\t123\t100\t9007199254740993\t200\t300\t400\t0.000000000000000001\t7654321.123456'
    );
  });

  it.each([new Error('daily query failed'), 'daily query failed'])(
    'includes the failed date and stops scheduling after %p',
    async failure => {
      const options = createOptions();
      options.fetchDay.mockResolvedValueOnce([row]).mockRejectedValueOnce(failure);

      await expect(queryGatewayUsageRange(range, options)).rejects.toMatchObject({
        message: 'Failed to fetch gateway usage for 2024-02-29: daily query failed',
        cause: failure,
      });
      expect(options.fetchDay).toHaveBeenCalledTimes(2);
      expect(options.onProgress.mock.calls).toEqual([
        [{ date: '2024-02-28', completedDays: 0, totalDays: 3 }],
        [{ date: '2024-02-28', completedDays: 1, totalDays: 3 }],
        [{ date: '2024-02-29', completedDays: 1, totalDays: 3 }],
      ]);
    }
  );

  it('includes the date when fetchDay throws synchronously', async () => {
    const options = createOptions();
    options.fetchDay.mockImplementation(() => {
      throw new Error('synchronous failure');
    });

    await expect(queryGatewayUsageRange(range, options)).rejects.toThrow(
      'Failed to fetch gateway usage for 2024-02-28: synchronous failure'
    );
    expect(options.fetchDay).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, new Error('cancelled'), 'custom cancellation'])(
    'preserves abort reason %p before querying without progress',
    async reason => {
      const options = createOptions();
      options.controller.abort(reason);

      await expect(queryGatewayUsageRange(range, options)).rejects.toBe(options.signal.reason);
      expect(options.fetchDay).not.toHaveBeenCalled();
      expect(options.onProgress).not.toHaveBeenCalled();
    }
  );

  it.each(['resolve', 'reject'] as const)(
    'does not complete or schedule another day when an aborted fetch later %ss',
    async outcome => {
      const pending = Promise.withResolvers<GatewayUsageRow[]>();
      const options = createOptions();
      options.fetchDay.mockReturnValueOnce(pending.promise);
      const result = queryGatewayUsageRange(range, options);
      options.controller.abort();
      const assertion = expect(result).rejects.toBe(options.signal.reason);
      if (outcome === 'resolve') pending.resolve([row]);
      else pending.reject(new Error('transport error after cancellation'));

      await assertion;
      expect(options.fetchDay).toHaveBeenCalledTimes(1);
      expect(options.onProgress.mock.calls).toEqual([
        [{ date: '2024-02-28', completedDays: 0, totalDays: 3 }],
      ]);
    }
  );

  it.each([
    new DOMException('Request aborted', 'AbortError'),
    Object.assign(new Error('Request aborted'), { name: 'AbortError' }),
    { name: 'AbortError', message: 'Request aborted' },
  ])('preserves fetch AbortError %p even if the signal is not aborted', async failure => {
    const options = createOptions();
    options.fetchDay.mockRejectedValueOnce(failure);

    await expect(queryGatewayUsageRange(range, options)).rejects.toBe(failure);
    expect(options.signal.aborted).toBe(false);
    expect(options.fetchDay).toHaveBeenCalledTimes(1);
    expect(options.onProgress).toHaveBeenCalledTimes(1);
  });

  it('does not fetch if progress cancels the current day before it starts', async () => {
    const options = createOptions();
    options.onProgress.mockImplementation(() => {
      options.controller.abort();
    });

    await expect(queryGatewayUsageRange(range, options)).rejects.toBe(options.signal.reason);
    expect(options.fetchDay).not.toHaveBeenCalled();
    expect(options.onProgress).toHaveBeenCalledTimes(1);
  });

  it.each([range.endDate, range.startDate])(
    'honors cancellation after a day completes even when it is the final day (%s)',
    async endDate => {
      const options = createOptions();
      options.onProgress.mockImplementation(({ completedDays }) => {
        if (completedDays === 1) options.controller.abort();
      });
      const result = queryGatewayUsageRange({ ...range, endDate }, options);

      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      expect(options.fetchDay).toHaveBeenCalledTimes(1);
      expect(options.onProgress).toHaveBeenCalledTimes(2);
    }
  );

  it('reports the full supported range total and allows cancellation before the first fetch', async () => {
    const options = createOptions();
    options.onProgress.mockImplementation(() => {
      options.controller.abort();
    });

    await expect(
      queryGatewayUsageRange({ ...range, startDate: '2000-01-01', endDate: '9999-12-31' }, options)
    ).rejects.toBe(options.signal.reason);
    expect(options.onProgress).toHaveBeenCalledWith({
      date: '2000-01-01',
      completedDays: 0,
      totalDays: 2_921_940,
    });
    expect(options.fetchDay).not.toHaveBeenCalled();
  });
});

describe('gatewayUsageToTsv', () => {
  it('includes date first and exact numeric values without formatting or rounding', () => {
    expect(GATEWAY_USAGE_COLUMNS).toEqual([
      'date',
      'provider',
      'is_byok',
      'users',
      'logged_in_users',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'cost',
      'market_cost',
    ]);
    expect(gatewayUsageToTsv([row])).toBe(
      `${GATEWAY_USAGE_COLUMNS.join('\t')}\n2024-02-28\topenrouter\tfalse\t123\t100\t9007199254740993\t200\t300\t400\t1234567.890123\t7654321.123456`
    );
  });

  it('preserves true BYOK and negative costs as spreadsheet values', () => {
    expect(gatewayUsageToTsv([{ ...row, is_byok: true, cost: '-1.25' }]).split('\n')[1]).toBe(
      '2024-02-28\topenrouter\ttrue\t123\t100\t9007199254740993\t200\t300\t400\t-1.25\t7654321.123456'
    );
  });

  it('copies nullable values as empty cells, not zeros', () => {
    expect(
      gatewayUsageToTsv([
        { ...row, provider: null, is_byok: null, input_tokens: null, market_cost: null },
      ]).split('\n')[1]
    ).toBe('2024-02-28\t\t\t123\t100\t\t200\t300\t400\t1234567.890123\t');
  });

  it.each(['=SUM(1,2)', '+1', '-1', '@SUM(1)', '  =SUM(1)'])(
    'neutralizes provider spreadsheet formulas: %s',
    provider => {
      expect(
        gatewayUsageToTsv([{ ...row, provider }])
          .split('\n')[1]
          .split('\t')[1]
      ).toBe(`'${provider}`);
    }
  );

  it('keeps provider tabs and line breaks from creating extra rows or cells', () => {
    const tsv = gatewayUsageToTsv([{ ...row, provider: '\t=SUM(1)\r\nprovider' }]);
    expect(tsv.split('\n')).toHaveLength(2);
    expect(tsv.split('\n')[1].split('\t')).toHaveLength(GATEWAY_USAGE_COLUMNS.length);
    expect(tsv.split('\n')[1].split('\t')[1]).toBe("' =SUM(1)  provider");
  });

  it('escapes provider quotes using spreadsheet field quoting', () => {
    expect(
      gatewayUsageToTsv([{ ...row, provider: 'a "quoted" provider' }])
        .split('\n')[1]
        .split('\t')[1]
    ).toBe('"a ""quoted"" provider"');
  });

  it('neutralizes quoted formulas and preserves decimal scale and zero values', () => {
    expect(
      gatewayUsageToTsv([
        { ...row, provider: '=SUM("1")', users: '0', input_tokens: '0.000', cost: '-0.000000' },
      ]).split('\n')[1]
    ).toBe(
      '2024-02-28\t"\'=SUM(""1"")"\tfalse\t0\t100\t0.000\t200\t300\t400\t-0.000000\t7654321.123456'
    );
  });

  it('returns only headers for empty results', () => {
    expect(gatewayUsageToTsv([])).toBe(GATEWAY_USAGE_COLUMNS.join('\t'));
  });
});
