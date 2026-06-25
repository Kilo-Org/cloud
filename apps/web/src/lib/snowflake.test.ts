jest.mock('jsonwebtoken', () => ({
  __esModule: true,
  default: { sign: jest.fn(() => 'test-jwt') },
}));

jest.mock('@/lib/snowflake-query-log', () => ({
  recordSnowflakeQuery: jest.fn(async () => undefined),
}));

import { recordSnowflakeQuery } from '@/lib/snowflake-query-log';
import { executeSnowflakeStatement, type SnowflakeConfig } from '@/lib/snowflake';

const config: SnowflakeConfig = {
  accountHost: 'example.snowflakecomputing.com',
  jwtAccountIdentifier: 'example',
  username: 'kilo',
  role: 'reader',
  warehouse: 'warehouse',
  database: 'database',
  schema: 'schema',
  privateKeyPem: 'private-key',
  publicKeyFingerprint: 'SHA256:test',
};

const recordQuery = jest.mocked(recordSnowflakeQuery);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('executeSnowflakeStatement query metrics', () => {
  beforeEach(() => {
    recordQuery.mockClear();
    jest.restoreAllMocks();
  });

  it('records submit and partition requests for one logical query', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          statementHandle: 'statement-1',
          statementStatusUrl: '/api/v2/statements/statement-1',
          resultSetMetaData: { partitionInfo: [{}, {}] },
          data: [['first']],
        })
      )
      .mockResolvedValueOnce(jsonResponse({ data: [['second']] }));

    const rows = await executeSnowflakeStatement({
      config,
      source: 'web',
      queryLabel: 'test.partitioned',
      statement: 'select 1',
    });

    expect(rows).toEqual([['first'], ['second']]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(recordQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'web',
        queryLabel: 'test.partitioned',
        statementHandle: 'statement-1',
        succeeded: true,
        statusCode: 200,
        submitRequestCount: 1,
        pollRequestCount: 0,
        partitionRequestCount: 1,
        partitionCount: 2,
        rowCount: 2,
      })
    );
  });

  it('records asynchronous submit and poll responses', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse(
          {
            statementHandle: 'statement-2',
            statementStatusUrl: '/api/v2/statements/statement-2',
          },
          202
        )
      )
      .mockResolvedValueOnce(jsonResponse({ statementHandle: 'statement-2', data: [] }));

    await executeSnowflakeStatement({
      config,
      source: 'web',
      queryLabel: 'test.async',
      statement: 'select 1',
    });

    expect(recordQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        succeeded: true,
        statusCode: 200,
        submitRequestCount: 1,
        pollRequestCount: 1,
        http202Count: 1,
        retryCount: 0,
      })
    );
  });

  it('records terminal HTTP failures without replacing the query error', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(
        {
          code: '001003',
          message: 'SQL compilation error for secret-user-id',
        },
        422
      )
    );

    await expect(
      executeSnowflakeStatement({
        config,
        source: 'web',
        queryLabel: 'test.failed',
        statement: 'select invalid',
      })
    ).rejects.toThrow('Snowflake statement failed (422)');

    expect(recordQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        succeeded: false,
        statusCode: 422,
        submitRequestCount: 1,
        errorCode: '001003',
        errorMessage: 'Submit request failed with status 422',
      })
    );
    expect(JSON.stringify(recordQuery.mock.calls[0]?.[0])).not.toContain('secret-user-id');
  });
});
