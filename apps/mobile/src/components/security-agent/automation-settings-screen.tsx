import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { toast } from 'sonner-native';

import { PillGroup } from '@/components/security-agent/settings-pill-group';
import { SettingsSaveButton } from '@/components/security-agent/settings-save-button';
import { getSettingsDirtyState } from '@/components/security-agent/settings-screen-state';
import { ToggleRow } from '@/components/security-agent/settings-toggle-row';
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
  useTrackSecurityAgentInteraction,
} from '@/lib/hooks/use-security-agent';
import { type SecurityAgentConfig } from '@/lib/security-agent';

type MinSeverity = SecurityAgentConfig['autoAnalysisMinSeverity'];
type ConfidenceThreshold = SecurityAgentConfig['autoDismissConfidenceThreshold'];

// Labels mirror apps/web/src/components/security-agent/SecurityConfigSections.tsx
// so the mobile and web copy for these enums stay in sync.
const MIN_SEVERITY_OPTIONS: { value: MinSeverity; label: string }[] = [
  { value: 'critical', label: 'Critical only' },
  { value: 'high', label: 'High and above' },
  { value: 'medium', label: 'Medium and above' },
  { value: 'all', label: 'All severities' },
];

const CONFIDENCE_OPTIONS: { value: ConfidenceThreshold; label: string }[] = [
  { value: 'high', label: 'High confidence only' },
  { value: 'medium', label: 'Medium or higher' },
  { value: 'low', label: 'Any confidence' },
];

function AutomationSettingsSkeleton() {
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Automation" />
      <View className="gap-3 px-6 pt-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </View>
    </View>
  );
}

export function AutomationSettingsScreen({ scope }: Readonly<{ scope: string }>) {
  const canManage = useSecurityAgentEditCapability(scope);
  const config = useSecurityAgentConfig(scope);
  const save = useSaveSecurityAgentConfig(scope);
  const trackInteraction = useTrackSecurityAgentInteraction(scope);

  const [autoAnalysisEnabled, setAutoAnalysisEnabled] = useState(false);
  const [autoAnalysisMinSeverity, setAutoAnalysisMinSeverity] = useState<MinSeverity>('all');
  const [autoAnalysisIncludeExisting, setAutoAnalysisIncludeExisting] = useState(false);
  const [autoRemediationEnabled, setAutoRemediationEnabled] = useState(false);
  const [autoRemediationMinSeverity, setAutoRemediationMinSeverity] = useState<MinSeverity>('all');
  const [autoRemediationIncludeExisting, setAutoRemediationIncludeExisting] = useState(false);
  const [autoDismissEnabled, setAutoDismissEnabled] = useState(false);
  const [autoDismissConfidenceThreshold, setAutoDismissConfidenceThreshold] =
    useState<ConfidenceThreshold>('high');
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
    setAutoAnalysisEnabled(config.data.autoAnalysisEnabled);
    setAutoAnalysisMinSeverity(config.data.autoAnalysisMinSeverity);
    setAutoAnalysisIncludeExisting(config.data.autoAnalysisIncludeExisting);
    setAutoRemediationEnabled(config.data.autoRemediationEnabled);
    setAutoRemediationMinSeverity(config.data.autoRemediationMinSeverity);
    setAutoRemediationIncludeExisting(config.data.autoRemediationIncludeExisting);
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
    autoDismissEnabled,
    autoDismissConfidenceThreshold,
  };
  const dirty =
    hydratedRef.current &&
    getSettingsDirtyState(initialConfigRef.current, patch, valid) !== 'clean';

  const handleSave = async () => {
    const result = await save.mutateAsync(patch);
    if (result.existingFindingsQueuedCount) {
      toast.success(
        `${result.existingFindingsQueuedCount} existing finding${result.existingFindingsQueuedCount === 1 ? '' : 's'} queued for analysis.`
      );
    }
  };

  const { onBack } = useSettingsBackGuard({ dirty, valid, onSave: handleSave });

  if (config.isError && !config.data) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Automation" />
        <QueryError
          className="flex-1"
          message="Could not load automation settings"
          onRetry={() => void config.refetch()}
        />
      </View>
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
        title="Automation"
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
      <ScrollView className="flex-1 px-6" contentContainerClassName="gap-6 pt-4 pb-24">
        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Auto Analysis
          </Text>
          <ToggleRow
            title="Enable auto-analysis"
            subtitle="Automatically analyze findings as they are synced."
            value={autoAnalysisEnabled}
            disabled={!canManage}
            onValueChange={setAutoAnalysisEnabled}
          />
          {autoAnalysisEnabled && (
            <>
              <PillGroup
                label="Minimum severity"
                options={MIN_SEVERITY_OPTIONS}
                value={autoAnalysisMinSeverity}
                disabled={!canManage}
                onChange={setAutoAnalysisMinSeverity}
              />
              <ToggleRow
                title="Include existing findings"
                subtitle="Also analyze previously synced findings. This may use additional credits."
                value={autoAnalysisIncludeExisting}
                disabled={!canManage}
                onValueChange={setAutoAnalysisIncludeExisting}
              />
            </>
          )}
        </View>

        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Auto Remediation
          </Text>
          <ToggleRow
            title="Enable auto-remediation"
            subtitle="Automatically open PRs for eligible exploitable findings."
            value={autoRemediationEnabled}
            disabled={!canManage}
            onValueChange={setAutoRemediationEnabled}
          />
          {autoRemediationEnabled && (
            <>
              <PillGroup
                label="Minimum severity"
                options={MIN_SEVERITY_OPTIONS}
                value={autoRemediationMinSeverity}
                disabled={!canManage}
                onChange={setAutoRemediationMinSeverity}
              />
              <ToggleRow
                title="Include existing findings"
                subtitle="Also queue already-analyzed eligible findings. Duplicate PRs stay suppressed."
                value={autoRemediationIncludeExisting}
                disabled={!canManage}
                onValueChange={setAutoRemediationIncludeExisting}
              />
            </>
          )}
        </View>

        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Auto Dismiss
          </Text>
          <ToggleRow
            title="Enable auto-dismiss"
            subtitle="Automatically dismiss findings AI determines are not exploitable."
            value={autoDismissEnabled}
            disabled={!canManage}
            onValueChange={setAutoDismissEnabled}
          />
          {autoDismissEnabled && (
            <PillGroup
              label="Confidence threshold"
              options={CONFIDENCE_OPTIONS}
              value={autoDismissConfidenceThreshold}
              disabled={!canManage}
              onChange={setAutoDismissConfidenceThreshold}
            />
          )}
        </View>

        {!canManage && (
          <Text className="text-center text-xs text-muted-foreground">
            Only organization owners and billing managers can change these settings.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
