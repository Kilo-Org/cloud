import { getSettingsDirtyState } from '@kilocode/app-shared/security-agent';
import * as Haptics from 'expo-haptics';
import { Check, Lock } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { SettingsSaveButton } from '@/components/security-agent/settings-save-button';
import { ScreenHeader } from '@/components/screen-header';
import { QueryError } from '@/components/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  useSecurityAgentSettingsRedirect,
  useSettingsBackGuard,
} from '@/lib/hooks/use-settings-back-guard';
import {
  useSaveSecurityAgentConfig,
  useSecurityAgentConfig,
  useSecurityAgentEditCapability,
  useSecurityAgentRepositories,
} from '@/lib/hooks/use-security-agent';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
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
  const colors = useThemeColors();
  const canManage = useSecurityAgentEditCapability(scope);
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
  const dirty =
    hydratedRef.current &&
    getSettingsDirtyState(
      initialConfigRef.current,
      { repositorySelectionMode: mode, selectedRepositoryIds: selectedIds },
      valid
    ) !== 'clean';

  const handleSave = async () => {
    await save.mutateAsync({ repositorySelectionMode: mode, selectedRepositoryIds: selectedIds });
  };

  const { onBack } = useSettingsBackGuard({ dirty, valid, onSave: handleSave });

  if (config.isError && !config.data) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Repositories" />
        <QueryError
          className="flex-1"
          message="Could not load repository settings"
          onRetry={() => void config.refetch()}
        />
      </View>
    );
  }
  if (config.isLoading || !config.data) {
    return <RepositorySettingsSkeleton />;
  }
  if (!config.data.isEnabled) {
    return null;
  }

  const setModeOption = (option: RepositorySelectionMode) => {
    void Haptics.selectionAsync();
    setMode(option);
  };

  const toggleRepo = (id: number) => {
    void Haptics.selectionAsync();
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
            />
          ) : undefined
        }
      />
      <ScrollView className="flex-1 px-6" contentContainerClassName="pt-4 pb-24">
        {(['all', 'selected'] as const).map(option => (
          <Pressable
            key={option}
            disabled={!canManage}
            className="flex-row items-center justify-between border-b-[0.5px] border-hair-soft py-3 active:opacity-70"
            onPress={() => {
              setModeOption(option);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: mode === option }}
          >
            <Text className="text-sm font-medium">
              {option === 'all' ? 'All repositories' : 'Selected repositories'}
            </Text>
            <Check size={18} color={mode === option ? colors.foreground : 'transparent'} />
          </Pressable>
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
            {(repositories.data ?? []).map(repo => (
              <Pressable
                key={repo.id}
                disabled={!canManage}
                className="flex-row items-center justify-between border-b-[0.5px] border-hair-soft py-3 active:opacity-70"
                onPress={() => {
                  toggleRepo(repo.id);
                }}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selectedIds.includes(repo.id) }}
              >
                <View className="flex-1 flex-row items-center gap-2 pr-3">
                  {repo.private ? <Lock size={12} color={colors.mutedForeground} /> : null}
                  <Text className="text-sm" numberOfLines={1}>
                    {repo.fullName}
                  </Text>
                </View>
                <Check
                  size={18}
                  color={selectedIds.includes(repo.id) ? colors.foreground : 'transparent'}
                />
              </Pressable>
            ))}
            {selectedIds.length === 0 && (
              <Text className="pt-2 text-xs text-destructive">Select at least one repository.</Text>
            )}
          </View>
        )}

        {!canManage && (
          <Text className="pt-6 text-center text-xs text-muted-foreground">
            Only organization owners and billing managers can change these settings.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
