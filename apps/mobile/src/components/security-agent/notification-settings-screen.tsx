import {
  getSettingsDirtyState,
  isPersonalSecurityScope,
  isValidDayCount,
  parseDayCount,
} from '@kilocode/app-shared/security-agent';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';

import { PillGroup } from '@/components/security-agent/settings-pill-group';
import { SettingsSaveButton } from '@/components/security-agent/settings-save-button';
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
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type SecurityAgentConfig } from '@/lib/security-agent';

type NotificationSeverity = SecurityAgentConfig['newFindingNotificationMinSeverity'];

// Labels mirror the shared NOTIFICATION_SEVERITY_OPTIONS in
// apps/web/src/components/security-agent/SecurityConfigSections.tsx — this
// is a distinct 4-value enum from the auto-analysis/remediation severity
// (no 'all' tier; 'low' is the catch-all instead).
const NOTIFICATION_SEVERITY_OPTIONS: { value: NotificationSeverity; label: string }[] = [
  { value: 'critical', label: 'Critical only' },
  { value: 'high', label: 'High and above' },
  { value: 'medium', label: 'Medium and above' },
  { value: 'low', label: 'Low and above' },
];

function NotificationSettingsSkeleton() {
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Notifications" />
      <View className="gap-3 px-6 pt-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
      </View>
    </View>
  );
}

export function NotificationSettingsScreen({ scope }: Readonly<{ scope: string }>) {
  const colors = useThemeColors();
  const canManage = useSecurityAgentEditCapability(scope);
  const config = useSecurityAgentConfig(scope);
  const save = useSaveSecurityAgentConfig(scope);
  const trackInteraction = useTrackSecurityAgentInteraction(scope);
  const personal = isPersonalSecurityScope(scope);

  const [newFindingNotificationsEnabled, setNewFindingNotificationsEnabled] = useState(false);
  const [newFindingNotificationMinSeverity, setNewFindingNotificationMinSeverity] =
    useState<NotificationSeverity>('low');
  const [slaNotificationsEnabled, setSlaNotificationsEnabled] = useState(false);
  const [slaNotificationMinSeverity, setSlaNotificationMinSeverity] =
    useState<NotificationSeverity>('low');
  // Uncontrolled numeric input — never pass `value` back into the
  // TextInput on iOS (see apps/mobile/AGENTS.md). The ref holds the raw
  // typed text; `slaNotificationWarningDays` holds the parsed number (or
  // NaN while the text isn't a valid 1-365 integer) purely to drive dirty
  // and validity checks, mirroring the `canSave` derived-state pattern in
  // kiloclaw/settings-card.tsx.
  const warningDaysRef = useRef('');
  const [slaNotificationWarningDays, setSlaNotificationWarningDays] = useState(Number.NaN);
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
    setNewFindingNotificationsEnabled(config.data.newFindingNotificationsEnabled);
    setNewFindingNotificationMinSeverity(config.data.newFindingNotificationMinSeverity);
    setSlaNotificationsEnabled(config.data.slaNotificationsEnabled);
    setSlaNotificationMinSeverity(config.data.slaNotificationMinSeverity);
    warningDaysRef.current = String(config.data.slaNotificationWarningDays);
    setSlaNotificationWarningDays(config.data.slaNotificationWarningDays);
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
    trackRef.current({ interaction: 'settings_notifications_viewed' });
  }, []);

  const valid = isValidDayCount(slaNotificationWarningDays);
  const patch = {
    newFindingNotificationsEnabled,
    newFindingNotificationMinSeverity,
    slaNotificationsEnabled,
    slaNotificationMinSeverity,
    slaNotificationWarningDays,
  };
  const dirty =
    hydratedRef.current &&
    getSettingsDirtyState(initialConfigRef.current, patch, valid) !== 'clean';

  const handleSave = async () => {
    await save.mutateAsync(patch);
  };

  const { onBack } = useSettingsBackGuard({ dirty, valid, onSave: handleSave });

  if (config.isError && !config.data) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Notifications" />
        <QueryError
          className="flex-1"
          message="Could not load notification settings"
          onRetry={() => void config.refetch()}
        />
      </View>
    );
  }
  if (config.isLoading || !config.data) {
    return <NotificationSettingsSkeleton />;
  }
  if (!config.data.isEnabled) {
    return null;
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Notifications"
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
      <ScrollView
        className="flex-1 px-6"
        contentContainerClassName="gap-6 pt-4 pb-24"
        automaticallyAdjustKeyboardInsets
      >
        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            New-finding Notification
          </Text>
          <ToggleRow
            title={personal ? 'Email me about new findings' : 'Email organization owners'}
            subtitle="Sent whenever a new finding is synced, including on first sync."
            value={newFindingNotificationsEnabled}
            disabled={!canManage}
            onValueChange={setNewFindingNotificationsEnabled}
          />
          {newFindingNotificationsEnabled && (
            <PillGroup
              label="New-finding minimum severity"
              options={NOTIFICATION_SEVERITY_OPTIONS}
              value={newFindingNotificationMinSeverity}
              disabled={!canManage}
              onChange={setNewFindingNotificationMinSeverity}
            />
          )}
        </View>

        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            SLA Warning Notification
          </Text>
          <ToggleRow
            title={personal ? 'Email me about SLA warnings' : 'Email organization owners'}
            subtitle="Sent before and when findings approach or breach their SLA deadline."
            value={slaNotificationsEnabled}
            disabled={!canManage}
            onValueChange={setSlaNotificationsEnabled}
          />
          {slaNotificationsEnabled && (
            <>
              <PillGroup
                label="SLA notification minimum severity"
                options={NOTIFICATION_SEVERITY_OPTIONS}
                value={slaNotificationMinSeverity}
                disabled={!canManage}
                onChange={setSlaNotificationMinSeverity}
              />
              <View className="gap-2">
                <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
                  SLA warning lead time (days)
                </Text>
                <TextInput
                  accessibilityLabel="SLA warning lead time in days"
                  accessibilityHint={
                    isValidDayCount(slaNotificationWarningDays)
                      ? undefined
                      : 'Enter a whole number between 1 and 365'
                  }
                  className="h-11 rounded-lg bg-secondary px-3 text-sm leading-5 text-foreground"
                  editable={canManage}
                  keyboardType="number-pad"
                  defaultValue={warningDaysRef.current}
                  placeholder="1-365"
                  placeholderTextColor={colors.mutedForeground}
                  onChangeText={text => {
                    warningDaysRef.current = text;
                    setSlaNotificationWarningDays(parseDayCount(text));
                  }}
                />
                {!isValidDayCount(slaNotificationWarningDays) && (
                  <Text className="text-xs text-destructive">
                    Enter a whole number of days between 1 and 365.
                  </Text>
                )}
              </View>
            </>
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
