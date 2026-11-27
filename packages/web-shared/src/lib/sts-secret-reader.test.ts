// The transport module is replaced by a factory that counts its own evaluation, so these tests see
// whether the STS/OIDC module graph was loaded at all, not only whether a function was called.
let mockTransportLoads = 0;
const mockReadSts = jest.fn<Promise<string>, [string]>();
jest.mock('@kilocode/web-shared/lib/sts-secret-transport', () => {
  mockTransportLoads += 1;
  return { createVercelStsSecretReader: () => mockReadSts };
});

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'env-only-secret',
}));

import {
  REPORT_WINDOW_MS,
  resetReportWindowsForTest,
} from '@kilocode/web-shared/lib/ai-gateway/report-window';
import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';
import { StsSecretReadConfigError } from '@kilocode/web-shared/lib/sts-secret-read-failure';
import {
  createSelectedInternalApiSecretRead,
  installSelectedInternalApiSecretRead,
  internalApiSecretFromSts,
  internalApiSecretSource,
  lazyStsSecretReader,
} from './sts-secret-reader';

const DELIVERED = 'sts-delivered-secret';

beforeEach(() => {
  delete process.env.SECRETS_SOURCE;
  mockReadSts.mockReset();
  mockReadSts.mockResolvedValue(DELIVERED);
  globalThis.__kilocodeInternalApiSecretRead = undefined;
});

afterEach(() => {
  delete process.env.SECRETS_SOURCE;
  globalThis.__kilocodeInternalApiSecretRead = undefined;
  jest.useRealTimers();
});

describe('internalApiSecretSource', () => {
  it.each([
    [undefined, 'env'],
    ['env', 'env'],
    ['sts', 'sts'],
  ] as const)('maps %j to %s', (value, expected) => {
    expect(internalApiSecretSource(value)).toBe(expected);
  });

  it.each(['', 'STS', 'Env', 'secrets-store', 'infisical'])('refuses %j', value => {
    expect(() => internalApiSecretSource(value)).toThrow(
      'SECRETS_SOURCE must be either "env" or "sts"'
    );
  });
});

describe('internalApiSecretFromSts', () => {
  it.each(['sts', 'secrets-store'])(
    'is false without the installed read, whatever SECRETS_SOURCE says (%s)',
    source => {
      process.env.SECRETS_SOURCE = source;
      expect(internalApiSecretFromSts()).toBe(false);
    }
  );

  it('follows the selector once the read is installed', () => {
    installSelectedInternalApiSecretRead();
    expect(internalApiSecretFromSts()).toBe(false);
    process.env.SECRETS_SOURCE = 'sts';
    expect(internalApiSecretFromSts()).toBe(true);
    process.env.SECRETS_SOURCE = 'secrets-store';
    expect(() => internalApiSecretFromSts()).toThrow('SECRETS_SOURCE must be either');
  });
});

// One test owns the module-load counter: jest evaluates a mocked module once per registry, so the
// order of reads inside it is the discriminator.
it('loads the STS transport only on the first STS read, and once', async () => {
  installSelectedInternalApiSecretRead();
  expect(mockTransportLoads).toBe(0);

  await expect(readInternalApiSecret()).resolves.toBe('env-only-secret');
  process.env.SECRETS_SOURCE = 'env';
  await expect(readInternalApiSecret()).resolves.toBe('env-only-secret');
  process.env.SECRETS_SOURCE = 'secrets-store';
  await expect(readInternalApiSecret()).rejects.toThrow('SECRETS_SOURCE must be either');
  expect(internalApiSecretFromSts).toThrow('SECRETS_SOURCE must be either');
  expect(mockTransportLoads).toBe(0);

  process.env.SECRETS_SOURCE = 'sts';
  await expect(Promise.all([readInternalApiSecret(), readInternalApiSecret()])).resolves.toEqual([
    DELIVERED,
    DELIVERED,
  ]);
  await expect(readInternalApiSecret()).resolves.toBe(DELIVERED);
  expect(mockTransportLoads).toBe(1);
  expect(mockReadSts).toHaveBeenCalledWith('INTERNAL_API_SECRET');
});

it('fails an STS read without the environment value when the transport read rejects', async () => {
  installSelectedInternalApiSecretRead();
  process.env.SECRETS_SOURCE = 'sts';
  const error = new Error('STS denied the bundle request for this workload');
  mockReadSts.mockRejectedValue(error);
  await expect(readInternalApiSecret()).rejects.toBe(error);
});

