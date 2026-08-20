import { type ResolvedSession } from '@kilocode/cloud-agent-sdk';
import { useEffect, useState } from 'react';

import { type AgentMode, normalizeAgentMode } from '@/components/agents/mode-normalize';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

type SessionConfigSnapshot = {
  mode?: string | null;
  model?: string | null;
  variant?: string | null;
};

type CloudAgentModelOverrideSnapshot = {
  model: string;
  variant?: string;
} | null;

type ResolveSessionConfigSelectionOptions = {
  activeSessionType: ResolvedSession['type'] | null;
  fetchedData: SessionConfigSnapshot | null;
  sessionConfig: SessionConfigSnapshot | null | undefined;
  modelOptions: SessionModelOption[];
  selectedModel: string;
  selectedVariant: string;
  /** Manager-held cloud-agent pick; wins over session/fetched config on non-remote. */
  cloudAgentModelOverride?: CloudAgentModelOverrideSnapshot;
};

type UseSessionConfigSyncOptions = ResolveSessionConfigSelectionOptions & {
  /**
   * Mode chosen at spawn, threaded from the route. Seeds the initial mode only:
   * a stored `fetchedData.mode`, a live `sessionConfig.mode`, and a later user
   * pick all win over it.
   */
  spawnedMode?: string;
};

type UseSessionConfigSyncResult = {
  currentMode: AgentMode;
  currentModel: string;
  currentVariant: string;
  setCurrentMode: (mode: AgentMode) => void;
  setCurrentModel: (model: string) => void;
  setCurrentVariant: (variant: string) => void;
};

export function resolveSessionConfigSelection({
  activeSessionType,
  fetchedData,
  sessionConfig,
  modelOptions,
  selectedModel,
  selectedVariant,
  cloudAgentModelOverride = null,
}: ResolveSessionConfigSelectionOptions) {
  if (activeSessionType === 'remote') {
    return { model: selectedModel, variant: selectedVariant };
  }

  // Cloud-agent in-session override must beat stored session config so the
  // sync effect cannot revert a user pick before send.
  if (cloudAgentModelOverride?.model) {
    return {
      model: cloudAgentModelOverride.model,
      variant: cloudAgentModelOverride.variant ?? '',
    };
  }

  const configuredModel = sessionConfig?.model ?? fetchedData?.model ?? '';
  if (configuredModel) {
    return {
      model: configuredModel,
      variant: sessionConfig?.variant ?? fetchedData?.variant ?? '',
    };
  }

  if (activeSessionType !== 'cloud-agent' || fetchedData === null) {
    return { model: '', variant: '' };
  }

  const firstModel = modelOptions[0];
  return firstModel
    ? { model: firstModel.id, variant: firstModel.variants[0] ?? '' }
    : { model: '', variant: '' };
}

export function useSessionConfigSync({
  activeSessionType,
  fetchedData,
  sessionConfig,
  modelOptions,
  selectedModel,
  selectedVariant,
  cloudAgentModelOverride = null,
  spawnedMode,
}: UseSessionConfigSyncOptions): UseSessionConfigSyncResult {
  const initialSelection = resolveSessionConfigSelection({
    activeSessionType,
    fetchedData,
    sessionConfig,
    modelOptions,
    selectedModel,
    selectedVariant,
    cloudAgentModelOverride,
  });
  const [currentMode, setCurrentMode] = useState<AgentMode>(() =>
    normalizeAgentMode(fetchedData?.mode ?? spawnedMode)
  );
  const [currentModel, setCurrentModel] = useState(initialSelection.model);
  const [currentVariant, setCurrentVariant] = useState(initialSelection.variant);

  useEffect(() => {
    const mode = sessionConfig?.mode ?? fetchedData?.mode;
    if (mode) {
      setCurrentMode(normalizeAgentMode(mode));
    }
  }, [sessionConfig?.mode, fetchedData?.mode]);

  useEffect(() => {
    const selection = resolveSessionConfigSelection({
      activeSessionType,
      fetchedData,
      sessionConfig,
      modelOptions,
      selectedModel,
      selectedVariant,
      cloudAgentModelOverride,
    });
    const isAutoSelectingFirstModel =
      activeSessionType === 'cloud-agent' &&
      fetchedData !== null &&
      !sessionConfig?.model &&
      !fetchedData.model &&
      !cloudAgentModelOverride?.model &&
      selection.model === modelOptions[0]?.id;
    if (isAutoSelectingFirstModel && currentModel) {
      return;
    }
    setCurrentModel(selection.model);
    setCurrentVariant(selection.variant);
  }, [
    activeSessionType,
    sessionConfig,
    fetchedData,
    modelOptions,
    selectedModel,
    selectedVariant,
    cloudAgentModelOverride,
    currentModel,
  ]);

  return {
    currentMode,
    currentModel,
    currentVariant,
    setCurrentMode,
    setCurrentModel,
    setCurrentVariant,
  };
}
