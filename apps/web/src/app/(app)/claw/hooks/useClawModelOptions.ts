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
export function useClawModelOptions(): {
  modelOptions: ModelOption[];
  isLoading: boolean;
  error: boolean;
} {
  const { organizationId } = useClawContext();
  const personalStatus = useKiloClawStatus({ enabled: !organizationId });
  const orgStatus = useOrgKiloClawStatus(organizationId);
  const status = (organizationId ? orgStatus.data : personalStatus.data) ?? EMPTY_STATUS;

  const { data: modelsData, isLoading: isLoadingModels } = useModelSelectorList(organizationId);
  const isRunning = status.status === 'running';
  const { trackedVersion, runningVersion, isLoadingControllerVersion, isControllerVersionError } =
    useClawUpdateAvailable(status);

  const hasError = isRunning && isControllerVersionError;
  const modelOptions = useMemo<ModelOption[]>(
    () =>
      getSettingsModelOptions({
        models: (modelsData?.data || []).map(model => ({
          id: model.id,
          name: model.name,
          isFree: model.isFree,
        })),
        trackedOpenClawVersion: trackedVersion,
        runningOpenClawVersion: runningVersion,
        isRunning,
        isLoadingRunningVersion: isLoadingControllerVersion,
        hasRunningVersionError: hasError,
      }),
    [modelsData, trackedVersion, runningVersion, isRunning, isLoadingControllerVersion, hasError]
  );

  return {
    modelOptions,
    isLoading: isLoadingModels || (isRunning && isLoadingControllerVersion),
    error: hasError,
  };
}
