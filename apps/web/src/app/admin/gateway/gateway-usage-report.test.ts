import { QueryClient, QueryObserver, type QueryObserverResult } from '@tanstack/react-query';
import * as z from 'zod';
import {
  GATEWAY_USAGE_COLUMNS,
  GatewayUsageRangeSchema,
  gatewayUsageRangeQueryOptions,
  gatewayUsageToTsv,
  queryGatewayUsageRange,
  type GatewayUsageRangeInput,
  type GatewayUsageReport,
  type GatewayUsageRow,
} from './gateway-usage-report';

const row: GatewayUsageRow = {
  hour_start: '2024-02-28T00:00:00.000Z',
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
const singleDay = { ...range, endDate: range.startDate };

function hourStart(date: string, hour: number): string {
  return `${date}T${String(hour).padStart(2, '0')}:00:00.000Z`;
}

function createOptions() {
  const controller = new AbortController();
  return {
    controller,
    signal: controller.signal,
    fetchHour: jest
      .fn<
        Promise<GatewayUsageRow[]>,
        [{ date: string; hour: number; model: string }, AbortSignal]
      >()
      .mockResolvedValue([]),
    onProgress: jest.fn<void, [GatewayUsageReport]>(),
  };
}

function snapshot(
  hour: number,
  completedHours: number,
  rows: GatewayUsageRow[] = []
): GatewayUsageReport {
  return {
    rows,
    progress: { hourStart: hourStart(singleDay.startDate, hour), completedHours, totalHours: 24 },
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
      expect(options.fetchHour).not.toHaveBeenCalled();
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
    expect(options.fetchHour).not.toHaveBeenCalled();
    expect(options.onProgress).not.toHaveBeenCalled();
  });

  it.each(['', ' \t\n ', 'x'.repeat(257)])(
    'rejects invalid model %j without fetching',
    async model => {
      const options = createOptions();
      await expect(queryGatewayUsageRange({ ...range, model }, options)).rejects.toBeInstanceOf(
        z.ZodError
      );
      expect(options.fetchHour).not.toHaveBeenCalled();
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
  ])('queries every UTC hour inclusively across $name', async ({ dates }) => {
    const options = createOptions();
    const input = { startDate: dates[0], endDate: dates[dates.length - 1], model: ' test-model ' };
    const hours = dates.flatMap(date => Array.from({ length: 24 }, (_, hour) => ({ date, hour })));
    const totalHours = hours.length;
    await expect(queryGatewayUsageRange(input, options)).resolves.toEqual({
      rows: [],
      progress: { hourStart: hourStart(input.endDate, 23), completedHours: totalHours, totalHours },
    });
    expect(options.fetchHour.mock.calls).toEqual(
      hours.map(hour => [{ ...hour, model: 'test-model' }, options.signal])
    );
    expect(options.onProgress.mock.calls.map(([report]) => report)).toEqual(
      hours.flatMap(({ date, hour }, index) => [
        {
          rows: [],
          progress: { hourStart: hourStart(date, hour), completedHours: index, totalHours },
        },
        {
          rows: [],
          progress: { hourStart: hourStart(date, hour), completedHours: index + 1, totalHours },
        },
      ])
    );
  });

  it('returns rows from hour 23 of the maximum supported date without advancing into year 10000', async () => {
    const options = createOptions();
    const lastRow = { ...row, hour_start: '9999-12-31T23:00:00.000Z' };
    options.fetchHour.mockImplementation(async ({ hour }) => (hour === 23 ? [lastRow] : []));

    await expect(
      queryGatewayUsageRange({ ...range, startDate: '9999-12-31', endDate: '9999-12-31' }, options)
    ).resolves.toEqual({
      rows: [lastRow],
      progress: { hourStart: lastRow.hour_start, completedHours: 24, totalHours: 24 },
    });
    expect(options.fetchHour).toHaveBeenCalledTimes(24);
    expect(options.fetchHour).toHaveBeenLastCalledWith(
      { date: '9999-12-31', hour: 23, model: range.model },
      options.signal
    );
  });

  it('publishes the first hour before the second completes and awaits each hour sequentially', async () => {
    const first = Promise.withResolvers<GatewayUsageRow[]>();
    const second = Promise.withResolvers<GatewayUsageRow[]>();
    const third = Promise.withResolvers<GatewayUsageRow[]>();
    const options = createOptions();
    options.fetchHour
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const secondRow = { ...row, hour_start: hourStart(singleDay.startDate, 1) };
    const thirdRow = { ...row, hour_start: hourStart(singleDay.startDate, 2) };
    const otherProvider = { ...thirdRow, provider: 'other-provider' };
    const result = queryGatewayUsageRange(singleDay, options);

    expect(options.fetchHour).toHaveBeenCalledTimes(1);
    expect(options.onProgress.mock.calls).toEqual([[snapshot(0, 0)]]);

    first.resolve([row]);
    await first.promise;
    expect(options.fetchHour).toHaveBeenCalledTimes(2);
    expect(options.fetchHour).toHaveBeenNthCalledWith(
      2,
      { date: singleDay.startDate, hour: 1, model: range.model },
      options.signal
    );
    expect(options.onProgress.mock.calls).toEqual([
      [snapshot(0, 0)],
      [snapshot(0, 1, [row])],
      [snapshot(1, 1, [row])],
    ]);
    const firstCompletedSnapshot = options.onProgress.mock.calls[1][0];

    second.resolve([secondRow]);
    await second.promise;
    expect(options.fetchHour).toHaveBeenCalledTimes(3);
    expect(options.fetchHour).toHaveBeenNthCalledWith(
      3,
      { date: singleDay.startDate, hour: 2, model: range.model },
      options.signal
    );
    expect(options.onProgress).toHaveBeenLastCalledWith(snapshot(2, 2, [row, secondRow]));
    expect(firstCompletedSnapshot).toEqual(snapshot(0, 1, [row]));

    third.resolve([thirdRow, otherProvider]);
    await expect(result).resolves.toEqual(
      snapshot(23, 24, [row, secondRow, thirdRow, otherProvider])
    );
    expect(options.fetchHour).toHaveBeenCalledTimes(24);
    expect(options.onProgress).toHaveBeenCalledTimes(48);
    expect(options.onProgress).toHaveBeenLastCalledWith(
      snapshot(23, 24, [row, secondRow, thirdRow, otherProvider])
    );
    expect(firstCompletedSnapshot).toEqual(snapshot(0, 1, [row]));
  });

  it('publishes before each fetch and after completion, including empty hours', async () => {
    const options = createOptions();
    const events: (GatewayUsageReport | string)[] = [];
    options.onProgress.mockImplementation(report => {
      events.push(report);
    });
    options.fetchHour.mockImplementation(async ({ date, hour }) => {
      events.push(`fetch ${hourStart(date, hour)}`);
      return hour === 0 ? [row] : [];
    });

    await expect(queryGatewayUsageRange(singleDay, options)).resolves.toEqual(
      snapshot(23, 24, [row])
    );
    expect(events).toEqual(
      Array.from({ length: 24 }, (_, hour) => [
        snapshot(hour, hour, hour === 0 ? [] : [row]),
        `fetch ${hourStart(singleDay.startDate, hour)}`,
        snapshot(hour, hour + 1, [row]),
      ]).flat()
    );
  });

  it('keeps hourly distinct counts separate and preserves numeric string precision', async () => {
    const options = createOptions();
    const secondRow = {
      ...row,
      hour_start: hourStart(singleDay.startDate, 1),
      cost: '0.000000000000000001',
    };
    options.fetchHour.mockResolvedValueOnce([row]).mockResolvedValueOnce([secondRow]);

    const { rows } = await queryGatewayUsageRange(singleDay, options);
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
        '2024-02-28T00:00:00.000Z\topenrouter\tfalse\t123\t100\t9007199254740993\t200\t300\t400\t1234567.890123\t7654321.123456\n' +
        '2024-02-28T01:00:00.000Z\topenrouter\tfalse\t123\t100\t9007199254740993\t200\t300\t400\t0.000000000000000001\t7654321.123456'
    );
  });

  it('does not mutate snapshots or reuse accumulated rows across repeated runs', async () => {
    const options = createOptions();
    options.onProgress.mockImplementation(report => {
      Object.freeze(report.rows);
      Object.freeze(report.progress);
      Object.freeze(report);
    });
    options.fetchHour.mockResolvedValueOnce([row]);
    const first = await queryGatewayUsageRange(singleDay, options);
    const firstSnapshots = options.onProgress.mock.calls.map(([report]) => report);
    const nextRow = { ...row, provider: 'another-provider' };
    options.fetchHour.mockResolvedValueOnce([nextRow]);
    const second = await queryGatewayUsageRange(singleDay, options);

    expect(firstSnapshots[0]).toEqual(snapshot(0, 0));
    expect(firstSnapshots[1]).toEqual(snapshot(0, 1, [row]));
    expect(first).toEqual(snapshot(23, 24, [row]));
    expect(first).toBe(firstSnapshots[47]);
    expect(options.onProgress.mock.calls[48][0]).toEqual(snapshot(0, 0));
    expect(second).toEqual(snapshot(23, 24, [nextRow]));
    expect(second.rows).not.toBe(first.rows);
    expect(options.onProgress).toHaveBeenCalledTimes(96);
  });

  it.each([new Error('hourly query failed'), 'hourly query failed'])(
    'includes the failed UTC hour and preserves earlier snapshots after %p',
    async failure => {
      const options = createOptions();
      options.fetchHour.mockResolvedValueOnce([row]).mockRejectedValueOnce(failure);

      await expect(queryGatewayUsageRange(singleDay, options)).rejects.toMatchObject({
        message: 'Failed to fetch gateway usage for 2024-02-28T01:00:00.000Z: hourly query failed',
        cause: failure,
      });
      expect(options.fetchHour).toHaveBeenCalledTimes(2);
      expect(options.onProgress.mock.calls).toEqual([
        [snapshot(0, 0)],
        [snapshot(0, 1, [row])],
        [snapshot(1, 1, [row])],
      ]);
    }
  );

  it('includes the UTC hour when fetchHour throws synchronously', async () => {
    const options = createOptions();
    options.fetchHour.mockImplementation(() => {
      throw new Error('synchronous failure');
    });

    await expect(queryGatewayUsageRange(singleDay, options)).rejects.toThrow(
      'Failed to fetch gateway usage for 2024-02-28T00:00:00.000Z: synchronous failure'
    );
    expect(options.fetchHour).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, new Error('cancelled'), 'custom cancellation'])(
    'preserves abort reason %p before querying without progress',
    async reason => {
      const options = createOptions();
      options.controller.abort(reason);

      await expect(queryGatewayUsageRange(singleDay, options)).rejects.toBe(options.signal.reason);
      expect(options.fetchHour).not.toHaveBeenCalled();
      expect(options.onProgress).not.toHaveBeenCalled();
    }
  );

  it.each(['resolve', 'reject'] as const)(
    'does not publish or schedule another hour when an aborted fetch later %ss',
    async outcome => {
      const pending = Promise.withResolvers<GatewayUsageRow[]>();
      const options = createOptions();
      options.fetchHour.mockResolvedValueOnce([row]).mockReturnValueOnce(pending.promise);
      const result = queryGatewayUsageRange(singleDay, options);
      await Promise.resolve();
      expect(options.fetchHour).toHaveBeenCalledTimes(2);
      options.controller.abort();
      const assertion = expect(result).rejects.toBe(options.signal.reason);
      if (outcome === 'resolve')
        pending.resolve([{ ...row, hour_start: hourStart(singleDay.startDate, 1) }]);
      else pending.reject(new Error('transport error after cancellation'));

      await assertion;
      expect(options.fetchHour).toHaveBeenCalledTimes(2);
      expect(options.onProgress.mock.calls).toEqual([
        [snapshot(0, 0)],
        [snapshot(0, 1, [row])],
        [snapshot(1, 1, [row])],
      ]);
    }
  );

  it.each([
    new DOMException('Request aborted', 'AbortError'),
    Object.assign(new Error('Request aborted'), { name: 'AbortError' }),
    { name: 'AbortError', message: 'Request aborted' },
  ])('preserves fetch AbortError %p even if the signal is not aborted', async failure => {
    const options = createOptions();
    options.fetchHour.mockRejectedValueOnce(failure);

    await expect(queryGatewayUsageRange(singleDay, options)).rejects.toBe(failure);
    expect(options.signal.aborted).toBe(false);
    expect(options.fetchHour).toHaveBeenCalledTimes(1);
    expect(options.onProgress).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])('does not fetch if progress cancels hour %s before it starts', async hour => {
    const options = createOptions();
    const reason = new Error('Cancelled before the hour starts');
    options.onProgress.mockImplementation(({ progress }) => {
      if (progress.hourStart === hourStart(singleDay.startDate, hour))
        options.controller.abort(reason);
    });

    await expect(queryGatewayUsageRange(singleDay, options)).rejects.toBe(reason);
    expect(options.fetchHour).toHaveBeenCalledTimes(hour);
    expect(options.onProgress).toHaveBeenCalledTimes(hour * 2 + 1);
  });

  it.each([1, 24])(
    'honors cancellation after %s completed hours, including the final hour',
    async count => {
      const options = createOptions();
      options.onProgress.mockImplementation(({ progress }) => {
        if (progress.completedHours === count) options.controller.abort();
      });

      await expect(queryGatewayUsageRange(singleDay, options)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(options.fetchHour).toHaveBeenCalledTimes(count);
      expect(options.onProgress).toHaveBeenCalledTimes(count * 2);
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
      rows: [],
      progress: {
        hourStart: '2000-01-01T00:00:00.000Z',
        completedHours: 0,
        totalHours: 2_921_940 * 24,
      },
    });
    expect(options.fetchHour).not.toHaveBeenCalled();
  });
});

