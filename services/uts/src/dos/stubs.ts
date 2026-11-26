import {
  UtsFeedIndexSchema,
  UtsSignerIndexSchema,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { Env, UtsConfig } from '../env';
import type { UtsFeedDO } from '../feed/UtsFeedDO';
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

/** The feed index a feed object takes from its id. */
export function feedOfObjectId(
  config: UtsConfig,
  id: Pick<DurableObjectId, 'name' | 'jurisdiction'>
): ObjectIdCheck {
  return indexOfObjectId(config, id, 'feed', feedOfObjectName);
}

export function getSignerStub(
  env: Env,
  config: UtsConfig,
  signer: number
): DurableObjectStub<UtsSignerDO> {
  const namespace =
    config.jurisdiction === 'eu' ? env.UTS_SIGNER_DO.jurisdiction('eu') : env.UTS_SIGNER_DO;
  return namespace.get(namespace.idFromName(signerObjectName(config.environment, signer)), {
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
  const namespace =
    config.jurisdiction === 'eu' ? env.UTS_FEED_DO.jurisdiction('eu') : env.UTS_FEED_DO;
  const index = UtsFeedIndexSchema.parse(feed);
  return namespace.get(namespace.idFromName(feedObjectName(config.environment, index)), {
    locationHint: FEED_OBJECT_LOCATION_HINTS[index],
  });
}
