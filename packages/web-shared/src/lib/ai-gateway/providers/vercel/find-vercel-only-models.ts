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

/**
 * The stored Vercel chat models that no OpenRouter model routes to, under the OpenRouter-style IDs
 * that route back to them. Models Vercel's list does not describe well enough to list are left out.
 */
export function findVercelOnlyModels({
  openRouterModelIds,
  vercelMetadata,
  overrides,
}: {
  openRouterModelIds: Iterable<string>;
  vercelMetadata: GatewayModelMap;
  overrides: VercelModelIdOverrides;
}): VercelOnlyModel[] {
  const coveredVercelModelIds = new Set(
    [...openRouterModelIds].map(id => mapResolvedModelIdToVercel(id, overrides))
  );
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
    return id && id === id.toLowerCase()
      ? [{ id, storedModel, contextWindow: context_window, modalities, pricing }]
      : [];
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
