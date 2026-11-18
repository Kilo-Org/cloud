import {
  getSettingsDirtyState,
  isPersonalSecurityScope,
} from '@kilocode/app-shared/security-agent';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { ExternalLink, FolderGit2 } from '@/components/ui/icons';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SettingsSaveButton } from '@/components/security-agent/settings-save-button';
import { useSettingsSaveFeedback } from '@/components/security-agent/settings-save-feedback';
import { EmptyState, StateAction } from '@/components/empty-state';
import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { classifyListBody } from '@/lib/query/list-body-state';
import { OrphanedFindingsCard } from '@/components/security-agent/orphaned-findings-card';
import { RepoToggleRow } from '@/components/repo-toggle-row';
import { ScreenHeader } from '@/components/screen-header';
import { QueryError } from '@/components/query-error';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { ChoiceRow } from '@/components/ui/choice-row';
import { RadioGroup } from '@/components/ui/radio-group';
import { RowGroup, RowGroupItem } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { openAppShellHandoff } from '@/lib/app-shell-handoff';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import {
  useSecurityAgentSettingsRedirect,
  useSettingsBackGuard,
} from '@/lib/hooks/use-settings-back-guard';
import {
  useSaveSecurityAgentConfig,
  useSecurityAgentCapability,
  useSecurityAgentConfig,
  useSecurityAgentRepositories,
} from '@/lib/hooks/use-security-agent';
import { type FlattenedSecurityAgentConfig, type SecurityAgentConfig } from '@/lib/security-agent';

type RepositorySelectionMode = SecurityAgentConfig['repositorySelectionMode'];

/** The repository rows the picker lists; derived from the hook so the row shape cannot drift. */
type RepositoryRow = NonNullable<ReturnType<typeof useSecurityAgentRepositories>['data']>[number];

// FlashList takes `contentContainerStyle`, not className, so the body carries
// only the tab-bar band and the safe-area side insets; the page gutter lives on
// the rows and the header, whose row primitives draw their own `px-4`.
const listStyle = { flex: 1 } satisfies ViewStyle;

/** Where a grouped cell sits in its section, for its rounded ends. */
function rowPosition(index: number, count: number): 'only' | 'first' | 'middle' | 'last' {
  if (count <= 1) {
    return 'only';
  }
  if (index === 0) {
    return 'first';
  }
  return index === count - 1 ? 'last' : 'middle';
}

function RepositorySettingsSkeleton() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.repositories')} />
      <View className={SCREEN_BODY_CLASS}>
        <RowGroup>
          <RowSkeleton />
          <RowSkeleton />
        </RowGroup>
        {/* The picker's rows are one grouped card, so the reserve is one. */}
        <RowGroup>
          <RowSkeleton />
          <RowSkeleton />
        </RowGroup>
      </View>
    </View>
  );
}

