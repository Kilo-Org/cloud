import {
  getSettingsDirtyState,
  isPersonalSecurityScope,
} from '@kilocode/app-shared/security-agent';
import { useRouter } from 'expo-router';
import { Brain, Search, Wrench } from '@/components/ui/icons';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SettingsSaveButton } from '@/components/security-agent/settings-save-button';
import { openModelPicker } from '@/components/agents/model-selector';
import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { ScreenHeader } from '@/components/screen-header';
import { QueryError } from '@/components/query-error';
import { ConfigureRow } from '@/components/ui/configure-row';
import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { modelLabelFromCatalogue } from '@/lib/auto-model-name';
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
import { type FlattenedSecurityAgentConfig, type SecurityAgentConfig } from '@/lib/security-agent';
import { cn } from '@/lib/utils';

type AnalysisMode = SecurityAgentConfig['analysisMode'];

const ANALYSIS_MODES = [
  { value: 'auto', labelKey: 'securityAgent.analysisMode.auto' },
  { value: 'shallow', labelKey: 'securityAgent.analysisMode.shallow' },
  { value: 'deep', labelKey: 'securityAgent.analysisMode.deep' },
] as const satisfies readonly { value: AnalysisMode; labelKey: string }[];

/**
 * The loaded screen's line boxes at the app's 14pt rem, so the placeholder
 * reserves the same frames the content replaces: the `small` depth label
 * (`text-sm leading-none`, one 12.25pt line), the segmented control (the
 * group's `p-1` around a 48pt pill, which is how the group measures itself),
 * and a `ConfigureRow` (a 30pt icon tile beside a 17.5pt title over a 14pt
 * subtitle behind `mt-0.5`, in `py-3`, with the group's hairline divider under
 * every row but the last). A bare stack of hand-sized bars made the screen
 * redraw in a different shape when the config arrived.
 */
const LABEL_LINE_CLASS = 'h-[12.25px] justify-center';
const SEGMENTED_FRAME_CLASS = 'rounded-full p-1';
const ROW_FRAME_CLASS = 'flex-row items-center gap-3 py-3';
const ROW_DIVIDER_CLASS = 'border-b-[0.5px] border-hair-soft';
const ROW_ICON_CLASS = 'h-[30px] w-[30px] rounded-lg';
const ROW_TITLE_LINE_CLASS = 'h-[17.5px] justify-center';
const ROW_SUBTITLE_LINE_CLASS = 'mt-0.5 h-[14px] justify-center';
const ROW_COUNT = 3;