describe('gatewayUsageRangeQueryOptions', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient();
  });

  afterEach(() => {
    client.clear();
  });

  it('disables an unsubmitted range and opts out of automatic refetches and retries', async () => {
    const { fetchHour } = createOptions();
    const options = gatewayUsageRangeQueryOptions(null, fetchHour);
    const observer = new QueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => {});
    try {
      expect(options).toMatchObject({
        queryKey: ['admin-gateway-usage-hourly-range', null],
        enabled: false,
        staleTime: 0,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchOnMount: false,
      });
      expect(observer.getCurrentResult().isFetching).toBe(false);
      expect(observer.getCurrentResult().data).toBeUndefined();
      expect(fetchHour).not.toHaveBeenCalled();
      await expect(client.fetchQuery(options)).rejects.toThrow('Gateway usage range is required');
      expect(fetchHour).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('exposes progressive cache data to an observer while the next hour is still fetching', async () => {
    const first = Promise.withResolvers<GatewayUsageRow[]>();
    const second = Promise.withResolvers<GatewayUsageRow[]>();
    const { fetchHour } = createOptions();
    fetchHour.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const options = gatewayUsageRangeQueryOptions(singleDay, fetchHour);
    const observer = new QueryObserver(client, options);
    const observations: QueryObserverResult<GatewayUsageReport>[] = [];
    const unsubscribe = observer.subscribe(result => observations.push(result));
    const result = client.fetchQuery(options);
    try {
      expect(options.queryKey).toEqual(['admin-gateway-usage-hourly-range', singleDay]);
      expect(options.enabled).toBe(true);
      expect(observer.getCurrentResult()).toMatchObject({ isFetching: true, data: snapshot(0, 0) });
      expect(fetchHour).toHaveBeenCalledTimes(1);
      expect(fetchHour.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
      expect(fetchHour.mock.calls[0][1].aborted).toBe(false);

      first.resolve([row]);
      await first.promise;
      expect(fetchHour).toHaveBeenCalledTimes(2);
      expect(fetchHour.mock.calls[1][1]).toBe(fetchHour.mock.calls[0][1]);
      expect(observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ isFetching: true, data: snapshot(0, 1, [row]) }),
          expect.objectContaining({ isFetching: true, data: snapshot(1, 1, [row]) }),
        ])
      );
      expect(observer.getCurrentResult()).toMatchObject({
        isFetching: true,
        data: snapshot(1, 1, [row]),
      });
      expect(client.getQueryData(options.queryKey)).toBe(observer.getCurrentResult().data);

      second.resolve([]);
      await expect(result).resolves.toEqual(snapshot(23, 24, [row]));
      expect(observer.getCurrentResult()).toMatchObject({
        isFetching: false,
        isSuccess: true,
        data: snapshot(23, 24, [row]),
      });
      expect(fetchHour).toHaveBeenCalledTimes(24);
    } finally {
      unsubscribe();
      first.resolve([]);
      second.resolve([]);
    }
  });

  it('keeps earlier rows in the cache and observer when a later hour fails', async () => {
    const first = Promise.withResolvers<GatewayUsageRow[]>();
    const second = Promise.withResolvers<GatewayUsageRow[]>();
    const { fetchHour } = createOptions();
    fetchHour.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const options = gatewayUsageRangeQueryOptions(singleDay, fetchHour);
    const observer = new QueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => {});
    const result = client.fetchQuery(options);
    const failure = new Error('hour unavailable');
    const assertion = expect(result).rejects.toMatchObject({
      message: 'Failed to fetch gateway usage for 2024-02-28T01:00:00.000Z: hour unavailable',
      cause: failure,
    });
    try {
      first.resolve([row]);
      await first.promise;
      const partial = client.getQueryData(options.queryKey);
      expect(partial).toEqual(snapshot(1, 1, [row]));
      expect(observer.getCurrentResult().isFetching).toBe(true);
      second.reject(failure);
      await assertion;

      expect(client.getQueryData(options.queryKey)).toBe(partial);
      expect(observer.getCurrentResult()).toMatchObject({
        isFetching: false,
        isError: true,
        data: snapshot(1, 1, [row]),
        error: {
          message: 'Failed to fetch gateway usage for 2024-02-28T01:00:00.000Z: hour unavailable',
        },
      });
      expect(fetchHour).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      first.resolve([]);
      second.resolve([]);
    }
  });

  it.each([false, true])(
    'refetch clears old results without duplication (previous run failed: %s)',
    async failed => {
      const { fetchHour } = createOptions();
      fetchHour.mockResolvedValueOnce([row]);
      if (failed) fetchHour.mockRejectedValueOnce(new Error('first run failed'));
      const options = gatewayUsageRangeQueryOptions(singleDay, fetchHour);
      const observer = new QueryObserver(client, options);
      const unsubscribe = observer.subscribe(() => {});
      const first = Promise.withResolvers<GatewayUsageRow[]>();
      const second = Promise.withResolvers<GatewayUsageRow[]>();
      try {
        const initial = client.fetchQuery(options);
        if (failed) await expect(initial).rejects.toThrow('first run failed');
        else await expect(initial).resolves.toEqual(snapshot(23, 24, [row]));
        const previous = client.getQueryData(options.queryKey);
        expect(previous?.rows).toEqual([row]);
        const previousProgress = failed ? snapshot(1, 1, [row]) : snapshot(23, 24, [row]);
        expect(previous).toEqual(previousProgress);
        const previousCallCount = fetchHour.mock.calls.length;
        fetchHour.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

        const refetch = observer.refetch();
        expect(observer.getCurrentResult()).toMatchObject({
          isFetching: true,
          isError: false,
          data: snapshot(0, 0),
        });
        expect(client.getQueryData(options.queryKey)).toEqual(snapshot(0, 0));
        expect(fetchHour).toHaveBeenCalledTimes(previousCallCount + 1);
        expect(previous).toEqual(previousProgress);

        first.resolve([row]);
        await first.promise;
        expect(observer.getCurrentResult()).toMatchObject({
          isFetching: true,
          data: snapshot(1, 1, [row]),
        });
        const secondRow = { ...row, hour_start: hourStart(singleDay.startDate, 1) };
        second.resolve([secondRow]);
        await expect(refetch).resolves.toMatchObject({
          isSuccess: true,
          isFetching: false,
          data: snapshot(23, 24, [row, secondRow]),
        });
        expect(client.getQueryData(options.queryKey)).toEqual(snapshot(23, 24, [row, secondRow]));
        expect(fetchHour).toHaveBeenCalledTimes(previousCallCount + 24);
        expect(previous).toEqual(previousProgress);
      } finally {
        unsubscribe();
        first.resolve([]);
        second.resolve([]);
      }
    }
  );
});

