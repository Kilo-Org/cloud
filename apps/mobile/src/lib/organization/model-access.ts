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
  name?: string;
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
 * means every provider is allowed, so it starts from the whole catalog's
 * providers — the same expansion the web page makes; a save then writes the
 * list explicitly.
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

/** Whether any of a row's searchable fields contains the query, case-insensitively. */
export function matchesSearch(fields: readonly (string | undefined)[], query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  return fields.some(field => field?.toLocaleLowerCase().includes(normalized) === true);
}
