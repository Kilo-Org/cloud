import {
  UtsFeedIndexSchema,
  UtsSignerIndexSchema,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import { AUDIT_SHARD_COUNT } from '../audit/relay';
import type { Env, UtsConfig } from '../env';
import type { UtsFeedDO } from '../feed/UtsFeedDO';
import type { UtsAuditRelayDO } from './UtsAuditRelayDO';
import type { UtsKeySetDO } from './UtsKeySetDO';
import type { UtsSignerDO } from './UtsSignerDO';

/**
 * A Durable Object never moves after creation, so the first `get()` places it: the `eu`
 * jurisdiction keeps it in the EU, and the hint asks for western Europe, near the identity store's
 * primary in Frankfurt (design 5.7). The hint is best effort; the jurisdiction is enforced.
 */
export const UTS_OBJECT_LOCATION_HINT: DurableObjectLocationHint = 'weur';

/**
 * The two feed objects sit in the `eu` jurisdiction with different EU hints, western and eastern
 * Europe, so one regional failure does not stop both (design 5.6).
 */
export const FEED_OBJECT_LOCATION_HINTS: readonly DurableObjectLocationHint[] = ['weur', 'eeur'];

/** The fixed number of key-set shards (design 5.7); it bounds the signer reads (design 3). */
export const KEY_SET_SHARD_COUNT = 8;

const KeySetShardSchema = z
  .number()
  .int()
  .min(0)
  .max(KEY_SET_SHARD_COUNT - 1);

const SIGNER_NAME_PATTERN = /^(production|staging|development):signer:(\d{2})$/;
const KEY_SET_SHARD_NAME_PATTERN = /^(production|staging|development):keyset:(\d)$/;
const FEED_NAME_PATTERN = /^(production|staging|development):feed:(\d)$/;

/** Object names carry the environment, so a staging object can never serve production. */
export function signerObjectName(environment: UtsEnvironment, signer: number): string {
  return `${environment}:signer:${String(UtsSignerIndexSchema.parse(signer)).padStart(2, '0')}`;
}

export function keySetShardObjectName(environment: UtsEnvironment, shard: number): string {
  return `${environment}:keyset:${KeySetShardSchema.parse(shard)}`;
}

export function feedObjectName(environment: UtsEnvironment, feed: number): string {
  return `${environment}:feed:${UtsFeedIndexSchema.parse(feed)}`;
}

/** The feed index an object name names in this environment, or null for any other name. */
export function feedOfObjectName(environment: UtsEnvironment, name: string): number | null {
  const match = FEED_NAME_PATTERN.exec(name);
  if (match === null || match[1] !== environment) return null;
  const feed = UtsFeedIndexSchema.safeParse(Number(match[2]));
  return feed.success ? feed.data : null;
}

/** The signer index an object name names in this environment, or null for any other name. */
export function signerOfObjectName(environment: UtsEnvironment, name: string): number | null {
  const match = SIGNER_NAME_PATTERN.exec(name);
  if (match === null || match[1] !== environment) return null;
  const signer = UtsSignerIndexSchema.safeParse(Number(match[2]));
  return signer.success ? signer.data : null;
}

/** The shard index an object name names in this environment, or null for any other name. */
export function keySetShardOfObjectName(environment: UtsEnvironment, name: string): number | null {
  const match = KEY_SET_SHARD_NAME_PATTERN.exec(name);
  if (match === null || match[1] !== environment) return null;
  const shard = KeySetShardSchema.safeParse(Number(match[2]));
  return shard.success ? shard.data : null;
}

export type ObjectIdCheck =
  | { status: 'accepted'; index: number }
  | { status: 'refused'; reason: string };

/**
 * The index a UTS object takes from its id. The name must be a `kind` name of this environment
 * and the object must sit in this environment's jurisdiction; any other object is refused, so no
 * key is ever created, and no key set is ever served, under another name or outside the EU.
 */
function indexOfObjectId(
  config: UtsConfig,
  id: Pick<DurableObjectId, 'name' | 'jurisdiction'>,
  kind: 'signer' | 'key-set shard' | 'feed',
  indexOfName: (environment: UtsEnvironment, name: string) => number | null
): ObjectIdCheck {
  const index = id.name === undefined ? null : indexOfName(config.environment, id.name);
  if (index === null) {
    return { status: 'refused', reason: `${kind} object was not created by its ${kind} name` };
  }
  const jurisdiction = id.jurisdiction ?? 'none';
  if (jurisdiction !== config.jurisdiction) {
    return {
      status: 'refused',
      reason: `${kind} object is in jurisdiction ${jurisdiction}, not ${config.jurisdiction}`,
    };
  }
  return { status: 'accepted', index };
}

/** The signer index a new signer object takes from its id. */
export function signerOfObjectId(
  config: UtsConfig,
  id: Pick<DurableObjectId, 'name' | 'jurisdiction'>
): ObjectIdCheck {
  return indexOfObjectId(config, id, 'signer', signerOfObjectName);
}

/** The shard index a key-set shard object takes from its id. */
export function keySetShardOfObjectId(
  config: UtsConfig,
  id: Pick<DurableObjectId, 'name' | 'jurisdiction'>
): ObjectIdCheck {
  return indexOfObjectId(config, id, 'key-set shard', keySetShardOfObjectName);
}

function signerNamespace(env: Env, config: UtsConfig): DurableObjectNamespace<UtsSignerDO> {
  return config.jurisdiction === 'eu' ? env.UTS_SIGNER_DO.jurisdiction('eu') : env.UTS_SIGNER_DO;
}

/** The id of signer `signer`'s object in this environment, inside its jurisdiction. */
function signerObjectId(env: Env, config: UtsConfig, signer: number): DurableObjectId {
  return signerNamespace(env, config).idFromName(signerObjectName(config.environment, signer));
}

/**
 * Checks that an object which already stores the state of `kind` object `index` is that object in
 * this environment and jurisdiction, before it imports the stored keys. It compares the object's
 * id with `expected`, the id that object's name gives in this environment (null when `index`
 * names no such object); an id carries its jurisdiction but not always its name (an object
 * started by an alarm or opened by its raw id has none), so this check needs no name. A state
 * copied to another object, or an object of another environment, is refused.
 */
function storedObjectCheck(
  kind: 'signer' | 'feed',
  config: UtsConfig,
  id: DurableObjectId,
  index: number,
  expected: DurableObjectId | null
): ObjectIdCheck {
  const jurisdiction = id.jurisdiction ?? 'none';
  if (jurisdiction !== config.jurisdiction) {
    return {
      status: 'refused',
      reason: `${kind} object is in jurisdiction ${jurisdiction}, not ${config.jurisdiction}`,
    };
  }
  if (expected === null || !id.equals(expected)) {
    return {
      status: 'refused',
      reason: `stored state names ${kind} ${index}, but this is not that ${kind}'s ${config.environment} object`,
    };
  }
  return { status: 'accepted', index };
}

/** `storedObjectCheck` for a signer object that stores signer `signer`'s keys. */
export function storedSignerCheck(
  env: Env,
  config: UtsConfig,
  id: DurableObjectId,
  signer: number
): ObjectIdCheck {
  return storedObjectCheck('signer', config, id, signer, signerObjectId(env, config, signer));
}

/** The feed index a new feed object takes from its id. */
export function feedOfObjectId(
  config: UtsConfig,
  id: Pick<DurableObjectId, 'name' | 'jurisdiction'>
): ObjectIdCheck {
  return indexOfObjectId(config, id, 'feed', feedOfObjectName);
}

function feedNamespace(env: Env, config: UtsConfig): DurableObjectNamespace<UtsFeedDO> {
  return config.jurisdiction === 'eu' ? env.UTS_FEED_DO.jurisdiction('eu') : env.UTS_FEED_DO;
}

/**
 * `storedObjectCheck` for a feed object that stores feed `feed`'s keys. The stored state has the
 * signer state's shape, so its index is checked as a feed index here.
 */
export function storedFeedCheck(
  env: Env,
  config: UtsConfig,
  id: DurableObjectId,
  feed: number
): ObjectIdCheck {
  const index = UtsFeedIndexSchema.safeParse(feed);
  const expected = index.success
    ? feedNamespace(env, config).idFromName(feedObjectName(config.environment, index.data))
    : null;
  return storedObjectCheck('feed', config, id, feed, expected);
}

export function getSignerStub(
  env: Env,
  config: UtsConfig,
  signer: number
): DurableObjectStub<UtsSignerDO> {
  return signerNamespace(env, config).get(signerObjectId(env, config, signer), {
    locationHint: UTS_OBJECT_LOCATION_HINT,
  });
}

export function getKeySetShardStub(
  env: Env,
  config: UtsConfig,
  shard: number
): DurableObjectStub<UtsKeySetDO> {
  const namespace =
    config.jurisdiction === 'eu' ? env.UTS_KEY_SET_DO.jurisdiction('eu') : env.UTS_KEY_SET_DO;
  return namespace.get(namespace.idFromName(keySetShardObjectName(config.environment, shard)), {
    locationHint: UTS_OBJECT_LOCATION_HINT,
  });
}

export function getFeedStub(
  env: Env,
  config: UtsConfig,
  feed: number
): DurableObjectStub<UtsFeedDO> {
  const namespace = feedNamespace(env, config);
  const index = UtsFeedIndexSchema.parse(feed);
  return namespace.get(namespace.idFromName(feedObjectName(config.environment, index)), {
    locationHint: FEED_OBJECT_LOCATION_HINTS[index],
  });
}

const AuditShardSchema = z
  .number()
  .int()
  .min(0)
  .max(AUDIT_SHARD_COUNT - 1);

export function auditRelayObjectName(environment: UtsEnvironment, shard: number): string {
  return `${environment}:audit-relay:${AuditShardSchema.parse(shard)}`;
}

function auditRelayNamespace(env: Env, config: UtsConfig): DurableObjectNamespace<UtsAuditRelayDO> {
  return config.jurisdiction === 'eu'
    ? env.UTS_AUDIT_RELAY_DO.jurisdiction('eu')
    : env.UTS_AUDIT_RELAY_DO;
}

/**
 * The audit shard of a relay object: the shard whose name gives this object's id in this
 * environment and jurisdiction. The relay stores no state that names its shard, and an id does
 * not always carry its name (an alarm after an eviction or a deploy starts the object without
 * one), so the check compares ids, as `storedObjectCheck` does: 8 local name hashes, once per
 * object start. Any other object, such as one of another environment, is refused.
 */
export function auditShardOfObjectId(
  env: Env,
  config: UtsConfig,
  id: DurableObjectId
): ObjectIdCheck {
  const jurisdiction = id.jurisdiction ?? 'none';
  if (jurisdiction !== config.jurisdiction) {
    return {
      status: 'refused',
      reason: `audit relay object is in jurisdiction ${jurisdiction}, not ${config.jurisdiction}`,
    };
  }
  const namespace = auditRelayNamespace(env, config);
  for (let shard = 0; shard < AUDIT_SHARD_COUNT; shard += 1) {
    if (id.equals(namespace.idFromName(auditRelayObjectName(config.environment, shard)))) {
      return { status: 'accepted', index: shard };
    }
  }
  return {
    status: 'refused',
    reason: `audit relay object is not the object of an audit relay name of ${config.environment}`,
  };
}

export function getAuditRelayStub(
  env: Env,
  config: UtsConfig,
  shard: number
): DurableObjectStub<UtsAuditRelayDO> {
  const namespace = auditRelayNamespace(env, config);
  return namespace.get(namespace.idFromName(auditRelayObjectName(config.environment, shard)), {
    locationHint: UTS_OBJECT_LOCATION_HINT,
  });
}
