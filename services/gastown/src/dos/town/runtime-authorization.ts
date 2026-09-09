import { z } from 'zod';
import {
  createRuntimeAuthorization as createAuthorization,
  renewRuntimeAuthorization as renewAuthorization,
  RuntimeAuthorizationExpiredError,
  RuntimeAuthorizationRevokedError,
  RuntimeAuthorizationSchema,
  type RuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization';
import { decodeJwt } from 'jose';
import { getTownContainerStub } from '../TownContainer.do';
import * as config from './config';
import { resolveSecret } from '../../util/secret.util';
import type { TownConfig, TownConfigUpdate } from '../../types';

export const RUNTIME_AUTHORIZATION_KEY = 'town:private:runtime-authorization';
export const TOWN_IDENTITY_KEY = 'town:private:identity';

export const TownIdentitySchema = z.object({
  ownerType: z.enum(['user', 'org']),
  ownerUserId: z.string().min(1),
  organizationId: z.string().min(1).optional(),
  createdByUserId: z.string().min(1),
  runtimeMode: z.enum(['legacy', 'modern']),
});
export type TownIdentity = z.infer<typeof TownIdentitySchema>;
export type TownIdentityState =
  | { type: 'legacy'; identity: TownIdentity | null }
  | { type: 'modern'; identity: TownIdentity }
  | { type: 'invalid' };

type RuntimeAuthorizationContext = {
  storage: DurableObjectStorage;
  env: Env;
  townId: string;
  hasActiveWork: () => boolean;
  updateTownConfig: (update: TownConfigUpdate) => Promise<TownConfig>;
  now?: () => Date;
};

export async function initializePrivateTownIdentity(
  storage: DurableObjectStorage,
  identity: TownIdentity
): Promise<void> {
  const parsed = TownIdentitySchema.parse(identity);
  await storage.transaction(async txn => {
    const existing = await txn.get<unknown>(TOWN_IDENTITY_KEY);
    if (existing !== undefined) throw new Error('Town identity already initialized');
    if ((await txn.get<unknown>(RUNTIME_AUTHORIZATION_KEY)) !== undefined) {
      throw new Error('Town authorization already initialized');
    }
    await txn.put(TOWN_IDENTITY_KEY, parsed);
    await config.updateTownConfig(txn, {
      owner_type: parsed.ownerType,
      owner_id: parsed.organizationId ?? parsed.ownerUserId,
      owner_user_id: parsed.ownerUserId,
      organization_id: parsed.organizationId,
      created_by_user_id: parsed.createdByUserId,
    });
  });
}

function isModernControlToken(token: string): boolean {
  try {
    return typeof decodeJwt(token).tokenPurpose === 'string';
  } catch {
    return false;
  }
}

export async function getPrivateTownIdentity(
  storage: DurableObjectStorage,
  townId: string
): Promise<TownIdentity | null> {
  const state = await getTownIdentityState(storage, townId);
  return state.type === 'invalid' ? null : state.identity;
}

/**
 * Classify persisted authorization metadata without treating corruption as a
 * legacy town. Once either private key exists, malformed or inconsistent data
 * is an authorization failure rather than permission to use stale JWT claims.
 */
export async function getTownIdentityState(
  storage: Pick<DurableObjectStorage, 'get'>,
  townId: string
): Promise<TownIdentityState> {
  const [rawIdentity, rawAuthorization] = await Promise.all([
    storage.get<unknown>(TOWN_IDENTITY_KEY),
    storage.get<unknown>(RUNTIME_AUTHORIZATION_KEY),
  ]);
  const hasIdentity = rawIdentity !== undefined;
  const hasAuthorization = rawAuthorization !== undefined;
  const identity = TownIdentitySchema.safeParse(rawIdentity);
  const authorization = RuntimeAuthorizationSchema.safeParse(rawAuthorization);

  if (!hasIdentity && !hasAuthorization) return { type: 'legacy', identity: null };
  if (!identity.success) return { type: 'invalid' };
  if (identity.data.runtimeMode === 'legacy') {
    return hasAuthorization ? { type: 'invalid' } : { type: 'legacy', identity: identity.data };
  }
  if (hasAuthorization && !authorization.success) return { type: 'invalid' };
  if (
    authorization.success &&
    (authorization.data.resourceKind !== 'gastown' ||
      authorization.data.resourceId !== townId ||
      authorization.data.organizationId !== identity.data.organizationId ||
      authorization.data.userId !== identity.data.ownerUserId ||
      authorization.data.authorizationUserId !== identity.data.ownerUserId)
  ) {
    return { type: 'invalid' };
  }
  return { type: 'modern', identity: identity.data };
}

export async function requiresRuntimeAuthorization(
  storage: DurableObjectStorage,
  townId: string
): Promise<boolean> {
  return (await getTownIdentityState(storage, townId)).type !== 'legacy';
}

export async function createRuntimeAuthorization(
  ctx: RuntimeAuthorizationContext,
  controlToken: string,
  userId: string,
  organizationId?: string,
  expectedAuthorization?: RuntimeAuthorization
): Promise<string | undefined> {
  const identity = await getPrivateTownIdentity(ctx.storage, ctx.townId);
  if (
    !identity ||
    identity.organizationId !== organizationId ||
    (identity.ownerType === 'user' && identity.ownerUserId !== userId) ||
    !controlToken ||
    !ctx.env.NEXTAUTH_SECRET ||
    !ctx.env.HYPERDRIVE
  )
    return undefined;
  const previousAuthorization = await ctx.storage.get<unknown>(RUNTIME_AUTHORIZATION_KEY);
  if (
    expectedAuthorization !== undefined &&
    JSON.stringify(RuntimeAuthorizationSchema.safeParse(previousAuthorization).data) !==
      JSON.stringify(expectedAuthorization)
  )
    return undefined;
  const secret = await resolveSecret(ctx.env.NEXTAUTH_SECRET);
  if (!secret) return undefined;
  try {
    const created = await createAuthorization({
      token: controlToken,
      secret,
      connectionString: ctx.env.HYPERDRIVE.connectionString,
      resourceKind: 'gastown',
      resourceId: ctx.townId,
      organizationId,
      now: ctx.now?.(),
    });
    if (
      created.authorization.userId !== userId ||
      created.authorization.authorizationUserId !== userId ||
      created.authorization.organizationId !== identity.organizationId ||
      created.authorization.resourceKind !== 'gastown' ||
      created.authorization.resourceId !== ctx.townId
    ) {
      throw new Error('Runtime authorization owner mismatch');
    }
    await ctx.storage.transaction(async txn => {
      const currentIdentity = await txn.get<unknown>(TOWN_IDENTITY_KEY);
      const currentAuthorization = await txn.get<unknown>(RUNTIME_AUTHORIZATION_KEY);
      if (
        JSON.stringify(currentIdentity) !== JSON.stringify(identity) ||
        JSON.stringify(currentAuthorization) !== JSON.stringify(previousAuthorization) ||
        (expectedAuthorization !== undefined && ctx.hasActiveWork())
      ) {
        throw new Error('Town authorization changed during admission');
      }
      await txn.put(RUNTIME_AUTHORIZATION_KEY, created.authorization);
      // An org owner can take over runtime sponsorship; retain creator attribution.
      await txn.put(TOWN_IDENTITY_KEY, {
        ...identity,
        ownerUserId: userId,
        runtimeMode: 'modern',
      } satisfies TownIdentity);
      if (identity.ownerUserId !== userId) {
        await config.updateTownConfig(txn, { owner_user_id: userId });
      }
    });
    return created.token;
  } catch {
    return undefined;
  }
}

export async function initializeTownIdentityAndRuntimeAuthorization(
  ctx: RuntimeAuthorizationContext,
  identity: TownIdentity,
  controlToken: string
): Promise<{ runtimeToken?: string; modernControl: boolean }> {
  await initializePrivateTownIdentity(ctx.storage, identity);
  const modernControl = isModernControlToken(controlToken);
  const runtimeToken = await createRuntimeAuthorization(
    ctx,
    controlToken,
    identity.ownerUserId,
    identity.organizationId
  );
  return { runtimeToken, modernControl };
}

export async function reauthorizeRuntime(
  ctx: RuntimeAuthorizationContext,
  controlToken: string,
  userId: string,
  organizationId?: string
): Promise<boolean> {
  const identity = await getPrivateTownIdentity(ctx.storage, ctx.townId);
  const current = RuntimeAuthorizationSchema.safeParse(
    await ctx.storage.get<unknown>(RUNTIME_AUTHORIZATION_KEY)
  );
  const expired =
    current.success &&
    current.data.state === 'active' &&
    Date.parse(current.data.delegationExpiresAt) <= (ctx.now?.() ?? new Date()).getTime();
  if (
    !isModernControlToken(controlToken) ||
    !identity ||
    !current.success ||
    (current.data.state !== 'revoked' && !expired) ||
    identity.organizationId !== organizationId ||
    (identity.ownerType === 'user' && identity.ownerUserId !== userId) ||
    ctx.hasActiveWork()
  )
    return false;
  const container = await getTownContainerStub(ctx.env, ctx.townId).getState();
  if (container.status === 'running' || container.status === 'healthy') return false;
  const latest = RuntimeAuthorizationSchema.safeParse(
    await ctx.storage.get<unknown>(RUNTIME_AUTHORIZATION_KEY)
  );
  if (!latest.success || JSON.stringify(latest.data) !== JSON.stringify(current.data)) {
    return false;
  }
  return (
    (await createRuntimeAuthorization(ctx, controlToken, userId, organizationId, current.data)) !==
    undefined
  );
}

export async function renewRuntimeAuthorization(
  ctx: RuntimeAuthorizationContext
): Promise<string | undefined> {
  const raw = await ctx.storage.get<unknown>(RUNTIME_AUTHORIZATION_KEY);
  if (!raw || !ctx.env.NEXTAUTH_SECRET || !ctx.env.HYPERDRIVE) return undefined;
  const authorization = RuntimeAuthorizationSchema.safeParse(raw);
  if (!authorization.success || authorization.data.state !== 'active') return undefined;
  const secret = await resolveSecret(ctx.env.NEXTAUTH_SECRET);
  if (!secret) return undefined;
  try {
    const renewed = await renewAuthorization({
      authorization: authorization.data,
      secret,
      connectionString: ctx.env.HYPERDRIVE.connectionString,
      now: ctx.now?.(),
    });
    const current = RuntimeAuthorizationSchema.safeParse(
      await ctx.storage.get<unknown>(RUNTIME_AUTHORIZATION_KEY)
    );
    if (
      !current.success ||
      current.data.id !== authorization.data.id ||
      current.data.state !== 'active'
    ) {
      return undefined;
    }
    await ctx.updateTownConfig({ kilocode_token: renewed.token });
    return renewed.token;
  } catch (error) {
    if (
      error instanceof RuntimeAuthorizationRevokedError ||
      error instanceof RuntimeAuthorizationExpiredError
    ) {
      // A concurrent reauthorization may have replaced this record while the
      // database renewal was in flight. Never let the old request revoke the
      // newly-issued authorization.
      const current = RuntimeAuthorizationSchema.safeParse(
        await ctx.storage.get<unknown>(RUNTIME_AUTHORIZATION_KEY)
      );
      if (
        current.success &&
        current.data.id === authorization.data.id &&
        current.data.state === 'active'
      ) {
        await ctx.storage.put(RUNTIME_AUTHORIZATION_KEY, {
          ...current.data,
          state: 'revoked',
        } satisfies RuntimeAuthorization);
      }
    }
    return undefined;
  }
}

export async function getRuntimeAuthorizationState(
  storage: DurableObjectStorage
): Promise<'active' | 'revoked' | null> {
  const authorization = RuntimeAuthorizationSchema.safeParse(
    await storage.get<unknown>(RUNTIME_AUTHORIZATION_KEY)
  );
  return authorization.success ? authorization.data.state : null;
}
