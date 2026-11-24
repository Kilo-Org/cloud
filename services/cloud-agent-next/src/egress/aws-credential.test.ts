import { describe, expect, it } from 'vitest';
import {
  mintSandboxLaunchCredential,
  verifySandboxLaunchCredential,
} from '../sandbox-control/credential.js';
import { ECS_TEST_CONFIG } from '../../test/fixtures/aws-ecs.js';
import { mintAwsEgressCredential, verifyAwsEgressCredential } from './aws-credential.js';

const secret = 'test-worker-secret';
const allocation = {
  sandboxId: 'sbx_test_aws',
  allocationId: '11111111-1111-4111-8111-111111111111',
  credential: 'a'.repeat(64),
};
const generation = '22222222-2222-4222-8222-222222222222';
const stackId = ECS_TEST_CONFIG.stackId;
const expiresAt = Math.floor((Date.now() + 86_400_000) / 1000) * 1000;

describe('AWS egress credential purpose', () => {
  it('binds the current allocation and deployment without authorizing a wrapper', () => {
    const launchCredential = mintSandboxLaunchCredential(allocation, secret);
    const egress = mintAwsEgressCredential(
      { launchCredential, generation, stackId },
      secret,
      expiresAt
    );
    expect(verifyAwsEgressCredential(egress, secret)).toMatchObject({
      ...allocation,
      generation,
      stackId,
    });
    expect(verifySandboxLaunchCredential(egress, secret)).toBeNull();
    expect(verifyAwsEgressCredential(launchCredential, secret)).toBeNull();
  });
  it('refuses another signer and expires at the given time', () => {
    const launchCredential = mintSandboxLaunchCredential(allocation, secret);
    const egress = mintAwsEgressCredential(
      { launchCredential, generation, stackId },
      secret,
      expiresAt
    );
    expect(verifyAwsEgressCredential(egress, 'other-secret')).toBeNull();
    expect(verifyAwsEgressCredential(egress, secret, expiresAt - 1000)).not.toBeNull();
    expect(verifyAwsEgressCredential(egress, secret, expiresAt)).toBeNull();
  });
  it('refuses an expiry that is not in the future', () => {
    const launchCredential = mintSandboxLaunchCredential(allocation, secret);
    expect(() =>
      mintAwsEgressCredential({ launchCredential, generation, stackId }, secret, Date.now())
    ).toThrow('expiry is invalid');
  });
  it('does not turn unverified launch input into a signed egress identity', () => {
    const launchCredential = mintSandboxLaunchCredential(allocation, 'other-secret');
    expect(() =>
      mintAwsEgressCredential({ launchCredential, generation, stackId }, secret, expiresAt)
    ).toThrow('identity is invalid');
  });
});
