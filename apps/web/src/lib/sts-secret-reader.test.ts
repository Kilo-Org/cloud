// The transport module is replaced by a factory that counts its own evaluation, so these tests see
// whether the STS/OIDC module graph was loaded at all, not only whether a function was called.
let mockTransportLoads = 0;
const mockReadSts = jest.fn<Promise<string>, [string]>();
jest.mock('@/lib/sts-secret-transport', () => {
  mockTransportLoads += 1;
  return { createWebStsSecretReader: () => mockReadSts };
});

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'env-only-secret',
}));

import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';
import {
  installWebInternalApiSecretRead,
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
    'is false without the installed web read, whatever SECRETS_SOURCE says (%s)',
    source => {
      process.env.SECRETS_SOURCE = source;
      expect(internalApiSecretFromSts()).toBe(false);
    }
  );

  it('follows the selector once the web read is installed', () => {
    installWebInternalApiSecretRead();
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
  installWebInternalApiSecretRead();
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
  installWebInternalApiSecretRead();
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
