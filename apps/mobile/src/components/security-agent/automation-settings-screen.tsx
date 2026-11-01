import { getSettingsDirtyState } from '@kilocode/app-shared/security-agent';
import { useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { announcingToast } from '@/lib/a11y/announcing-toast';

import { PillGroup } from '@/components/security-agent/settings-pill-group';
import { SettingsSaveButton } from '@/components/security-agent/settings-save-button';
import { ToggleRow } from '@/components/security-agent/settings-toggle-row';
import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import {
  useSecurityAgentSettingsRedirect,
  useSettingsBackGuard,
} from '@/lib/hooks/use-settings-back-guard';
import {
  useSaveSecurityAgentConfig,
  useSecurityAgentCapability,
  useSecurityAgentConfig,
  useTrackSecurityAgentInteraction,
} from '@/lib/hooks/use-security-agent';
import { type FlattenedSecurityAgentConfig, type SecurityAgentConfig } from '@/lib/security-agent';

type MinSeverity = SecurityAgentConfig['autoAnalysisMinSeverity'];
type ConfidenceThreshold = SecurityAgentConfig['autoDismissConfidenceThreshold'];

// Labels mirror apps/web/src/components/security-agent/SecurityConfigSections.tsx
// so the mobile and web copy for these enums stay in sync.
const MIN_SEVERITY_OPTIONS = [
  { value: 'critical', labelKey: 'securityAgent.automation.severityCriticalOnly' },
  { value: 'high', labelKey: 'securityAgent.automation.severityHighAndAbove' },
  { value: 'medium', labelKey: 'securityAgent.automation.severityMediumAndAbove' },
  { value: 'all', labelKey: 'securityAgent.automation.severityAll' },
] as const satisfies readonly { value: MinSeverity; labelKey: string }[];

const CONFIDENCE_OPTIONS = [
  { value: 'high', labelKey: 'securityAgent.automation.confidenceHighOnly' },
  { value: 'medium', labelKey: 'securityAgent.automation.confidenceMediumOrHigher' },
  { value: 'low', labelKey: 'securityAgent.automation.confidenceAny' },
] as const satisfies readonly { value: ConfidenceThreshold; labelKey: string }[];

function AutomationSettingsSkeleton() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader className="px-6" title={t('securityAgent.automation.title')} />
      <View className="gap-3 px-6 pt-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </View>
    </View>
  );
}

