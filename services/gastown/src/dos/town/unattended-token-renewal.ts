import { kiloTokenPayload } from '@kilocode/worker-utils';
import { compactVerify } from 'jose';
import { z } from 'zod';
import { getGastownOrgStub } from '../GastownOrg.do';
import { getGastownUserStub } from '../GastownUser.do';
import { OrgTownRecord } from '../../db/tables/org-towns.table';
import { UserTownRecord } from '../../db/tables/user-towns.table';
import { generateKiloApiToken } from '../../util/kilo-token.util';
import { resolveSecret } from '../../util/secret.util';
import type { TownConfig } from '../../types';
import * as config from './config';
import * as runtimeAuthorization from './runtime-authorization';
import { isLegacyTownTokenRenewalAuthorized } from './legacy-token-renewal';

// The old town producer minted this plain token. Do not erase audience,
// purpose, device, environment, org, or workload restrictions by renewing another class.
const legacyTownPayload = kiloTokenPayload
  .pick({ version: true, kiloUserId: true, apiTokenPepper: true, iat: true, exp: true })
  .extend({ apiTokenPepper: z.string().min(1), iat: z.number().int(), exp: z.number().int() })
  .strict();

async function resolveRegistryIdentity(
  env: Env,
  townId: string,
  townConfig: TownConfig,
  userId: string
) {
  // Configuration only locates a registry. Its row must bind this exact town
  // to the signed principal; an eligible org member is not the town creator.
  if (townConfig.owner_type === 'org') {
    const orgId = townConfig.organization_id;
    if (!orgId) return null;
    const row = OrgTownRecord.nullable().parse(
      await getGastownOrgStub(env, orgId).getTownAsync(townId)
    );
    if (
      !row ||
      row.id !== townId ||
      row.owner_org_id !== orgId ||
      row.created_by_user_id !== userId
    )
      return null;
    return runtimeAuthorization.TownIdentitySchema.parse({
      ownerType: 'org',
      ownerUserId: row.created_by_user_id,
      organizationId: row.owner_org_id,
      createdByUserId: row.created_by_user_id,
      runtimeMode: 'legacy',
    });
  }
  if (townConfig.organization_id) return null;
  const row = UserTownRecord.nullable().parse(
    await getGastownUserStub(env, userId).getTownAsync(townId)
  );
  if (!row || row.id !== townId || row.owner_user_id !== userId) return null;
  return runtimeAuthorization.TownIdentitySchema.parse({
    ownerType: 'user',
    ownerUserId: row.owner_user_id,
    createdByUserId: row.owner_user_id,
    runtimeMode: 'legacy',
  });
}

/** Only the unattended town path may recover an expired, registry-bound legacy token. */
export async function renewUnattendedLegacyTownToken(
  storage: DurableObjectStorage,
  env: Env,
  townId: string
): Promise<boolean> {
  const state = await runtimeAuthorization.getTownIdentityState(storage, townId);
  if (state.type !== 'legacy') return false;
  const townConfig = await config.getTownConfig(storage);
  const token = townConfig.kilocode_token;
  if (!token || !env.NEXTAUTH_SECRET) return false;
  const secret = await resolveSecret(env.NEXTAUTH_SECRET);
  if (!secret) throw new Error('Town token signing unavailable');
  let raw: unknown;
  try {
    // Authenticate the bytes before parsing claims. Expiry is intentionally
    // allowed here; the strict legacy schema rejects all other restrictions.
    const { payload } = await compactVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
    });
    raw = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return false;
  }
  const parsed = legacyTownPayload.safeParse(raw);
  if (!parsed.success) return false;
  const payload = parsed.data;
  const now = Math.floor(Date.now() / 1000);
  if (payload.iat > now || payload.exp <= payload.iat || payload.exp - now > 7 * 24 * 60 * 60)
    return false;

  const identity =
    state.identity ?? (await resolveRegistryIdentity(env, townId, townConfig, payload.kiloUserId));
  if (
    !identity ||
    !(await isLegacyTownTokenRenewalAuthorized(
      env,
      identity,
      payload.kiloUserId,
      payload.apiTokenPepper
    ))
  )
    return false;
  const newToken = await generateKiloApiToken(
    { id: payload.kiloUserId, api_token_pepper: payload.apiTokenPepper },
    secret
  );

  // External verification stays outside the transaction. Fence both private
  // state and the source config so a concurrent adoption/revocation/edit wins.
  return storage.transaction(async txn => {
    const currentState = await runtimeAuthorization.getTownIdentityState(txn, townId);
    if (JSON.stringify(currentState) !== JSON.stringify(state)) return false;
    const currentConfig = await config.getTownConfig(txn);
    if (JSON.stringify(currentConfig) !== JSON.stringify(townConfig)) return false;
    if (!state.identity) await txn.put(runtimeAuthorization.TOWN_IDENTITY_KEY, identity);
    await config.updateTownConfig(txn, {
      kilocode_token: newToken,
      owner_type: identity.ownerType,
      owner_id: identity.organizationId ?? identity.ownerUserId,
      owner_user_id: identity.ownerUserId,
      organization_id: identity.organizationId,
      created_by_user_id: identity.createdByUserId,
    });
    return true;
  });
}
