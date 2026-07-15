import { useCallback, useMemo, useRef } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Lock } from 'lucide-react-native';

import { ScreenHeader } from '@/components/screen-header';
import {
  isRuntimeCatalogPickerScopeCurrent,
  type RuntimeCatalogPickerScope,
} from '@/lib/hooks/local-runtime-catalog-picker-scope';
import { type LocalRuntimeFence } from '@/lib/hooks/local-runtime-catalog-types';
import {
  buildLocalSessionConfigScreenViewModel,
  useLocalSessionConfigController,
} from '@/lib/hooks/use-local-session-config-controller';
import {
  setRuntimeCatalogAgentPickerBridge,
  setRuntimeCatalogModelPickerBridge,
  setRuntimePickerBridge,
} from '@/lib/picker-bridge';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { ConfiguredRows, FooterMessage, SCREEN_TITLE } from './local-session-config-rows';
import { LocalSessionConfigStateRenderer } from './local-session-config-states';

const RUNTIME_PICKER_PATH = '/(app)/agent-chat/runtime-picker' as const;
const RUNTIME_CATALOG_AGENT_PICKER_PATH = '/(app)/agent-chat/runtime-catalog-agent-picker' as const;
const RUNTIME_CATALOG_MODEL_PICKER_PATH = '/(app)/agent-chat/runtime-catalog-model-picker' as const;

export function LocalSessionConfigScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const controller = useLocalSessionConfigController();
  const viewModel = useMemo(() => buildLocalSessionConfigScreenViewModel(controller), [controller]);
  // The bridge's `isSelectionCurrent` callback is invoked synchronously by the
  // commit helpers. The screen must answer against the live view-model, not a
  // stale closure value, so a ref keeps the callback stable while the body of
  // the callback reads the freshest published data.
  const liveViewModelRef = useRef(viewModel);
  liveViewModelRef.current = viewModel;

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
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={SCREEN_TITLE} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="flex-grow px-4 pb-32 pt-4"
        keyboardShouldPersistTaps="handled"
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
      </ScrollView>
      <FooterMessage />
    </View>
  );
}
