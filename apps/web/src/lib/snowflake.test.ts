import { getEventListeners } from 'node:events';
import jwt from 'jsonwebtoken';
import { executeSnowflakeStatement, type SnowflakeConfig } from './snowflake';

jest.mock('jsonwebtoken', () => ({
  __esModule: true,
  default: { sign: jest.fn(() => 'test-jwt') },
}));

const STATUS_URL = '/api/v2/statements/handle-1';
const START_TIME = new Date('2026-09-01T00:00:00Z').getTime();

let config: SnowflakeConfig;
let fetchMock: jest.SpiedFunction<typeof fetch>;

function pendingResponse() {
  return Response.json({ statementStatusUrl: STATUS_URL }, { status: 202 });
}

function waitForAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  if (!signal) throw new Error('Expected an abort signal');
  return new Promise((_resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

beforeEach(() => {
  jest.useFakeTimers({ now: START_TIME });
  jest
    .mocked(jwt.sign)
    .mockReset()
    .mockImplementation(() => 'test-jwt');
  config = {
    accountHost: 'account.snowflakecomputing.com',
    jwtAccountIdentifier: 'ACCOUNT',
    username: 'user',
    role: 'role',
    warehouse: 'warehouse',
    database: 'database',
    schema: 'schema',
    privateKeyPem: 'key',
    publicKeyFingerprint: `SHA256:${crypto.randomUUID()}`,
  };
  fetchMock = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('executeSnowflakeStatement', () => {
  it('preserves positional bindings, SQL timeout, raw strings and null values', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [['9007199254740993', null]] }));
    const controller = new AbortController();

    await expect(
      executeSnowflakeStatement({
        config,
        statement: 'SELECT ? FROM usage',
        bindings: [{ type: 'TEXT', value: 'model-name' }],
        timeoutSeconds: 600,
        signal: controller.signal,
      })
    ).resolves.toEqual([['9007199254740993', null]]);

    const [url, request] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`https://${config.accountHost}/api/v2/statements?requestId=`);
    expect(request).toMatchObject({
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: 'Bearer test-jwt',
        'x-snowflake-authorization-token-type': 'KEYPAIR_JWT',
      },
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      statement: 'SELECT ? FROM usage',
      warehouse: config.warehouse,
      database: config.database,
      schema: config.schema,
      role: config.role,
      bindings: { '1': { type: 'TEXT', value: 'model-name' } },
      timeout: 600,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('allows over 100 polls with a time budget and removes completed sleep listeners', async () => {
    let polls = 0;
    fetchMock.mockImplementation(async (url, request) => {
      if (request?.method === 'POST') return pendingResponse();
      expect(String(url)).toBe(`https://${config.accountHost}${STATUS_URL}`);
      const signal = request?.signal;
      if (!signal) throw new Error('Expected poll signal');
      expect(getEventListeners(signal, 'abort')).toHaveLength(0);
      polls++;
      if (polls <= 120) return new Response(null, { status: polls % 2 === 0 ? 429 : 202 });
      return Response.json({ data: [['done']] });
    });
    const result = executeSnowflakeStatement({
      config,
      statement: 'SELECT 1',
      pollTimeoutMs: 630_000,
    });

    await jest.runAllTimersAsync();

    await expect(result).resolves.toEqual([['done']]);
    expect(polls).toBe(121);
    expect(fetchMock).toHaveBeenCalledTimes(122);
    expect(Date.now() - START_TIME).toBe(590_000);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves the ten-attempt limit and uncapped delays without an opt-in budget', async () => {
    fetchMock.mockImplementation(async () => pendingResponse());
    const result = executeSnowflakeStatement({ config, statement: 'SELECT 1' });
    const rejected = expect(result).rejects.toThrow('Snowflake query timed out after polling');

    await jest.runAllTimersAsync();
    await rejected;

    expect(fetchMock).toHaveBeenCalledTimes(11);
    expect(Date.now() - START_TIME).toBe(55_000);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('times out during a poll sleep and removes its timer and abort listener', async () => {
    fetchMock.mockImplementation(async () => pendingResponse());
    const result = executeSnowflakeStatement({
      config,
      statement: 'SELECT 1',
      pollTimeoutMs: 2_500,
    });
    const rejected = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });

    await jest.advanceTimersByTimeAsync(2_500);
    await rejected;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const signal = fetchMock.mock.calls[1][1]?.signal;
    if (!signal) throw new Error('Expected poll signal');
    expect(signal.aborted).toBe(true);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('aborts an in-flight poll fetch when its budget expires', async () => {
    fetchMock
      .mockResolvedValueOnce(pendingResponse())
      .mockImplementationOnce((_url, request) => waitForAbort(request?.signal));
    const result = executeSnowflakeStatement({
      config,
      statement: 'SELECT 1',
      pollTimeoutMs: 2_500,
    });
    const rejected = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });

    await jest.advanceTimersByTimeAsync(2_500);
    await rejected;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['sleep', 'fetch'])('forwards caller aborts while waiting on a poll %s', async phase => {
    const controller = new AbortController();
    const reason = new Error('caller canceled');
    fetchMock.mockResolvedValueOnce(pendingResponse());
    if (phase === 'sleep') {
      fetchMock.mockImplementation(async () => pendingResponse());
    } else {
      fetchMock.mockImplementation((_url, request) => waitForAbort(request?.signal));
    }
    const result = executeSnowflakeStatement({
      config,
      statement: 'SELECT 1',
      pollTimeoutMs: 630_000,
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toBe(reason);

    await jest.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    await rejected;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not submit a statement for an already-aborted caller', async () => {
    const reason = new Error('already canceled');
    await expect(
      executeSnowflakeStatement({
        config,
        statement: 'SELECT 1',
        signal: AbortSignal.abort(reason),
      })
    ).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity, 2_147_483_648])(
    'rejects invalid poll budgets: %s',
    async budget => {
      await expect(
        executeSnowflakeStatement({ config, statement: 'SELECT 1', pollTimeoutMs: budget })
      ).rejects.toThrow('Invalid Snowflake polling timeout');
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('refreshes a nearly expired cached JWT between polls', async () => {
    jest
      .mocked(jwt.sign)
      .mockImplementationOnce(() => 'initial-jwt')
      .mockImplementationOnce(() => 'refreshed-jwt');
    fetchMock.mockResolvedValueOnce(Response.json({ data: [] }));
    await executeSnowflakeStatement({ config, statement: 'SELECT 1' });
    jest.setSystemTime(START_TIME + 58 * 60_000 - 500);
    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(pendingResponse())
      .mockResolvedValueOnce(pendingResponse())
      .mockResolvedValueOnce(Response.json({ data: [['done']] }));

    const result = executeSnowflakeStatement({
      config,
      statement: 'SELECT 1',
      pollTimeoutMs: 630_000,
    });
    await jest.runAllTimersAsync();
    await expect(result).resolves.toEqual([['done']]);

    expect(jest.mocked(jwt.sign)).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, request]) => request?.headers)).toEqual([
      expect.objectContaining({ authorization: 'Bearer initial-jwt' }),
      expect.objectContaining({ authorization: 'Bearer initial-jwt' }),
      expect.objectContaining({ authorization: 'Bearer refreshed-jwt' }),
    ]);
  });

  it.each([false, true])(
    'refreshes JWTs between partitions after async submission: %s',
    async asyncQuery => {
      jest
        .mocked(jwt.sign)
        .mockImplementationOnce(() => 'initial-jwt')
        .mockImplementationOnce(() => 'refreshed-jwt');
      const partitionUrls: string[] = [];
      if (asyncQuery) fetchMock.mockResolvedValueOnce(pendingResponse());
      fetchMock
        .mockResolvedValueOnce(
          Response.json({
            data: [['first']],
            statementHandle: 'handle-1',
            resultSetMetaData: { partitionInfo: [{}, {}, {}] },
          })
        )
        .mockImplementationOnce(async url => {
          partitionUrls.push(String(url));
          jest.setSystemTime(START_TIME + 58 * 60_000);
          return Response.json({ data: [['second']] });
        })
        .mockImplementationOnce(async url => {
          partitionUrls.push(String(url));
          return Response.json({ data: [['third']] });
        });

      await expect(
        executeSnowflakeStatement({ config, statement: 'SELECT 1', pollTimeoutMs: 630_000 })
      ).resolves.toEqual([['first'], ['second'], ['third']]);

      const partitionCalls = fetchMock.mock.calls.slice(asyncQuery ? 2 : 1);
      expect(partitionUrls).toEqual([
        `https://${config.accountHost}${STATUS_URL}?partition=1`,
        `https://${config.accountHost}${STATUS_URL}?partition=2`,
      ]);
      expect(partitionCalls.map(([, request]) => request?.headers)).toEqual([
        expect.objectContaining({ authorization: 'Bearer initial-jwt' }),
        expect.objectContaining({ authorization: 'Bearer refreshed-jwt' }),
      ]);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it('clears the polling budget after a failed poll', async () => {
    fetchMock
      .mockResolvedValueOnce(pendingResponse())
      .mockResolvedValueOnce(new Response('query failed', { status: 422 }));

    await expect(
      executeSnowflakeStatement({ config, statement: 'SELECT 1', pollTimeoutMs: 630_000 })
    ).rejects.toThrow('Snowflake poll failed (422)');
    expect(jest.getTimerCount()).toBe(0);
  });
});
