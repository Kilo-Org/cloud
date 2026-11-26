import { installInternalApiSecretRead, readInternalApiSecret } from './internal-api-secret';

let mockEnvSecret = 'env-only-secret';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  get INTERNAL_API_SECRET() {
    return mockEnvSecret;
  },
}));

const DELIVERED = 'sts-delivered-secret';
const installedRead = jest.fn<Promise<string>, []>();

beforeEach(() => {
  mockEnvSecret = 'env-only-secret';
  delete process.env.SECRETS_SOURCE;
  installedRead.mockReset();
  installedRead.mockResolvedValue(DELIVERED);
  globalThis.__kilocodeInternalApiSecretRead = undefined;
});

afterEach(() => {
  delete process.env.SECRETS_SOURCE;
  globalThis.__kilocodeInternalApiSecretRead = undefined;
});

describe('readInternalApiSecret without an installed read (AI gateway, scripts)', () => {
  it.each([undefined, 'env', 'sts', '', 'secrets-store'])(
    'returns the configured value whatever SECRETS_SOURCE says (%j)',
    async source => {
      if (source !== undefined) process.env.SECRETS_SOURCE = source;
      await expect(readInternalApiSecret()).resolves.toBe('env-only-secret');
    }
  );

  it('keeps an empty configured value empty', async () => {
    mockEnvSecret = '';
    await expect(readInternalApiSecret()).resolves.toBe('');
  });
});

describe('readInternalApiSecret with the installed web read', () => {
  beforeEach(() => {
    installInternalApiSecretRead(installedRead);
  });

  it('returns only what the installed read returns', async () => {
    await expect(readInternalApiSecret()).resolves.toBe(DELIVERED);
    expect(installedRead).toHaveBeenCalledTimes(1);
  });

  it('rejects with the installed read instead of returning the configured value', async () => {
    const error = new Error('STS denied the bundle request for this workload');
    installedRead.mockRejectedValue(error);
    await expect(readInternalApiSecret()).rejects.toBe(error);
  });
});
