import { installInternalApiSecretRead } from '@kilocode/web-shared/lib/internal-api-secret';
import { createSelectedInternalApiSecretRead } from '@kilocode/web-shared/lib/sts-secret-reader';
import { resetInternalAuthObservation } from '@kilocode/worker-utils/internal-auth-observation';
import { authorizeInternalApiRequest } from './internal-api-auth';

let mockEnvSecret = 'env-only-secret';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  get INTERNAL_API_SECRET() {
    return mockEnvSecret;
  },
  STS_URL: '',
}));

const DELIVERED = 'sts-delivered-secret';
const readSts = jest.fn<Promise<string>, [string]>();
let observed: jest.SpyInstance;

function request(headers: Record<string, string>): Request {
  return new Request('https://app.test/api/internal/usage/record', { method: 'POST', headers });
}

async function statusOf(headers: Record<string, string>): Promise<number | null> {
  const refusal = await authorizeInternalApiRequest(request(headers), 'usage_record');
  if (refusal === null) return null;
  expect(await refusal.json()).toEqual({ error: 'Unauthorized' });
  return refusal.status;
}

beforeEach(() => {
  mockEnvSecret = 'env-only-secret';
  delete process.env.SECRETS_SOURCE;
  delete process.env.INTERNAL_AUTH_OBSERVATION_ENABLED;
  resetInternalAuthObservation();
  observed = jest.spyOn(console, 'log').mockImplementation(() => {});
  readSts.mockReset();
  readSts.mockResolvedValue(DELIVERED);
  // The web app's own selection with a stand-in STS read; the shipped wiring is covered in
  // sts-secret-reader.test.ts and installed by instrumentation in the HTTP fixture.
  installInternalApiSecretRead(
    createSelectedInternalApiSecretRead({
      source: () => process.env.SECRETS_SOURCE,
      env: () => mockEnvSecret,
      readSts,
    })
  );
});

afterEach(() => {
  delete process.env.SECRETS_SOURCE;
  delete process.env.INTERNAL_AUTH_OBSERVATION_ENABLED;
  observed.mockRestore();
  globalThis.__kilocodeInternalApiSecretRead = undefined;
});

describe('authorizeInternalApiRequest', () => {
  it.each([undefined, 'env'])(
    'accepts the environment value in either header (SECRETS_SOURCE=%s)',
    async source => {
      if (source !== undefined) process.env.SECRETS_SOURCE = source;
      expect(await statusOf({ 'x-internal-api-key': 'env-only-secret' })).toBeNull();
      expect(await statusOf({ 'x-internal-secret': 'env-only-secret' })).toBeNull();
      expect(readSts).not.toHaveBeenCalled();
    }
  );

  it('answers 401 Unauthorized as before for a wrong, absent or STS value under env', async () => {
    expect(await statusOf({ 'x-internal-api-key': 'wrong' })).toBe(401);
    expect(await statusOf({})).toBe(401);
    expect(await statusOf({ 'x-internal-api-key': DELIVERED })).toBe(401);
  });

  it('answers 401 for every request while the environment value is empty', async () => {
    mockEnvSecret = '';
    expect(await statusOf({ 'x-internal-api-key': '' })).toBe(401);
    expect(await statusOf({ 'x-internal-api-key': 'anything' })).toBe(401);
  });

  it('accepts only the delivered value under sts', async () => {
    process.env.SECRETS_SOURCE = 'sts';
    expect(await statusOf({ 'x-internal-api-key': DELIVERED })).toBeNull();
    expect(await statusOf({ 'x-internal-secret': DELIVERED })).toBeNull();
    expect(await statusOf({ 'x-internal-api-key': 'env-only-secret' })).toBe(401);
    expect(readSts).toHaveBeenCalledWith('INTERNAL_API_SECRET');
  });

  it('refuses a request without a credential before any STS read', async () => {
    process.env.SECRETS_SOURCE = 'sts';
    readSts.mockRejectedValue(new Error('STS denied the bundle request for this workload'));
    expect(await statusOf({})).toBe(401);
    expect(await statusOf({ 'x-internal-api-key': '' })).toBe(401);
    expect(readSts).not.toHaveBeenCalled();
  });

  it('fails the request instead of accepting the environment value when STS denies', async () => {
    process.env.SECRETS_SOURCE = 'sts';
    readSts.mockRejectedValue(new Error('STS denied the bundle request for this workload'));
    await expect(
      authorizeInternalApiRequest(request({ 'x-internal-api-key': 'env-only-secret' }), 'x')
    ).rejects.toThrow('STS denied');
  });

  it.each(['', 'STS', 'secrets-store', 'infisical'])(
    'fails closed in the web app for SECRETS_SOURCE=%j',
    async source => {
      process.env.SECRETS_SOURCE = source;
      await expect(
        authorizeInternalApiRequest(request({ 'x-internal-api-key': 'env-only-secret' }), 'x')
      ).rejects.toThrow('SECRETS_SOURCE must be either "env" or "sts"');
      expect(readSts).not.toHaveBeenCalled();
    }
  );
});

describe('authorizeInternalApiRequest observation (design 9.4 item 9)', () => {
  it('writes one line for an accepted shared-secret request and never the secret', async () => {
    expect(
      await statusOf({ 'x-internal-api-key': 'env-only-secret', 'x-kilo-caller': 'usage-ingest' })
    ).toBeNull();

    expect(observed).toHaveBeenCalledTimes(1);
    const line = String(observed.mock.calls[0][0]);
    expect(line).not.toContain('env-only-secret');
    expect(JSON.parse(line)).toMatchObject({
      event: 'kilo_internal_auth',
      v: 1,
      receiver: 'web',
      route: 'usage_record',
      auth: 'legacy_shared_secret',
      caller: 'usage-ingest',
      count: 1,
    });
  });

  it('labels a caller outside the allowlist unknown', async () => {
    await statusOf({ 'x-internal-api-key': 'env-only-secret', 'x-kilo-caller': 'anyone' });

    expect(JSON.parse(String(observed.mock.calls[0][0])).caller).toBe('unknown');
  });

  it('writes nothing for a refused request', async () => {
    expect(await statusOf({ 'x-internal-api-key': 'wrong' })).toBe(401);
    expect(await statusOf({})).toBe(401);
    expect(observed).not.toHaveBeenCalled();
  });

  it('writes nothing when the observation flag is exactly false', async () => {
    process.env.INTERNAL_AUTH_OBSERVATION_ENABLED = 'false';

    expect(await statusOf({ 'x-internal-api-key': 'env-only-secret' })).toBeNull();
    expect(observed).not.toHaveBeenCalled();
  });
});
