import {
  executeSnowflakeStatement,
  resolveSnowflakeConfig,
  type SnowflakeConfig,
} from '@/lib/snowflake';

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 'test-token') }));

const CONFIG = {
  accountHost: 'test-account.snowflakecomputing.com',
  jwtAccountIdentifier: 'TEST_ACCOUNT',
  username: 'TEST_USER',
  role: 'TEST_ROLE',
  warehouse: 'TEST_WAREHOUSE',
  database: 'TEST_DATABASE',
  schema: 'TEST_SCHEMA',
  privateKeyPem: 'test-private-key',
  publicKeyFingerprint: 'SHA256:test-fingerprint',
} satisfies SnowflakeConfig;

const STATEMENT_PATH = '/api/v2/statements/test-handle';
const STATEMENT_URL = `https://${CONFIG.accountHost}${STATEMENT_PATH}`;

beforeEach(() => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    SNOWFLAKE_ACCOUNT_HOST: CONFIG.accountHost,
    SNOWFLAKE_JWT_ACCOUNT_IDENTIFIER: CONFIG.jwtAccountIdentifier,
    SNOWFLAKE_USERNAME: CONFIG.username,
    SNOWFLAKE_ROLE: CONFIG.role,
    SNOWFLAKE_WAREHOUSE: CONFIG.warehouse,
    SNOWFLAKE_DATABASE: CONFIG.database,
    SNOWFLAKE_SCHEMA: CONFIG.schema,
    SNOWFLAKE_PRIVATE_KEY_PEM: CONFIG.privateKeyPem,
    SNOWFLAKE_PUBLIC_KEY_FINGERPRINT: CONFIG.publicKeyFingerprint,
  });
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected fetch'));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('resolveSnowflakeConfig', () => {
  test.each([
    'test-account.snowflakecomputing.com',
    'TEST-ACCOUNT.SNOWFLAKECOMPUTING.COM',
    ' Test-Account.snowflakecomputing.com ',
    ' https://Test-Account.snowflakecomputing.com/ ',
    ' HTTPS://TEST-ACCOUNT.SNOWFLAKECOMPUTING.COM/ ',
  ])('normalizes the hostname without changing other configuration: %s', accountHost => {
    process.env.SNOWFLAKE_ACCOUNT_HOST = accountHost;

    expect(resolveSnowflakeConfig()).toEqual(CONFIG);
  });
});

describe.each([CONFIG.accountHost, 'Test-Account.SNOWFLAKECOMPUTING.COM'])(
  'executeSnowflakeStatement with accountHost %s',
  accountHost => {
    const config = { ...CONFIG, accountHost };

    test.each([undefined, STATEMENT_PATH, STATEMENT_URL])(
      'fetches additional partitions using status URL %s',
      async statementStatusUrl => {
        const request = jest.mocked(global.fetch);
        request
          .mockResolvedValueOnce(
            Response.json({
              statementHandle: 'test-handle',
              statementStatusUrl,
              resultSetMetaData: { partitionInfo: [{}, {}] },
              data: [['first']],
            })
          )
          .mockResolvedValueOnce(Response.json({ data: [['second']] }));

        await expect(executeSnowflakeStatement({ config, statement: 'SELECT 1' })).resolves.toEqual(
          [['first'], ['second']]
        );
        expect(request).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenNthCalledWith(
          2,
          new URL(`${STATEMENT_URL}?partition=1`),
          expect.objectContaining({
            headers: expect.objectContaining({ authorization: 'Bearer test-token' }),
          })
        );
      }
    );

    test.each([STATEMENT_PATH, STATEMENT_URL])(
      'polls an asynchronous statement using status URL %s',
      async statementStatusUrl => {
        const request = jest.mocked(global.fetch);
        request
          .mockResolvedValueOnce(Response.json({ statementStatusUrl }, { status: 202 }))
          .mockResolvedValueOnce(Response.json({ data: [['complete']] }));

        await expect(executeSnowflakeStatement({ config, statement: 'SELECT 1' })).resolves.toEqual(
          [['complete']]
        );
        expect(request).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenNthCalledWith(
          2,
          new URL(STATEMENT_URL),
          expect.objectContaining({
            headers: expect.objectContaining({ authorization: 'Bearer test-token' }),
          })
        );
      }
    );

    test.each([
      'https://other.snowflakecomputing.com/api/v2/statements/test-handle',
      '//test-account.snowflakecomputing.com.attacker.example/api/v2/statements/test-handle',
    ])('rejects a foreign partition host without fetching it: %s', async statementStatusUrl => {
      const request = jest.mocked(global.fetch);
      request.mockResolvedValueOnce(
        Response.json({
          statementStatusUrl,
          resultSetMetaData: { partitionInfo: [{}, {}] },
          data: [['first']],
        })
      );

      await expect(executeSnowflakeStatement({ config, statement: 'SELECT 1' })).rejects.toThrow(
        'Snowflake returned unexpected result host:'
      );
      expect(request).toHaveBeenCalledTimes(1);
    });

    test.each([
      'https://other.snowflakecomputing.com/api/v2/statements/test-handle',
      '//test-account.snowflakecomputing.com.attacker.example/api/v2/statements/test-handle',
    ])('rejects a foreign polling host without fetching it: %s', async statementStatusUrl => {
      const request = jest.mocked(global.fetch);
      request.mockResolvedValueOnce(Response.json({ statementStatusUrl }, { status: 202 }));

      await expect(executeSnowflakeStatement({ config, statement: 'SELECT 1' })).rejects.toThrow(
        'Snowflake returned unexpected poll host:'
      );
      expect(request).toHaveBeenCalledTimes(1);
    });
  }
);
