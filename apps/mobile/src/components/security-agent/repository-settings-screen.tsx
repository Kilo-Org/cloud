import {
  getSettingsDirtyState,
  isPersonalSecurityScope,
} from '@kilocode/app-shared/security-agent';
import { FolderGit2 } from '@/components/ui/icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { SettingsSaveButton } from '@/components/security-agent/settings-save-button';
import { EmptyState } from '@/components/empty-state';
import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { RepoToggleRow } from '@/components/repo-toggle-row';
import { ScreenHeader } from '@/components/screen-header';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { ChoiceRow } from '@/components/ui/choice-row';
import { RadioGroup } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
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
  useSecurityAgentPermissionStatus,
  useSecurityAgentRepositories,
} from '@/lib/hooks/use-security-agent';
import { type FlattenedSecurityAgentConfig, type SecurityAgentConfig } from '@/lib/security-agent';
import {
  installationStatusLabel,
  RepositorySettingsSkeleton,
  toggleRepositorySelection,
} from './repository-settings-support';

type RepositorySelectionMode = SecurityAgentConfig['repositorySelectionMode'];
type SelectedRepository = SecurityAgentConfig['selectedRepositories'][number];
export function RepositorySettingsScreen({ scope }: Readonly<{ scope: string }>) {
  const { t } = useTranslation();
  const canManage = useSecurityAgentCapability(scope).canManage;
  const config = useSecurityAgentConfig(scope);
  const repositories = useSecurityAgentRepositories(scope);
  const permission = useSecurityAgentPermissionStatus(scope);
  const save = useSaveSecurityAgentConfig(scope);

  const [mode, setMode] = useState<RepositorySelectionMode>('all');
  const [selectedRepositories, setSelectedRepositories] = useState<SelectedRepository[]>([]);
  const hydratedRef = useRef(false);
  const initialConfigRef = useRef<Partial<FlattenedSecurityAgentConfig>>({});

  useEffect(() => {
    if (hydratedRef.current || !config.data || !repositories.data) {
      return;
    }
    hydratedRef.current = true;
    initialConfigRef.current = config.data;
    setMode(config.data.repositorySelectionMode);
    setSelectedRepositories(
      config.data.selectedRepositories.length > 0
        ? config.data.selectedRepositories
        : repositories.data
            .filter(repository => config.data.selectedRepositoryIds.includes(repository.id))
            .map(repository => ({
              repositoryId: repository.id,
              platformIntegrationId: repository.integrationId,
            }))
    );
  }, [config.data, repositories.data]);

  useSecurityAgentSettingsRedirect(scope, config.data?.isEnabled, true);

  const selectedRepositoryIds = [
    ...new Set(selectedRepositories.map(selection => selection.repositoryId)),
  ];
  const valid = mode === 'all' || selectedRepositories.length > 0;
  const patch = { repositorySelectionMode: mode, selectedRepositoryIds, selectedRepositories };
  const dirty =
    hydratedRef.current &&
    getSettingsDirtyState(initialConfigRef.current, patch, valid) !== 'clean';

  const handleSave = async () => {
    await save.mutateAsync(patch);
    initialConfigRef.current = { ...initialConfigRef.current, ...patch };
  };

  const { onBack, skipNextGuardRef } = useSettingsBackGuard({ dirty, valid, onSave: handleSave });

  if (config.isError && !config.data) {
    return (
      <PlatformErrorScreen
        title={t('securityAgent.repositories.title')}
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

  const toggleRepo = (repositoryId: number, platformIntegrationId: string) => {
    setSelectedRepositories(current =>
      toggleRepositorySelection(current, repositoryId, platformIntegrationId)
    );
  };
  const repositoryGroups = new Map<
    string,
    { accountLogin: string | null; repositories: NonNullable<typeof repositories.data> }
  >();
  for (const repository of repositories.data ?? []) {
    const group = repositoryGroups.get(repository.integrationId);
    if (group) {
      group.repositories.push(repository);
    } else {
      repositoryGroups.set(repository.integrationId, {
        accountLogin: repository.accountLogin,
        repositories: [repository],
      });
    }
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('securityAgent.repositories.title')}
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
      <TabScreenScrollView className="flex-1" contentContainerClassName="px-6 pt-4">
        {!canManage && (
          <Text className="pb-4 text-center text-xs text-muted-foreground">
            {t('securityAgent.repositories.readOnly')}
          </Text>
        )}
        <RadioGroup label={t('securityAgent.repositories.title')}>
          {(['all', 'selected'] as const).map(option => (
            <ChoiceRow
              key={option}
              label={
                option === 'all'
                  ? t('securityAgent.repositories.allRepositories')
                  : t('securityAgent.repositories.selectedRepositories')
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

        {(permission.data?.installations.length ?? 0) > 0 ? (
          <View className="mt-6 rounded-lg bg-secondary px-3">
            {permission.data?.installations.map((installation, index, installations) => (
              <View
                key={installation.integrationId}
                className={`min-h-14 flex-row items-center justify-between gap-3 py-3 ${
                  index < installations.length - 1 ? 'border-b-[0.5px] border-hair-soft' : ''
                }`}
              >
                <View className="min-w-0 flex-1">
                  <Text className="text-sm font-medium" numberOfLines={1}>
                    {installation.accountLogin ?? installation.integrationId}
                  </Text>
                  <Text variant="muted" className="text-xs">
                    {installationStatusLabel(installation)}
                  </Text>
                </View>
                {installation.reauthorizeUrl ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onPress={() => {
                      const reauthorizeUrl = installation.reauthorizeUrl;
                      if (!reauthorizeUrl) {
                        return;
                      }
                      void openExternalUrl(reauthorizeUrl, {
                        label: t('securityAgent.scopeEntry.reauthorizeButton'),
                      });
                    }}
                  >
                    <Text>{t('securityAgent.scopeEntry.reauthorizeButton')}</Text>
                  </Button>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {mode === 'selected' && (
          <View className="mt-6">
            <Text variant="small" className="mb-1 uppercase tracking-wide text-muted-foreground">
              {t('securityAgent.repositories.title')}
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
                title={t('securityAgent.repositories.couldNotLoadRepositories')}
                onRetry={() => void repositories.refetch()}
                isRetrying={repositories.isFetching}
              />
            )}
            {!repositories.isLoading && !repositories.isError && repositories.data?.length === 0 ? (
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
                          await openExternalUrl(
                            getGitHubIntegrationUrl(WEB_BASE_URL, orgId, token),
                            {
                              label: t('securityAgent.repositories.githubAppSettings'),
                            }
                          );
                        } catch {
                          toast.error(t('securityAgent.repositories.couldNotOpenGithubSettings'));
                        }
                      })();
                    }}
                  >
                    <Text>{t('securityAgent.repositories.manageAccess')}</Text>
                  </Button>
                }
              />
            ) : null}
            {!repositories.isLoading &&
              !repositories.isError &&
              [...repositoryGroups.entries()].map(([integrationId, group]) => (
                <View key={integrationId} className="mb-4">
                  <Text className="min-h-11 py-3 text-sm font-medium" numberOfLines={1}>
                    {group.accountLogin ?? integrationId}
                  </Text>
                  {group.repositories.map(repo => (
                    <RepoToggleRow
                      key={`${integrationId}:${repo.id}`}
                      repo={repo}
                      selected={selectedRepositories.some(
                        selection =>
                          selection.repositoryId === repo.id &&
                          selection.platformIntegrationId === integrationId
                      )}
                      disabled={!canManage}
                      className="border-b-[0.5px] border-hair-soft"
                      onPress={() => {
                        toggleRepo(repo.id, integrationId);
                      }}
                    />
                  ))}
                </View>
              ))}
            {!repositories.isLoading &&
              !repositories.isError &&
              (repositories.data?.length ?? 0) > 0 &&
              selectedRepositories.length === 0 && (
                <Text className="pt-2 text-xs text-destructive">
                  {t('securityAgent.repositories.selectAtLeastOne')}
                </Text>
              )}
          </View>
        )}
      </TabScreenScrollView>
    </View>
  );
}
