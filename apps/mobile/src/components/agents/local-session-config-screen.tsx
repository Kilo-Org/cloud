import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Lock } from 'lucide-react-native';

import { LocalSessionCreatePromptInput } from '@/components/agents/local-session-create-prompt-input';
import { LocalSessionCreateRecoveryPanel } from '@/components/agents/local-session-create-recovery-panel';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { isStartSessionEnabled } from '@/lib/hooks/local-session-create-enablement';
import {
  preservePromptOnClearFence,
  preservePromptOnRefreshCatalog,
} from '@/lib/hooks/local-session-create-prompt-actions';
import { resolveRecoveryCtaAction } from '@/lib/hooks/local-session-create-recovery-actions';
import { useLocalSessionCreate } from '@/lib/hooks/use-local-session-create';
import {
  isRuntimeCatalogPickerScopeCurrent,
  type RuntimeCatalogPickerScope,
} from '@/lib/hooks/local-runtime-catalog-picker-scope';
import {
  type LocalRuntimeCatalog,
  type LocalRuntimeFence,
} from '@/lib/hooks/local-runtime-catalog-types';
import {
  buildLocalSessionConfigScreenViewModel,
  useLocalSessionConfigController,
} from '@/lib/hooks/use-local-session-config-controller';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  setRuntimeCatalogAgentPickerBridge,
  setRuntimeCatalogModelPickerBridge,
  setRuntimePickerBridge,
} from '@/lib/picker-bridge';

import { ConfiguredRows, SCREEN_TITLE } from './local-session-config-rows';
import { LocalSessionConfigStateRenderer } from './local-session-config-states';

const RUNTIME_PICKER_PATH = '/(app)/agent-chat/runtime-picker' as const;
const RUNTIME_CATALOG_AGENT_PICKER_PATH = '/(app)/agent-chat/runtime-catalog-agent-picker' as const;
const RUNTIME_CATALOG_MODEL_PICKER_PATH = '/(app)/agent-chat/runtime-catalog-model-picker' as const;

type ReadySelections = {
  fence: LocalRuntimeFence;
  catalog: LocalRuntimeCatalog;
  selectedAgentSlug: string;
  selectedModel: { providerID: string; modelID: string; variant: string };
};

function readReadySelections(
  viewModel: ReturnType<typeof buildLocalSessionConfigScreenViewModel>
): ReadySelections | null {
  if (viewModel.kind !== 'ready') {
    return null;
  }
  return {
    fence: {
      runtimeId: viewModel.runtime.runtimeId,
      connectionId: viewModel.runtime.connectionId,
    },
    catalog: viewModel.catalog,
    selectedAgentSlug: viewModel.selectedAgent.slug,
    selectedModel: {
      providerID: viewModel.selectedModel.providerID,
      modelID: viewModel.selectedModel.modelID,
      variant: viewModel.selectedVariant,
    },
  };
}

