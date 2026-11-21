import {
  getSettingsDirtyState,
  isPersonalSecurityScope,
} from '@kilocode/app-shared/security-agent';
import { Brain, Search, Wrench } from '@/components/ui/icons';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SettingsRecoveryStatus } from '@/components/security-agent/settings-recovery-status';
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
import { SEGMENTED_FRAME_HEIGHT_CLASS, SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { modelLabelFromCatalogue } from '@/lib/auto-model-name';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { classifyListBody } from '@/lib/query/list-body-state';
import {
  classifyReadFailureVariant,
  isReadPausedBeforeData,
} from '@/lib/query/read-failure-variant';
import {
  useSecurityAgentSettingsRedirect,
  useSettingsBackGuard,
} from '@/lib/hooks/use-settings-back-guard';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import {
  useRetrySecurityAgentConfig,
  useRetrySecurityAgentSettings,
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
 * content replaces: the `Section` label above the segmented control, and a
 * `RowGroup` of `RowSkeleton` rows at the `ConfigureRow` geometry the model
 * rows paint.
 */
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
          <Skeleton className={cn('w-full', SEGMENTED_FRAME_HEIGHT_CLASS, 'rounded-lg')} />
        </Section>
        <RowGroup leadingTile>
          {Array.from({ length: ROW_COUNT }, (_, index) => (
            <RowSkeleton key={index} tile subtitle />
          ))}
        </RowGroup>
      </View>
    </View>
  );
}

