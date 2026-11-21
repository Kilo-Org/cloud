import {
  customRouterModelId,
  isVirtualAutoModelId,
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
import { readLatestAliasTargets } from '@kilocode/web-shared/lib/ai-gateway/providers/latest-alias-targets';
import { isLatestAliasId } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import { db } from '@kilocode/web-shared/lib/drizzle';
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
  // A pool's pins and an alias's stored target are routing state written in the same PostgreSQL
  // transaction, so a replica read, or two primary reads split by a promotion, can serve a pool
  // whose definition no longer matches the target the provider would resolve later. A pool
  // without a gateway alias keeps its previous single primary read; an alias-bearing pool takes
  // one read-only repeatable-read snapshot and serves the definition and targets from it.
  const firstRead = owner ? await findCustomRouter(owner, params.reference.slug, db) : null;
  if (!owner || !firstRead) return CUSTOM_ROUTER_NOT_FOUND;
  const hasAliasEntry = firstRead.entries.some(
    entry => entry.kind === 'gateway' && isLatestAliasId(entry.model)
  );
  const snapshot = hasAliasEntry
    ? await db.transaction(
        async tx => ({
          router: await findCustomRouter(owner, params.reference.slug, tx),
          aliasTargets: await readLatestAliasTargets(tx),
        }),
        { isolationLevel: 'repeatable read', accessMode: 'read only' }
      )
    : null;
  const router = snapshot ? snapshot.router : firstRead;
  if (!router) return CUSTOM_ROUTER_NOT_FOUND;
  const aliasTargets = snapshot?.aliasTargets;

  const gatewayEntries = router.entries.filter(
    (entry): entry is GatewayCustomRouterEntry => entry.kind === 'gateway'
  );
  const gatewayModelIds = gatewayEntries.map(entry => entry.model);
  // The concrete model the stored config serves for an alias. Both dispatch paths use it, so the
  // deny policy below names exactly the model that will run rather than the alias that could be
  // remapped downstream.
  const aliasConcreteTarget = (model: string): string | null => {
    if (!isLatestAliasId(model)) return model;
    const stored = aliasTargets?.get(model);
    return stored && !isLatestAliasId(stored.target) && !isVirtualAutoModelId(stored.target)
      ? stored.target
      : null;
  };
  // A pinned entry dispatches its concrete target instead of its pool model, so the policy is
  // evaluated for both, plus every alias's snapshot concrete target.
  const dispatchableModelIds = [
    ...new Set(
      gatewayEntries.flatMap(entry => {
        const target = aliasConcreteTarget(entry.model);
        return [
          entry.model,
          ...(target ? [target] : []),
          ...(entry.servingPin ? [entry.servingPin.model] : []),
        ];
      })
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
  const markedFallback =
    decision !== null && 'servingFallback' in decision && decision.servingFallback === true;
  const stableModel = decision === null ? null : aliasConcreteTarget(decision.model);
  // A saved pin is the concrete target this pool promised. Serving the entry's own id instead is
  // the Worker's retirement answer, which it must mark and which must map to a different concrete
  // target in this snapshot; an older Worker that never saw this definition, or a stored target
  // that is the retired pin itself, would otherwise silently drop the target the gateway checked.
  const servesEntryUnderPin =
    pinned !== undefined &&
    pinned.model !== entryModel &&
    dispatchesEntry &&
    !(markedFallback && stableModel !== null && stableModel !== pinned.model);
  const pinMatchesDecision =
    decision?.servingPin === undefined || decision.servingPin.model === decision.model;
  if (
    decision === null ||
    !entryModel ||
    !gatewayModelIds.includes(entryModel) ||
    (!dispatchesEntry && !dispatchesPin) ||
    servesEntryUnderPin ||
    !pinMatchesDecision ||
    // The dispatched model is what runs; the pool model is the identity the policy names. Both
    // must be clear, so a denied alias cannot be reached through an allowed pin (or the reverse).
    deniedModelIds.includes(decision.model) ||
    deniedModelIds.includes(entryModel) ||
    (stableModel !== null && deniedModelIds.includes(stableModel))
  ) {
    warnExceptInTest('Custom router decision is not a servable pool entry', {
      routerModelId: customRouterModelId(router.ownerType, router.slug),
      model: decision?.model ?? null,
      entry: entryModel,
    });
    return { kind: 'unavailable' };
  }
  // Dispatch the concrete model this snapshot proved, so a later alias move cannot remap the
  // request after its policy was checked. An alias with no stored target keeps its own id: it is
  // uninitialized rather than remapped, and refusing it would invent a policy the gateway lacks.
  if (!isLatestAliasId(decision.model) || stableModel === null) {
    return { kind: 'ok', decision };
  }
  // The dispatched model is no longer the pinned target, so the pin does not describe it.
  const { servingPin: _pinnedTarget, ...dispatched } = decision;
  return {
    kind: 'ok',
    decision: {
      ...dispatched,
      model: stableModel,
      entry: { kind: 'gateway', model: stableModel },
    },
  };
}