function AnalysisSettingsSkeleton() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader className="px-6" title={t('securityAgent.analysisSettings.title')} />
      {/* A plain body rather than the loaded scroll view: the settings screens
          guard that no body frame paints before the draft hydrates, and the
          skeleton's own frames stay out of that check. */}
      <View className="flex-1 gap-6 px-6 pt-4">
        <View className="gap-2">
          <View className={LABEL_LINE_CLASS}>
            <Skeleton className="h-2.5 w-24 rounded-full" />
          </View>
          <View className={SEGMENTED_FRAME_CLASS}>
            <Skeleton className="h-[48px] w-full rounded-full" />
          </View>
        </View>
        <View>
          {Array.from({ length: ROW_COUNT }, (_, index) => (
            <View
              key={index}
              className={cn(ROW_FRAME_CLASS, index < ROW_COUNT - 1 && ROW_DIVIDER_CLASS)}
            >
              <Skeleton className={ROW_ICON_CLASS} />
              <View className="flex-1">
                <View className={ROW_TITLE_LINE_CLASS}>
                  <Skeleton className="h-3.5 w-2/3 rounded-full" />
                </View>
                <View className={ROW_SUBTITLE_LINE_CLASS}>
                  <Skeleton className="h-2.5 w-1/3 rounded-full" />
                </View>
              </View>
              <Skeleton className="h-3.5 w-3.5 rounded-full" />
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

export function AnalysisSettingsScreen({ scope }: Readonly<{ scope: string }>) {
  const router = useRouter();
  const { t } = useTranslation();
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
    setTriageModelSlug(config.data.triageModelSlug);
    setAnalysisModelSlug(config.data.analysisModelSlug);
    setRemediationModelSlug(config.data.remediationModelSlug);
    setAnalysisMode(config.data.analysisMode);
  }, [baseline, config.data]);

  // Every field here is a model slug or a fixed enum option — there is no
  // invalid combination once hydrated, unlike the repository or SLA screens.
  const valid = true;
  const patch = {
    triageModelSlug,
    analysisModelSlug,
    remediationModelSlug,
    analysisMode,
  };
  const dirty = baseline !== null && getSettingsDirtyState(baseline, patch, valid) !== 'clean';
  useSecurityAgentSettingsRedirect(scope, config.data?.isEnabled, { dirty });

  const handleSave = async () => {
    await save.mutateAsync(patch);
    setBaseline(previous => ({ ...previous, ...patch }));
  };

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

  if (config.isError && !config.data) {
    return (
      <PlatformErrorScreen
        title={t('securityAgent.analysisSettings.title')}
        variant="offline"
        message={t('securityAgent.analysisSettings.couldNotLoad')}
        onRetry={() => void config.refetch()}
      />
    );
  }
  if (config.isLoading || !config.data) {
    return <AnalysisSettingsSkeleton />;
  }
  if (!config.data.isEnabled && !dirty) {
    // Keep a dirty draft and its controls usable if the redirect is cancelled.
    return <>{dialog}</>;
  }
  // The draft hydrates from the config in an effect; painting the body first
  // would show the default mode and empty model rows before the config's.
  if (baseline === null) {
    return <AnalysisSettingsSkeleton />;
  }

  const modelName = (slug: string) => modelLabelFromCatalogue(models, slug);
  // A failed catalogue refetch keeps the last list. Hide the rows only when the
  // failure left nothing to show, so an offline visit with a warm catalogue keeps
  // the current slugs readable and pickable, as the new-session picker does.
  const modelsUnavailable = modelsError && models.length === 0;
  const modelRowOnPress = (value: string, onSelect: (modelSlug: string) => void) =>
    canManage && !modelsLoading && models.length > 0
      ? () => {
          // The Security Agent config stores a model slug and nothing else, so
          // the picker must not offer a thinking effort it would have to drop.
          openModelPicker(router, {
            options: models,
            value,
            variant: '',
            acceptsVariant: false,
            onSelect,
          });
        }
      : undefined;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        className="px-6"
        title={t('securityAgent.analysisSettings.title')}
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
      <TabScreenScrollView className="flex-1" contentContainerClassName="px-6 gap-6 pt-4">
        {!canManage && (
          <Text className="text-center text-xs text-muted-foreground">
            {t('securityAgent.sla.permissionNote')}
          </Text>
        )}
        <View className="gap-2">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('securityAgent.analysisSettings.depth')}
          </Text>
          <RadioGroup
            label={t('securityAgent.analysisSettings.depth')}
            className="flex-row gap-2 rounded-full bg-secondary p-1"
          >
            {ANALYSIS_MODES.map(option => {
              const active = analysisMode === option.value;
              const label = t(option.labelKey);
              return (
                <Pressable
                  key={option.value}
                  disabled={!canManage}
                  className={cn(
                    // The pill's own node has to carry the floor: its
                    // `py-2` frame alone renders under the design target.
                    // `justify-center` keeps the one-line label centred in the
                    // taller box; a column default would leave it at the top.
                    ROW_TARGET_CLASS,
                    'flex-1 items-center justify-center rounded-full py-2 active:opacity-70',
                    active && 'bg-foreground',
                    !canManage && 'opacity-50'
                  )}
                  onPress={() => {
                    setAnalysisMode(option.value);
                  }}
                  {...radioItemA11y({ label, checked: active, disabled: !canManage })}
                >
                  <Text
                    className={cn(
                      'text-sm font-medium',
                      active ? 'text-background' : 'text-foreground'
                    )}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </RadioGroup>
        </View>

        {modelsLoading && (
          <View className="gap-3">
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
          </View>
        )}
        {modelsUnavailable && (
          <QueryError
            variant="server"
            placement="top"
            title={t('common.couldNotLoadModels')}
            onRetry={() => void refetchModels()}
            isRetrying={modelsLoading}
          />
        )}
        {!modelsLoading && !modelsUnavailable && (
          <View>
            <ConfigureRow
              icon={Search}
              title={t('securityAgent.analysisSettings.triageModel')}
              subtitle={modelName(triageModelSlug)}
              disabled={!canManage}
              onPress={modelRowOnPress(triageModelSlug, setTriageModelSlug)}
            />
            <ConfigureRow
              icon={Brain}
              title={t('securityAgent.analysisSettings.analysisModel')}
              subtitle={modelName(analysisModelSlug)}
              disabled={!canManage}
              onPress={modelRowOnPress(analysisModelSlug, setAnalysisModelSlug)}
            />
            <ConfigureRow
              icon={Wrench}
              title={t('securityAgent.analysisSettings.remediationModel')}
              subtitle={modelName(remediationModelSlug)}
              last
              disabled={!canManage}
              onPress={modelRowOnPress(remediationModelSlug, setRemediationModelSlug)}
            />
          </View>
        )}
      </TabScreenScrollView>
      {dialog}
    </View>
  );
}
