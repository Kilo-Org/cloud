import {
  getSettingsDirtyState,
  isPersonalSecurityScope,
  isValidDayCount,
} from '@kilocode/app-shared/security-agent';
import { Bell, Clock3 } from '@/components/ui/icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { PillGroup } from '@/components/security-agent/settings-pill-group';
import { SettingsSaveButton } from '@/components/security-agent/settings-save-button';
import { useSettingsSaveFeedback } from '@/components/security-agent/settings-save-feedback';
import { ToggleRow } from '@/components/security-agent/settings-toggle-row';
import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { ScreenHeader } from '@/components/screen-header';
import { FormField } from '@/components/ui/form-field';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { i18n } from '@/i18n';
import { formatList, formatNumber, parseLocalizedNumber } from '@/lib/format';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
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
import { type SecurityAgentConfig } from '@/lib/security-agent';

type NotificationSeverity = SecurityAgentConfig['newFindingNotificationMinSeverity'];

// Labels mirror the shared NOTIFICATION_SEVERITY_OPTIONS in
// apps/web/src/components/security-agent/SecurityConfigSections.tsx — this
// is a distinct 4-value enum from the auto-analysis/remediation severity
// (no 'all' tier; 'low' is the catch-all instead).
const NOTIFICATION_SEVERITY_OPTIONS = [
  { value: 'critical', labelKey: 'common.critical' },
  { value: 'high', labelKey: 'securityAgent.filter.severityHigh' },
  { value: 'medium', labelKey: 'securityAgent.filter.severityMedium' },
  { value: 'low', labelKey: 'securityAgent.filter.severityLow' },
] as const satisfies readonly { value: NotificationSeverity; labelKey: string }[];

function NotificationSettingsSkeleton() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.notifications')} />
      <View className={SCREEN_BODY_CLASS}>
        <RowGroup>
          <RowSkeleton subtitle />
          <RowSkeleton subtitle />
        </RowGroup>
        <RowGroup>
          <RowSkeleton subtitle />
        </RowGroup>
      </View>
    </View>
  );
}

