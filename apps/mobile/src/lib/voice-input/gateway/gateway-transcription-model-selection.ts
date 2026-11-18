import { useEffect } from 'react';

import { type ModelOption } from '@/lib/hooks/use-available-models';
import { useTranscriptionModels } from '@/lib/hooks/use-transcription-models';

import {
  type GatewayTranscriptionModel,
  readGatewayTranscriptionModel,
  useGatewayTranscriptionModel,
  useGatewayTranscriptionModelLoaded,
  useGatewayTranscriptionPreference,
  writeGatewayTranscriptionModel,
} from './gateway-transcription-preference';

/**
 * The state the transcription-model row renders. `unavailable` is its own
 * non-retryable state: a stored choice the live catalogue no longer offers is
 * kept (so the engine still has an id) but the user is told to pick another,
 * because a retry cannot bring the missing model back.
 */
export type GatewayTranscriptionModelSelectionStatus =
  | 'off'
  | 'loading'
  | 'error'
  | 'empty'
  | 'unavailable'
  | 'ready';

/** The effective model: the stored choice, else the catalogue's first entry, else none. */
export function selectTranscriptionModel(
  models: ModelOption[],
  stored: GatewayTranscriptionModel | null
): GatewayTranscriptionModel | null {
  return stored ?? firstModel(models);
}

function firstModel(models: ModelOption[]): GatewayTranscriptionModel | null {
  const first = models[0];
  return first ? { id: first.id, name: first.name } : null;
}

/**
 * Persist the catalogue's first model when the user has never chosen one, so a
 * never-opened settings page still has a model on the first dictation. Returns
 * the model now in effect: the stored choice when one exists, the newly
 * persisted first entry, or null when the catalogue offers nothing.
 */
export function persistFirstTranscriptionModel(
  models: ModelOption[]
): GatewayTranscriptionModel | null {
  const stored = readGatewayTranscriptionModel();
  if (stored !== null) {
    return stored;
  }
  const first = firstModel(models);
  if (first === null) {
    return null;
  }
  writeGatewayTranscriptionModel(first);
  return first;
}

export function resolveTranscriptionModelSelectionStatus(input: {
  enabled: boolean;
  isLoading: boolean;
  isError: boolean;
  modelStoreLoaded: boolean;
  models: ModelOption[];
  stored: GatewayTranscriptionModel | null;
}): GatewayTranscriptionModelSelectionStatus {
  const { enabled, isLoading, isError, modelStoreLoaded, models, stored } = input;
  if (!enabled) {
    return 'off';
  }
  // The stored-model read races the catalogue on a cold start; hold the
  // loading state until both settle so the row never flashes the wrong model.
  if (isLoading || !modelStoreLoaded) {
    return 'loading';
  }
  if (isError && models.length === 0) {
    return 'error';
  }
  if (models.length === 0) {
    return 'empty';
  }
  if (stored !== null && !models.some(model => model.id === stored.id)) {
    return 'unavailable';
  }
  return selectTranscriptionModel(models, stored) === null ? 'empty' : 'ready';
}

/**
 * The transcription-model row's data source: the live catalogue scoped to the
 * organization, the persisted choice, and the single state the row renders.
 * Once enabled with a loaded, non-empty catalogue and no explicit choice it
 * persists the first model, so "no model selected" is never a present state.
 */
export function useGatewayTranscriptionModelSelection(organizationId?: string) {
  const { gatewayTranscriptionEnabled } = useGatewayTranscriptionPreference();
  const stored = useGatewayTranscriptionModel();
  const modelStoreLoaded = useGatewayTranscriptionModelLoaded();
  const { models, isLoading, isError, isFetching, refetch } =
    useTranscriptionModels(organizationId);

  useEffect(() => {
    // Wait for the stored-model read before treating "no stored model" as
    // "never chose one": a cold start reports null until SecureStore settles,
    // so writing early would clobber an existing choice on disk.
    if (gatewayTranscriptionEnabled && modelStoreLoaded && stored === null && models.length > 0) {
      persistFirstTranscriptionModel(models);
    }
  }, [gatewayTranscriptionEnabled, modelStoreLoaded, stored, models]);

  const status = resolveTranscriptionModelSelectionStatus({
    enabled: gatewayTranscriptionEnabled,
    isLoading,
    isError,
    modelStoreLoaded,
    models,
    stored,
  });

  return {
    status,
    model: selectTranscriptionModel(models, stored),
    models,
    isLoading,
    isError,
    isFetching,
    refetch,
  };
}
