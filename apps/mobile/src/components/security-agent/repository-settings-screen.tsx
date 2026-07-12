import {
  getSettingsDirtyState,
  isPersonalSecurityScope,
} from '@kilocode/app-shared/security-agent';
import { FolderGit2 } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { SettingsSaveButton } from '@/components/security-agent/settings-save-button';
import { EmptyState } from '@/components/empty-state';
import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { RepoToggleRow } from '@/components/repo-toggle-row';
import { ScreenHeader } from '@/components/screen-header';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { WEB_BASE_URL } from '@/lib/config';
import { openExternalUrl } from '@/lib/external-link';
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
import { type SecurityAgentConfig } from '@/lib/security-agent';

type RepositorySelectionMode = SecurityAgentConfig['repositorySelectionMode'];

function RepositorySettingsSkeleton() {
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Repositories" />
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
  const canManage = useSecurityAgentCapability(scope).canManage;
  const config = useSecurityAgentConfig(scope);
  const repositories = useSecurityAgentRepositories(scope);
  const save = useSaveSecurityAgentConfig(scope);

  const [mode, setMode] = useState<RepositorySelectionMode>('all');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const hydratedRef = useRef(false);
  const initialConfigRef = useRef<Partial<SecurityAgentConfig>>({});

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

  useSecurityAgentSettingsRedirect(scope, config.data?.isEnabled);

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

  if (config.isError && !config.data) {
    return (
      <PlatformErrorScreen
        title="Repositories"
        variant="offline"
        message="Could not load repository settings"
        onRetry={() => void config.refetch()}
      />
    );
  }
  if (config.isLoading || !config.data) {
    return <RepositorySettingsSkeleton />;
  }
  if (!config.data.isEnabled) {
    return null;
  }

  const setModeOption = (option: RepositorySelectionMode) => {
    setMode(option);
  };

  const toggleRepo = (id: number) => {
    setSelectedIds(current =>
      current.includes(id) ? current.filter(existing => existing !== id) : [...current, id]
    );
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Repositories"
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
      <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="pt-4">
        {!canManage && (
          <Text className="pb-4 text-center text-xs text-muted-foreground">
            Only organization owners and billing managers can change these settings.
          </Text>
        )}
        {(['all', 'selected'] as const).map(option => (
          <ChoiceRow
            key={option}
            label={option === 'all' ? 'All repositories' : 'Selected repositories'}
            selected={mode === option}
            disabled={!canManage}
            className="border-b-[0.5px] border-hair-soft"
            onPress={() => {
              setModeOption(option);
            }}
          />
        ))}

        {mode === 'selected' && (
          <View className="mt-6">
            <Text variant="small" className="mb-1 uppercase tracking-wide text-muted-foreground">
              Repositories
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
                title="Could not load repositories"
                onRetry={() => void repositories.refetch()}
                isRetrying={repositories.isFetching}
              />
            )}
            {!repositories.isLoading && !repositories.isError && repositories.data?.length === 0 ? (
              <EmptyState
                placement="top"
                icon={FolderGit2}
                title="No repositories"
                description="Grant the Kilo GitHub App access to repositories"
                action={
                  <Button
                    variant="outline"
                    onPress={() => {
                      void openExternalUrl(
                        getGitHubIntegrationUrl(
                          WEB_BASE_URL,
                          isPersonalSecurityScope(scope) ? undefined : scope
                        ),
                        { label: 'GitHub App settings' }
                      );
                    }}
                  >
                    <Text>Manage GitHub App access</Text>
                  </Button>
                }
              />
            ) : null}
            {!repositories.isLoading &&
              !repositories.isError &&
              (repositories.data ?? []).map(repo => (
                <RepoToggleRow
                  key={repo.id}
                  repo={repo}
                  selected={selectedIds.includes(repo.id)}
                  disabled={!canManage}
                  className="border-b-[0.5px] border-hair-soft"
                  onPress={() => {
                    toggleRepo(repo.id);
                  }}
                />
              ))}
            {!repositories.isLoading &&
              !repositories.isError &&
              (repositories.data?.length ?? 0) > 0 &&
              selectedIds.length === 0 && (
                <Text className="pt-2 text-xs text-destructive">
                  Select at least one repository.
                </Text>
              )}
          </View>
        )}
      </TabScreenScrollView>
    </View>
  );
}
