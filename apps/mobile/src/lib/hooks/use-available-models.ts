import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import * as z from 'zod';

import { API_BASE_URL } from '@/lib/config';
import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { i18n } from '@/i18n';
import { collator } from '@/lib/intl-cache';
import { formatShortModelDisplayName } from '@/lib/model-display-name';

const THINKING_EFFORT_KEYS = {
  none: 'models.thinkingEffort.none',
  minimal: 'models.thinkingEffort.minimal',
  low: 'models.thinkingEffort.low',
  medium: 'models.thinkingEffort.medium',
  high: 'models.thinkingEffort.high',
  xhigh: 'models.thinkingEffort.xhigh',
  max: 'models.thinkingEffort.max',
} satisfies Record<string, string>;

/** Looks up a possibly-unknown key in a literal dictionary without widening its type. */
function lookup<V>(dictionary: Readonly<Record<string, V>>, key: string): V | undefined {
  return (dictionary as Readonly<Record<string, V | undefined>>)[key];
}

// ── Types ─────────────────────────────────────────────────────────────

export type ModelOption = {
  id: string;
  name: string;
  variants: string[];
  isPreferred: boolean;
  isFree?: boolean;
  mayTrainOnYourPrompts?: boolean;
  hasUserByokAvailable?: boolean;
  context_length?: number | null;
  pricing?: { prompt?: string; completion?: string };
};

type ModelResponse = {
  data: {
    id: string;
    name: string;
    isFree?: boolean;
    mayTrainOnYourPrompts?: boolean;
    hasUserByokAvailable?: boolean;
    context_length?: number | null;
    preferredIndex?: number;
    pricing?: { prompt?: string; completion?: string };
    opencode?: {
      variants?: Record<string, unknown>;
    };
  }[];
};

// ── Pure model-option helpers ─────────────────────────────────────────

export function toModelOptions(data: ModelResponse | undefined): ModelOption[] {
  if (!data?.data) {
    return [];
  }

  const items = data.data.map(model => ({
    id: model.id,
    name: formatShortModelDisplayName(model.name),
    isFree: model.isFree,
    mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
    hasUserByokAvailable: model.hasUserByokAvailable,
    pricing: model.pricing,
    variants: Object.keys(model.opencode?.variants ?? {}),
    preferredIndex: model.preferredIndex,
    context_length: model.context_length ?? null,
  }));

  items.sort((a, b) => {
    const aHas = a.preferredIndex !== undefined;
    const bHas = b.preferredIndex !== undefined;

    if (aHas && bHas) {
      return (a.preferredIndex ?? 0) - (b.preferredIndex ?? 0);
    }
    if (aHas) {
      return -1;
    }
    if (bHas) {
      return 1;
    }
    return collator(i18n.language, { sensitivity: 'base' }).compare(a.name, b.name);
  });

  return items.map(item => ({
    id: item.id,
    name: item.name,
    variants: item.variants,
    isPreferred: item.preferredIndex !== undefined,
    isFree: item.isFree,
    mayTrainOnYourPrompts: item.mayTrainOnYourPrompts,
    hasUserByokAvailable: item.hasUserByokAvailable,
    pricing: item.pricing,
    context_length: item.context_length,
  }));
}

export function thinkingEffortLabel(variant: string): string {
  const key = lookup(THINKING_EFFORT_KEYS, variant);
  return key ? i18n.t(key) : variant;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Wire contract for the openrouter / org models endpoints. The response is a
 * `data` array of model descriptors matching the `ModelResponse` fields.
 */
export const OpenRouterModelsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      isFree: z.boolean().optional(),
      mayTrainOnYourPrompts: z.boolean().optional(),
      hasUserByokAvailable: z.boolean().optional(),
      context_length: z.number().nullable().optional(),
      preferredIndex: z.number().optional(),
      pricing: z
        .object({ prompt: z.string().optional(), completion: z.string().optional() })
        .optional(),
      opencode: z.object({ variants: z.record(z.string(), z.unknown()).optional() }).optional(),
    })
  ),
});

/**
 * Wire contract for the organization defaults endpoint.
 */
export const OrganizationDefaultsResponseSchema = z.object({ defaultModel: z.string() });

/**
 * The catalogue is a small static list from our own API, and the row that
 * consumes it shows a loading caption while the request is pending. A wall-clock
 * abort turned a slow-but-alive backend into a hard "could not load models"
 * error before the list could arrive, so the fetch has no client timeout: a
 * refused or reset connection still rejects and surfaces the error + Retry,
 * while a stalled response resolves when the backend answers.
 */
async function fetchModels(organizationId: string | undefined): Promise<ModelResponse> {
  const token = await getAuthTokenForRequest();
  const url = organizationId
    ? `${API_BASE_URL}/api/organizations/${organizationId}/models`
    : `${API_BASE_URL}/api/openrouter/models`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
  }

  return OpenRouterModelsResponseSchema.parse(await response.json());
}

async function fetchOrgDefaults(organizationId: string): Promise<{ defaultModel: string }> {
  const token = await getAuthTokenForRequest();
  const response = await fetch(`${API_BASE_URL}/api/organizations/${organizationId}/defaults`, {
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch org defaults: ${response.status} ${response.statusText}`);
  }
  return OrganizationDefaultsResponseSchema.parse(await response.json());
}

// ── Hooks ────────────────────────────────────────────────────────────

export function useOrgDefaultModel(organizationId: string | undefined) {
  const { data, isLoading } = useQuery({
    queryKey: ['org-default-model', organizationId] as const,
    queryFn: async () => {
      if (!organizationId) {
        throw new Error('Missing organizationId');
      }
      const defaults = await fetchOrgDefaults(organizationId);
      return defaults;
    },
    enabled: Boolean(organizationId),
    staleTime: 60_000,
  });
  return { defaultModel: data?.defaultModel, isLoading };
}

export function useAvailableModels(organizationId: string | undefined) {
  const { data, isLoading, isError, isFetching, isFetched, error, refetch } = useQuery({
    queryKey: ['available-models', organizationId] as const,
    queryFn: fetchModels.bind(null, organizationId),
    staleTime: 60_000,
  });

  const models = useMemo(() => toModelOptions(data), [data]);

  // `isFetching` covers every in-flight request; `isLoading` is only the first
  // load (it turns true again during a no-data refetch, so it cannot tell a
  // retry from the initial load). `isFetched` records that the query settled at
  // least once, letting a caller keep the error state through a retry: v5
  // downgrades a no-data refetch back to pending and clears `error`, so
  // `isError` alone would drop the error block. See `use-current-user-id`.
  return { models, isLoading, isError, isFetching, isFetched, error, refetch };
}
