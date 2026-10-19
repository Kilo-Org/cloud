import { beforeEach, describe, expect, it } from '@jest/globals';
import type { EffectiveOrganizationModelPolicy } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import {
  organizationModelPolicyEpochRedisKey,
  organizationModelPolicyRedisKey,
} from '@kilocode/web-shared/lib/redis-keys';
import {
  getCachedOrganizationModelPolicy,
  invalidateOrganizationModelPolicyCache,
} from './organization-model-policy-cache';

jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { mget: jest.fn(), set: jest.fn(), incr: jest.fn() },
}));

const mockedRedisMget = jest.mocked(redisClient.mget);
const mockedRedisSet = jest.mocked(redisClient.set);
const mockedRedisIncr = jest.mocked(redisClient.incr);

const organizationId = 'org-1';
const kiloUserId = 'user-1';
const params = { organizationId, kiloUserId };
const epochKey = 'organization-model-policy-epoch:v1:org-1';
const entryKey = 'organization-model-policy:v1:org-1:user-1';

const selectedPolicy: EffectiveOrganizationModelPolicy = {
  requireModelInCurrentSnapshot: true,
  organizationModelDenyList: ['openai/gpt-4o'],
  organizationProviderCeiling: ['anthropic'],
  memberGrant: {
    mode: 'selected',
    includeOrganizationBaseline: false,
    modelAllowList: ['anthropic/claude-sonnet-4.5'],
    providerAllowList: ['amazon-bedrock'],
  },
  dataCollection: null,
  policyRevision: 4,
};

const computedPolicy: EffectiveOrganizationModelPolicy = {
  requireModelInCurrentSnapshot: true,
  organizationModelDenyList: [],
  memberGrant: { mode: 'organization_baseline' },
  dataCollection: 'deny',
  policyRevision: 5,
};

function mockRedisValues(epoch: string | null, entry: string | null) {
  mockedRedisMget.mockResolvedValue([epoch, entry] as never);
}

async function flushBackgroundWrites() {
  await new Promise(resolve => setImmediate(resolve));
}

