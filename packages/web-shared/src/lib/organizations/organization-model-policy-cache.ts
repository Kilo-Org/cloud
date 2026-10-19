import * as z from 'zod';
import type { EffectiveOrganizationModelPolicy } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import {
  organizationModelPolicyEpochRedisKey,
  organizationModelPolicyRedisKey,
} from '@kilocode/web-shared/lib/redis-keys';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/**
 * Writers bump the organization epoch after commit, but a reader on a lagging
 * replica can still cache pre-write data under the new epoch, and writes that
 * bypass application code never bump it. The TTL bounds both.
 */
export const ORGANIZATION_MODEL_POLICY_CACHE_TTL_SECONDS = 60;

const EffectiveOrganizationModelPolicySchema = z.object({
  requireModelInCurrentSnapshot: z.boolean(),
  organizationModelDenyList: z.array(z.string()),
  organizationProviderCeiling: z.array(z.string()).optional(),
  memberGrant: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('unrestricted') }),
    z.object({ mode: z.literal('organization_baseline') }),
    z.object({
      mode: z.literal('selected'),
      includeOrganizationBaseline: z.boolean(),
      modelAllowList: z.array(z.string()),
      providerAllowList: z.array(z.string()),
    }),
  ]),
  dataCollection: z.enum(['allow', 'deny']).nullable().optional(),
  policyRevision: z.number().int(),
}) satisfies z.ZodType<EffectiveOrganizationModelPolicy>;

const CachedPolicyEntrySchema = z.object({
  epoch: z.number().int().nonnegative(),
  policy: EffectiveOrganizationModelPolicySchema,
});

type CacheParams = { organizationId: string; kiloUserId: string };

type CacheRead =
  | { status: 'hit'; policy: EffectiveOrganizationModelPolicy }
  | { status: 'miss'; epoch: number }
  | { status: 'unavailable' };

function parseEpoch(value: string | null): number | null {
  if (value === null) return 0;
  if (!/^\d+$/.test(value)) return null;
  const epoch = Number(value);
  return Number.isSafeInteger(epoch) ? epoch : null;
}

function parseEntry(value: string | null) {
  if (value === null) return null;
  try {
    const parsed = CachedPolicyEntrySchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readCachedPolicy({ organizationId, kiloUserId }: CacheParams): Promise<CacheRead> {
  try {
    const [rawEpoch, rawEntry] = await redisClient.mget<[string | null, string | null]>(
      organizationModelPolicyEpochRedisKey(organizationId),
      organizationModelPolicyRedisKey(organizationId, kiloUserId)
    );
    const epoch = parseEpoch(rawEpoch);
    if (epoch === null) return { status: 'unavailable' };
    const entry = parseEntry(rawEntry);
    if (entry?.epoch === epoch) return { status: 'hit', policy: entry.policy };
    return { status: 'miss', epoch };
  } catch (error) {
    warnExceptInTest('Organization model policy cache read failed', { organizationId, error });
    return { status: 'unavailable' };
  }
}

async function writeCachedPolicy(
  { organizationId, kiloUserId }: CacheParams,
  epoch: number,
  policy: EffectiveOrganizationModelPolicy
): Promise<void> {
  try {
    await redisClient.set(
      organizationModelPolicyRedisKey(organizationId, kiloUserId),
      JSON.stringify({ epoch, policy }),
      { ex: ORGANIZATION_MODEL_POLICY_CACHE_TTL_SECONDS }
    );
  } catch (error) {
    warnExceptInTest('Organization model policy cache write failed', { organizationId, error });
  }
}

/**
 * Return the member's effective model policy from Redis, or compute it and
 * cache it without delaying the caller.
 *
 * The epoch and the member entry are read with one MGET, a plain read that the
 * regional Upstash replica serves. An entry is only used when it was written
 * under the current epoch, and a computed policy is stored under the epoch
 * observed before `computePolicy` read the database, so an invalidation that
 * lands during the computation makes the new entry unusable. Redis failures
 * and malformed values fall back to `computePolicy`.
 *
 * A hit skips `computePolicy`, including any membership check it performs, so
 * callers must authorize membership independently.
 */
export async function getCachedOrganizationModelPolicy(
  params: CacheParams,
  computePolicy: () => Promise<EffectiveOrganizationModelPolicy>
): Promise<EffectiveOrganizationModelPolicy> {
  const cached = await readCachedPolicy(params);
  if (cached.status === 'hit') return cached.policy;
  const policy = await computePolicy();
  if (cached.status === 'miss') void writeCachedPolicy(params, cached.epoch, policy);
  return policy;
}

/**
 * Make every cached model policy of the organization unusable. Call after the
 * transaction that changes any input of the evaluated policy commits. Redis
 * failures are logged, not thrown: the cache TTL still bounds staleness.
 */
export async function invalidateOrganizationModelPolicyCache(
  organizationId: string
): Promise<void> {
  try {
    await redisClient.incr(organizationModelPolicyEpochRedisKey(organizationId));
  } catch (error) {
    warnExceptInTest('Organization model policy cache invalidation failed', {
      organizationId,
      error,
    });
  }
}
