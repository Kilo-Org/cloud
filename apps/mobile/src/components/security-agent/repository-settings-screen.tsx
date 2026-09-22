import {
  getSettingsDirtyState,
  isPersonalSecurityScope,
} from '@kilocode/app-shared/security-agent';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { FolderGit2 } from '@/components/ui/icons';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';
import { toast } from 'sonner-native';

import { SettingsSaveButton } from '@/components/security-agent/settings-save-button';
import { EmptyState } from '@/components/empty-state';
import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { RepoToggleRow } from '@/components/repo-toggle-row';
import { ScreenHeader } from '@/components/screen-header';
import { QueryError } from '@/components/query-error';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { ChoiceRow } from '@/components/ui/choice-row';
import { RadioGroup } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { WEB_BASE_URL } from '@/lib/config';
import { openExternalUrl } from '@/lib/external-link';
import { trpcClient } from '@/lib/trpc';
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

// FlashList takes `contentContainerStyle`, not className, so the ScrollView's
// `px-6 pt-4` content classes map to their pixel values. The tab-bar inset
// rides on the content (the ScrollView used a frame `marginBottom`) so the
// last row can still scroll clear of the bar.
const listStyle = { flex: 1 } satisfies ViewStyle;

function RepositorySettingsSkeleton() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.repositories')} />
      <View className="gap-3 px-6 pt-4">
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
      </View>
    </View>
  );
}

export function RepositorySettingsScreen({ scope }: Readonly<{ scope: string }>) {
  const { t } = useTranslation();
  const canManage = useSecurityAgentCapability(scope).canManage;
  const config = useSecurityAgentConfig(scope);
  const repositories = useSecurityAgentRepositories(scope);
  const save = useSaveSecurityAgentConfig(scope);

  const [mode, setMode] = useState<RepositorySelectionMode>('all');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const hydratedRef = useRef(false);
  const initialConfigRef = useRef<Partial<FlattenedSecurityAgentConfig>>({});

  // Local state initialized from the loaded config exactly once — later
  // config refetches (e.g. after this screen's own save) shouldn't clobber
  // in-progress edits.
  useEffect(() => {
    if (hydratedRef.current || !config.data) {
      return;
    }
    hydratedRef.current = true;
    initialConfigRef.current = config.data;
    setMode(config.data.repositorySelectionMode);
    setSelectedIds(config.data.selectedRepositoryIds);
  }, [config.data]);

  // The repositories screen stays reachable while the agent is disabled so a
  // user with integration repos but no effective selection can pick repos and
  // then enable (the overview's "Select repositories" CTA lands here). Opt out
  // of the disabled-state redirect; every other sub-screen keeps it.
  useSecurityAgentSettingsRedirect(scope, config.data?.isEnabled, true);

  const valid = mode === 'all' || selectedIds.length > 0;
  const patch = { repositorySelectionMode: mode, selectedRepositoryIds: selectedIds };
  const dirty =
    hydratedRef.current &&
    getSettingsDirtyState(initialConfigRef.current, patch, valid) !== 'clean';

  const handleSave = async () => {
    await save.mutateAsync(patch);
    initialConfigRef.current = { ...initialConfigRef.current, ...patch };
  };

  const { onBack, skipNextGuardRef } = useSettingsBackGuard({ dirty, valid, onSave: handleSave });

  // Selection is a Set for O(1) row lookups: the row renderer would otherwise
  // scan `selectedIds` once per repository per render (O(repos × selected)).
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const toggleRepo = useCallback((id: number) => {
    setSelectedIds(current =>
      current.includes(id) ? current.filter(existing => existing !== id) : [...current, id]
    );
  }, []);

  const paddingBottom = useTabBarBottomPadding();
  const listContentContainerStyle = useMemo(
    () => ({ paddingHorizontal: 24, paddingTop: 16, paddingBottom }),
    [paddingBottom]
  );

  // Hoisted so the FlashList keeps one renderer identity across toggles and
  // re-renders only the rows whose `selected` actually changed.
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<RepositoryRow>) => (
      <RepoToggleRow
        repo={item}
        selected={selectedIdSet.has(item.id)}
        disabled={!canManage}
        className="border-b-[0.5px] border-hair-soft"
        onPress={() => {
          toggleRepo(item.id);
        }}
      />
    ),
    [selectedIdSet, canManage, toggleRepo]
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

  const setModeOption = (option: RepositorySelectionMode) => {
    setMode(option);
  };

  const showRepositoryStates = mode === 'selected';
  const hasRepositories = (repositories.data?.length ?? 0) > 0;

  // Everything above the rows (permission note, mode choice, and — in selected
  // mode — the loading / error / empty branches) rides on the list header so
  // the rendered order and paddings are unchanged from the ScrollView version.
  const listHeader: ReactNode = (
    <>
      {!canManage && (
        <Text className="pb-4 text-center text-xs text-muted-foreground">
          {t('securityAgent.sla.permissionNote')}
        </Text>
      )}
      <RadioGroup label={t('common.repositories')}>
        {(['all', 'selected'] as const).map(option => (
          <ChoiceRow
            key={option}
            label={
              option === 'all' ? t('common.allRepositories') : t('common.selectedRepositories')
            }
            selected={mode === option}
            disabled={!canManage}
            className="border-b-[0.5px] border-hair-soft"
            onPress={() => {
              setModeOption(option);
            }}
          />
        ))}
      </RadioGroup>

      {showRepositoryStates && (
        <View className="mt-6">
          <Text variant="small" className="mb-1 uppercase tracking-wide text-muted-foreground">
            {t('common.repositories')}
          </Text>
          {repositories.isLoading && (
            <View className="gap-3 pt-2">
              <Skeleton className="h-12 w-full rounded-lg" />
              <Skeleton className="h-12 w-full rounded-lg" />
            </View>
          )}
          {repositories.isError && (
            <QueryError
              variant="server"
              placement="top"
              title={t('common.couldNotLoadRepositories')}
              onRetry={() => void repositories.refetch()}
              isRetrying={repositories.isFetching}
            />
          )}
          {!repositories.isLoading && !repositories.isError && !hasRepositories ? (
            <EmptyState
              placement="top"
              icon={FolderGit2}
              title={t('securityAgent.repositories.noRepositories')}
              description={t('securityAgent.repositories.noRepositoriesDescription')}
              action={
                <Button
                  variant="outline"
                  onPress={() => {
                    void (async () => {
                      const orgId = isPersonalSecurityScope(scope) ? undefined : scope;
                      try {
                        const { token } = await trpcClient.githubApps.mintInstallState.mutate({
                          organizationId: orgId ?? undefined,
                          returnTo: '/cloud/sessions',
                        });
                        await openExternalUrl(getGitHubIntegrationUrl(WEB_BASE_URL, orgId, token), {
                          label: t('securityAgent.repositories.githubAppSettings'),
                        });
                      } catch {
                        toast.error(t('prReview.couldNotOpenGitHubAppSettings'));
                      }
                    })();
                  }}
                >
                  <Text>{t('securityAgent.repositories.manageAccess')}</Text>
                </Button>
              }
            />
          ) : null}
        </View>
      )}
    </>
  );

  const listFooter: ReactNode =
    showRepositoryStates &&
    !repositories.isLoading &&
    !repositories.isError &&
    hasRepositories &&
    selectedIds.length === 0 ? (
      <Text className="pt-2 text-xs text-destructive">
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
    </View>
  );
}
