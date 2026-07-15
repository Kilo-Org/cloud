import { Server, Terminal } from 'lucide-react-native';
import { useMemo } from 'react';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  buildRuntimeDiscoveryViewModel,
  type LocalRuntime,
  RUNTIME_DISCOVERY_COPY,
  type RuntimeDiscoveryRow,
} from '@/lib/hooks/runtime-discovery-logic';
import { useLocalRuntimes } from '@/lib/hooks/use-local-runtimes';

type RuntimeDiscoveryContentProps = {
  /**
   * Optional tap handler attached to capable rows. Incapable rows are never
   * pressable; when this is omitted every row is non-pressable.
   */
  onSelect?: (runtime: LocalRuntime) => void;
};

const SKELETON_ROW_COUNT = 3;
const ROW_SKELETON_CLASS = 'h-[54px] w-full rounded-lg';

function LoadingState() {
  return (
    <View className="gap-3">
      {Array.from({ length: SKELETON_ROW_COUNT }).map((_, index) => (
        <Skeleton key={`runtime-skeleton-${index}`} className={ROW_SKELETON_CLASS} />
      ))}
    </View>
  );
}

function ReadyState({
  rows,
  onSelect,
}: {
  rows: RuntimeDiscoveryRow[];
  onSelect: (runtime: LocalRuntime) => void;
}) {
  const lastIndex = rows.length - 1;

  return (
    <View>
      {rows.map((row, index) => {
        if (row.kind === 'incapable') {
          return (
            <ConfigureRow
              key={row.runtime.runtimeId}
              icon={Terminal}
              title={row.displayName}
              subtitle={RUNTIME_DISCOVERY_COPY.incapable}
              tone="warn"
              disabled
              last={index === lastIndex}
            />
          );
        }
        return (
          <ConfigureRow
            key={row.runtime.runtimeId}
            icon={Server}
            title={row.displayName}
            subtitle={`${row.projectName} · CLI ${row.cliVersion}`}
            tone="good"
            onPress={() => {
              onSelect(row.runtime);
            }}
            last={index === lastIndex}
          />
        );
      })}
    </View>
  );
}

export function RuntimeDiscoveryContent({ onSelect }: Readonly<RuntimeDiscoveryContentProps>) {
  const { data, isError, refetch } = useLocalRuntimes();

  const handleRetry = () => {
    void refetch();
  };

  const viewModel = useMemo(
    () =>
      buildRuntimeDiscoveryViewModel({
        data,
        isError,
        refetch: () => {
          void refetch();
        },
        onSelect,
      }),
    [data, isError, refetch, onSelect]
  );

  if (viewModel.kind === 'loading') {
    return <LoadingState />;
  }

  if (viewModel.kind === 'error') {
    return <QueryError title={viewModel.title} message={viewModel.message} onRetry={handleRetry} />;
  }

  if (viewModel.kind === 'empty') {
    return (
      <EmptyState
        icon={Server}
        title={viewModel.title}
        description={viewModel.message}
        action={
          <Button variant="outline" onPress={handleRetry} accessibilityLabel="Retry">
            <Text>Retry</Text>
          </Button>
        }
      />
    );
  }

  const handleSelect = (runtime: LocalRuntime) => {
    viewModel.onSelect(runtime);
  };

  return <ReadyState rows={viewModel.rows} onSelect={handleSelect} />;
}
