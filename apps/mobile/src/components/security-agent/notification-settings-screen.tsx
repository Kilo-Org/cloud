import {
  getSettingsDirtyState,
  isPersonalSecurityScope,
  isValidDayCount,
  parseDayCount,
} from '@kilocode/app-shared/security-agent';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextInput, View } from 'react-native';

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
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type SecurityAgentConfig } from '@/lib/security-agent';
import { cn } from '@/lib/utils';

type NotificationSeverity = SecurityAgentConfig['newFindingNotificationMinSeverity'];

// Labels mirror the shared NOTIFICATION_SEVERITY_OPTIONS in
// apps/web/src/components/security-agent/SecurityConfigSections.tsx — this
// is a distinct 4-value enum from the auto-analysis/remediation severity
// (no 'all' tier; 'low' is the catch-all instead).
const NOTIFICATION_SEVERITY_OPTIONS = [
  { value: 'critical', labelKey: 'securityAgent.filter.severityCritical' },
  { value: 'high', labelKey: 'securityAgent.filter.severityHigh' },
  { value: 'medium', labelKey: 'securityAgent.filter.severityMedium' },
  { value: 'low', labelKey: 'securityAgent.filter.severityLow' },
] as const satisfies readonly { value: NotificationSeverity; labelKey: string }[];

function NotificationSettingsSkeleton() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('securityAgent.notifications.title')} />
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
  const { t } = useTranslation();
  const canManage = useSecurityAgentCapability(scope).canManage;
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

  // Only validate the lead-time field while the SLA notification feature
  // that owns it is enabled — once hidden by the toggle, its value can't
  // block saving. If the field is invalid at the moment it's hidden, fall
  // back to the last persisted value instead of sending an invalid one.
  const warningDaysValid = isValidDayCount(slaNotificationWarningDays);
  const valid = !slaNotificationsEnabled || warningDaysValid;
  const patch = {
    newFindingNotificationsEnabled,
    newFindingNotificationMinSeverity,
    slaNotificationsEnabled,
    slaNotificationMinSeverity,
    slaNotificationWarningDays: warningDaysValid
      ? slaNotificationWarningDays
      : (initialConfigRef.current.slaNotificationWarningDays ?? slaNotificationWarningDays),
  };
  const dirty =
    hydratedRef.current &&
    getSettingsDirtyState(initialConfigRef.current, patch, valid) !== 'clean';

  const handleSave = async () => {
    await save.mutateAsync(patch);
    initialConfigRef.current = { ...initialConfigRef.current, ...patch };
  };

  const { onBack, skipNextGuardRef } = useSettingsBackGuard({ dirty, valid, onSave: handleSave });

  const severityOptions = NOTIFICATION_SEVERITY_OPTIONS.map(option => ({
    value: option.value,
    label: t(option.labelKey),
  }));

  if (config.isError && !config.data) {
    return (
      <PlatformErrorScreen
        title={t('securityAgent.notifications.title')}
        variant="offline"
        message={t('securityAgent.notifications.couldNotLoad')}
        onRetry={() => void config.refetch()}
      />
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
        title={t('securityAgent.notifications.title')}
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
      <TabScreenScrollView
        className="flex-1 px-6"
        contentContainerClassName="gap-6 pt-4"
        automaticallyAdjustKeyboardInsets
      >
        {!canManage && (
          <Text className="text-center text-xs text-muted-foreground">
            {t('securityAgent.notifications.readOnly')}
          </Text>
        )}
        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('securityAgent.notifications.newFindingSection')}
          </Text>
          <ToggleRow
            title={
              personal
                ? t('securityAgent.notifications.newFindingPersonalTitle')
                : t('securityAgent.notifications.emailOwners')
            }
            subtitle={t('securityAgent.notifications.newFindingSubtitle')}
            value={newFindingNotificationsEnabled}
            disabled={!canManage}
            onValueChange={setNewFindingNotificationsEnabled}
          />
          {newFindingNotificationsEnabled && (
            <PillGroup
              label={t('securityAgent.notifications.newFindingSeverityLabel')}
              options={severityOptions}
              value={newFindingNotificationMinSeverity}
              disabled={!canManage}
              onChange={setNewFindingNotificationMinSeverity}
            />
          )}
        </View>

        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('securityAgent.notifications.slaSection')}
          </Text>
          <ToggleRow
            title={
              personal
                ? t('securityAgent.notifications.slaPersonalTitle')
                : t('securityAgent.notifications.emailOwners')
            }
            subtitle={t('securityAgent.notifications.slaSubtitle')}
            value={slaNotificationsEnabled}
            disabled={!canManage}
            onValueChange={setSlaNotificationsEnabled}
          />
          {slaNotificationsEnabled && (
            <>
              <PillGroup
                label={t('securityAgent.notifications.slaSeverityLabel')}
                options={severityOptions}
                value={slaNotificationMinSeverity}
                disabled={!canManage}
                onChange={setSlaNotificationMinSeverity}
              />
              <View className="gap-2">
                <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
                  {t('securityAgent.notifications.slaLeadTimeLabel')}
                </Text>
                <TextInput
                  accessibilityLabel={t('securityAgent.notifications.slaLeadTimeAccessibility')}
                  accessibilityHint={
                    isValidDayCount(slaNotificationWarningDays)
                      ? undefined
                      : t('securityAgent.notifications.slaLeadTimeHint')
                  }
                  className={cn(
                    'h-11 rounded-lg bg-secondary px-3 text-sm leading-[normal] text-foreground',
                    !canManage && 'opacity-50'
                  )}
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
                    {t('securityAgent.notifications.slaLeadTimeError')}
                  </Text>
                )}
              </View>
            </>
          )}
        </View>
      </TabScreenScrollView>
    </View>
  );
}
