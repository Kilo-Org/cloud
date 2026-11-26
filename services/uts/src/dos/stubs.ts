import { UtsSignerIndexSchema, type UtsEnvironment } from '@kilocode/uts-contracts';
import { z } from 'zod';
import { AUDIT_SHARD_COUNT } from '../audit/relay';
import type { Env, UtsConfig } from '../env';
import type { UtsAuditRelayDO } from './UtsAuditRelayDO';
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
  kind: 'signer' | 'key-set shard' | 'audit relay',
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

const AuditShardSchema = z
  .number()
  .int()
  .min(0)
  .max(AUDIT_SHARD_COUNT - 1);

const AUDIT_RELAY_NAME_PATTERN = /^(production|staging|development):audit-relay:(\d)$/;

export function auditRelayObjectName(environment: UtsEnvironment, shard: number): string {
  return `${environment}:audit-relay:${AuditShardSchema.parse(shard)}`;
}

/** The audit shard an object name names in this environment, or null for any other name. */
export function auditShardOfObjectName(environment: UtsEnvironment, name: string): number | null {
  const match = AUDIT_RELAY_NAME_PATTERN.exec(name);
  if (match === null || match[1] !== environment) return null;
  const shard = AuditShardSchema.safeParse(Number(match[2]));
  return shard.success ? shard.data : null;
}

/** The audit shard an audit relay object takes from its id. */
export function auditShardOfObjectId(
  config: UtsConfig,
  id: Pick<DurableObjectId, 'name' | 'jurisdiction'>
): ObjectIdCheck {
  return indexOfObjectId(config, id, 'audit relay', auditShardOfObjectName);
}

export function getAuditRelayStub(
  env: Env,
  config: UtsConfig,
  shard: number
): DurableObjectStub<UtsAuditRelayDO> {
  const namespace =
    config.jurisdiction === 'eu'
      ? env.UTS_AUDIT_RELAY_DO.jurisdiction('eu')
      : env.UTS_AUDIT_RELAY_DO;
  return namespace.get(namespace.idFromName(auditRelayObjectName(config.environment, shard)), {
    locationHint: UTS_OBJECT_LOCATION_HINT,
  });
}
