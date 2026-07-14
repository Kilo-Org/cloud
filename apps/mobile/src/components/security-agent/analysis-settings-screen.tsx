import {
  getSettingsDirtyState,
  isPersonalSecurityScope,
} from '@kilocode/app-shared/security-agent';
import { useRouter } from 'expo-router';
import { Brain, Search, Wrench } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';

import { SettingsSaveButton } from '@/components/security-agent/settings-save-button';
import { openModelPicker } from '@/components/agents/model-selector';
import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { ScreenHeader } from '@/components/screen-header';
import { QueryError } from '@/components/query-error';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import {
  useSecurityAgentSettingsRedirect,
  useSettingsBackGuard,
} from '@/lib/hooks/use-settings-back-guard';
import {
  useSaveSecurityAgentConfig,
  useSecurityAgentCapability,
  useSecurityAgentConfig,
} from '@/lib/hooks/use-security-agent';
import { type SecurityAgentConfig } from '@/lib/security-agent';
import { cn } from '@/lib/utils';

type AnalysisMode = SecurityAgentConfig['analysisMode'];

const ANALYSIS_MODES: { value: AnalysisMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'shallow', label: 'Shallow' },
  { value: 'deep', label: 'Deep' },
];

function AnalysisSettingsSkeleton() {
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Models & analysis" />
      <View className="gap-3 px-6 pt-4">
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
      </View>
    </View>
  );
}

export function AnalysisSettingsScreen({ scope }: Readonly<{ scope: string }>) {
  const router = useRouter();
  const canManage = useSecurityAgentCapability(scope).canManage;
  const config = useSecurityAgentConfig(scope);
  const save = useSaveSecurityAgentConfig(scope);
  const {
    models,
    isLoading: modelsLoading,
    isError: modelsError,
    refetch: refetchModels,
  } = useAvailableModels(isPersonalSecurityScope(scope) ? undefined : scope);

  const [triageModelSlug, setTriageModelSlug] = useState('');
  const [analysisModelSlug, setAnalysisModelSlug] = useState('');
  const [remediationModelSlug, setRemediationModelSlug] = useState('');
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('auto');
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
    setTriageModelSlug(config.data.triageModelSlug);
    setAnalysisModelSlug(config.data.analysisModelSlug);
    setRemediationModelSlug(config.data.remediationModelSlug);
    setAnalysisMode(config.data.analysisMode);
  }, [config.data]);

  useSecurityAgentSettingsRedirect(scope, config.data?.isEnabled);

  // Every field here is a model slug or a fixed enum option — there is no
  // invalid combination once hydrated, unlike the repository or SLA screens.
  const valid = true;
  const patch = {
    triageModelSlug,
    analysisModelSlug,
    remediationModelSlug,
    analysisMode,
  };
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
        title="Models & analysis"
        variant="offline"
        message="Could not load analysis settings"
        onRetry={() => void config.refetch()}
      />
    );
  }
  if (config.isLoading || !config.data) {
    return <AnalysisSettingsSkeleton />;
  }
  if (!config.data.isEnabled) {
    return null;
  }

  const modelName = (slug: string) => models.find(model => model.id === slug)?.name ?? slug;
  const modelRowOnPress = (value: string, onSelect: (modelSlug: string) => void) =>
    canManage && !modelsLoading && models.length > 0
      ? () => {
          openModelPicker(router, { options: models, value, variant: '', onSelect });
        }
      : undefined;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Models & analysis"
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
      <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="gap-6 pt-4">
        {!canManage && (
          <Text className="text-center text-xs text-muted-foreground">
            Only organization owners and billing managers can change these settings.
          </Text>
        )}
        <View className="gap-2">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Analysis depth
          </Text>
          <View className="flex-row gap-2 rounded-full bg-secondary p-1">
            {ANALYSIS_MODES.map(option => {
              const active = analysisMode === option.value;
              return (
                <Pressable
                  key={option.value}
                  disabled={!canManage}
                  className={cn(
                    'flex-1 items-center rounded-full py-2 active:opacity-70',
                    active && 'bg-foreground',
                    !canManage && 'opacity-50'
                  )}
                  onPress={() => {
                    setAnalysisMode(option.value);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active, disabled: !canManage }}
                >
                  <Text
                    className={cn(
                      'text-sm font-medium',
                      active ? 'text-background' : 'text-foreground'
                    )}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {modelsLoading && (
          <View className="gap-3">
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
          </View>
        )}
        {modelsError && (
          <QueryError
            variant="server"
            placement="top"
            title="Could not load models"
            onRetry={() => void refetchModels()}
            isRetrying={modelsLoading}
          />
        )}
        {!modelsLoading && !modelsError && (
          <View>
            <ConfigureRow
              icon={Search}
              title="Triage model"
              subtitle={modelName(triageModelSlug)}
              disabled={!canManage}
              onPress={modelRowOnPress(triageModelSlug, setTriageModelSlug)}
            />
            <ConfigureRow
              icon={Brain}
              title="Analysis model"
              subtitle={modelName(analysisModelSlug)}
              disabled={!canManage}
              onPress={modelRowOnPress(analysisModelSlug, setAnalysisModelSlug)}
            />
            <ConfigureRow
              icon={Wrench}
              title="Remediation model"
              subtitle={modelName(remediationModelSlug)}
              last
              disabled={!canManage}
              onPress={modelRowOnPress(remediationModelSlug, setRemediationModelSlug)}
            />
          </View>
        )}
      </TabScreenScrollView>
    </View>
  );
}
