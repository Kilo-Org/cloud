import {
  getSettingsDirtyState,
  isValidDayCount,
  parseDayCount,
} from '@kilocode/app-shared/security-agent';
import { useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';

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

function SlaSettingsSkeleton() {
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="SLA policy" />
      <View className="gap-3 px-6 pt-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="h-11 w-full rounded-lg" />
      </View>
    </View>
  );
}

type SlaSeverity = 'critical' | 'high' | 'medium' | 'low';

const SLA_ROWS: { key: SlaSeverity; label: string; description: string }[] = [
  {
    key: 'critical',
    label: 'Critical',
    description: 'Remote exploitation without authentication.',
  },
  { key: 'high', label: 'High', description: 'Potential significant data exposure.' },
  { key: 'medium', label: 'Medium', description: 'Limited impact or specific conditions.' },
  { key: 'low', label: 'Low', description: 'Minimal security impact.' },
];

// Uncontrolled numeric TextInput — never pass `value` back on iOS (see
// apps/mobile/AGENTS.md). The ref holds the raw typed text; `days` holds
// the parsed number (or NaN while invalid) purely to drive dirty/validity,
// mirroring the derived-state pattern in kiloclaw/settings-card.tsx.
function SlaDayRow({
  label,
  description,
  initialValue,
  disabled,
  onChangeValue,
}: Readonly<{
  label: string;
  description: string;
  initialValue: number;
  disabled: boolean;
  onChangeValue: (value: number) => void;
}>) {
  const colors = useThemeColors();
  const rawRef = useRef(String(initialValue));
  const [days, setDays] = useState(initialValue);

  return (
    <View
      className={cn(
        'flex-row items-center justify-between rounded-lg bg-secondary p-4',
        disabled && 'opacity-50'
      )}
    >
      <View className="flex-1 pr-3">
        <Text className="text-sm font-medium">{label}</Text>
        <Text variant="muted" className="text-xs">
          {description}
        </Text>
        {!isValidDayCount(days) && (
          <Text className="mt-1 text-xs text-destructive">1-365 days, whole numbers only.</Text>
        )}
      </View>
      <TextInput
        accessibilityLabel={`${label} remediation deadline in days`}
        accessibilityHint={
          isValidDayCount(days) ? undefined : 'Enter a whole number between 1 and 365'
        }
        className="h-11 w-16 rounded-lg border border-input bg-background px-2 text-sm leading-5 text-foreground"
        textAlign="center"
        editable={!disabled}
        accessibilityState={{ disabled }}
        keyboardType="number-pad"
        defaultValue={rawRef.current}
        placeholderTextColor={colors.mutedForeground}
        onChangeText={text => {
          rawRef.current = text;
          const parsed = parseDayCount(text);
          setDays(parsed);
          onChangeValue(parsed);
        }}
      />
    </View>
  );
}

export function SlaSettingsScreen({ scope }: Readonly<{ scope: string }>) {
  const canManage = useSecurityAgentCapability(scope).canManage;
  const config = useSecurityAgentConfig(scope);
  const save = useSaveSecurityAgentConfig(scope);
  const trackInteraction = useTrackSecurityAgentInteraction(scope);

  const [slaEnabled, setSlaEnabled] = useState(false);
  const [slaDays, setSlaDays] = useState<Record<SlaSeverity, number>>({
    critical: Number.NaN,
    high: Number.NaN,
    medium: Number.NaN,
    low: Number.NaN,
  });
  const hydratedRef = useRef(false);
  const initialConfigRef = useRef<Partial<SecurityAgentConfig>>({});

  // Local state initialized from the loaded config exactly once — later
  // config refetches (e.g. after this screen's own save) shouldn't clobber
  // in-progress edits. Day-row inputs stay unmounted (see the `slaEnabled`
  // read below) until this has run, so they never mount with the NaN
  // placeholder as their initial value.
  useEffect(() => {
    if (hydratedRef.current || !config.data) {
      return;
    }
    hydratedRef.current = true;
    initialConfigRef.current = config.data;
    setSlaEnabled(config.data.slaEnabled);
    setSlaDays({
      critical: config.data.slaCriticalDays,
      high: config.data.slaHighDays,
      medium: config.data.slaMediumDays,
      low: config.data.slaLowDays,
    });
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
    trackRef.current({ interaction: 'settings_sla_viewed' });
  }, []);

  // Only validate the four day fields while SLA tracking is enabled — once
  // hidden by the toggle, an invalid day count can't block saving. If a
  // field is invalid at the moment it's hidden, fall back to its last
  // persisted value instead of sending an invalid one.
  const daysValid: Record<SlaSeverity, boolean> = {
    critical: isValidDayCount(slaDays.critical),
    high: isValidDayCount(slaDays.high),
    medium: isValidDayCount(slaDays.medium),
    low: isValidDayCount(slaDays.low),
  };
  const valid = !slaEnabled || Object.values(daysValid).every(Boolean);
  const patch = {
    slaEnabled,
    slaCriticalDays: daysValid.critical
      ? slaDays.critical
      : (initialConfigRef.current.slaCriticalDays ?? slaDays.critical),
    slaHighDays: daysValid.high
      ? slaDays.high
      : (initialConfigRef.current.slaHighDays ?? slaDays.high),
    slaMediumDays: daysValid.medium
      ? slaDays.medium
      : (initialConfigRef.current.slaMediumDays ?? slaDays.medium),
    slaLowDays: daysValid.low ? slaDays.low : (initialConfigRef.current.slaLowDays ?? slaDays.low),
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
        title="SLA policy"
        variant="offline"
        message="Could not load SLA settings"
        onRetry={() => void config.refetch()}
      />
    );
  }
  if (config.isLoading || !config.data) {
    return <SlaSettingsSkeleton />;
  }
  if (!config.data.isEnabled) {
    return null;
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="SLA policy"
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
            Only organization owners and billing managers can change these settings.
          </Text>
        )}
        <ToggleRow
          title="Enable SLA tracking"
          subtitle="Set remediation deadlines based on finding severity."
          value={slaEnabled}
          disabled={!canManage}
          onValueChange={setSlaEnabled}
        />

        {hydratedRef.current && slaEnabled && (
          <View className="gap-3">
            <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
              Remediation deadlines (days)
            </Text>
            {SLA_ROWS.map(row => (
              <SlaDayRow
                key={row.key}
                label={row.label}
                description={row.description}
                initialValue={slaDays[row.key]}
                disabled={!canManage}
                onChangeValue={value => {
                  setSlaDays(current => ({ ...current, [row.key]: value }));
                }}
              />
            ))}
          </View>
        )}
      </TabScreenScrollView>
    </View>
  );
}