describe('lazyStsSecretReader', () => {
  it('shares one load between concurrent first reads', async () => {
    const load = jest.fn(async () => mockReadSts);
    const read = lazyStsSecretReader(load, 1_000);
    await expect(Promise.all([read('A'), read('B')])).resolves.toEqual([DELIVERED, DELIVERED]);
    await read('C');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('forgets a failed load so the next read starts a new one', async () => {
    const failure = new Error('chunk load failed');
    const load = jest
      .fn<Promise<typeof mockReadSts>, []>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(mockReadSts);
    const read = lazyStsSecretReader(load, 1_000);
    await expect(read('A')).rejects.toBe(failure);
    await expect(read('A')).resolves.toBe(DELIVERED);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('fails a load that outlasts its bound and forgets it', async () => {
    jest.useFakeTimers();
    const load = jest
      .fn<Promise<typeof mockReadSts>, []>()
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValue(mockReadSts);
    const read = lazyStsSecretReader(load, 1_000);
    const first = read('A').catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(999);
    expect(load).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(await first).toEqual(new Error('The STS secret transport did not load in time'));
    expect(jest.getTimerCount()).toBe(0);
    await expect(read('A')).resolves.toBe(DELIVERED);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('the STS read failure signal', () => {
  // Error text, cause, name and the secret's name and values must never reach the signal.
  const DETAIL = 'sentinel-error-detail';
  let warn: jest.SpyInstance;
  let now: jest.SpyInstance;

  const signal = (reason: string) => [JSON.stringify({ event: 'sts_secret_read_failed', reason })];
  const FORBIDDEN = [DETAIL, DELIVERED, 'env-only-secret', 'INTERNAL_API_SECRET', 'Error'];

  function expectNoDetail(): void {
    const emitted = JSON.stringify(warn.mock.calls);
    for (const forbidden of FORBIDDEN) {
      expect(emitted).not.toContain(forbidden);
    }
  }

  function clientError(reason: unknown): Error {
    return Object.assign(new Error(DETAIL, { cause: new Error(DETAIL) }), {
      name: 'SecretUnavailableError',
      reason,
    });
  }

  beforeEach(() => {
    resetReportWindowsForTest();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    installSelectedInternalApiSecretRead();
  });

  afterEach(() => {
    warn.mockRestore();
    now.mockRestore();
  });

  it.each([undefined, 'env'])(
    'stays silent on the %s source, whatever STS answers',
    async source => {
      if (source !== undefined) process.env.SECRETS_SOURCE = source;
      mockReadSts.mockRejectedValue(clientError('denied'));
      await expect(readInternalApiSecret()).resolves.toBe('env-only-secret');
      expect(mockReadSts).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    }
  );

  it.each(['missing', 'not_granted', 'denied', 'unavailable'])(
    'emits the client reason %s once and rethrows the same error',
    async reason => {
      process.env.SECRETS_SOURCE = 'sts';
      const error = clientError(reason);
      mockReadSts.mockRejectedValue(error);
      await expect(readInternalApiSecret()).rejects.toBe(error);
      expect(warn.mock.calls).toEqual([signal(reason)]);
      expectNoDetail();
    }
  );

  it('emits config for a deployment or selector mismatch', async () => {
    process.env.SECRETS_SOURCE = 'sts';
    const error = new StsSecretReadConfigError(DETAIL);
    mockReadSts.mockRejectedValue(error);
    await expect(readInternalApiSecret()).rejects.toBe(error);

    resetReportWindowsForTest();
    process.env.SECRETS_SOURCE = 'secrets-store';
    await expect(readInternalApiSecret()).rejects.toThrow('SECRETS_SOURCE must be either');
    expect(warn.mock.calls).toEqual([signal('config'), signal('config')]);
    expectNoDetail();
  });

  it.each([
    ['an error without a client reason', new TypeError(DETAIL)],
    ['an error whose reason is not allowlisted', clientError(DETAIL)],
    ['a thrown non-error', DETAIL],
  ])('emits transport for %s', async (_case, error) => {
    process.env.SECRETS_SOURCE = 'sts';
    mockReadSts.mockRejectedValue(error);
    await expect(readInternalApiSecret()).rejects.toBe(error);
    expect(warn.mock.calls).toEqual([signal('transport')]);
    expectNoDetail();
  });

  it('emits load when the transport module does not load', async () => {
    const failure = new Error(DETAIL);
    const read = createSelectedInternalApiSecretRead({
      source: () => 'sts',
      env: () => 'env-only-secret',
      readSts: lazyStsSecretReader(() => Promise.reject(failure), 1_000),
    });
    await expect(read()).rejects.toBe(failure);
    expect(warn.mock.calls).toEqual([signal('load')]);
    expectNoDetail();
  });

  it('reports each reason at most once per window', async () => {
    process.env.SECRETS_SOURCE = 'sts';
    mockReadSts.mockRejectedValue(clientError('unavailable'));
    for (let i = 0; i < 5; i += 1) await expect(readInternalApiSecret()).rejects.toThrow();
    mockReadSts.mockRejectedValue(clientError('denied'));
    await expect(readInternalApiSecret()).rejects.toThrow();
    expect(warn.mock.calls).toEqual([signal('unavailable'), signal('denied')]);

    now.mockReturnValue(1_000_000 + REPORT_WINDOW_MS - 1);
    mockReadSts.mockRejectedValue(clientError('unavailable'));
    await expect(readInternalApiSecret()).rejects.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);

    now.mockReturnValue(1_000_000 + REPORT_WINDOW_MS);
    await expect(readInternalApiSecret()).rejects.toThrow();
    expect(warn.mock.calls).toEqual([
      signal('unavailable'),
      signal('denied'),
      signal('unavailable'),
    ]);
  });
});