export function RepositorySettingsScreen({ scope }: Readonly<{ scope: string }>) {
  const { t } = useTranslation();
  const canManage = useSecurityAgentCapability(scope).canManage;
  const config = useSecurityAgentConfig(scope);
  const repositories = useSecurityAgentRepositories(scope);
  const save = useSaveSecurityAgentConfig(scope, { announceFailed: false });
  const feedback = useSettingsSaveFeedback();
  const connectivityKnown = useCommittedConnectivityStatus() !== 'unknown';

  const [mode, setMode] = useState<RepositorySelectionMode>('all');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  // The saved baseline the draft is compared against. State rather than a ref:
  // a successful save must re-render, so `dirty` (and the back guard that
  // reads it) reflects the saved values by the time the header action leaves.
  const [baseline, setBaseline] = useState<Partial<FlattenedSecurityAgentConfig> | null>(null);

  // Local state initialized from the loaded config exactly once — later
  // config refetches (e.g. after this screen's own save) shouldn't clobber
  // in-progress edits.
  useEffect(() => {
    if (baseline !== null || !config.data) {
      return;
    }
    setBaseline(config.data);
    setMode(config.data.repositorySelectionMode);
    setSelectedIds(config.data.selectedRepositoryIds);
  }, [baseline, config.data]);

  // The repositories screen stays reachable while the agent is disabled so a
  // user with integration repos but no effective selection can pick repos and
  // then enable (the overview's "Select repositories" CTA lands here). Opt out
  // of the disabled-state redirect; every other sub-screen keeps it.
  useSecurityAgentSettingsRedirect(scope, config.data?.isEnabled, { skipRedirect: true });

  const valid = mode === 'all' || selectedIds.length > 0;
  const patch = { repositorySelectionMode: mode, selectedRepositoryIds: selectedIds };
  const dirty = baseline !== null && getSettingsDirtyState(baseline, patch, valid) !== 'clean';

  const handleSave = () =>
    feedback.run(async () => {
      await save.mutateAsync(patch);
      setBaseline(previous => ({ ...previous, ...patch }));
    });

  const { onBack, skipNextGuardRef, dialog } = useSettingsBackGuard({
    dirty,
    valid,
    // These screens never ask a destructive question of their own: a save
    // here always persists.
    onSave: async () => {
      await handleSave();
      return 'saved';
    },
  });

  // Selection is a Set for O(1) row lookups: the row renderer would otherwise
  // scan `selectedIds` once per repository per render (O(repos × selected)).
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const toggleRepo = useCallback((id: number) => {
    setSelectedIds(current =>
      current.includes(id) ? current.filter(existing => existing !== id) : [...current, id]
    );
  }, []);

  const paddingBottom = useTabBarBottomPadding();
  const insets = useSafeAreaInsets();
  // One content-container style for the whole list, so every row — recycled or
  // not — starts at the same offset and a rotation re-derives it once.
  const listContentContainerStyle = useMemo(
    () => ({
      paddingTop: 12,
      paddingLeft: insets.left,
      paddingRight: insets.right,
      paddingBottom,
    }),
    [insets.left, insets.right, paddingBottom]
  );

  // The rendered count decides each cell's rounded end, so it is read once and
  // carried into the renderer rather than re-derived per cell.
  const repositoryCount = repositories.data?.length ?? 0;

  // Hoisted so the FlashList keeps one renderer identity across toggles and
  // re-renders only the rows whose `selected` actually changed.
  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<RepositoryRow>) => (
      // The picker is one grouped card inside the full-bleed list, so each
      // virtualized cell draws its own rounded end, surface and separator and
      // the page gutter lives here rather than on the list.
      <RowGroupItem position={rowPosition(index, repositoryCount)} className="mx-4">
        <RepoToggleRow
          repo={item}
          selected={selectedIdSet.has(item.id)}
          disabled={!canManage}
          onPress={() => {
            toggleRepo(item.id);
          }}
        />
      </RowGroupItem>
    ),
    [selectedIdSet, canManage, repositoryCount, toggleRepo]
  );

  if (config.isError && !config.data) {
    return (
      <PlatformErrorScreen
        title={t('common.repositories')}
        variant="offline"
        message={t('securityAgent.repositories.couldNotLoad')}
        onRetry={() => void config.refetch()}
      />
    );
  }
  if (config.isLoading || !config.data) {
    return <RepositorySettingsSkeleton />;
  }

  const showRepositoryStates = mode === 'selected';
  const hasRepositories = repositoryCount > 0;
  // A loading, failed, or not-yet-fetched repository query must not read as
  // zero repositories. Only a delivered read may claim the list is empty: a
  // read paused by lost connectivity delivered nothing and names the
  // connection with Retry instead.
  const repositoriesBody = classifyListBody({
    rowCount: repositoryCount,
    hasDeliveredData: repositories.data !== undefined,
    isError: repositories.isError,
    isFetching: repositories.isFetching,
    fetchStatus: repositories.fetchStatus,
    connectivityKnown,
  });
  const repositoriesFailed =
    repositoriesBody.status === 'error' ||
    (repositoriesBody.status === 'rows' && repositories.isError);

  // An empty grant is the one repository state that is not about the mode: with
  // nothing accessible there is nothing to select and nothing to sync whichever
  // mode is stored, and widening the app's access is the only way out. Naming it
  // only in `selected` mode left the disabled agent's "Select repositories" row
  // landing on a screen whose only controls were the two mode choices. Only the
  // classifier's delivered-empty answer reaches the section in `all` mode, so a
  // cached `[]` under a failed read cannot render a label with no control.
  const showRepositorySection = showRepositoryStates || repositoriesBody.status === 'empty';

  // The GitHub settings page is where installation access is widened on the
  // web, and `openAppShellHandoff` resolves when that page closes — on both
  // platforms it awaits the browser's own dismissal (a launch or mint it could
  // not complete is toasted by that helper and still resolves). Reading the
  // repository list again on that return edge is what makes a grant show up
  // here: without it the cached empty answer stays fresh for the whole stale
  // window, and the disabled agent's enable rule counts exactly these
  // repositories.
  const manageAccess = async () => {
    const orgId = isPersonalSecurityScope(scope) ? undefined : scope;
    await openAppShellHandoff(
      { page: 'github-app', ...(orgId ? { organizationId: orgId } : {}) },
      { label: t('securityAgent.repositories.githubAppSettings') }
    );
    await repositories.refetch();
  };

  // Everything above the rows (permission note, mode choice, and — in selected
  // mode — the loading / error / empty branches) rides on the list header so
  // the rendered order and paddings are unchanged from the ScrollView version.
  const listHeader: ReactNode = (
    <View className="gap-6 px-4 pt-3">
      {!canManage && (
        <Text className="text-center text-xs text-muted-foreground">
          {t('securityAgent.sla.permissionNote')}
        </Text>
      )}
      <OrphanedFindingsCard scope={scope} canManage={canManage} />
      <RadioGroup label={t('common.repositories')}>
        <RowGroup>
          {(['all', 'selected'] as const).map(option => (
            <ChoiceRow
              key={option}
              label={
                option === 'all' ? t('common.allRepositories') : t('common.selectedRepositories')
              }
              selected={mode === option}
              disabled={!canManage}
              onPress={() => {
                setMode(option);
              }}
            />
          ))}
        </RowGroup>
      </RadioGroup>

      {showRepositorySection && (
        // The empty state's own title already says "No repositories", so a
        // section label above it only repeats the screen title.
        <Section label={repositoriesBody.status === 'empty' ? undefined : t('common.repositories')}>
          {repositoriesBody.status === 'loading' && (
            <RowGroup>
              <RowSkeleton />
              <RowSkeleton />
            </RowGroup>
          )}
          {repositoriesFailed && (
            <QueryError
              variant={
                repositoriesBody.status === 'error' && repositoriesBody.cause === 'offline'
                  ? 'offline'
                  : 'server'
              }
              placement="top"
              title={t('common.couldNotLoadRepositories')}
              onRetry={() => void repositories.refetch()}
              isRetrying={repositories.isFetching}
            />
          )}
          {repositoriesBody.status === 'empty' ? (
            <EmptyState
              placement="top"
              icon={FolderGit2}
              title={t('securityAgent.repositories.noRepositories')}
              description={t('securityAgent.repositories.noRepositoriesDescription')}
              iconContainerClassName="h-14 w-14 items-center justify-center rounded-2xl border border-border bg-card dark:border-input dark:bg-secondary"
              action={
                <StateAction
                  label={t('securityAgent.repositories.manageAccess')}
                  icon={ExternalLink}
                  onPress={() => {
                    void manageAccess();
                  }}
                />
              }
            />
          ) : null}
        </Section>
      )}
    </View>
  );

  const listFooter: ReactNode =
    showRepositoryStates &&
    !repositories.isLoading &&
    !repositories.isError &&
    hasRepositories &&
    selectedIds.length === 0 ? (
      <Text className="px-4 pt-3 text-xs text-destructive">
        {t('securityAgent.repositories.selectAtLeastOne')}
      </Text>
    ) : null;

  // The ScrollView cannot hold a virtualized list, so the picker's rows live in
  // this FlashList and stop mounting every repository in one commit. Its data
  // is empty outside selected mode (or while loading / errored), leaving only
  // the header's states visible.
  const listData =
    showRepositoryStates && !repositories.isLoading && !repositories.isError
      ? (repositories.data ?? [])
      : [];

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('common.repositories')}
        onBack={onBack}
        headerRight={
          canManage ? (
            <SettingsSaveButton
              dirty={dirty}
              valid={valid}
              pending={save.isPending}
              onSave={handleSave}
              skipNextGuardRef={skipNextGuardRef}
            />
          ) : undefined
        }
      />
      {feedback.node}
      <FlashList
        style={listStyle}
        data={listData}
        renderItem={renderItem}
        keyExtractor={repo => String(repo.id)}
        getItemType={() => 'repo'}
        contentContainerStyle={listContentContainerStyle}
        ListHeaderComponent={listHeader}
        ListFooterComponent={listFooter}
      />
      {dialog}
    </View>
  );
}