export function AnalysisSettingsScreen({ scope }: Readonly<{ scope: string }>) {
  const pushOnce = useSinglePushRoute();
  const { t } = useTranslation();
  const capability = useSecurityAgentCapability(scope);
  // Only a settled denial disables the controls: a failed or still-unanswered role
  // read is not evidence that the viewer cannot manage the settings.
  const readOnly = capability.status === 'denied';
  const settingsRecovery = useRetrySecurityAgentSettings(scope);
  const config = useSecurityAgentConfig(scope);
  const pausedRetry = useRetrySecurityAgentConfig(scope);
  const save = useSaveSecurityAgentConfig(scope, { announceFailed: false });
  const feedback = useSettingsSaveFeedback();
  const {
    models,
    isError: modelsUnavailableFlag,
    error: modelsError,
    isLoading: modelsLoading,
    isFetched: modelsFetched,
    isFetching: modelsFetching,
    hasDeliveredData: modelsDelivered,
    fetchStatus: modelsFetchStatus,
    refetch: refetchModels,
  } = useAvailableModels(isPersonalSecurityScope(scope) ? undefined : scope);
  const connectivity = useCommittedConnectivityStatus();
  const capabilityPaused = isReadPausedBeforeData({
    ...capability,
    connectivity,
  });

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
    // The error title names what failed and the classified variant supplies the
    // cause and next step; naming the failed action in both said neither.
    return (
      <PlatformErrorScreen
        title={t('securityAgent.analysisSettings.title')}
        errorTitle={t('securityAgent.analysisSettings.couldNotLoad')}
        variant={classifyReadFailureVariant({
          errors: [config.error],
          isPaused: config.fetchStatus === 'paused',
          connectivity,
        })}
        onRetry={() => void config.refetch()}
      />
    );
  }
  // A first read the online manager paused (the app's connectivity is known,
  // offline or online) can never finish: the loading gate would hold the
  // skeleton until connectivity returns. Name the connection and offer Retry.
  if (isReadPausedBeforeData({ ...config, connectivity })) {
    return (
      <PlatformErrorScreen
        title={t('securityAgent.analysisSettings.title')}
        errorTitle={t('securityAgent.analysisSettings.couldNotLoad')}
        variant="offline"
        onRetry={() => {
          void pausedRetry.retry();
        }}
        isRetrying={pausedRetry.isRetrying}
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
  // A failed catalogue refetch keeps the last list: the classifier answers
  // `rows` whenever the catalogue delivered any, so an offline visit with a warm
  // list keeps the current slugs readable and pickable, as the new-session
  // picker does. Only a failure with nothing delivered names its cause and Retry.
  //
  // v5 downgrades a no-data refetch back to `pending` and clears `error`, so the
  // failure has to survive the Retry's own request: `isError || (isLoading &&
  // isFetched)` is the idiom `tool-summary-translation-settings-screen.tsx` uses,
  // and `hasDeliveredData` must be the delivered list, not `isFetched` (true
  // after a failed read too).
  const modelsBody = classifyListBody({
    rowCount: models.length,
    hasDeliveredData: modelsDelivered,
    isError: modelsUnavailableFlag || (modelsLoading && modelsFetched),
    isFetching: modelsFetching,
    fetchStatus: modelsFetchStatus,
    connectivityKnown: connectivity !== 'unknown',
  });
  const modelsPickable = modelsBody.status === 'rows';
  const modelRowOnPress = (value: string, onSelect: (modelSlug: string) => void) =>
    !readOnly && models.length > 0
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
          readOnly ? undefined : (
            <SettingsSaveButton
              dirty={dirty}
              valid={valid}
              pending={save.isPending}
              onSave={handleSave}
              skipNextGuardRef={skipNextGuardRef}
            />
          )
        }
      />
      {feedback.node}
      <TabScreenScrollView className="flex-1" contentContainerClassName={SCREEN_BODY_CLASS}>
        {capability.status === 'error' || capabilityPaused ? (
          <SettingsRecoveryStatus
            message={t('securityAgent.settingsOverview.couldNotLoadPermissions')}
            isRetrying={settingsRecovery.isRetrying}
            onRetry={() => {
              void settingsRecovery.retry();
            }}
          />
        ) : null}
        {readOnly && (
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
            disabled={readOnly}
            onChange={setAnalysisMode}
          />
        </Section>

        {modelsBody.status === 'loading' && (
          <RowGroup leadingTile>
            {Array.from({ length: ROW_COUNT }, (_, index) => (
              <RowSkeleton key={index} tile subtitle />
            ))}
          </RowGroup>
        )}
        {modelsBody.status === 'error' && (
          <QueryError
            variant={classifyReadFailureVariant({
              errors: modelsError ? [modelsError] : [],
              isPaused: modelsFetchStatus === 'paused',
              connectivity,
            })}
            placement="top"
            title={t('common.couldNotLoadModels')}
            onRetry={() => void refetchModels()}
            isRetrying={modelsBody.isRetrying}
          />
        )}
        {modelsBody.status === 'empty' && (
          // A delivered empty catalogue is not a failure, so the rows stay under
          // their notice and stay disabled: there is nothing to pick from.
          <Text className="text-center text-xs text-muted-foreground">
            {t('common.noModelsAvailable')}
          </Text>
        )}
        {(modelsPickable || modelsBody.status === 'empty') && (
          <RowGroup leadingTile>
            <ConfigureRow
              icon={Search}
              title={t('securityAgent.analysisSettings.triageModel')}
              subtitle={modelName(triageModelSlug)}
              disabled={readOnly || !modelsPickable}
              onPress={modelRowOnPress(triageModelSlug, setTriageModelSlug)}
            />
            <ConfigureRow
              icon={Brain}
              title={t('securityAgent.analysisSettings.analysisModel')}
              subtitle={modelName(analysisModelSlug)}
              disabled={readOnly || !modelsPickable}
              onPress={modelRowOnPress(analysisModelSlug, setAnalysisModelSlug)}
            />
            <ConfigureRow
              icon={Wrench}
              title={t('securityAgent.analysisSettings.remediationModel')}
              subtitle={modelName(remediationModelSlug)}
              disabled={readOnly || !modelsPickable}
              onPress={modelRowOnPress(remediationModelSlug, setRemediationModelSlug)}
            />
          </RowGroup>
        )}
      </TabScreenScrollView>
      {dialog}
    </View>
  );
}
