import { describe, expect, it } from 'vitest';
import { SecretsBroker } from '../../src/broker';
import { policyFor, policyIndex } from '../../src/policy';
import { bundleFolder } from '../../src/policy/schema';
import { config, env } from './test-env';

// The shipped `uts` policy (services/sts/policy/uts.yaml): the UTS mint Worker's runtime secrets,
// exactly the names services/uts/src/secrets.ts reads, in staging and production only.
const UTS_SECRETS = [
  'DEVICE_USER_CODE_KEY',
  'SIGNIN_EMAIL_HASH_KEY',
  'SIGNIN_GITHUB_CLIENT_SECRET',
  'SIGNIN_GOOGLE_CLIENT_SECRET',
  'SIGNIN_GITLAB_CLIENT_SECRET',
  'SIGNIN_DISCORD_CLIENT_SECRET',
  'SIGNIN_LINKEDIN_CLIENT_SECRET',
  'SIGNIN_APPLE_PRIVATE_KEY',
  'SIGNIN_OPENAI_CLIENT_SECRET',
  'SIGNIN_ANACONDA_CLIENT_SECRET',
  'SIGNIN_ANTHROPIC_ASSERTION_PRIVATE_KEY',
  'SIGNIN_WORKOS_API_KEY',
  'UTS_MAILGUN_SENDING_KEY',
  'UTS_TURNSTILE_SECRET_KEY',
  'ATTEST_PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY',
];

/** The ExecutionContext a SecretsBroker binding with `props: { caller }` gives the entrypoint. */
function bindingContext(caller: string, pending: Promise<unknown>[]): ExecutionContext {
  const ctx: Pick<ExecutionContext, 'props' | 'waitUntil' | 'passThroughOnException'> = {
    props: { caller },
    waitUntil: promise => {
      pending.push(promise);
    },
    passThroughOnException: () => undefined,
  };
  return ctx as ExecutionContext;
}

describe('the uts policy', () => {
  it.each(['staging', 'production'] as const)(
    'grants exactly the UTS runtime secrets over a worker binding in %s, from /workloads/uts',
    environment => {
      const policy = policyFor(environment, 'uts');
      expect(policy).toEqual({
        workload: 'uts',
        environments: ['staging', 'production'],
        identity: { kind: 'worker-binding' },
        secrets: UTS_SECRETS,
        audiences: [],
        scopes: [],
        dynamic: [],
        environmentGrants: {},
      });
      if (policy === null) throw new Error('expected the uts policy');
      expect(bundleFolder(policy)).toEqual({ root: '/workloads', path: '/workloads/uts' });
    }
  );

  it('is a policy, not a registration, and serves nothing in development', () => {
    expect(policyIndex.has('uts')).toBe(true);
    expect(policyIndex.registered()).not.toContain('uts');
    expect(policyFor('development', 'uts')).toBeNull();
  });

  it.each(['development', 'staging', 'production'] as const)(
    'grants no UTS secret to any other workload in %s',
    environment => {
      for (const policy of policyIndex.forEnvironment(environment)) {
        if (policy.workload === 'uts') continue;
        const granted = [
          ...policy.secrets,
          ...Object.values(policy.environmentGrants).flatMap(grant => grant?.secrets ?? []),
        ];
        expect(
          granted.filter(name => UTS_SECRETS.includes(name)),
          policy.workload
        ).toEqual([]);
      }
    }
  );

  it.each(['uts-staging', 'uts-local', 'uts-test'])(
    'has no policy for the other UTS deployment name %s',
    name => {
      expect(policyIndex.has(name)).toBe(false);
    }
  );

  it('refuses the uts caller on development STS and the other UTS deployment names everywhere', async () => {
    expect(config.environment).toBe('development');
    const pending: Promise<unknown>[] = [];
    const bundle = (caller: string) =>
      new SecretsBroker(bindingContext(caller, pending), env).getBundle({});
    expect(await bundle('uts')).toEqual({ status: 'denied', reason: 'environment_mismatch' });
    for (const caller of ['uts-staging', 'uts-local', 'uts-test']) {
      expect(await bundle(caller), caller).toEqual({
        status: 'denied',
        reason: 'unknown_workload',
      });
    }
    await Promise.all(pending);
  });
});