export function AutomationSettingsScreen({ scope }: Readonly<{ scope: string }>) {
  const { t } = useTranslation();
  const minSeverityOptions = MIN_SEVERITY_OPTIONS.map(({ value, labelKey }) => ({
    value,
    label: t(labelKey),
  }));
  const confidenceOptions = CONFIDENCE_OPTIONS.map(({ value, labelKey }) => ({
    value,
    label: t(labelKey),
  }));
  const canManage = useSecurityAgentCapability(scope).canManage;
  const config = useSecurityAgentConfig(scope);
  // This screen announces the outcome itself: the queued count when the save
  // schedules existing findings, the generic confirmation otherwise.
  const save = useSaveSecurityAgentConfig(scope, { announceSaved: false });
  const trackInteraction = useTrackSecurityAgentInteraction(scope);

  const [autoAnalysisEnabled, setAutoAnalysisEnabled] = useState(false);
  const [autoAnalysisMinSeverity, setAutoAnalysisMinSeverity] = useState<MinSeverity>('all');
  const [autoAnalysisIncludeExisting, setAutoAnalysisIncludeExisting] = useState(false);
  const [autoRemediationEnabled, setAutoRemediationEnabled] = useState(false);
  const [autoRemediationMinSeverity, setAutoRemediationMinSeverity] = useState<MinSeverity>('all');
  const [autoRemediationIncludeExisting, setAutoRemediationIncludeExisting] = useState(false);
  const [autoRemediationRequireApproval, setAutoRemediationRequireApproval] = useState(true);
  const [autoDismissEnabled, setAutoDismissEnabled] = useState(false);
  const [autoDismissConfidenceThreshold, setAutoDismissConfidenceThreshold] =
    useState<ConfidenceThreshold>('high');
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
    setAutoAnalysisEnabled(config.data.autoAnalysisEnabled);
    setAutoAnalysisMinSeverity(config.data.autoAnalysisMinSeverity);
    setAutoAnalysisIncludeExisting(config.data.autoAnalysisIncludeExisting);
    setAutoRemediationEnabled(config.data.autoRemediationEnabled);
    setAutoRemediationMinSeverity(config.data.autoRemediationMinSeverity);
    setAutoRemediationIncludeExisting(config.data.autoRemediationIncludeExisting);
    setAutoRemediationRequireApproval(config.data.autoRemediationRequireApproval);
    setAutoDismissEnabled(config.data.autoDismissEnabled);
    setAutoDismissConfidenceThreshold(config.data.autoDismissConfidenceThreshold);
  }, [baseline, config.data]);

  // Ref indirection keeps the tracking effect independent of the mutation
  // object's identity (a new object every render) — fires once per mount,
  // mirroring finding-detail-screen.tsx's tracked-once pattern.
  const trackRef = useRef(trackInteraction.mutate);
  trackRef.current = trackInteraction.mutate;
  const trackedRef = useRef(false);
  useEffect(() => {
    if (trackedRef.current) {
      return;
    }
    trackedRef.current = true;
    trackRef.current({ interaction: 'settings_automation_viewed' });
  }, []);

  // Every field here is a boolean or a fixed enum option — there is no
  // invalid combination once hydrated, unlike the notification/SLA screens.
  const valid = true;
  const patch = {
    autoAnalysisEnabled,
    autoAnalysisMinSeverity,
    autoAnalysisIncludeExisting,
    autoRemediationEnabled,
    autoRemediationMinSeverity,
    autoRemediationIncludeExisting,
    autoRemediationRequireApproval,
    autoDismissEnabled,
    autoDismissConfidenceThreshold,
  };
  const dirty = baseline !== null && getSettingsDirtyState(baseline, patch, valid) !== 'clean';
  useSecurityAgentSettingsRedirect(scope, config.data?.isEnabled, { dirty });

  const handleSave = async () => {
    const result = await save.mutateAsync(patch);
    setBaseline(previous => ({ ...previous, ...patch }));
    const queuedCount = result.existingFindingsQueuedCount;
    announcingToast.success(
      queuedCount
        ? t('securityAgent.automation.queued', {
            count: queuedCount,
            displayCount: formatNumber(queuedCount, i18n.language),
          })
        : t('securityAgent.settingsSave.saved')
    );
  };

  // Enabling auto-remediation is destructive: it opens PRs without a human in
  // the loop, so confirm before committing (apps/mobile/AGENTS.md rule).
  const handleAutoRemediationToggle = (next: boolean) => {
    if (!next) {
      setAutoRemediationEnabled(false);
      return;
    }
    Alert.alert(
      t('securityAgent.automation.enableAutoRemediationConfirmTitle'),
      t('securityAgent.automation.enableAutoRemediationConfirmMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('securityAgent.automation.enable'),
          onPress: () => {
            setAutoRemediationEnabled(true);
          },
        },
      ]
    );
  };

  const { onBack, skipNextGuardRef, dialog } = useSettingsBackGuard({
    dirty,
    valid,
    onSave: handleSave,
  });

  if (config.isError && !config.data) {
    return (
      <PlatformErrorScreen
        title={t('securityAgent.automation.title')}
        variant="offline"
        message={t('securityAgent.automation.couldNotLoad')}
        onRetry={() => void config.refetch()}
      />
    );
  }
  if (config.isLoading || !config.data) {
    return <AutomationSettingsSkeleton />;
  }
  if (!config.data.isEnabled && !dirty) {
    // Keep a dirty draft and its controls usable if the redirect is cancelled.
    return <>{dialog}</>;
  }
  // The draft hydrates from the config in an effect; painting the body first
  // would show the default toggles and then push every control below them down
  // when their pickers appear.
  if (baseline === null) {
    return <AutomationSettingsSkeleton />;
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        className="px-6"
        title={t('securityAgent.automation.title')}
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
        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('securityAgent.automation.autoAnalysis')}
          </Text>
          <ToggleRow
            title={t('securityAgent.automation.enableAutoAnalysis')}
            subtitle={t('securityAgent.automation.enableAutoAnalysisSubtitle')}
            value={autoAnalysisEnabled}
            disabled={!canManage}
            onValueChange={setAutoAnalysisEnabled}
          />
          {autoAnalysisEnabled && (
            <>
              <PillGroup
                // A picker label is a header: it takes the section gap above
                // it (its own margin plus the section's `gap-3`), the same one
                // the section headers above get, so every label groups with
                // the list it names instead of the card before it.
                className="mt-3"
                label={t('securityAgent.automation.minimumSeverity')}
                options={minSeverityOptions}
                value={autoAnalysisMinSeverity}
                disabled={!canManage}
                onChange={setAutoAnalysisMinSeverity}
              />
              <ToggleRow
                title={t('securityAgent.automation.includeExistingFindings')}
                subtitle={t('securityAgent.automation.includeExistingFindingsAnalysisSubtitle')}
                value={autoAnalysisIncludeExisting}
                disabled={!canManage}
                onValueChange={setAutoAnalysisIncludeExisting}
              />
            </>
          )}
        </View>

        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('securityAgent.automation.autoRemediation')}
          </Text>
          <ToggleRow
            title={t('securityAgent.automation.enableAutoRemediation')}
            subtitle={t('securityAgent.automation.enableAutoRemediationSubtitle')}
            value={autoRemediationEnabled}
            disabled={!canManage}
            onValueChange={handleAutoRemediationToggle}
          />
          {autoRemediationEnabled && (
            <>
              <PillGroup
                className="mt-3"
                label={t('securityAgent.automation.minimumSeverity')}
                options={minSeverityOptions}
                value={autoRemediationMinSeverity}
                disabled={!canManage}
                onChange={setAutoRemediationMinSeverity}
              />
              <ToggleRow
                title={t('securityAgent.automation.includeExistingFindings')}
                subtitle={t('securityAgent.automation.includeExistingFindingsRemediationSubtitle')}
                value={autoRemediationIncludeExisting}
                disabled={!canManage}
                onValueChange={setAutoRemediationIncludeExisting}
              />
              <ToggleRow
                title={t('securityAgent.automation.requireApproval')}
                subtitle={t('securityAgent.automation.requireApprovalSubtitle')}
                value={autoRemediationRequireApproval}
                disabled={!canManage}
                onValueChange={setAutoRemediationRequireApproval}
              />
            </>
          )}
        </View>

        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('securityAgent.automation.autoDismiss')}
          </Text>
          <ToggleRow
            title={t('securityAgent.automation.enableAutoDismiss')}
            subtitle={t('securityAgent.automation.enableAutoDismissSubtitle')}
            value={autoDismissEnabled}
            disabled={!canManage}
            onValueChange={setAutoDismissEnabled}
          />
          {autoDismissEnabled && (
            <PillGroup
              className="mt-3"
              label={t('securityAgent.automation.confidenceThreshold')}
              options={confidenceOptions}
              value={autoDismissConfidenceThreshold}
              disabled={!canManage}
              onChange={setAutoDismissConfidenceThreshold}
            />
          )}
        </View>

        {!canManage && (
          <Text className="text-center text-xs text-muted-foreground">
            {t('securityAgent.sla.permissionNote')}
          </Text>
        )}
      </TabScreenScrollView>
      {dialog}
    </View>
  );
}