describe('gatewayUsageToTsv', () => {
  it('includes hour_start first and exact numeric values without formatting or rounding', () => {
    expect(GATEWAY_USAGE_COLUMNS).toEqual([
      'hour_start',
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
      `${GATEWAY_USAGE_COLUMNS.join('\t')}\n2024-02-28T00:00:00.000Z\topenrouter\tfalse\t123\t100\t9007199254740993\t200\t300\t400\t1234567.890123\t7654321.123456`
    );
  });

  it('preserves true BYOK and negative costs as spreadsheet values', () => {
    expect(gatewayUsageToTsv([{ ...row, is_byok: true, cost: '-1.25' }]).split('\n')[1]).toBe(
      '2024-02-28T00:00:00.000Z\topenrouter\ttrue\t123\t100\t9007199254740993\t200\t300\t400\t-1.25\t7654321.123456'
    );
  });

  it('copies nullable values as empty cells, not zeros', () => {
    expect(
      gatewayUsageToTsv([
        { ...row, provider: null, is_byok: null, input_tokens: null, market_cost: null },
      ]).split('\n')[1]
    ).toBe('2024-02-28T00:00:00.000Z\t\t\t123\t100\t\t200\t300\t400\t1234567.890123\t');
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
      '2024-02-28T00:00:00.000Z\t"\'=SUM(""1"")"\tfalse\t0\t100\t0.000\t200\t300\t400\t-0.000000\t7654321.123456'
    );
  });

  it('returns only headers for empty results', () => {
    expect(gatewayUsageToTsv([])).toBe(GATEWAY_USAGE_COLUMNS.join('\t'));
  });
});
