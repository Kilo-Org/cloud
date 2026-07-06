import { type ResolvedSession } from 'cloud-agent-sdk';
import { useEffect, useState } from 'react';

import { normalizeAgentMode } from '@/components/agents/mode-options';
import { type AgentMode } from '@/components/agents/mode-selector';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

type SessionConfigSnapshot = {
  mode?: string | null;
  model?: string | null;
  variant?: string | null;
};

type ResolveSessionConfigSelectionOptions = {
  activeSessionType: ResolvedSession['type'] | null;
  fetchedData: SessionConfigSnapshot | null;
  sessionConfig: SessionConfigSnapshot | null | undefined;
  modelOptions: SessionModelOption[];
  selectedModel: string;
  selectedVariant: string;
};

type UseSessionConfigSyncOptions = ResolveSessionConfigSelectionOptions;

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
}: ResolveSessionConfigSelectionOptions): { model: string; variant: string } {
  if (activeSessionType === 'remote') {
    return { model: selectedModel, variant: selectedVariant };
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
}: UseSessionConfigSyncOptions): UseSessionConfigSyncResult {
  const initialSelection = resolveSessionConfigSelection({
    activeSessionType,
    fetchedData,
    sessionConfig,
    modelOptions,
    selectedModel,
    selectedVariant,
  });
  const [currentMode, setCurrentMode] = useState<AgentMode>(() =>
    normalizeAgentMode(fetchedData?.mode)
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
    });
    const isAutoSelectingFirstModel =
      activeSessionType === 'cloud-agent' &&
      fetchedData !== null &&
      !sessionConfig?.model &&
      !fetchedData.model &&
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
