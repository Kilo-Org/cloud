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
export function getVendorNamesByModelPrefix(
  openRouterModels: Iterable<{ id: string; name: string }>
): ReadonlyMap<string | undefined, string> {
  const vendorNames = new Map<string | undefined, string>();
  for (const { id, name } of openRouterModels) {
    const prefix = getModelPrefix(id);
    const separatorIndex = name.indexOf(': ');
    if (prefix && separatorIndex > 0 && !vendorNames.has(prefix)) {
      vendorNames.set(prefix, name.slice(0, separatorIndex));
    }
  }
  return vendorNames;
}

export function getVercelOnlyModelName(
  { id, storedModel }: VercelOnlyModel,
  vendorNames: ReadonlyMap<string | undefined, string>
): string {
  const vendorName = vendorNames.get(getModelPrefix(id));
  return vendorName ? `${vendorName}: ${storedModel.name}` : storedModel.name;
}

/**
 * The stored Vercel chat models that no OpenRouter model routes to, under the OpenRouter-style IDs
 * that route back to them. Models Vercel's list does not describe well enough to list are left out.
 *
 * Vercel sometimes serves a model under a different ID than OpenRouter, so no OpenRouter ID maps to
 * it. When `openRouterModels` is given, a model is also left out if the name it would be listed with
 * equals, exactly, the name of one of those models. Without it, only the IDs are compared.
 */
export function findVercelOnlyModels({
  openRouterModelIds,
  openRouterModels,
  vercelMetadata,
  overrides,
}: {
  openRouterModelIds: Iterable<string>;
  openRouterModels?: Iterable<{ id: string; name: string }>;
  vercelMetadata: GatewayModelMap;
  overrides: VercelModelIdOverrides;
}): VercelOnlyModel[] {
  const coveredVercelModelIds = new Set(
    [...openRouterModelIds].map(id => mapResolvedModelIdToVercel(id, overrides))
  );
  const openRouterNames = openRouterModels && [...openRouterModels];
  const vendorNames = getVendorNamesByModelPrefix(openRouterNames ?? []);
  const listedNames = new Set(openRouterNames?.map(model => model.name));
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
    const model = { id, storedModel, contextWindow: context_window, modalities, pricing };
    return listedNames.has(getVercelOnlyModelName(model, vendorNames)) ? [] : [model];
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
