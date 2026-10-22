import {
  DEFAULT_AUTO_ROUTING_MODE,
  EfficientModelPoolSchema,
  type AutoRoutingMode,
  type AutoRoutingModeOwnerType,
  type CustomRouterDefinition,
} from '@kilocode/auto-routing-contracts';
import { findLegacyPoolRouter } from './custom-router-store';
import {
  getCachedAutoRoutingSettings,
  getConfiguredAutoRoutingSettings,
  getConfiguredAutoRoutingMode,
  type AutoRoutingOwnerSettings,
} from './routing-mode';

type Owner = { ownerType: AutoRoutingModeOwnerType; ownerId: string };
type OverlapEnv = Pick<Env, 'AUTO_ROUTING_MODE_CONFIG' | 'HYPERDRIVE'>;

export type LegacyPoolRouting = AutoRoutingOwnerSettings & {
  mode: AutoRoutingMode;
  poolOwner: Owner | null;
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
    mode: await getConfiguredAutoRoutingMode(env, owner),
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
  const orgSettings = org?.router || org?.pool ? org : null;
  const poolSettings = orgSettings ?? user;
  return {
    mode,
    pool: poolSettings.pool,
    poolOwner:
      poolSettings.pool === null
        ? null
        : orgSettings && owner.organizationId
          ? { ownerType: 'org', ownerId: owner.organizationId }
          : { ownerType: 'user', ownerId: owner.userId },
    router: poolSettings.router ? { ...poolSettings.router, mode } : null,
  };
}
