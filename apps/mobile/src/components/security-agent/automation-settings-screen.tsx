import { getSettingsDirtyState } from '@kilocode/app-shared/security-agent';
import { useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { PillGroup } from '@/components/security-agent/settings-pill-group';
import { SettingsSaveButton } from '@/components/security-agent/settings-save-button';
import { ToggleRow } from '@/components/security-agent/settings-toggle-row';
import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
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
      <ScreenHeader title={t('securityAgent.automation.title')} />
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
  const save = useSaveSecurityAgentConfig(scope);
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
    setAutoAnalysisEnabled(config.data.autoAnalysisEnabled);
    setAutoAnalysisMinSeverity(config.data.autoAnalysisMinSeverity);
    setAutoAnalysisIncludeExisting(config.data.autoAnalysisIncludeExisting);
    setAutoRemediationEnabled(config.data.autoRemediationEnabled);
    setAutoRemediationMinSeverity(config.data.autoRemediationMinSeverity);
    setAutoRemediationIncludeExisting(config.data.autoRemediationIncludeExisting);
    setAutoRemediationRequireApproval(config.data.autoRemediationRequireApproval);
    setAutoDismissEnabled(config.data.autoDismissEnabled);
    setAutoDismissConfidenceThreshold(config.data.autoDismissConfidenceThreshold);
  }, [config.data]);

  useSecurityAgentSettingsRedirect(scope, config.data?.isEnabled);

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
  const dirty =
    hydratedRef.current &&
    getSettingsDirtyState(initialConfigRef.current, patch, valid) !== 'clean';

  const handleSave = async () => {
    const result = await save.mutateAsync(patch);
    initialConfigRef.current = { ...initialConfigRef.current, ...patch };
    if (result.existingFindingsQueuedCount) {
      const count = result.existingFindingsQueuedCount;
      toast.success(
        count === 1
          ? t('securityAgent.automation.queuedOne', { count })
          : t('securityAgent.automation.queuedMany', { count })
      );
    }
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

  const { onBack, skipNextGuardRef } = useSettingsBackGuard({ dirty, valid, onSave: handleSave });

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
  if (!config.data.isEnabled) {
    return null;
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
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
      <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="gap-6 pt-4">
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
            {t('securityAgent.automation.permissionNote')}
          </Text>
        )}
      </TabScreenScrollView>
    </View>
  );
}
