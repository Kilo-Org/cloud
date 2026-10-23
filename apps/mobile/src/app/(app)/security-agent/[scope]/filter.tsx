import {
  getSecurityRepositoriesInScope,
  parseSecurityFindingFilters,
  type SecurityFindingFilters,
  type SecurityFindingRouteParams,
  toSecurityFindingParams,
} from '@kilocode/app-shared/security-agent';
import { type ErrorBoundaryProps, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { PickerSheet } from '@/components/picker-sheet';
import { QueryError } from '@/components/query-error';
import { FindingFilterModal } from '@/components/security-agent/finding-filter-modal';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  useSecurityAgentConfig,
  useSecurityAgentRepositories,
} from '@/lib/hooks/use-security-agent';

const FINDINGS_ROUTE = '/(app)/security-agent/[scope]/findings' as const;

function FilterOptionsSkeleton() {
  const { t } = useTranslation();
  return (
    <View className="gap-3 px-3 pt-2">
      {/* Skeleton rows carry the shape of the list; the status line says in
          words what the sheet is waiting for, so the same progress reaches a
          screen reader. */}
      <AccessibleStatus message={t('common.loading')} tone="status" className="text-sm" />
      <Skeleton className="h-4 w-24 rounded" />
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full rounded-lg" />
      ))}
    </View>
  );
}

// The sheet's whole input travels in its own route: the findings screen pushes
// this route with the filters it currently shows, so a reopened, restored or
// reloaded sheet always starts from the same draft it was opened with. The
// repository options come from the queries the findings screen already holds
// (same cache keys), so a normal open renders them immediately and a cold open
// shows rows while they arrive instead of a control-less placeholder.
export default function SecurityAgentFilterFindingsRoute() {
  const router = useRouter();
  const { t } = useTranslation();
  const { scope, ...routeParams } = useLocalSearchParams<
    { scope: string } & SecurityFindingRouteParams
  >();
  // Seeded once, deliberately: the route params describe the filters the list
  // is showing when the sheet opens. Re-syncing them on every render would
  // overwrite edits with the committed filters while the reader is still
  // choosing, and the sheet is the only writer while it is on screen.
  const [draft, setDraft] = useState<SecurityFindingFilters>(() =>
    parseSecurityFindingFilters(routeParams)
  );

  const config = useSecurityAgentConfig(scope);
  const repositories = useSecurityAgentRepositories(scope);
  const options = useMemo(
    () => getSecurityRepositoriesInScope(repositories.data ?? [], config.data),
    [repositories.data, config.data]
  );

  // An unloaded or failed repository fetch must not cost the reader the sheet:
  // the fixed sections stay usable and the list area explains itself. A fetch
  // paused by lost connectivity is reported the same way instead of leaving a
  // skeleton that can never finish.
  const repositoriesOffline = repositories.isPending && repositories.isPaused;
  const repositoriesLoading =
    repositories.isPending && !repositories.isPaused && !repositories.isError;
  const renderOptionList = () => {
    if (repositories.isError || repositoriesOffline) {
      return (
        <View className="px-6">
          <QueryError
            variant={repositoriesOffline ? 'offline' : 'neutral'}
            message={t('common.couldNotLoadRepositories')}
            onRetry={() => {
              void repositories.refetch();
            }}
            isRetrying={repositories.isFetching}
          />
        </View>
      );
    }
    if (repositoriesLoading) {
      return <FilterOptionsSkeleton />;
    }
    return <FindingFilterModal filters={draft} repositories={options} onChange={setDraft} />;
  };

  return (
    <PickerSheet
      title={t('securityAgent.filter.title')}
      onDone={() => {
        router.dismissTo({
          pathname: FINDINGS_ROUTE,
          params: { scope, ...toSecurityFindingParams(draft) },
        });
      }}
      onCancel={() => {
        router.back();
      }}
      doneLabel={t('common.apply')}
    >
      {renderOptionList()}
    </PickerSheet>
  );
}

// A render failure inside the sheet stays inside the sheet: the findings list
// underneath keeps its place and the reader can go back instead of being reset
// to the app root by the global boundary. Deliberately not a PickerSheet — the
// shell is what may just have failed.
export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
  return <FilterSheetFailure onRetry={() => void retry()} />;
}

function FilterSheetFailure({ onRetry }: Readonly<{ onRetry: () => void }>) {
  const router = useRouter();
  const { t } = useTranslation();
  return (
    <View className="flex-1 items-center justify-center bg-background px-6">
      <QueryError placement="static" message={t('common.somethingWentWrong')} onRetry={onRetry} />
      <Button
        variant="ghost"
        className="mt-2"
        onPress={() => {
          router.back();
        }}
      >
        <Text>{t('common.goBack')}</Text>
      </Button>
    </View>
  );
}
