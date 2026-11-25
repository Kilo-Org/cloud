import type { BundleResult } from '@kilocode/sts-contracts';
import { describe, expect, it, vi } from 'vitest';
import { SecretSourceError, createSecretSource, createStsSecretSource } from '../src/secrets';

const FETCHED_AT = '2026-11-25T10:00:00.000Z';

function okBundle(secrets: Record<string, { value: string; version: number }>): BundleResult {
  return {
    status: 'ok',
    workload: 'audit-relay',
    environment: 'production',
    etag: '"0123456789abcdef"',
    stale: false,
    fetchedAt: FETCHED_AT,
    secrets,
    missing: [],
  };
}

function binding(result: BundleResult) {
  return { getBundle: vi.fn().mockResolvedValue(result) };
}

describe('createStsSecretSource', () => {
  it('returns a secret from an ok bundle and asks STS once for several gets', async () => {
    const sts = binding(
      okBundle({
        AUDIT_RELAY_AXIOM_TOKEN: { value: 'axiom-token', version: 3 },
        AUDIT_RELAY_SLACK_WEBHOOK_PAGE: { value: 'https://hooks.slack.test/x', version: 1 },
      })
    );
    const source = createStsSecretSource(sts);

    await expect(source.get('AUDIT_RELAY_AXIOM_TOKEN')).resolves.toBe('axiom-token');
    await expect(source.get('AUDIT_RELAY_SLACK_WEBHOOK_PAGE')).resolves.toBe(
      'https://hooks.slack.test/x'
    );
    expect(sts.getBundle).toHaveBeenCalledTimes(1);
    expect(sts.getBundle).toHaveBeenCalledWith({});
  });

  it('reports a name the bundle does not hold as a non-retryable failure', async () => {
    const source = createStsSecretSource(binding(okBundle({})));

    const error = await source.get('AUDIT_RELAY_AXIOM_TOKEN').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecretSourceError);
    expect(error).toMatchObject({ kind: 'missing', retryable: false });
  });

  it('reports a denied bundle as non-retryable', async () => {
    const source = createStsSecretSource(binding({ status: 'denied', reason: 'unknown_workload' }));

    const error = await source.get('AUDIT_RELAY_AXIOM_TOKEN').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'denied', retryable: false });
  });

  it('reports an unavailable bundle as retryable', async () => {
    const source = createStsSecretSource(
      binding({
        status: 'unavailable',
        reason: 'manager_unreachable_no_copy',
        retryAfterSeconds: 5,
      })
    );

    const error = await source.get('AUDIT_RELAY_AXIOM_TOKEN').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'unavailable', retryable: true });
  });

  it('reports not_modified as retryable because the request is unconditional', async () => {
    const source = createStsSecretSource(
      binding({
        status: 'not_modified',
        etag: '"0123456789abcdef"',
        stale: false,
        fetchedAt: FETCHED_AT,
      })
    );

    const error = await source.get('AUDIT_RELAY_AXIOM_TOKEN').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'not_modified', retryable: true });
  });
});

describe('createSecretSource', () => {
  it('reads the local secrets in a local environment', async () => {
    const source = createSecretSource({
      AUDIT_ENVIRONMENT: 'local',
      AUDIT_RELAY_LOCAL_SECRETS: '{"AUDIT_RELAY_AXIOM_TOKEN":"local-token"}',
      STS: binding(okBundle({})),
    });

    await expect(source.get('AUDIT_RELAY_AXIOM_TOKEN')).resolves.toBe('local-token');
  });

  it('never reads the local secrets outside a local environment', async () => {
    const sts = binding(okBundle({ AUDIT_RELAY_AXIOM_TOKEN: { value: 'sts-token', version: 1 } }));
    const source = createSecretSource({
      AUDIT_ENVIRONMENT: 'production',
      AUDIT_RELAY_LOCAL_SECRETS: '{"AUDIT_RELAY_AXIOM_TOKEN":"local-token"}',
      STS: sts,
    });

    await expect(source.get('AUDIT_RELAY_AXIOM_TOKEN')).resolves.toBe('sts-token');
    expect(sts.getBundle).toHaveBeenCalledTimes(1);
  });
});
