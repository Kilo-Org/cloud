import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { API_BASE_URL } from '@/lib/config';
import {
  type ModelOption,
  OpenRouterModelsResponseSchema,
  toModelOptions,
} from '@/lib/hooks/use-available-models';
import { TELEMETRY_DESCRIPTION_KEY, type TelemetryDescription } from '@/lib/telemetry/error-sink';
import { isExpectedStatus } from '@/lib/telemetry/network-errors';

const TRANSCRIPTION_MODELS_TIMEOUT_MS = 15_000;

const TRANSCRIPTION_MODELS_PATH = '/api/gateway/transcription-models';

/** Every way this fetch can fail, one fingerprint part each. */
type TranscriptionModelsOutcome = 'timeout' | 'transport' | 'invalid-response' | `http.${number}`;

/**
 * A transcription-models failure that declares its own telemetry for the
 * app-wide QueryCache reporter, the way the CLI command error does
 * (`lib/hooks/cli-command-unavailable-error.ts`). The reporter files it under
 * this stable fingerprint, tags and level instead of its catch-all `app-error`
 * grouping, so a failure is attributed to the endpoint. The deadline and a
 * transport rejection are expected outcomes (warning); a response that breaks
 * the shared contract is a defect (error).
 */
class TranscriptionModelsFetchError extends Error {
  readonly [TELEMETRY_DESCRIPTION_KEY]: TelemetryDescription;

  constructor(
    outcome: TranscriptionModelsOutcome,
    message: string,
    options: {
      cause?: unknown;
      level?: 'warning' | 'error';
      report?: 'event' | 'breadcrumb';
      tags?: Record<string, string | number>;
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TranscriptionModelsFetchError';
    this[TELEMETRY_DESCRIPTION_KEY] = {
      level: options.level ?? 'warning',
      fingerprint: ['transcription-models-fetch', outcome],
      ...(options.report === undefined ? {} : { report: options.report }),
      tags: {
        'error.subsystem': 'transcription-models',
        'error.operation': 'fetch',
        ...options.tags,
      },
    };
  }
}

/**
 * Fetch the transcription models the gateway offers. The endpoint answers
 * unfiltered when auth is missing (its catch-then-fallback), so this never
 * gates on a token; the organization header only narrows the list to the
 * caller's policy. Parses with the shared OpenRouter wire contract and maps
 * with the shared option mapper so the picker rows shape-match every other
 * model list in the app.
 *
 * Every rejection is typed: the 15-second deadline bounds the post-recording
 * model read in the voice-input path, so a stalled gateway cannot leave a
 * dictation waiting on a catalogue, but it declares itself instead of filing a
 * plain `Error` and grouping as an unattributed app-error event.
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
      throw new TranscriptionModelsFetchError(
        `http.${response.status}`,
        `Failed to fetch transcription models: ${response.status} ${response.statusText}`,
        {
          tags: { 'http.status': response.status },
          // A rate limit, a stale token, or a not-found answer names no defect:
          // the network layer already keeps those as breadcrumbs, so this
          // failure records its own trail entry instead of an issue.
          ...(isExpectedStatus(response.status, {}) ? { report: 'breadcrumb' } : {}),
        }
      );
    }

    let body: unknown = undefined;
    try {
      body = await response.json();
    } catch (error) {
      // An abort also rejects a body read already in flight: leave that to the
      // deadline branch below.
      if (controller.signal.aborted) {
        throw error;
      }
      throw new TranscriptionModelsFetchError(
        'invalid-response',
        'Transcription models response was not valid JSON',
        { level: 'error', cause: error }
      );
    }

    const parsed = OpenRouterModelsResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new TranscriptionModelsFetchError(
        'invalid-response',
        'Transcription models response did not match the shared model contract',
        { level: 'error', cause: parsed.error }
      );
    }

    return toModelOptions(parsed.data);
  } catch (error) {
    // A typed failure is the more specific outcome, even when the deadline
    // fired while it was thrown: an abort rejects with a raw error, never with
    // one of these.
    if (error instanceof TranscriptionModelsFetchError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new TranscriptionModelsFetchError(
        'timeout',
        `Timed out fetching transcription models after ${TRANSCRIPTION_MODELS_TIMEOUT_MS}ms`,
        { cause: error }
      );
    }

    throw new TranscriptionModelsFetchError(
      'transport',
      'Failed to reach the transcription models endpoint',
      { cause: error }
    );
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
  const { data, isLoading, isError, isFetching, error, refetch } = useQuery({
    queryKey: ['transcription-models', organizationId] as const,
    queryFn: fetchTranscriptionModels.bind(null, organizationId),
    staleTime: 60_000,
    enabled: true,
  });

  const models = useMemo(() => data ?? [], [data]);

  return { models, isLoading, isError, isFetching, error, refetch };
}
