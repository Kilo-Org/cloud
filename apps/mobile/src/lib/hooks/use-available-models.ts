import { useQuery } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import { useMemo } from 'react';

import { API_BASE_URL } from '@/lib/config';
import { AUTH_TOKEN_KEY } from '@/lib/storage-keys';

// ── Types ────────────────────────────────────────────────────────────

export type ModelOption = {
  id: string;
  name: string;
  variants: string[];
  isPreferred: boolean;
};

type ModelResponse = {
  data: {
    id: string;
    name: string;
    preferredIndex?: number;
    opencode?: {
      variants?: Record<string, unknown>;
    };
  }[];
};

// ── Helpers ──────────────────────────────────────────────────────────

const MODEL_REQUEST_TIMEOUT_MS = 15_000;

function formatShortModelName(name: string): string {
  if (!name) {
    return name;
  }
  const colonIndex = name.indexOf(': ');
  return colonIndex === -1 ? name : name.slice(colonIndex + 2);
}

export function thinkingEffortLabel(variant: string): string {
  if (variant === 'xhigh') {
    return 'Extra High';
  }
  return variant.charAt(0).toUpperCase() + variant.slice(1);
}

async function fetchModels(organizationId: string | undefined): Promise<ModelResponse> {
  const token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  const url = organizationId
    ? `${API_BASE_URL}/api/organizations/${organizationId}/models`
    : `${API_BASE_URL}/api/openrouter/models`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, MODEL_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    }

    const data: ModelResponse = await response.json();
    return data;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Timed out fetching models after ${MODEL_REQUEST_TIMEOUT_MS}ms`, {
        cause: error,
      });
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Hook ─────────────────────────────────────────────────────────────

export function useAvailableModels(organizationId: string | undefined) {
  const { data, isLoading } = useQuery({
    queryKey: ['available-models', organizationId] as const,
    queryFn: fetchModels.bind(null, organizationId),
    staleTime: 60_000,
  });

  const models = useMemo<ModelOption[]>(() => {
    if (!data?.data) {
      return [];
    }

    const items = data.data.map(model => ({
      id: model.id,
      name: formatShortModelName(model.name),
      variants: Object.keys(model.opencode?.variants ?? {}),
      preferredIndex: model.preferredIndex,
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
      return a.name.localeCompare(b.name);
    });

    return items.map(item => ({
      id: item.id,
      name: item.name,
      variants: item.variants,
      isPreferred: item.preferredIndex !== undefined,
    }));
  }, [data]);

  return { models, isLoading };
}