export function NotificationSettingsScreen({ scope }: Readonly<{ scope: string }>) {
  const { t } = useTranslation();
  const canManage = useSecurityAgentCapability(scope).canManage;
  const config = useSecurityAgentConfig(scope);
  const save = useSaveSecurityAgentConfig(scope, { announceFailed: false });
  const feedback = useSettingsSaveFeedback();
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
  // and validity checks.
  const warningDaysRef = useRef('');
  const [slaNotificationWarningDays, setSlaNotificationWarningDays] = useState(Number.NaN);
  // The saved baseline the draft is compared against. State rather than a ref:
  // a successful save must re-render, so `dirty` (and the back guard that
  // reads it) reflects the saved values by the time the header action leaves.
  const [baseline, setBaseline] = useState<Partial<SecurityAgentConfig> | null>(null);

  // Local state initialized from the loaded config exactly once — later
  // config refetches (e.g. after this screen's own save) shouldn't clobber
  // in-progress edits.
  useEffect(() => {
    if (baseline !== null || !config.data) {
      return;
    }
    setBaseline(config.data);
    setNewFindingNotificationsEnabled(config.data.newFindingNotificationsEnabled);
    setNewFindingNotificationMinSeverity(config.data.newFindingNotificationMinSeverity);
    setSlaNotificationsEnabled(config.data.slaNotificationsEnabled);
    setSlaNotificationMinSeverity(config.data.slaNotificationMinSeverity);
    warningDaysRef.current = formatNumber(config.data.slaNotificationWarningDays, i18n.language, {
      useGrouping: false,
    });
    setSlaNotificationWarningDays(config.data.slaNotificationWarningDays);
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
      : (baseline?.slaNotificationWarningDays ?? slaNotificationWarningDays),
  };
  // Same split as the SLA screen: the save payload falls back to the saved
  // lead time, while the back guard reads the draft the user can see so an
  // invalid-only edit is not silently classified as clean.
  const draft = slaNotificationsEnabled ? { ...patch, slaNotificationWarningDays } : patch;
  const dirty = baseline !== null && getSettingsDirtyState(baseline, draft, valid) !== 'clean';
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

  const severityOptions = NOTIFICATION_SEVERITY_OPTIONS.map(option => ({
    value: option.value,
    label: t(option.labelKey),
  }));

  if (config.isError && !config.data) {
    return (
      <PlatformErrorScreen
        title={t('common.notifications')}
        variant="offline"
        message={t('securityAgent.notifications.couldNotLoad')}
        onRetry={() => void config.refetch()}
      />
    );
  }
  if (config.isLoading || !config.data) {
    return <NotificationSettingsSkeleton />;
  }
  if (!config.data.isEnabled && !dirty) {
    // Keep a dirty draft and its controls usable if the redirect is cancelled.
    return <>{dialog}</>;
  }
  // The draft hydrates from the config in an effect; painting the body first
  // would show the default toggles and then push every control below them down
  // when their pickers appear.
  if (baseline === null) {
    return <NotificationSettingsSkeleton />;
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('common.notifications')}
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
      <TabScreenScrollView
        // iOS IME inset and focused-field auto-reveal (AGENTS.md: input screens).
        automaticallyAdjustKeyboardInsets
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
      >
        {!canManage && (
          <Text className="text-center text-xs text-muted-foreground">
            {t('securityAgent.sla.permissionNote')}
          </Text>
        )}
        <Section label={personal ? undefined : t('securityAgent.notifications.newFindingSection')}>
          <RowGroup>
            <ToggleRow
              icon={Bell}
              title={
                personal
                  ? t('securityAgent.notifications.newFindingPersonalTitle')
                  : t('securityAgent.notifications.emailOwners')
              }
              accessibilityLabel={
                personal
                  ? undefined
                  : formatList(
                      [
                        t('securityAgent.notifications.newFindingSection'),
                        t('securityAgent.notifications.emailOwners'),
                      ],
                      i18n.language
                    )
              }
              subtitle={t('securityAgent.notifications.newFindingSubtitle')}
              value={newFindingNotificationsEnabled}
              disabled={!canManage}
              onValueChange={setNewFindingNotificationsEnabled}
            />
          </RowGroup>
          {newFindingNotificationsEnabled && (
            <PillGroup
              label={t('securityAgent.notifications.newFindingSeverityLabel')}
              options={severityOptions}
              value={newFindingNotificationMinSeverity}
              disabled={!canManage}
              onChange={setNewFindingNotificationMinSeverity}
            />
          )}
        </Section>

        <Section label={personal ? undefined : t('securityAgent.notifications.slaSection')}>
          <RowGroup>
            <ToggleRow
              icon={Clock3}
              title={
                personal
                  ? t('securityAgent.notifications.slaPersonalTitle')
                  : t('securityAgent.notifications.emailOwners')
              }
              accessibilityLabel={
                personal
                  ? undefined
                  : formatList(
                      [
                        t('securityAgent.notifications.slaSection'),
                        t('securityAgent.notifications.emailOwners'),
                      ],
                      i18n.language
                    )
              }
              subtitle={t('securityAgent.notifications.slaSubtitle')}
              value={slaNotificationsEnabled}
              disabled={!canManage}
              onValueChange={setSlaNotificationsEnabled}
            />
          </RowGroup>
          {slaNotificationsEnabled && (
            <>
              <PillGroup
                label={t('securityAgent.notifications.slaSeverityLabel')}
                options={severityOptions}
                value={slaNotificationMinSeverity}
                disabled={!canManage}
                onChange={setSlaNotificationMinSeverity}
              />
              <FormField
                label={t('securityAgent.notifications.slaLeadTimeLabel')}
                error={
                  isValidDayCount(slaNotificationWarningDays)
                    ? undefined
                    : t('securityAgent.notifications.slaLeadTimeError')
                }
                keyboardType="number-pad"
                disabled={!canManage}
                defaultValue={warningDaysRef.current}
                onChangeText={text => {
                  warningDaysRef.current = text;
                  const value = parseLocalizedNumber(text, i18n.language);
                  setSlaNotificationWarningDays(
                    value !== null && Number.isInteger(value) ? value : Number.NaN
                  );
                }}
              />
            </>
          )}
        </Section>
      </TabScreenScrollView>
      {dialog}
    </View>
  );
}
