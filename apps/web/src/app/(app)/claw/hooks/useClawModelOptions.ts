'use client';

import { useMemo } from 'react';

import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { useOrgKiloClawStatus } from '@/hooks/useOrgKiloClaw';

import { useClawContext } from '../components/ClawContext';
import { getSettingsModelOptions } from '../components/modelSupport';
import { useClawUpdateAvailable } from './useClawUpdateAvailable';

const EMPTY_STATUS = {
  status: null,
  openclawVersion: null,
  imageVariant: null,
  trackedImageTag: null,
};

/**
 * The same version-filtered model list the Settings page shows in its Model
 * Configuration picker, context-aware (personal vs org). Reuses
 * useModelSelectorList + getSettingsModelOptions so the two surfaces stay in sync.
 */
export function useClawModelOptions(enabled = true): {
  modelOptions: ModelOption[];
  isLoading: boolean;
  error: string | undefined;
} {
  const { organizationId } = useClawContext();
  const personalStatus = useKiloClawStatus({ enabled: !organizationId });
  const orgStatus = useOrgKiloClawStatus(organizationId);
  const status = (organizationId ? orgStatus.data : personalStatus.data) ?? EMPTY_STATUS;

  // Gate the OpenRouter model-catalog fetch — the genuinely new round-trip this
  // hook adds. Callers that only render the picker conditionally (the inline
  // row model control, the create/defaults dialogs) pass `enabled` so it never
  // fires on a stopped machine or for read-only users. (Status / controller
  // version are deduped with the page's own queries.)
  const {
    data: modelsData,
    isLoading: isLoadingModels,
    error: modelsError,
  } = useModelSelectorList(organizationId, enabled);
  const isModelsError = modelsError != null;
  const isRunning = status.status === 'running';
  const { trackedVersion, runningVersion, isLoadingControllerVersion, isControllerVersionError } =
    useClawUpdateAvailable(status);

  const versionError = isRunning && isControllerVersionError;
  const modelOptions = useMemo<ModelOption[]>(
    () =>
      getSettingsModelOptions({
        models: (modelsData?.data || []).map(model => ({
          id: model.id,
          name: model.name,
          isFree: model.isFree,
          mayTrainOnYourPrompts: model.mayTrainOnYourPrompts,
        })),
        trackedOpenClawVersion: trackedVersion,
        runningOpenClawVersion: runningVersion,
        isRunning,
        isLoadingRunningVersion: isLoadingControllerVersion,
        hasRunningVersionError: versionError,
      }),
    [
      modelsData,
      trackedVersion,
      runningVersion,
      isRunning,
      isLoadingControllerVersion,
      versionError,
    ]
  );

  // Surface either failure so the combobox shows it instead of a bare "no
  // models" that hides a transient model-catalog or controller-version error.
  const hasError = isModelsError || versionError;
  return {
    modelOptions,
    isLoading: isLoadingModels || (isRunning && isLoadingControllerVersion),
    error: hasError ? 'Could not load models. Try again in a moment.' : undefined,
  };
}
