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
  /** The session this composer is for, so a pick never leaks into another one. */
  sessionId: string;
  /**
   * Mode chosen at spawn, threaded from the route. Seeds the initial mode only:
   * a stored `fetchedData.mode`, a live `sessionConfig.mode`, and a later user
   * pick all win over it.
   */
  spawnedMode?: string;
};

/**
 * Who owns the composer's mode. A mode the person picked outlives the session
 * row that lands after it; the pick names its session, so it never leaks into
 * another.
 */
type ModeChoice =
  | { readonly kind: 'session'; readonly mode: AgentMode }
  | { readonly kind: 'picked'; readonly sessionId: string; readonly mode: AgentMode };

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
  sessionId,
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
  const [modeChoice, setModeChoice] = useState<ModeChoice>(() => ({
    kind: 'session',
    mode: normalizeAgentMode(fetchedData?.mode ?? spawnedMode),
  }));
  const [currentModel, setCurrentModel] = useState(initialSelection.model);
  const [currentVariant, setCurrentVariant] = useState(initialSelection.variant);

  useEffect(() => {
    const mode = sessionConfig?.mode ?? fetchedData?.mode;
    if (mode) {
      /* A row that lands after a pick may not replace it: the pick is the person
         answering, and the row is about the session as it was before they did.
         The pick names its session, so another session's row replaces the seed
         rather than a choice made in a different chat. */
      setModeChoice(held =>
        held.kind === 'picked' && held.sessionId === sessionId
          ? held
          : { kind: 'session', mode: normalizeAgentMode(mode) }
      );
    }
  }, [sessionConfig?.mode, fetchedData?.mode, sessionId]);

  const setCurrentMode = useCallback(
    (mode: AgentMode) => {
      setModeChoice({ kind: 'picked', sessionId, mode });
    },
    [sessionId]
  );

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
    currentMode: modeChoice.mode,
    currentModel,
    currentVariant,
    setCurrentMode,
    setCurrentModel,
    setCurrentVariant,
  };
}
