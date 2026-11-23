import {
  isVirtualAutoModelId,
  parseCustomRouterCandidateModel,
  parseCustomRouterModelId,
  verifyAutoDecision,
  type AutoDecisionPayload,
  type CustomRouterDefinition,
  type GatewayCustomRouterEntry,
} from '@kilocode/auto-routing-contracts';
import type { ResolvedAutoModel } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { resolveCatalogVariant } from '@kilocode/web-shared/lib/ai-gateway/auto-model/resolution';
import {
  findCustomRouter,
  type CustomRouterOwner,
} from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { readLatestAliasTargets } from '@kilocode/web-shared/lib/ai-gateway/providers/latest-alias-targets';
import { isLatestAliasId } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import { db } from '@kilocode/web-shared/lib/drizzle';

export type AutoDecisionRejection =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'user_mismatch'
  | 'organization_mismatch'
  | 'model_mismatch'
  | 'client_entry'
  | 'auto_model'
  | 'pool_mismatch'
  | 'pool_stale_alias'
  | 'variant_unavailable';

export type AutoDecisionCheck =
  | { kind: 'ok'; routerModelId: string; resolved: ResolvedAutoModel }
  | { kind: 'rejected'; reason: AutoDecisionRejection };

type SavedPoolRejection = { ok: false; reason: 'pool_mismatch' | 'pool_stale_alias' };
type SavedPoolCheck = { ok: true; dispatchModel: string } | SavedPoolRejection;

function findGatewayEntry(
  router: CustomRouterDefinition,
  model: string
): GatewayCustomRouterEntry | undefined {
  for (const entry of router.entries) {
    if (entry.kind === 'gateway' && entry.model === model) return entry;
  }
  return undefined;
}

/**
 * Whether a verified decision names a target this saved pool still dispatches. A saved pin is the
 * concrete target the pool promised, so the entry's own id is stale until the worker signs that
 * the pinned target left the catalog, and only the exact saved pin proves that fallback. A token
 * that predates the pin carries no entry identity, so it is accepted only while it names a
 * dispatched target unambiguously: a saved pin, or an entry model no pin has moved. An entry model
 * a pin moved outranks any other pool entry pinned to that same id, because serving it would
 * follow the alias instead of the target that entry promised.
 */
function savedPoolDecision(
  router: CustomRouterDefinition,
  payload: AutoDecisionPayload
): SavedPoolRejection | { ok: true } {
  if (payload.entryModel === undefined) {
    const entry = findGatewayEntry(router, payload.model);
    if (entry) {
      const pin = entry.servingPin;
      return pin !== undefined && pin.model !== entry.model
        ? { ok: false, reason: 'pool_stale_alias' }
        : { ok: true };
    }
    const namesSavedPin = router.entries.some(
      entry => entry.kind === 'gateway' && entry.servingPin?.model === payload.model
    );
    return namesSavedPin ? { ok: true } : { ok: false, reason: 'pool_mismatch' };
  }

  const entry = findGatewayEntry(router, payload.entryModel);
  if (!entry) return { ok: false, reason: 'pool_mismatch' };
  const pin = entry.servingPin;

  if (payload.model === entry.model) {
    if (pin === undefined || pin.model === entry.model) {
      return payload.servingFallback === true
        ? { ok: false, reason: 'pool_mismatch' }
        : { ok: true };
    }
    return payload.servingFallback === true && payload.servingPinModel === pin.model
      ? { ok: true }
      : { ok: false, reason: 'pool_stale_alias' };
  }

  if (pin === undefined || payload.model !== pin.model) {
    return { ok: false, reason: 'pool_mismatch' };
  }
  return payload.servingFallback === true ? { ok: false, reason: 'pool_mismatch' } : { ok: true };
}

/**
 * The concrete model a stored alias target names, or null when the alias has no stored target or
 * stores another alias. A null result is "unproven": the gateway cannot say what the alias serves.
 */
function storedAliasTarget(
  targets: ReadonlyMap<string, { target: string }>,
  alias: string
): string | null {
  const target = targets.get(alias)?.target;
  if (target === undefined || isLatestAliasId(target) || isVirtualAutoModelId(target)) return null;
  return target;
}