describe('organization model policy cache', () => {
  beforeEach(() => {
    mockedRedisMget.mockReset();
    mockedRedisSet.mockReset();
    mockedRedisSet.mockResolvedValue('OK' as never);
    mockedRedisIncr.mockReset();
    mockedRedisIncr.mockResolvedValue(1);
  });

  it('formats the epoch and entry keys', () => {
    expect(organizationModelPolicyEpochRedisKey(organizationId)).toBe(epochKey);
    expect(organizationModelPolicyRedisKey(organizationId, kiloUserId)).toBe(entryKey);
  });

  it('returns a cached policy written under the current epoch without computing it', async () => {
    mockRedisValues('3', JSON.stringify({ epoch: 3, policy: selectedPolicy }));
    const computePolicy = jest.fn(async () => computedPolicy);

    await expect(getCachedOrganizationModelPolicy(params, computePolicy)).resolves.toEqual(
      selectedPolicy
    );

    expect(mockedRedisMget).toHaveBeenCalledWith(epochKey, entryKey);
    expect(computePolicy).not.toHaveBeenCalled();
    expect(mockedRedisSet).not.toHaveBeenCalled();
  });

  it('computes and caches the policy under epoch 0 when nothing is cached', async () => {
    mockRedisValues(null, null);
    const computePolicy = jest.fn(async () => computedPolicy);

    await expect(getCachedOrganizationModelPolicy(params, computePolicy)).resolves.toBe(
      computedPolicy
    );
    await flushBackgroundWrites();

    expect(computePolicy).toHaveBeenCalledTimes(1);
    expect(mockedRedisSet).toHaveBeenCalledWith(
      entryKey,
      JSON.stringify({ epoch: 0, policy: computedPolicy }),
      { ex: 60 }
    );
  });

  it('ignores an entry written under an older epoch', async () => {
    mockRedisValues('3', JSON.stringify({ epoch: 2, policy: selectedPolicy }));
    const computePolicy = jest.fn(async () => computedPolicy);

    await expect(getCachedOrganizationModelPolicy(params, computePolicy)).resolves.toBe(
      computedPolicy
    );
    await flushBackgroundWrites();

    expect(mockedRedisSet).toHaveBeenCalledWith(
      entryKey,
      JSON.stringify({ epoch: 3, policy: computedPolicy }),
      { ex: 60 }
    );
  });

  it('caches under the epoch observed before computing, even if it was bumped meanwhile', async () => {
    mockRedisValues('8', null);
    const computePolicy = jest.fn(async () => {
      mockRedisValues('9', null);
      return computedPolicy;
    });

    await getCachedOrganizationModelPolicy(params, computePolicy);
    await flushBackgroundWrites();

    expect(mockedRedisSet).toHaveBeenCalledWith(
      entryKey,
      JSON.stringify({ epoch: 8, policy: computedPolicy }),
      { ex: 60 }
    );
  });

  it('returns before the cache write completes', async () => {
    mockRedisValues(null, null);
    mockedRedisSet.mockReturnValue(new Promise(() => {}) as never);

    await expect(
      getCachedOrganizationModelPolicy(params, async () => computedPolicy)
    ).resolves.toBe(computedPolicy);
  });

  it('falls back to computing the policy when the Redis read fails, without writing', async () => {
    mockedRedisMget.mockRejectedValue(new Error('timeout'));
    const computePolicy = jest.fn(async () => computedPolicy);

    await expect(getCachedOrganizationModelPolicy(params, computePolicy)).resolves.toBe(
      computedPolicy
    );
    await flushBackgroundWrites();

    expect(computePolicy).toHaveBeenCalledTimes(1);
    expect(mockedRedisSet).not.toHaveBeenCalled();
  });

  it('falls back to computing the policy when the epoch is not an integer, without writing', async () => {
    mockRedisValues('not-a-number', JSON.stringify({ epoch: 0, policy: selectedPolicy }));
    const computePolicy = jest.fn(async () => computedPolicy);

    await expect(getCachedOrganizationModelPolicy(params, computePolicy)).resolves.toBe(
      computedPolicy
    );
    await flushBackgroundWrites();

    expect(mockedRedisSet).not.toHaveBeenCalled();
  });

  it.each([
    ['unparseable JSON', '{not json'],
    ['a policy that fails validation', JSON.stringify({ epoch: 1, policy: { memberGrant: {} } })],
    [
      'an unknown member grant mode',
      JSON.stringify({
        epoch: 1,
        policy: { ...selectedPolicy, memberGrant: { mode: 'everything' } },
      }),
    ],
  ])('recomputes and overwrites %s', async (_label, entry) => {
    mockRedisValues('1', entry);
    const computePolicy = jest.fn(async () => computedPolicy);

    await expect(getCachedOrganizationModelPolicy(params, computePolicy)).resolves.toBe(
      computedPolicy
    );
    await flushBackgroundWrites();

    expect(computePolicy).toHaveBeenCalledTimes(1);
    expect(mockedRedisSet).toHaveBeenCalledWith(
      entryKey,
      JSON.stringify({ epoch: 1, policy: computedPolicy }),
      { ex: 60 }
    );
  });

  it('does not surface a failed cache write', async () => {
    mockRedisValues(null, null);
    mockedRedisSet.mockRejectedValue(new Error('timeout'));

    await expect(
      getCachedOrganizationModelPolicy(params, async () => computedPolicy)
    ).resolves.toBe(computedPolicy);
    await flushBackgroundWrites();
  });

  it('propagates a policy computation failure without caching', async () => {
    mockRedisValues(null, null);
    const error = new Error('You do not have direct access to this organization');

    await expect(
      getCachedOrganizationModelPolicy(params, async () => {
        throw error;
      })
    ).rejects.toBe(error);
    await flushBackgroundWrites();

    expect(mockedRedisSet).not.toHaveBeenCalled();
  });

  it('invalidates by incrementing the organization epoch', async () => {
    await invalidateOrganizationModelPolicyCache(organizationId);

    expect(mockedRedisIncr).toHaveBeenCalledWith(epochKey);
  });

  it('does not throw when invalidation fails', async () => {
    mockedRedisIncr.mockRejectedValue(new Error('timeout'));

    await expect(invalidateOrganizationModelPolicyCache(organizationId)).resolves.toBeUndefined();
  });
});
