import {
  customRouterModelId,
  type AutoRoutingDecision,
  type CustomRouterDefinition,
  type CustomRouterErrorCode,
  type CustomRouterReference,
  type GatewayCustomRouterEntry,
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

  const gatewayEntries = router.entries.filter(
    (entry): entry is GatewayCustomRouterEntry => entry.kind === 'gateway'
  );
  const gatewayModelIds = gatewayEntries.map(entry => entry.model);
  // A pinned entry dispatches its concrete target instead of its pool model, so the policy is
  // evaluated for both and the pick is accepted only against the saved pin.
  const dispatchableModelIds = [
    ...new Set(
      gatewayEntries.flatMap(entry => [
        entry.model,
        ...(entry.servingPin ? [entry.servingPin.model] : []),
      ])
    ),
  ];
  const deniedModelIds = await params.deniedModelIds(dispatchableModelIds);
  const outcome = await params.decide(router, deniedModelIds);
  if (outcome.kind !== 'ok') return outcome;

  const { decision } = outcome;
  const entryModel = decision?.entry?.kind === 'gateway' ? decision.entry.model : null;
  const pinned = entryModel
    ? gatewayEntries.find(entry => entry.model === entryModel)?.servingPin
    : undefined;
  const dispatchesEntry = decision !== null && decision.model === entryModel;
  const dispatchesPin =
    pinned !== undefined && decision !== null && decision.model === pinned.model;
  const pinMatchesDecision =
    decision?.servingPin === undefined || decision.servingPin.model === decision.model;
  if (
    !entryModel ||
    !gatewayModelIds.includes(entryModel) ||
    (!dispatchesEntry && !dispatchesPin) ||
    !pinMatchesDecision ||
    // The dispatched model is what runs; the pool model is the identity the policy names. Both
    // must be clear, so a denied alias cannot be reached through an allowed pin (or the reverse).
    deniedModelIds.includes(decision.model) ||
    deniedModelIds.includes(entryModel)
  ) {
    warnExceptInTest('Custom router decision is not a servable pool entry', {
      routerModelId: customRouterModelId(router.ownerType, router.slug),
      model: decision?.model ?? null,
      entry: entryModel,
    });
    return { kind: 'unavailable' };
  }
  return { kind: 'ok', decision };
}