/**
 * Checks a verified decision against the owner's saved pool and returns the model this gateway
 * must dispatch. A `~` alias is dispatched as the concrete target stored for it, read in the same
 * repeatable-read snapshot as the pool: the provider resolves aliases again from its own cache, so
 * passing an alias through would let a promotion between this check and that resolution serve a
 * target whose policy was never evaluated. A retirement fallback additionally proves the snapshot
 * target is the exact fallback the worker signed and is not the pin it retired; without that proof
 * it refuses instead of silently following a move.
 */
async function checkSavedPool(params: {
  owner: CustomRouterOwner | null;
  slug: string;
  payload: AutoDecisionPayload;
}): Promise<SavedPoolCheck> {
  const { owner, slug, payload } = params;
  if (!owner) return { ok: false, reason: 'pool_mismatch' };
  const resolvesAlias = isLatestAliasId(payload.model);
  const snapshot = resolvesAlias
    ? await db.transaction(
        async tx => ({
          router: await findCustomRouter(owner, slug, tx),
          aliasTargets: await readLatestAliasTargets(tx),
        }),
        { isolationLevel: 'repeatable read', accessMode: 'read only' }
      )
    : { router: await findCustomRouter(owner, slug, db), aliasTargets: null };
  if (!snapshot.router) return { ok: false, reason: 'pool_mismatch' };

  const pool = savedPoolDecision(snapshot.router, payload);
  if (!pool.ok) return pool;
  if (!resolvesAlias) return { ok: true, dispatchModel: payload.model };

  const stable = snapshot.aliasTargets
    ? storedAliasTarget(snapshot.aliasTargets, payload.model)
    : null;
  if (payload.servingFallback !== true) {
    return { ok: true, dispatchModel: stable ?? payload.model };
  }
  if (
    stable === null ||
    stable === payload.servingPinModel ||
    stable !== payload.servingFallbackTarget
  ) {
    return { ok: false, reason: 'pool_stale_alias' };
  }
  return { ok: true, dispatchModel: stable };
}

// A CLI-path decision for a gateway pick (ADR 0005). The token binds the decision to one caller
// and one concrete model; the gateway serves the signed variant and attributes usage to the
// custom router. A pool decision is re-checked against the owner's primary row, because a pin or
// an edit can land while the token is still valid and the token alone cannot see that.
export async function checkAutoDecision(params: {
  token: string;
  secret: string;
  nowMs: number;
  userId: string;
  organizationId: string | null;
  model: string;
}): Promise<AutoDecisionCheck> {
  const verification = await verifyAutoDecision(params.token, params.secret, params.nowMs);
  if (!verification.ok) return { kind: 'rejected', reason: verification.reason };
  const { payload } = verification;
  if (payload.userId !== params.userId) return { kind: 'rejected', reason: 'user_mismatch' };
  if (payload.organizationId !== params.organizationId) {
    return { kind: 'rejected', reason: 'organization_mismatch' };
  }
  // The CLI dispatches client picks itself; the gateway cannot serve them.
  if (parseCustomRouterCandidateModel(payload.model)?.kind === 'client') {
    return { kind: 'rejected', reason: 'client_entry' };
  }
  // A decision names one concrete pool entry; an auto model would re-enter routing.
  if (isVirtualAutoModelId(payload.model)) {
    return { kind: 'rejected', reason: 'auto_model' };
  }
  if (payload.model.toLowerCase() !== params.model.toLowerCase()) {
    return { kind: 'rejected', reason: 'model_mismatch' };
  }
  const reference = parseCustomRouterModelId(payload.routerModelId);
  // The new fields assert a saved-pool relationship; a router id with no pool cannot have one.
  if (reference === null && payload.entryModel !== undefined) {
    return { kind: 'rejected', reason: 'pool_mismatch' };
  }
  let dispatchModel = payload.model;
  if (reference) {
    const owner: CustomRouterOwner | null =
      reference.scope === 'user'
        ? { type: 'user', id: params.userId }
        : params.organizationId === null
          ? null
          : { type: 'org', id: params.organizationId };
    const pool = await checkSavedPool({ owner, slug: reference.slug, payload });
    if (!pool.ok) return { kind: 'rejected', reason: pool.reason };
    dispatchModel = pool.dispatchModel;
  }
  const resolved = await resolveCatalogVariant(dispatchModel, payload.variant);
  if (!resolved) return { kind: 'rejected', reason: 'variant_unavailable' };
  return { kind: 'ok', routerModelId: payload.routerModelId, resolved };
}
