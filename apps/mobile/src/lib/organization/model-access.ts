import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

/** The one model as `organizations.settings.listAvailableModels` answers it. */
export type AvailableModel =
  RouterOutputs['organizations']['settings']['listAvailableModels']['data'][number];

/**
 * What the allow and deny lists need from a catalog entry. The catalog entry
 * carries the rest of the gateway's model descriptor, which these helpers never
 * read.
 */
export type CatalogModel = Readonly<{
  id: string;
  name: string;
  inference_provider_ids?: readonly string[];
}>;

export type ModelAccessDraft = {
  /** Every provider that may serve the organization; the server stores it sorted. */
  providerAllowList: readonly string[];
  /** Models no member may use, whichever provider serves them. */
  modelDenyList: readonly string[];
};

/**
 * The gateway's own normalisation (`normalizeModelId` in web-shared): a variant
 * suffix such as `:free` names the same model. The allow and deny lists are
 * stored against the bare id, so a toggle has to compare the same value.
 */
export function normalizeModelId(modelId: string): string {
  const colonIndex = modelId.indexOf(':');
  return colonIndex === -1 ? modelId : modelId.slice(0, colonIndex);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * Every provider that can serve at least one model in this catalog. The model
 * catalog carries the inference providers per model in the same slug namespace
 * as `provider_allow_list`, which is the only provider list a mobile client can
 * read without the web's provider snapshot endpoint.
 */
export function catalogProviderSlugs(models: readonly CatalogModel[]): string[] {
  const slugs = models.flatMap(model => model.inference_provider_ids ?? []);
  return sortedUnique(slugs);
}

/**
 * The provider rows the Providers tab shows, and the set an absent
 * `provider_allow_list` expands to on its first save. The rows come from the
 * whole gateway catalog, never the organization's own usable models alone: that
 * list drops every model of a provider the organization may not use, so a
 * provider an admin turned off would lose its row and could never be turned
 * back on. The organization's models only add the providers that serve a model
 * the whole catalog lacks, and a saved slug no model serves any more still gates
 * routing, so it stays visible and removable.
 */
export function providerRows(params: {
  catalog: readonly CatalogModel[];
  available: readonly CatalogModel[];
  savedAllowList: readonly string[] | undefined;
}): string[] {
  return sortedUnique([
    ...catalogProviderSlugs([...params.catalog, ...params.available]),
    ...(params.savedAllowList ?? []),
  ]);
}

/** One row of the deny list: a model an admin may allow or deny, by its bare id. */
export type DenyListModel = Readonly<{ id: string; name: string }>;

/**
 * Every model the deny list can show, one row per bare id — the same list the
 * web editor's Models tab shows. The organization's own catalog omits the
 * models its policy denies, so the gateway's whole catalog supplies them; the
 * organization's list adds the entries only it serves (custom LLMs, BYOK, the
 * auto model); and an id the saved deny list names that neither carries still
 * gets a row, so a stale entry can be allowed again.
 */
export function denyListModels(params: {
  catalog: readonly DenyListModel[];
  available: readonly DenyListModel[];
  denyList: readonly string[];
}): DenyListModel[] {
  const nameById = new Map<string, string>();
  for (const model of [...params.catalog, ...params.available]) {
    const id = normalizeModelId(model.id);
    if (!nameById.has(id)) {
      nameById.set(id, model.name);
    }
  }
  for (const id of params.denyList) {
    if (!nameById.has(id)) {
      nameById.set(id, id);
    }
  }
  return [...nameById].map(([id, name]) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The draft a saved configuration starts from. An absent `provider_allow_list`
 * means every provider is allowed, so it starts from the provider rows the
 * admin can name. Those rows cannot hold a BYOK-only provider the organization
 * reads from the web snapshot, so this draft's list is a view of the policy, not
 * the list a save writes: see `modelAccessSave`.
 */
export function initialDraft(
  settings: {
    provider_allow_list?: readonly string[];
    model_deny_list?: readonly string[];
  },
  catalogProviders: readonly string[]
): ModelAccessDraft {
  const denied = (settings.model_deny_list ?? []).map(modelId => normalizeModelId(modelId));
  return {
    providerAllowList: sortedUnique(settings.provider_allow_list ?? catalogProviders),
    modelDenyList: sortedUnique(denied),
  };
}

export function toggleProvider(
  draft: ModelAccessDraft,
  providerSlug: string,
  nextAllowed: boolean
): ModelAccessDraft {
  const allowed = new Set(draft.providerAllowList);
  if (nextAllowed) {
    allowed.add(providerSlug);
  } else {
    allowed.delete(providerSlug);
  }
  return { ...draft, providerAllowList: sortedUnique([...allowed]) };
}

export function toggleModel(
  draft: ModelAccessDraft,
  modelId: string,
  nextAllowed: boolean
): ModelAccessDraft {
  const denied = new Set(draft.modelDenyList);
  if (nextAllowed) {
    denied.delete(normalizeModelId(modelId));
  } else {
    denied.add(normalizeModelId(modelId));
  }
  return { ...draft, modelDenyList: sortedUnique([...denied]) };
}

/** Applies one decision to every listed provider, as the web's bulk action does. */
export function setProvidersAllowed(
  draft: ModelAccessDraft,
  providerSlugs: readonly string[],
  nextAllowed: boolean
): ModelAccessDraft {
  const allowed = new Set(draft.providerAllowList);
  for (const slug of providerSlugs) {
    if (nextAllowed) {
      allowed.add(slug);
    } else {
      allowed.delete(slug);
    }
  }
  return { ...draft, providerAllowList: sortedUnique([...allowed]) };
}

export function setModelsAllowed(
  draft: ModelAccessDraft,
  modelIds: readonly string[],
  nextAllowed: boolean
): ModelAccessDraft {
  const denied = new Set(draft.modelDenyList);
  for (const modelId of modelIds) {
    const normalized = normalizeModelId(modelId);
    if (nextAllowed) {
      denied.delete(normalized);
    } else {
      denied.add(normalized);
    }
  }
  return { ...draft, modelDenyList: sortedUnique([...denied]) };
}

export function draftsEqual(a: ModelAccessDraft, b: ModelAccessDraft): boolean {
  return (
    a.providerAllowList.join('\n') === b.providerAllowList.join('\n') &&
    a.modelDenyList.join('\n') === b.modelDenyList.join('\n')
  );
}

/**
 * What a save writes. `providerAllowList` is absent when the save leaves the
 * saved list alone: `updateAllowLists` treats an omitted list as unchanged
 * (`provider_allow_list !== undefined` in
 * `apps/web/src/routers/organizations/organization-settings-router.ts`).
 */
export type ModelAccessSave =
  | {
      kind: 'ready';
      providerAllowList: readonly string[] | undefined;
      modelDenyList: readonly string[];
    }
  /** The organization would be left with no allowed provider, blocking every route. */
  | { kind: 'empty-provider-list' };

/**
 * The two lists a save writes, or the refusal that keeps it from writing them.
 *
 * An organization with no saved provider list allows every provider, including
 * BYOK-only and direct-BYOK providers that no mobile catalog row names
 * (`getKiloRouteProviders` in
 * `packages/web-shared/src/lib/ai-gateway/providers/openrouter/models-by-provider-index.server.ts`
 * leaves them out). Writing the rows as they first render would persist a
 * narrower list than the policy the phone read, so a save that did not move the
 * Providers tab omits the list and leaves it unset. The rows behind an edit
 * include every saved slug (`providerRows`), so an explicit write keeps them.
 *
 * An empty list is refused unless the organization's saved list was already
 * empty: it stops every Kilo route, which no toggle on this form should do by
 * accident.
 */
export function modelAccessSave(params: {
  savedAllowList: readonly string[] | undefined;
  baseline: ModelAccessDraft;
  draft: ModelAccessDraft;
}): ModelAccessSave {
  const providersChanged =
    params.draft.providerAllowList.join('\n') !== params.baseline.providerAllowList.join('\n');
  const providerAllowList =
    params.savedAllowList === undefined && !providersChanged
      ? undefined
      : [...params.draft.providerAllowList];
  if (providerAllowList?.length === 0 && params.baseline.providerAllowList.length > 0) {
    return { kind: 'empty-provider-list' };
  }
  return {
    kind: 'ready',
    providerAllowList,
    modelDenyList: [...params.draft.modelDenyList],
  };
}

/** Whether any of a row's searchable fields contains the query, case-insensitively. */
export function matchesSearch(fields: readonly (string | undefined)[], query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  return fields.some(field => field?.toLocaleLowerCase().includes(normalized) === true);
}
