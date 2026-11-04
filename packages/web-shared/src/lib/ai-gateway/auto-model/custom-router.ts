import {
  customRouterModelId,
  type AutoRoutingDecision,
  type CustomRouterDefinition,
  type CustomRouterErrorCode,
  type CustomRouterReference,
} from '@kilocode/auto-routing-contracts';
import type { CustomRouterDecisionOutcome } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-decision';
import {
  findCustomRouter,
  type CustomRouterOwner,
} from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

export type CustomRouterResolution =
  | { kind: 'ok'; decision: AutoRoutingDecision }
  | { kind: 'rejected'; code: CustomRouterErrorCode; message: string }
  | { kind: 'unavailable' };

export const CUSTOM_ROUTER_NOT_FOUND = {
  kind: 'rejected',
  code: 'router_not_found',
  message: 'Custom router not found',
} as const satisfies CustomRouterResolution;

// The gateway path considers gateway entries only, and a custom router never routes outside its
// pool: the worker owns null decisions, and the gateway serves exactly the entry it picked. Only
// flagged owners can create routers, so a router's existence is the rollout gate (ADR 0005).
export async function decideCustomRouter(params: {
  reference: CustomRouterReference;
  userId: string;
  organizationId: string | null;
  deniedModelIds: (candidateModelIds: ReadonlyArray<string>) => Promise<string[]>;
  decide: (
    router: CustomRouterDefinition,
    deniedModelIds: ReadonlyArray<string>
  ) => Promise<CustomRouterDecisionOutcome>;
}): Promise<CustomRouterResolution> {
  const owner: CustomRouterOwner | null =
    params.reference.scope === 'user'
      ? { type: 'user', id: params.userId }
      : params.organizationId
        ? { type: 'org', id: params.organizationId }
        : null;
  const router = owner ? await findCustomRouter(owner, params.reference.slug) : null;
  if (!router) return CUSTOM_ROUTER_NOT_FOUND;

  const gatewayModelIds = router.entries.flatMap(entry =>
    entry.kind === 'gateway' ? [entry.model] : []
  );
  const deniedModelIds = await params.deniedModelIds(gatewayModelIds);
  const outcome = await params.decide(router, deniedModelIds);
  if (outcome.kind !== 'ok') return outcome;

  const { decision } = outcome;
  if (
    decision?.entry?.kind !== 'gateway' ||
    !gatewayModelIds.includes(decision.model) ||
    deniedModelIds.includes(decision.model)
  ) {
    warnExceptInTest('Custom router decision is not a servable pool entry', {
      routerModelId: customRouterModelId(router.ownerType, router.slug),
      model: decision?.model ?? null,
    });
    return { kind: 'unavailable' };
  }
  return { kind: 'ok', decision };
}