export function LocalSessionConfigScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const controller = useLocalSessionConfigController();
  const viewModel = useMemo(() => buildLocalSessionConfigScreenViewModel(controller), [controller]);
  const liveViewModelRef = useRef(viewModel);
  liveViewModelRef.current = viewModel;

  // The prompt is owned by an uncontrolled TextInput ref. The orchestrator
  // snapshots `promptRef.current` on submit; the screen only mirrors the
  // derived `hasPrompt` flag so the Start button can react to typing
  // without rebuilding the orchestrator.
  const promptRef = useRef('');
  const [hasPrompt, setHasPrompt] = useState(false);
  const handlePromptChange = useCallback((text: string) => {
    promptRef.current = text;
    const nextHasPrompt = text.trim().length > 0;
    setHasPrompt(current => (current === nextHasPrompt ? current : nextHasPrompt));
  }, []);

  // Hooks must run unconditionally; the orchestrator hook tolerates null
  // selections and reports `canSubmit === false` until every selection is
  // resolved.
  const readySelections = readReadySelections(viewModel);
  const create = useLocalSessionCreate({
    fence: readySelections?.fence ?? null,
    catalog: readySelections?.catalog ?? null,
    selectedAgentSlug: readySelections?.selectedAgentSlug ?? null,
    selectedModel: readySelections?.selectedModel ?? null,
    promptRef,
    hasPromptRef: { current: hasPrompt },
  });

  const isCurrentCatalogScope = useCallback(
    (scope: RuntimeCatalogPickerScope) =>
      isRuntimeCatalogPickerScopeCurrent(scope, liveViewModelRef.current),
    []
  );

  const openRuntimePicker = useCallback(() => {
    if (viewModel.kind !== 'selecting-runtime') {
      return;
    }
    setRuntimePickerBridge({
      runtimes: viewModel.runtimes,
      currentFence: viewModel.currentFence,
      selectionScope: viewModel.currentFence,
      isSelectionCurrent: scope => {
        if (!scope || !viewModel.currentFence) {
          return false;
        }
        return (
          scope.runtimeId === viewModel.currentFence.runtimeId &&
          scope.connectionId === viewModel.currentFence.connectionId
        );
      },
      onSelect: (fence: LocalRuntimeFence) => {
        controller.onSelectFence(fence);
      },
    });
    router.push(RUNTIME_PICKER_PATH);
  }, [controller, router, viewModel]);

  const openAgentPicker = useCallback(() => {
    if (viewModel.kind !== 'ready') {
      return;
    }
    setRuntimeCatalogAgentPickerBridge({
      catalog: viewModel.catalog,
      currentFence: {
        runtimeId: viewModel.runtime.runtimeId,
        connectionId: viewModel.runtime.connectionId,
      },
      currentValue: viewModel.selectedAgent.slug,
      selectionScope: {
        runtimeId: viewModel.runtime.runtimeId,
        connectionId: viewModel.runtime.connectionId,
        protocol: 'v1',
        catalogGenerationIdentity: viewModel.catalogGeneration,
      },
      isSelectionCurrent: scope => isCurrentCatalogScope(scope),
      onSelect: selection => {
        controller.onSelectAgent(selection.slug);
      },
    });
    router.push(RUNTIME_CATALOG_AGENT_PICKER_PATH);
  }, [controller, isCurrentCatalogScope, router, viewModel]);

  const openModelPicker = useCallback(() => {
    if (viewModel.kind !== 'ready' || viewModel.isModelLocked) {
      return;
    }
    setRuntimeCatalogModelPickerBridge({
      catalog: viewModel.catalog,
      currentFence: {
        runtimeId: viewModel.runtime.runtimeId,
        connectionId: viewModel.runtime.connectionId,
      },
      currentValue: viewModel.selectedModel.modelID,
      currentVariant: viewModel.selectedVariant,
      selectionScope: {
        runtimeId: viewModel.runtime.runtimeId,
        connectionId: viewModel.runtime.connectionId,
        protocol: 'v1',
        catalogGenerationIdentity: viewModel.catalogGeneration,
      },
      isSelectionCurrent: scope => isCurrentCatalogScope(scope),
      onSelect: selection => {
        controller.onSelectModel(selection);
      },
    });
    router.push(RUNTIME_CATALOG_MODEL_PICKER_PATH);
  }, [controller, isCurrentCatalogScope, router, viewModel]);

  const handleSelectFence = useCallback(
    (fence: LocalRuntimeFence) => {
      controller.onSelectFence(fence);
    },
    [controller]
  );

  const handleSelectRuntimeFromRecovery = useCallback(() => {
    preservePromptOnClearFence({ controller, promptRef });
  }, [controller]);

  const handleRefreshCatalogFromRecovery = useCallback(() => {
    preservePromptOnRefreshCatalog({
      refetchCatalog: controller.refetchCatalog,
      onResetOverrides: controller.onResetOverrides,
      promptRef,
    });
  }, [controller]);

  const handleStart = useCallback(() => {
    void create.submit();
  }, [create]);

  const recoveryAction = resolveRecoveryCtaAction({
    recovery: create.recovery,
    isSubmitting: create.isSubmitting,
    onRetry: () => {
      void create.retry();
    },
    onCheckAgain: () => {
      void create.checkAgain();
    },
    onSelectRuntime: handleSelectRuntimeFromRecovery,
    onRefreshCatalog: handleRefreshCatalogFromRecovery,
  });

  if (viewModel.kind !== 'ready') {
    return (
      <LocalSessionConfigStateRenderer
        viewModel={viewModel}
        onPressRuntime={openRuntimePicker}
        onPressAgent={openAgentPicker}
        onPressModel={openModelPicker}
        onSelectFence={handleSelectFence}
      />
    );
  }

  const ready = viewModel;
  const canStart = isStartSessionEnabled({
    isReadySelection: true,
    hasPrompt,
    canSubmit: create.canSubmit,
    isSubmitting: create.isSubmitting,
  });

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={SCREEN_TITLE} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="flex-grow px-4 pb-32 pt-4"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <ConfiguredRows
          runtimeTitle={ready.runtime.displayName}
          runtimeSubtitle={`${ready.runtime.projectName} · CLI ${ready.runtime.cliVersion}`}
          onPressRuntime={openRuntimePicker}
          agentTitle={ready.selectedAgent.name}
          agentSubtitle={
            ready.selectedAgent.description ??
            (ready.isModelLocked ? 'Model is locked to this agent.' : ready.selectedAgent.slug)
          }
          onPressAgent={openAgentPicker}
          modelTitle={`${ready.selectedModel.modelID}${
            ready.selectedVariant ? ` · ${ready.selectedVariant}` : ''
          }`}
          modelSubtitle={ready.isModelLocked ? 'Pinned by agent' : ready.selectedModel.providerID}
          onPressModel={openModelPicker}
          modelDisabled={ready.isModelLocked}
          modelTrailing={
            ready.isModelLocked ? <Lock size={14} color={colors.mutedForeground} /> : null
          }
        />
        <LocalSessionCreatePromptInput
          promptRef={promptRef}
          onChangePrompt={handlePromptChange}
          isSubmitting={create.isSubmitting}
        />
        {create.recovery ? (
          <LocalSessionCreateRecoveryPanel
            message={create.recovery.message}
            action={recoveryAction}
            disabled={create.isSubmitting}
          />
        ) : null}
        <Button
          size="lg"
          className="mt-6"
          disabled={!canStart}
          loading={create.isSubmitting}
          onPress={handleStart}
          accessibilityLabel="Start session"
        >
          {create.isSubmitting ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Text>Start session</Text>
          )}
        </Button>
      </ScrollView>
    </View>
  );
}
