import { ScrollView, View } from 'react-native';
import { Server } from 'lucide-react-native';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  type LocalRuntimeFence,
  type LocalSessionConfigViewModel,
} from '@/lib/hooks/local-runtime-catalog-types';
import { type LocalRuntime } from '@/lib/hooks/runtime-discovery-logic';

import { ConfiguredRows, SCREEN_TITLE, SKELETON_ROW_CLASS } from './local-session-config-rows';

type LocalSessionConfigStateRendererProps = {
  viewModel: LocalSessionConfigViewModel;
  onPressRuntime: () => void;
  onPressAgent: () => void;
  onPressModel: () => void;
  onSelectFence: (fence: LocalRuntimeFence) => void;
};

export function LocalSessionConfigStateRenderer({
  viewModel,
  onPressRuntime,
  onPressAgent,
  onPressModel,
  onSelectFence,
}: LocalSessionConfigStateRendererProps) {
  if (viewModel.kind === 'loading') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={SCREEN_TITLE} />
        <View className="gap-3 px-4 pt-4">
          <Skeleton className={SKELETON_ROW_CLASS} />
          <Skeleton className={SKELETON_ROW_CLASS} />
        </View>
      </View>
    );
  }

  if (viewModel.kind === 'empty') {
    const handleRetry = viewModel.retry;
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={SCREEN_TITLE} />
        <View className="flex-1 px-4 pt-4">
          <QueryError title={viewModel.title} message={viewModel.message} onRetry={handleRetry} />
        </View>
      </View>
    );
  }

  if (viewModel.kind === 'incapable') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={SCREEN_TITLE} />
        <View className="flex-1 px-4 pt-4">
          <QueryError title="Update Kilo CLI" message="Update Kilo CLI and reconnect." />
        </View>
      </View>
    );
  }

  if (viewModel.kind === 'selecting-runtime') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={SCREEN_TITLE} />
        <ScrollView
          className="flex-1"
          contentContainerClassName="flex-grow px-4 pb-32 pt-4"
          keyboardShouldPersistTaps="handled"
        >
          <Text className="mb-3 text-sm font-medium text-muted-foreground">Available runtimes</Text>
          <View className="overflow-hidden rounded-lg border border-border bg-card px-1">
            {viewModel.runtimes.map((runtime: LocalRuntime, index: number) => {
              const last = index === viewModel.runtimes.length - 1;
              return (
                <ConfigureRow
                  key={runtime.runtimeId}
                  icon={Server}
                  title={runtime.displayName}
                  subtitle={`${runtime.projectName} · CLI ${runtime.cliVersion}`}
                  tone="good"
                  onPress={() => {
                    onSelectFence({
                      runtimeId: runtime.runtimeId,
                      connectionId: runtime.connectionId,
                    });
                  }}
                  last={last}
                />
              );
            })}
          </View>
        </ScrollView>
      </View>
    );
  }

  if (viewModel.kind === 'catalog-loading') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={SCREEN_TITLE} />
        <ScrollView
          className="flex-1"
          contentContainerClassName="flex-grow px-4 pb-32 pt-4"
          keyboardShouldPersistTaps="handled"
        >
          <ConfiguredRows
            runtimeTitle={viewModel.runtime.displayName}
            runtimeSubtitle={`${viewModel.runtime.projectName} · CLI ${viewModel.runtime.cliVersion}`}
            onPressRuntime={onPressRuntime}
            agentTitle={'\u00A0'}
            agentSubtitle="Loading agents..."
            onPressAgent={onPressAgent}
            agentDisabled
            modelTitle={'\u00A0'}
            modelSubtitle="Loading models..."
            onPressModel={onPressModel}
            modelDisabled
          />
        </ScrollView>
      </View>
    );
  }

  if (viewModel.kind === 'catalog-error-retryable') {
    const handleRetry = viewModel.retry;
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={SCREEN_TITLE} />
        <ScrollView
          className="flex-1"
          contentContainerClassName="flex-grow px-4 pb-32 pt-4"
          keyboardShouldPersistTaps="handled"
        >
          <ConfiguredRows
            runtimeTitle={viewModel.runtime.displayName}
            runtimeSubtitle={`${viewModel.runtime.projectName} · CLI ${viewModel.runtime.cliVersion}`}
            onPressRuntime={onPressRuntime}
            agentTitle="Agent"
            agentSubtitle="Unavailable while catalog is loading."
            onPressAgent={onPressAgent}
            agentDisabled
            modelTitle="Model"
            modelSubtitle="Unavailable while catalog is loading."
            onPressModel={onPressModel}
            modelDisabled
          />
          <View className="mt-5">
            <QueryError title={viewModel.title} message={viewModel.message} onRetry={handleRetry} />
          </View>
        </ScrollView>
      </View>
    );
  }

  if (viewModel.kind === 'catalog-error-non-retryable') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={SCREEN_TITLE} />
        <ScrollView
          className="flex-1"
          contentContainerClassName="flex-grow px-4 pb-32 pt-4"
          keyboardShouldPersistTaps="handled"
        >
          <ConfiguredRows
            runtimeTitle={viewModel.runtime.displayName}
            runtimeSubtitle={`${viewModel.runtime.projectName} · CLI ${viewModel.runtime.cliVersion}`}
            onPressRuntime={onPressRuntime}
            agentTitle="Agent"
            agentSubtitle="Unavailable."
            onPressAgent={onPressAgent}
            agentDisabled
            modelTitle="Model"
            modelSubtitle="Unavailable."
            onPressModel={onPressModel}
            modelDisabled
          />
          <View className="mt-5">
            <QueryError title={viewModel.title} message={viewModel.message} />
          </View>
        </ScrollView>
      </View>
    );
  }

  return null;
}
