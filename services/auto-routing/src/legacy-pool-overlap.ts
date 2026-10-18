import {
  CustomRouterDefinitionSchema,
  DEFAULT_AUTO_ROUTING_MODE,
  EfficientModelPoolSchema,
  customRouterEntryKey,
  type AutoRoutingMode,
  type AutoRoutingModeOwnerType,
  type CustomRouterDefinition,
} from '@kilocode/auto-routing-contracts';
import { auto_routing_custom_routers, getWorkerDb } from '@kilocode/db';
import { and, eq, sql } from 'drizzle-orm';
import { CustomRouterError } from './caller-auth';
import {
  clearCustomRouterCache,
  findLegacyPoolRouter,
  toCustomRouterDefinition,
} from './custom-router-store';
import {
  getCachedAutoRoutingSettings,
  getConfiguredAutoRoutingSettings,
  type AutoRoutingOwnerSettings,
} from './routing-mode';

type Owner = { ownerType: AutoRoutingModeOwnerType; ownerId: string };
type OverlapEnv = Pick<Env, 'AUTO_ROUTING_MODE_CONFIG' | 'HYPERDRIVE'>;

export type LegacyPoolRouting = AutoRoutingOwnerSettings & {
  mode: AutoRoutingMode;
  router: CustomRouterDefinition | null;
};

export async function getSharedOwnerSettings(
  env: OverlapEnv,
  owner: Owner,
  cacheLegacySettings = false,
  knownRouter?: CustomRouterDefinition | null
) {
  const router =
    knownRouter === undefined
      ? await findLegacyPoolRouter(env, { type: owner.ownerType, id: owner.ownerId })
      : knownRouter;
  if (!router) {
    const settings = await (cacheLegacySettings
      ? getCachedAutoRoutingSettings(env, owner)
      : getConfiguredAutoRoutingSettings(env, owner));
    return { ...settings, router: null };
  }
  const pool = EfficientModelPoolSchema.safeParse(
    router.entries.flatMap(entry => (entry.kind === 'gateway' ? [{ model: entry.model }] : []))
  );
  return {
    mode: router.legacyModeInherited ? null : router.mode,
    pool: pool.success ? pool.data : null,
    router,
  };
}

export async function resolveLegacyPoolRouting(
  env: OverlapEnv,
  owner: { userId: string; organizationId: string | null }
): Promise<LegacyPoolRouting | undefined> {
  const [userRouter, orgRouter] = await Promise.all([
    findLegacyPoolRouter(env, { type: 'user', id: owner.userId }),
    owner.organizationId
      ? findLegacyPoolRouter(env, { type: 'org', id: owner.organizationId })
      : null,
  ]);
  if (!userRouter && !orgRouter) return undefined;
  const [user, org] = await Promise.all([
    getSharedOwnerSettings(env, { ownerType: 'user', ownerId: owner.userId }, true, userRouter),
    owner.organizationId
      ? getSharedOwnerSettings(
          env,
          { ownerType: 'org', ownerId: owner.organizationId },
          true,
          orgRouter
        )
      : null,
  ]);
  const mode = org?.mode ?? user.mode ?? DEFAULT_AUTO_ROUTING_MODE;
  const poolOwner = org?.router || org?.pool ? org : user;
  return {
    mode,
    pool: poolOwner.pool,
    router: poolOwner.router ? { ...poolOwner.router, mode } : null,
  };
}

export async function inheritedLegacyPoolMode(
  env: OverlapEnv,
  router: CustomRouterDefinition,
  caller: { userId: string; organizationId: string | null }
): Promise<CustomRouterDefinition> {
  if (!router.legacyPool) return router;
  if (router.ownerType === 'org') {
    if (!router.legacyModeInherited) return router;
    const user = await getSharedOwnerSettings(
      env,
      { ownerType: 'user', ownerId: caller.userId },
      true
    );
    return { ...router, mode: user.mode ?? DEFAULT_AUTO_ROUTING_MODE };
  }
  const org = caller.organizationId
    ? await getSharedOwnerSettings(env, { ownerType: 'org', ownerId: caller.organizationId }, true)
    : null;
  return {
    ...router,
    mode: org?.mode ?? (router.legacyModeInherited ? DEFAULT_AUTO_ROUTING_MODE : router.mode),
  };
}

export async function updateSharedPoolRouter(
  env: Pick<Env, 'HYPERDRIVE'>,
  router: CustomRouterDefinition,
  update: { mode: AutoRoutingMode | null; settings?: AutoRoutingOwnerSettings }
): Promise<CustomRouterDefinition> {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 2_000 });
  const updated = await db.transaction(async tx => {
    const key = `auto-routing-custom-routers:${router.ownerType}:${router.ownerId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const where = and(
      eq(auto_routing_custom_routers.id, router.id),
      eq(auto_routing_custom_routers.legacy_pool, true)
    );
    const [row] = await tx.select().from(auto_routing_custom_routers).where(where).limit(1);
    if (!row) throw new Error('Migrated pool disappeared during its update');
    const current = toCustomRouterDefinition(row);
    if (update.settings?.pool === null) {
      throw new CustomRouterError(
        'invalid_request',
        'A migrated pool cannot be cleared during the notice period; edit the custom router instead'
      );
    }
    if (update.settings && current.entries.some(entry => entry.kind === 'client')) {
      throw new CustomRouterError(
        'invalid_request',
        'This pool contains client entries; edit it in custom router settings'
      );
    }
    const entries = update.settings?.pool?.map(entry => ({ kind: 'gateway' as const, ...entry }));
    const firstEntry = entries?.[0];
    const defaultEntryKey =
      firstEntry && !entries?.some(entry => customRouterEntryKey(entry) === current.defaultEntryKey)
        ? customRouterEntryKey(firstEntry)
        : current.defaultEntryKey;
    const definition = CustomRouterDefinitionSchema.parse({
      ...current,
      mode: update.mode ?? DEFAULT_AUTO_ROUTING_MODE,
      legacyModeInherited: update.mode === null,
      ...(entries ? { entries, defaultEntryKey } : {}),
    });
    const [saved] = await tx
      .update(auto_routing_custom_routers)
      .set({
        mode: definition.mode,
        legacy_mode_inherited: definition.legacyModeInherited,
        ...(entries
          ? { entries: definition.entries, default_entry_key: definition.defaultEntryKey }
          : {}),
      })
      .where(where)
      .returning();
    if (!saved) throw new Error('Migrated pool disappeared during its update');
    return toCustomRouterDefinition(saved);
  });
  clearCustomRouterCache();
  return updated;
}
