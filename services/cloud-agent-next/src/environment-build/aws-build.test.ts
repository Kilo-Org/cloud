import { describe, expect, it } from 'vitest';
import { EC2_TEST_CONFIG } from '../../test/fixtures/aws-ec2.js';
import { awsEc2FilesystemBase } from '../byoc/aws-ec2-provider.js';
import type { Env } from '../types.js';
import { awsBuildEgressContext } from './aws-build.js';
import { AwsBuildInactiveError, createAwsBuildContexts } from './aws-build-context.js';
import type { BuildScmGrant } from './scm-credentials.js';
import type { BuildInputRecord, BuildRow } from './store.js';

const credentialId = '11111111-1111-4111-8111-111111111111';
const environmentId = '22222222-2222-4222-8222-222222222222';
const buildId = '33333333-3333-4333-8333-333333333333';
const allocationId = '44444444-4444-4444-8444-444444444444';
const env = {} as Env;

const input: BuildInputRecord = {
  reference: {
    environmentId,
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

function buildRow(state: BuildRow['state']): BuildRow {
  return {
    id: buildId,
    revision: 1,
    trigger: 'manual',
    actor_user_id: 'user-1',
    input: JSON.stringify(input),
    state,
    allocation_id: allocationId,
    deadline_at: 2_000_000,
  } as BuildRow;
}

function contextsFor(row: BuildRow) {
  return createAwsBuildContexts({
    env,
    store: {
      build: () => row,
      environment: () => ({ environmentId, deletedAt: null }),
      providerState: () => undefined,
      setProviderState: () => {},
    },
    transaction: write => write(),
    reference: async () => null,
    actorAccess: async () => {
      throw new Error('Actor access must not be read for an inactive build');
    },
    refuse: async () => {},
    now: () => 1_000_000,
  });
}

const pinned = contextsFor(buildRow('preparing')).pinned(buildId);
const grant = { buildId } as unknown as BuildScmGrant;
const withGrant = { ...pinned, state: { ...pinned.state, scm: grant } };
const retired = { ...pinned, state: { ...pinned.state, scm: 'retired' as const } };

describe('awsBuildEgressContext', () => {
  it('admits the build grant only while the build is available and the grant is live', () => {
    const active = awsBuildEgressContext(env, withGrant, true);
    expect(active.grants).toEqual([grant]);
    expect(active.liveMemberIds).toEqual([buildId]);
  });

  it('removes SCM authority once the grant is retired', () => {
    const context = awsBuildEgressContext(env, retired, true);
    expect(context.grants).toEqual([]);
    expect(context.liveMemberIds).toEqual([]);
  });

  it('removes SCM authority once the build is no longer available', () => {
    const context = awsBuildEgressContext(env, withGrant, false);
    expect(context.available).toBe(false);
    expect(context.allocation.active).toBe(false);
    expect(context.grants).toEqual([]);
    expect(context.liveMemberIds).toEqual([]);
  });

  it('changes the identity binding on retirement so in-flight admissions are fenced', () => {
    expect(awsBuildEgressContext(env, retired, true).identityBinding).not.toBe(
      awsBuildEgressContext(env, withGrant, true).identityBinding
    );
  });

  it('never claims that build egress is audited', () => {
    expect(awsBuildEgressContext(env, withGrant, true).audit).toBe(false);
  });
});

describe('createAwsBuildContexts', () => {
  it('treats a build that left preparing as inactive', async () => {
    await expect(contextsFor(buildRow('capturing')).active(buildId)).rejects.toBeInstanceOf(
      AwsBuildInactiveError
    );
  });
});
