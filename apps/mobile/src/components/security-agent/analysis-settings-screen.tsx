import {
  getSettingsDirtyState,
  isPersonalSecurityScope,
} from '@kilocode/app-shared/security-agent';
import { Brain, Search, Wrench } from '@/components/ui/icons';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SettingsSaveButton } from '@/components/security-agent/settings-save-button';
import { useSettingsSaveFeedback } from '@/components/security-agent/settings-save-feedback';
import { openModelPicker } from '@/components/agents/model-selector';
import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { ScreenHeader } from '@/components/screen-header';
import { QueryError } from '@/components/query-error';
import { ConfigureRow } from '@/components/ui/configure-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { modelLabelFromCatalogue } from '@/lib/auto-model-name';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
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
 * The loaded screen's frames, so the placeholder reserves the same shape the
 * content replaces: the `Section` label above the segmented control's own
 * `p-1` frame around a 48pt segment, and a `RowGroup` of `RowSkeleton` rows at
 * the `ConfigureRow` geometry the model rows paint.
 */
const SEGMENTED_FRAME_CLASS = 'rounded-lg bg-secondary p-1';
const SEGMENTED_SEGMENT_CLASS = 'h-[48px] w-full rounded-md';
const ROW_COUNT = 3;

function AnalysisSettingsSkeleton() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('securityAgent.analysisSettings.title')} />
      {/* A plain body rather than the loaded scroll view: the settings screens
          guard that no body frame paints before the draft hydrates, and the
          skeleton's own frames stay out of that check. */}
      <View className={cn('flex-1', SCREEN_BODY_CLASS)}>
        <Section label={t('securityAgent.analysisSettings.depth')}>
          <View className={SEGMENTED_FRAME_CLASS}>
            <Skeleton className={SEGMENTED_SEGMENT_CLASS} />
          </View>
        </Section>
        <RowGroup>
          {Array.from({ length: ROW_COUNT }, (_, index) => (
            <RowSkeleton key={index} />
          ))}
        </RowGroup>
      </View>
    </View>
  );
}

export function AnalysisSettingsScreen({ scope }: Readonly<{ scope: string }>) {
  const pushOnce = useSinglePushRoute();
  const { t } = useTranslation();
  const canManage = useSecurityAgentCapability(scope).canManage;
  const config = useSecurityAgentConfig(scope);
  const save = useSaveSecurityAgentConfig(scope, { announceFailed: false });
  const feedback = useSettingsSaveFeedback();
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
          openModelPicker(pushOnce, {
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
      {feedback.node}
      <TabScreenScrollView className="flex-1" contentContainerClassName={SCREEN_BODY_CLASS}>
        {!canManage && (
          <Text className="text-center text-xs text-muted-foreground">
            {t('securityAgent.sla.permissionNote')}
          </Text>
        )}
        <Section label={t('securityAgent.analysisSettings.depth')}>
          <SegmentedControl
            accessibilityLabel={t('securityAgent.analysisSettings.depth')}
            options={ANALYSIS_MODES.map(option => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
            value={analysisMode}
            disabled={!canManage}
            onChange={setAnalysisMode}
          />
        </Section>

        {modelsLoading && (
          <RowGroup>
            {Array.from({ length: ROW_COUNT }, (_, index) => (
              <RowSkeleton key={index} />
            ))}
          </RowGroup>
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
          <RowGroup leadingTile>
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
              disabled={!canManage}
              onPress={modelRowOnPress(remediationModelSlug, setRemediationModelSlug)}
            />
          </RowGroup>
        )}
      </TabScreenScrollView>
      {dialog}
    </View>
  );
}
