import type { BundleRequest, BundleResult } from '@kilocode/sts-contracts';
import { SecretUnavailableError, type BundleBinding } from '@kilocode/secrets-client';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { secretsFor } from '../src/secrets';
import type { SecretsEnv } from '../src/secrets';

const FETCHED_AT = '2026-11-25T10:00:00.000Z';
const ETAG = '"0123456789abcdef"';

function okBundle(secrets: Record<string, { value: string; version: number }>): BundleResult {
  return {
    status: 'ok',
    workload: 'audit-relay',
    environment: 'production',
    etag: ETAG,
    stale: false,
    fetchedAt: FETCHED_AT,
    secrets,
    missing: [],
  };
}

/** A stand-in for the STS service binding that records each request. */
type FakeBinding = { getBundle: Mock<BundleBinding['getBundle']> };

function binding(result: BundleResult | ((request: BundleRequest) => BundleResult)): FakeBinding {
  const getBundle = vi.fn(async (request: BundleRequest) =>
    typeof result === 'function' ? result(request) : result
  );
  return { getBundle };
}

function envWith(sts: FakeBinding, overrides: Partial<SecretsEnv> = {}): SecretsEnv {
  return { AUDIT_ENVIRONMENT: 'production', STS: sts, ...overrides };
}

async function failureFrom(read: Promise<string>): Promise<SecretUnavailableError> {
  const error = await read.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(SecretUnavailableError);
  return error as SecretUnavailableError;
}

describe('secretsFor', () => {
  it('reports a denied bundle as non-retryable', async () => {
    const sts = binding({ status: 'denied', reason: 'unknown_workload' });

    const error = await failureFrom(secretsFor(envWith(sts)).get('AUDIT_RELAY_AXIOM_TOKEN'));

    expect(error).toMatchObject({ reason: 'denied', retryable: false });
  });

  it('reports an unavailable bundle as retryable', async () => {
    const sts = binding({
      status: 'unavailable',
      reason: 'manager_unreachable_no_copy',
      retryAfterSeconds: 5,
    });

    const error = await failureFrom(secretsFor(envWith(sts)).get('AUDIT_RELAY_AXIOM_TOKEN'));

    expect(error).toMatchObject({ reason: 'unavailable', retryable: true });
  });

  it('reports a name the bundle lists as missing as non-retryable', async () => {
    const sts = binding(okBundle({}));

    const error = await failureFrom(secretsFor(envWith(sts)).get('AUDIT_RELAY_AXIOM_TOKEN'));

    expect(error).toMatchObject({ reason: 'not_granted', retryable: false });
  });

  it('reports a granted name the manager does not hold as non-retryable', async () => {
    const bundle = okBundle({}) as Extract<BundleResult, { status: 'ok' }>;
    const sts = binding({ ...bundle, missing: ['AUDIT_RELAY_AXIOM_TOKEN'] });

    const error = await failureFrom(secretsFor(envWith(sts)).get('AUDIT_RELAY_AXIOM_TOKEN'));

    expect(error).toMatchObject({ reason: 'missing', retryable: false });
  });

  it('reuses the isolate bundle, then revalidates with If-None-Match', async () => {
    // Only Date is faked: the client's request deadlines keep real timers.
    vi.useFakeTimers({ now: Date.parse(FETCHED_AT), toFake: ['Date'] });
    try {
      const sts = binding(request => {
        if (request.ifNoneMatch === undefined) {
          return okBundle({ AUDIT_RELAY_AXIOM_TOKEN: { value: 'axiom-token', version: 3 } });
        }
        expect(request.ifNoneMatch).toBe(ETAG);
        return { status: 'not_modified', etag: ETAG, stale: false, fetchedAt: FETCHED_AT };
      });
      const env = envWith(sts);

      await expect(secretsFor(env).get('AUDIT_RELAY_AXIOM_TOKEN')).resolves.toBe('axiom-token');
      expect(sts.getBundle).toHaveBeenNthCalledWith(1, {});

      vi.setSystemTime(Date.parse(FETCHED_AT) + 60_000);
      await expect(secretsFor(env).get('AUDIT_RELAY_AXIOM_TOKEN')).resolves.toBe('axiom-token');
      expect(sts.getBundle).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.parse(FETCHED_AT) + 241_000);
      await expect(secretsFor(env).get('AUDIT_RELAY_AXIOM_TOKEN')).resolves.toBe('axiom-token');
      await vi.waitFor(() => expect(sts.getBundle).toHaveBeenCalledTimes(2));
      expect(sts.getBundle).toHaveBeenNthCalledWith(2, { ifNoneMatch: ETAG });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('local secrets', () => {
  it('reads the local values in a local environment', async () => {
    const env = envWith(binding(okBundle({})), {
      AUDIT_ENVIRONMENT: 'local',
      AUDIT_RELAY_LOCAL_SECRETS: '{"AUDIT_RELAY_AXIOM_TOKEN":"local-token"}',
    });

    await expect(secretsFor(env).get('AUDIT_RELAY_AXIOM_TOKEN')).resolves.toBe('local-token');
  });

  it('reports a local name it does not hold as non-retryable', async () => {
    const env = envWith(binding(okBundle({})), {
      AUDIT_ENVIRONMENT: 'local',
      AUDIT_RELAY_LOCAL_SECRETS: '{"AUDIT_RELAY_AXIOM_TOKEN":"local-token"}',
    });

    const error = await failureFrom(secretsFor(env).get('AUDIT_RELAY_SLACK_WEBHOOK_PAGE'));

    expect(error).toMatchObject({ reason: 'missing', retryable: false });
  });

  it('never reads the local values outside a local environment', async () => {
    const sts = binding(okBundle({ AUDIT_RELAY_AXIOM_TOKEN: { value: 'sts-token', version: 1 } }));
    const env = envWith(sts, {
      AUDIT_ENVIRONMENT: 'production',
      AUDIT_RELAY_LOCAL_SECRETS: '{"AUDIT_RELAY_AXIOM_TOKEN":"local-token"}',
    });

    await expect(secretsFor(env).get('AUDIT_RELAY_AXIOM_TOKEN')).resolves.toBe('sts-token');
    expect(sts.getBundle).toHaveBeenCalledTimes(1);
  });
});
