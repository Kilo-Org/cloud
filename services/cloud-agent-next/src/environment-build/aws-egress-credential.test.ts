import { describe, expect, it } from 'vitest';
import { mintRunnerCredential, verifyRunnerCredential } from './runner-credential.js';
import {
  mintAwsBuildEgressCredential,
  verifyAwsBuildEgressCredential,
} from './aws-egress-credential.js';
import { verifyAwsEgressCredential } from '../egress/aws-credential.js';
import { verifySandboxLaunchCredential } from '../sandbox-control/credential.js';

const secret = 'synthetic-worker-signing-secret';
const runner = {
  environmentId: '11111111-1111-4111-8111-111111111111',
  buildId: '22222222-2222-4222-8222-222222222222',
  allocationId: '33333333-3333-4333-8333-333333333333',
  credential: 'a'.repeat(64),
};
function input() {
  return {
    ...runner,
    provider: 'aws-ecs' as const,
    runnerCredential: mintRunnerCredential(runner, secret),
    sandboxId: 'ses-' + runner.buildId.replaceAll('-', ''),
    actorUserId: 'oauth/provider/build-actor',
    credentialId: '44444444-4444-4444-8444-444444444444',
    generation: '55555555-5555-4555-8555-555555555555',
    stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/customer/12345678-abcd',
    expiresAt: Date.now() + 60_000,
  };
}
describe('ECS build proxy purpose', () => {
  it('binds verified runner, actor, engine, connection and proxy generation without Session authority', () => {
    const value = input();
    const token = mintAwsBuildEgressCredential(value, secret);
    expect(verifyAwsBuildEgressCredential(token, secret)).toMatchObject({
      ...runner,
      provider: 'aws-ecs',
      sandboxId: value.sandboxId,
      actorUserId: value.actorUserId,
      credentialId: value.credentialId,
      generation: value.generation,
      stackId: value.stackId,
      exp: Math.floor(value.expiresAt / 1000),
    });
    expect(verifyAwsEgressCredential(token, secret)).toBeNull();
    expect(verifySandboxLaunchCredential(token, secret)).toBeNull();
    expect(verifyRunnerCredential(token, secret)).toBeNull();
    expect(verifyAwsBuildEgressCredential(value.runnerCredential, secret)).toBeNull();
    expect(token.length).toBeLessThan(4096);
  });
  it.each(['environmentId', 'buildId', 'allocationId'] as const)(
    'rejects runner %s substitution before signing',
    field => {
      const value = input();
      value[field] = '66666666-6666-4666-8666-666666666666';
      expect(() => mintAwsBuildEgressCredential(value, secret)).toThrow('identity is invalid');
    }
  );
  it('refuses a retired engine before signing', () => {
    expect(() =>
      mintAwsBuildEgressCredential({ ...input(), provider: 'aws' } as never, secret)
    ).toThrow();
  });
  it('refuses an unverified runner, another signer and expiry', () => {
    const value = input();
    expect(() =>
      mintAwsBuildEgressCredential(
        { ...value, runnerCredential: mintRunnerCredential(runner, 'other-secret') },
        secret
      )
    ).toThrow();
    const token = mintAwsBuildEgressCredential(value, secret);
    expect(verifyAwsBuildEgressCredential(token, 'other-secret')).toBeNull();
    expect(verifyAwsBuildEgressCredential(token, secret, value.expiresAt + 1000)).toBeNull();
    expect(() =>
      mintAwsBuildEgressCredential({ ...value, expiresAt: Date.now() - 1 }, secret)
    ).toThrow();
  });
});
