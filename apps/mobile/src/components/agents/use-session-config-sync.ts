import { useEffect, useState } from 'react';

import { normalizeAgentMode } from '@/components/agents/mode-options';
import { type AgentMode } from '@/components/agents/mode-selector';
import { type ModelOption } from '@/lib/hooks/use-available-models';

type SessionConfigSnapshot = {
  mode?: string | null;
  model?: string | null;
  variant?: string | null;
};

type UseSessionConfigSyncOptions = {
  fetchedData: SessionConfigSnapshot | null;
  sessionConfig: SessionConfigSnapshot | null | undefined;
  modelOptions: ModelOption[];
};

type UseSessionConfigSyncResult = {
  currentMode: AgentMode;
  currentModel: string;
  currentVariant: string;
  setCurrentMode: (mode: AgentMode) => void;
  setCurrentModel: (model: string) => void;
  setCurrentVariant: (variant: string) => void;
};

// Keeps the composer's mode/model/variant in sync with the session's
// fetched data and the SDK session config (which is updated from assistant
// messages during snapshot replay). For sessions without a configured model
// (e.g. remote CLI sessions), auto-selects the first available model.
export function useSessionConfigSync({
  fetchedData,
  sessionConfig,
  modelOptions,
}: UseSessionConfigSyncOptions): UseSessionConfigSyncResult {
  const [currentMode, setCurrentMode] = useState<AgentMode>(() =>
    normalizeAgentMode(fetchedData?.mode)
  );
  const [currentModel, setCurrentModel] = useState<string>(fetchedData?.model ?? '');
  const [currentVariant, setCurrentVariant] = useState<string>(fetchedData?.variant ?? '');

  useEffect(() => {
    const mode = sessionConfig?.mode ?? fetchedData?.mode;
    if (mode) {
      setCurrentMode(normalizeAgentMode(mode));
    }

    const model = sessionConfig?.model ?? fetchedData?.model;
    if (model) {
      setCurrentModel(model);
    }

    const variant = sessionConfig?.variant ?? fetchedData?.variant;
    if (variant) {
      setCurrentVariant(variant);
    }
  }, [
    sessionConfig?.mode,
    sessionConfig?.model,
    sessionConfig?.variant,
    fetchedData?.mode,
    fetchedData?.model,
    fetchedData?.variant,
  ]);

  useEffect(() => {
    if (currentModel || modelOptions.length === 0 || fetchedData === null) {
      return;
    }
    const firstModel = modelOptions[0];
    if (firstModel) {
      setCurrentModel(firstModel.id);
      setCurrentVariant(firstModel.variants[0] ?? '');
    }
  }, [currentModel, modelOptions, fetchedData]);

  return {
    currentMode,
    currentModel,
    currentVariant,
    setCurrentMode,
    setCurrentModel,
    setCurrentVariant,
  };
}
