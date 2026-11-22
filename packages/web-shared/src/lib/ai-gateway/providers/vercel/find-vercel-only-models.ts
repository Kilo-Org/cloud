import {
  ReasoningEffortSchema,
  type GatewayModel,
  type ReasoningOption,
} from '@kilocode/db/schema-types';
import type {
  GatewayModelMap,
  GatewayModelWithEndpoints,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import {
  effortOptions,
  REASONING_TOGGLE,
} from '@kilocode/web-shared/lib/ai-gateway/providers/reasoning-options';
import {
  mapResolvedModelIdToVercel,
  mapVercelModelIdToOpenRouter,
  type VercelModelIdOverrides,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';

export type VercelOnlyModel = {
  /** The OpenRouter-style ID that routes to the Vercel model. */
  id: string;
  /**
   * The listing name: the vendor-prefixed `storedModel.name`, or `storedModel.name` when no vendor
   * prefix applies.
   */
  name: string;
  storedModel: GatewayModelWithEndpoints;
  contextWindow: number;
  modalities: NonNullable<GatewayModel['modalities']>;
  pricing: NonNullable<GatewayModel['pricing']>;
};

function getModelPrefix(modelId: string): string | undefined {
  const slashIndex = modelId.indexOf('/');
  return slashIndex > 0 ? modelId.slice(0, slashIndex) : undefined;
}

/** OpenRouter names start with the vendor, as in `Qwen: Qwen3 Max`. */
function getVendorNamesByModelPrefix(
  openRouterModels: Iterable<{ id: string; name: string }>
): ReadonlyMap<string, string> {
  const vendorNames = new Map<string, string>();
  for (const { id, name } of openRouterModels) {
    const prefix = getModelPrefix(id);
    const separatorIndex = name.indexOf(': ');
    if (prefix && separatorIndex > 0 && !vendorNames.has(prefix)) {
      vendorNames.set(prefix, name.slice(0, separatorIndex));
    }
  }
  return vendorNames;
}

function getVercelOnlyModelName(
  { id, storedModel }: { id: string; storedModel: GatewayModelWithEndpoints },
  vendorNames: ReadonlyMap<string, string>
): string {
  const prefix = getModelPrefix(id);
  const vendorName = prefix === undefined ? undefined : vendorNames.get(prefix);
  return vendorName ? `${vendorName}: ${storedModel.name}` : storedModel.name;
}

/**
 * The stored Vercel chat models that no OpenRouter model routes to, under the OpenRouter-style IDs
 * that route back to them. Models Vercel's list does not describe well enough to list are left out.
 *
 * Vercel sometimes serves a model under a different ID than OpenRouter, so no OpenRouter ID maps to
 * it. A model is also left out if the name it would be listed with equals, exactly, the name of one
 * of the models in `listedOpenRouterModels`, which defaults to `openRouterModels`. Omitting
 * `openRouterModels` removes the vendor prefix from the compared and displayed name, while the
 * comparison itself still runs whenever `listedOpenRouterModels` yields any names.
 */
export function findVercelOnlyModels({
  openRouterModelIds,
  openRouterModels,
  listedOpenRouterModels = openRouterModels,
  vercelMetadata,
  overrides,
}: {
  openRouterModelIds: Iterable<string>;
  openRouterModels?: Iterable<{ id: string; name: string }>;
  listedOpenRouterModels?: Iterable<{ name: string }>;
  vercelMetadata: GatewayModelMap;
  overrides: VercelModelIdOverrides;
}): VercelOnlyModel[] {
  const coveredVercelModelIds = new Set(
    [...openRouterModelIds].map(id => mapResolvedModelIdToVercel(id, overrides))
  );
  const vendorNames = getVendorNamesByModelPrefix(openRouterModels ?? []);
  const listedNames = new Set([...(listedOpenRouterModels ?? [])].map(model => model.name));
  return Object.values(vercelMetadata).flatMap(storedModel => {
    const { context_window, modalities, pricing } = storedModel;
    if (
      storedModel.type !== 'language' ||
      !modalities?.output.includes('text') ||
      context_window === undefined ||
      pricing === undefined ||
      coveredVercelModelIds.has(storedModel.id)
    ) {
      return [];
    }
    const id = mapVercelModelIdToOpenRouter(storedModel.id, overrides);
    // The proxy lowercases requested model IDs before routing.
    if (!id || id !== id.toLowerCase()) return [];
    const name = getVercelOnlyModelName({ id, storedModel }, vendorNames);
    return listedNames.has(name)
      ? []
      : [{ id, name, storedModel, contextWindow: context_window, modalities, pricing }];
  });
}

/**
 * Vercel's reasoning options in models.dev format. A token budget can only switch reasoning on or
 * off there. Undefined when none translate, because an empty list means reasoning is always on.
 */
export function fromVercelReasoningOptions(
  vercelOptions: GatewayModel['reasoning_options'] = []
): ReasoningOption[] | undefined {
  const hasToggle = vercelOptions.some(
    option => option.type === 'toggle' || option.type === 'budget_tokens'
  );
  const efforts = vercelOptions.flatMap(option => {
    const values = (option.type === 'effort' ? (option.values ?? []) : []).flatMap(
      value => ReasoningEffortSchema.safeParse(value).data ?? []
    );
    return values.length > 0 ? effortOptions(...values) : [];
  });
  const options = [...(hasToggle ? REASONING_TOGGLE : []), ...efforts];
  return options.length > 0 ? options : undefined;
}
