import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { API_BASE_URL } from '@/lib/config';
import {
  type ModelOption,
  OpenRouterModelsResponseSchema,
  toModelOptions,
} from '@/lib/hooks/use-available-models';

const TRANSCRIPTION_MODELS_TIMEOUT_MS = 15_000;

const TRANSCRIPTION_MODELS_PATH = '/api/gateway/transcription-models';

/**
 * Fetch the transcription models the gateway offers. The endpoint answers
 * unfiltered when auth is missing (its catch-then-fallback), so this never
 * gates on a token; the organization header only narrows the list to the
 * caller's policy. Parses with the shared OpenRouter wire contract and maps
 * with the shared option mapper so the picker rows shape-match every other
 * model list in the app.
 */
export async function fetchTranscriptionModels(organizationId?: string): Promise<ModelOption[]> {
  const token = await getAuthTokenForRequest();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, TRANSCRIPTION_MODELS_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE_URL}${TRANSCRIPTION_MODELS_PATH}`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(organizationId ? { 'X-KiloCode-OrganizationId': organizationId } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch transcription models: ${response.status} ${response.statusText}`
      );
    }

    const data = OpenRouterModelsResponseSchema.parse(await response.json());
    return toModelOptions(data);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Timed out fetching transcription models after ${TRANSCRIPTION_MODELS_TIMEOUT_MS}ms`,
        { cause: error }
      );
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Transcription models offered by the Kilo gateway, for the settings picker.
 * Always enabled: the endpoint answers with an empty list when it cannot
 * narrow to the caller, and the picker renders that as its empty state.
 */
export function useTranscriptionModels(organizationId?: string) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['transcription-models', organizationId] as const,
    queryFn: fetchTranscriptionModels.bind(null, organizationId),
    staleTime: 60_000,
    enabled: true,
  });

  const models = useMemo(() => data ?? [], [data]);

  return { models, isLoading, isError, error, refetch };
}
