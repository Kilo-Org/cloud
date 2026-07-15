import { type LocalRuntime } from '@/lib/hooks/runtime-discovery-logic';
import {
  type LocalRuntimeCatalog,
  type LocalRuntimeCatalogAgent,
  type LocalRuntimeFence,
} from './local-runtime-catalog-types';

export type { LocalRuntime } from '@/lib/hooks/runtime-discovery-logic';

/**
 * A runtime is "fence-equal" to a selected fence when both its `runtimeId` and
 * its `connectionId` match. The catalog hook uses this to detect when a
 * previously selected runtime has been replaced by a fresh socket and the
 * cached catalog must be discarded.
 */
export function runtimeFenceEquals(left: LocalRuntimeFence, right: LocalRuntimeFence): boolean {
  return left.runtimeId === right.runtimeId && left.connectionId === right.connectionId;
}

/**
 * Project a list of runtimes into the resolved selected fence. The rules —
 * which mirror the Slice 2 product spec — are:
 *
 * 1. If the previous selected fence still appears in the list, keep it
 *    (so a background refresh does not silently re-pick a different runtime).
 * 2. Otherwise, if there WAS no previous fence and exactly one capable
 *    runtime is present, auto-select it. A disconnected previous fence never
 *    auto-selects — the user must explicitly choose a replacement so a stale
 *    agent/model does not silently change.
 * 3. Otherwise (zero capable runtimes, or multiple capable runtimes, or a
 *    disconnected previous fence), require an explicit selection and return
 *    `null`.
 *
 * Incapable runtimes never count toward auto-selection and are never returned
 * as a default.
 */
export function resolveSelectedRuntimeFence(
  runtimes: readonly LocalRuntime[],
  currentFence: LocalRuntimeFence | null
): LocalRuntimeFence | null {
  if (currentFence) {
    // First: did the same runtime (by runtimeId) reappear with a new
    // connectionId? That happens when `kilo remote` reconnects. The fence
    // itself is keyed on both fields, so the old connection is detached —
    // but the user's intent was to keep using that machine, so we adopt the
    // new socket. The catalog hook will discard the stale catalog on the
    // next render because the query key now differs.
    const sameProcess = runtimes.find(
      runtime => runtime.runtimeId === currentFence.runtimeId && hasCatalogCapability(runtime)
    );
    if (sameProcess) {
      return { runtimeId: sameProcess.runtimeId, connectionId: sameProcess.connectionId };
    }
    // The previous runtimeId is gone entirely. Treat this as a fresh
    // selection — never auto-pick a replacement, even if exactly one
    // capable runtime remains, so a stale agent/model does not silently
    // change.
    return null;
  }
  const capable = runtimes.filter(runtime => hasCatalogCapability(runtime));
  if (capable.length === 1) {
    const only = capable[0];
    if (!only) {
      return null;
    }
    return { runtimeId: only.runtimeId, connectionId: only.connectionId };
  }
  return null;
}

const CATALOG_CAPABILITY = 'catalog.v1' as const;

export function hasCatalogCapability(runtime: LocalRuntime): boolean {
  return runtime.capabilities.includes(CATALOG_CAPABILITY);
}

/**
 * Look up an agent by its exact slug. Returns `null` when the slug is not
 * present in the catalog. The renderer uses this to detect a malformed or
 * tampered catalog (the default agent should always exist) and to resolve the
 * active agent when the user changes their selection.
 */
export function findAgentBySlug(
  catalog: LocalRuntimeCatalog,
  slug: string
): LocalRuntimeCatalogAgent | null {
  return catalog.agents.find(agent => agent.slug === slug) ?? null;
}

/**
 * Resolve the model and variant that the configuration screen should start
 * with. Precedence:
 *
 * 1. The currently selected agent's pinned `model` + `variant` win — the
 *    agent is the source of truth for the model it runs on.
 * 2. Otherwise the catalog's `defaultModel` (if any) and a first-variant
 *    fallback. A runtime that ships no `defaultModel` is allowed — the
 *    renderer treats the first model's first variant as the fallback.
 *
 * Returns `null` only when the catalog has zero models — which the
 * non-retryable error path covers separately.
 */
export function resolveInitialModelSelection(
  catalog: LocalRuntimeCatalog,
  agent: LocalRuntimeCatalogAgent
): { providerID: string; modelID: string; variant: string } | null {
  if (agent.model) {
    return {
      providerID: agent.model.providerID,
      modelID: agent.model.modelID,
      variant: agent.variant ?? '',
    };
  }
  const defaultModel = catalog.models.defaultModel;
  if (defaultModel) {
    return { providerID: defaultModel.providerID, modelID: defaultModel.modelID, variant: '' };
  }
  const firstProvider = catalog.models.providers[0];
  const firstModel = firstProvider?.models[0];
  if (!firstModel) {
    return null;
  }
  return {
    providerID: firstProvider.id,
    modelID: firstModel.id,
    variant: firstModel.variants[0] ?? '',
  };
}

/**
 * Defensive shape check applied to a freshly fetched catalog. A catalog that
 * has no `defaultAgent`, a `defaultAgent` that does not appear in `agents`, or
 * zero models is treated as malformed — the user must change runtimes, retry
 * will not help. The renderer also runs this before it transitions into the
 * happy state.
 */
export function isUsableCatalog(catalog: LocalRuntimeCatalog): boolean {
  if (!catalog.defaultAgent) {
    return false;
  }
  if (!findAgentBySlug(catalog, catalog.defaultAgent)) {
    return false;
  }
  if (catalog.models.providers.length === 0) {
    return false;
  }
  if (catalog.agents.length === 0) {
    return false;
  }
  return true;
}
