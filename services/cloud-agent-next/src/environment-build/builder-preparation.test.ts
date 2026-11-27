import { describe, expect, it } from 'vitest';
import { EC2_TEST_CONFIG } from '../../test/fixtures/aws-ec2.js';
import { ByocAwsProviderError } from '../byoc/aws-errors.js';
import { ScmCapabilityIssueError } from '../scm-broker/failure.js';
import { awsEc2FilesystemBase } from '../byoc/aws-ec2-provider.js';
import { AwsBuildInactiveError } from './aws-build-context.js';
import { BuilderStateInvalidError, BuilderTargetMismatchError } from './builder-errors.js';
import { createBuilderPreparation } from './builder-preparation.js';
import type { BuildInputRecord, BuildRow } from './store.js';

const credentialId = '11111111-1111-4111-8111-111111111111';
const input: BuildInputRecord = {
  reference: {
    environmentId: '22222222-2222-4222-8222-222222222222',
    owner: { type: 'organization', id: '55555555-5555-4555-8555-555555555555' },
    configurationRevision: 1,
    repository: { platform: 'github', repoFullName: 'acme/widgets' },
  },
  repoFullName: 'acme/widgets',
  commands: [],
  plainVars: {},
  target: {
    provider: 'aws-ec2',
    instance: 'aws-ec2-8g',
    credentialId,
    baseImage: awsEc2FilesystemBase(credentialId, EC2_TEST_CONFIG),
  },
};
const build = {
  id: '33333333-3333-4333-8333-333333333333',
  input: JSON.stringify(input),
  allocation_id: '44444444-4444-4444-8444-444444444444',
  actor_user_id: 'user-1',
  encrypted_secrets: null,
  deadline_at: 2_000_000,
} as BuildRow;

function prepareWith(error: Error) {
  return createBuilderPreparation({
    gitSource: async () => {
      throw new Error('AWS builds must not resolve Git sources directly');
    },
    decryptSecrets: () => ({}),
    aws: {
      input: async () => {
        throw error;
      },
      assertReady: () => {},
    },
  }).prepareInput(build);
}

describe('AWS builder input preparation', () => {
  it.each([new BuilderStateInvalidError(), new BuilderTargetMismatchError()])(
    'fails the build once for permanent state error $name',
    async error => {
      await expect(prepareWith(error)).resolves.toEqual({
        refused: 'input_unavailable',
        detail: error.message,
      });
    }
  );

  it.each([
    new ByocAwsProviderError('byoc_aws_not_ready'),
    new ScmCapabilityIssueError('github', 'service_unavailable'),
  ])('keeps transient error $name retryable', async error => {
    await expect(prepareWith(error)).resolves.toEqual({ refused: 'unavailable' });
  });

  it('refuses a denied repository and an inactive build specifically', async () => {
    await expect(
      prepareWith(new ScmCapabilityIssueError('github', 'repository_not_installed'))
    ).resolves.toEqual({ refused: 'repository_unauthorized' });
    await expect(prepareWith(new AwsBuildInactiveError())).resolves.toEqual({ refused: 'gone' });
  });
});
