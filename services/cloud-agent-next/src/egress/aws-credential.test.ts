import { describe, expect, it } from 'vitest';
import {
  mintSandboxLaunchCredential,
  verifySandboxLaunchCredential,
} from '../sandbox-control/credential.js';
import { AWS_TEST_CONFIGURATION } from '../../test/fixtures/aws-provider.js';
import { mintAwsEgressCredential, verifyAwsEgressCredential } from './aws-credential.js';

const secret = 'test-worker-secret';
const allocation = {
  sandboxId: 'sbx_test_aws',
  allocationId: '11111111-1111-4111-8111-111111111111',
  credential: 'a'.repeat(64),
};
const generation = '22222222-2222-4222-8222-222222222222';
const stackId = AWS_TEST_CONFIGURATION.stackId;

describe('AWS egress credential purpose', () => {
  it('binds the current allocation and deployment without authorizing a wrapper', () => {
    const launchCredential = mintSandboxLaunchCredential(allocation, secret);
    const egress = mintAwsEgressCredential({ launchCredential, generation, stackId }, secret);
    expect(verifyAwsEgressCredential(egress, secret)).toMatchObject({
      ...allocation,
      generation,
      stackId,
    });
    expect(verifySandboxLaunchCredential(egress, secret)).toBeNull();
    expect(verifyAwsEgressCredential(launchCredential, secret)).toBeNull();
  });
  it('refuses another signer and expires after the provider lifetime', () => {
    const launchCredential = mintSandboxLaunchCredential(allocation, secret);
    const egress = mintAwsEgressCredential({ launchCredential, generation, stackId }, secret);
    expect(verifyAwsEgressCredential(egress, 'other-secret')).toBeNull();
    expect(verifyAwsEgressCredential(egress, secret, Date.now() + 28_801_000)).toBeNull();
  });
  it('does not turn unverified launch input into a signed egress identity', () => {
    const launchCredential = mintSandboxLaunchCredential(allocation, 'other-secret');
    expect(() =>
      mintAwsEgressCredential({ launchCredential, generation, stackId }, secret)
    ).toThrow('identity is invalid');
  });
});
