import { UtsSignerIndexSchema, type UtsEnvironment } from '@kilocode/uts-contracts';
import type { Env, UtsConfig } from '../env';
import type { UtsSignerDO } from './UtsSignerDO';

/**
 * A Durable Object never moves after creation, so the first `get()` places it: the `eu`
 * jurisdiction keeps it in the EU, and the hint asks for western Europe, near the identity store's
 * primary in Frankfurt (design 5.7).
 */
export const SIGNER_LOCATION_HINT: DurableObjectLocationHint = 'weur';

const SIGNER_NAME_PATTERN = /^(production|staging|development):signer:(\d{2})$/;

/** Object names carry the environment, so a staging object can never serve production. */
export function signerObjectName(environment: UtsEnvironment, signer: number): string {
  return `${environment}:signer:${String(UtsSignerIndexSchema.parse(signer)).padStart(2, '0')}`;
}

/** The signer index an object name names in this environment, or null for any other name. */
export function signerOfObjectName(environment: UtsEnvironment, name: string): number | null {
  const match = SIGNER_NAME_PATTERN.exec(name);
  if (match === null || match[1] !== environment) return null;
  const signer = UtsSignerIndexSchema.safeParse(Number(match[2]));
  return signer.success ? signer.data : null;
}

export type ObjectIdCheck =
  | { status: 'signer'; signer: number }
  | { status: 'refused'; reason: string };

/**
 * The signer index a new object takes from its id. The name must be a signer name of this
 * environment and the object must sit in this environment's jurisdiction; any other object is
 * refused, so no key is ever created under another name or outside the EU.
 */
export function signerOfObjectId(
  config: UtsConfig,
  id: Pick<DurableObjectId, 'name' | 'jurisdiction'>
): ObjectIdCheck {
  const signer = id.name === undefined ? null : signerOfObjectName(config.environment, id.name);
  if (signer === null) {
    return { status: 'refused', reason: 'signer object was not created by its signer name' };
  }
  const jurisdiction = id.jurisdiction ?? 'none';
  if (jurisdiction !== config.jurisdiction) {
    return {
      status: 'refused',
      reason: `signer object is in jurisdiction ${jurisdiction}, not ${config.jurisdiction}`,
    };
  }
  return { status: 'signer', signer };
}

export function getSignerStub(
  env: Env,
  config: UtsConfig,
  signer: number
): DurableObjectStub<UtsSignerDO> {
  const namespace =
    config.jurisdiction === 'eu' ? env.UTS_SIGNER_DO.jurisdiction('eu') : env.UTS_SIGNER_DO;
  return namespace.get(namespace.idFromName(signerObjectName(config.environment, signer)), {
    locationHint: SIGNER_LOCATION_HINT,
  });
}
