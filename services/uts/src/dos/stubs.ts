import { UtsSignerIndexSchema, type UtsEnvironment } from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { Env, UtsConfig } from '../env';
import type { UtsKeySetDO } from './UtsKeySetDO';
import type { UtsSignerDO } from './UtsSignerDO';

/**
 * A Durable Object never moves after creation, so the first `get()` places it: the `eu`
 * jurisdiction keeps it in the EU, and the hint asks for western Europe, near the identity store's
 * primary in Frankfurt (design 5.7). The hint is best effort; the jurisdiction is enforced.
 */
export const UTS_OBJECT_LOCATION_HINT: DurableObjectLocationHint = 'weur';

/** The fixed number of key-set shards (design 5.7); it bounds the signer reads (design 3). */
export const KEY_SET_SHARD_COUNT = 8;

const KeySetShardSchema = z
  .number()
  .int()
  .min(0)
  .max(KEY_SET_SHARD_COUNT - 1);

const SIGNER_NAME_PATTERN = /^(production|staging|development):signer:(\d{2})$/;
const KEY_SET_SHARD_NAME_PATTERN = /^(production|staging|development):keyset:(\d)$/;

/** Object names carry the environment, so a staging object can never serve production. */
export function signerObjectName(environment: UtsEnvironment, signer: number): string {
  return `${environment}:signer:${String(UtsSignerIndexSchema.parse(signer)).padStart(2, '0')}`;
}

export function keySetShardObjectName(environment: UtsEnvironment, shard: number): string {
  return `${environment}:keyset:${KeySetShardSchema.parse(shard)}`;
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
  kind: 'signer' | 'key-set shard',
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
 * Checks that an object which already stores the state of signer `signer` is that signer's
 * object in this environment and jurisdiction, before it imports the stored keys. It compares the
 * object's id with the id the signer's name gives in this environment; an id carries its
 * jurisdiction but not always its name (an object started by an alarm or opened by its raw id has
 * none), so this check needs no name. A state copied to another object, or an object of another
 * environment, is refused.
 */
export function storedSignerCheck(
  env: Env,
  config: UtsConfig,
  id: DurableObjectId,
  signer: number
): ObjectIdCheck {
  const jurisdiction = id.jurisdiction ?? 'none';
  if (jurisdiction !== config.jurisdiction) {
    return {
      status: 'refused',
      reason: `signer object is in jurisdiction ${jurisdiction}, not ${config.jurisdiction}`,
    };
  }
  if (!id.equals(signerObjectId(env, config, signer))) {
    return {
      status: 'refused',
      reason: `stored state names signer ${signer}, but this is not that signer's ${config.environment} object`,
    };
  }
  return { status: 'accepted', index: signer };
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
