import {
  getSettingsDirtyState,
  isValidDayCount,
  parseDayCount,
} from '@kilocode/app-shared/security-agent';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';

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

function SlaSettingsSkeleton() {
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="SLA Policy" />
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
    <View className="flex-row items-center justify-between rounded-lg bg-secondary p-4">
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
  const canManage = useSecurityAgentEditCapability(scope);
  const config = useSecurityAgentConfig(scope);
  const save = useSaveSecurityAgentConfig(scope);
  const trackInteraction = useTrackSecurityAgentInteraction(scope);

  const [slaEnabled, setSlaEnabled] = useState(false);
  const [slaCriticalDays, setSlaCriticalDays] = useState(Number.NaN);
  const [slaHighDays, setSlaHighDays] = useState(Number.NaN);
  const [slaMediumDays, setSlaMediumDays] = useState(Number.NaN);
  const [slaLowDays, setSlaLowDays] = useState(Number.NaN);
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
    setSlaCriticalDays(config.data.slaCriticalDays);
    setSlaHighDays(config.data.slaHighDays);
    setSlaMediumDays(config.data.slaMediumDays);
    setSlaLowDays(config.data.slaLowDays);
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

  const valid =
    isValidDayCount(slaCriticalDays) &&
    isValidDayCount(slaHighDays) &&
    isValidDayCount(slaMediumDays) &&
    isValidDayCount(slaLowDays);
  const patch = {
    slaEnabled,
    slaCriticalDays,
    slaHighDays,
    slaMediumDays,
    slaLowDays,
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
        <ScreenHeader title="SLA Policy" />
        <QueryError
          className="flex-1"
          message="Could not load SLA settings"
          onRetry={() => void config.refetch()}
        />
      </View>
    );
  }
  if (config.isLoading || !config.data) {
    return <SlaSettingsSkeleton />;
  }
  if (!config.data.isEnabled) {
    return null;
  }

  const setters: Record<SlaSeverity, (value: number) => void> = {
    critical: setSlaCriticalDays,
    high: setSlaHighDays,
    medium: setSlaMediumDays,
    low: setSlaLowDays,
  };
  const values: Record<SlaSeverity, number> = {
    critical: slaCriticalDays,
    high: slaHighDays,
    medium: slaMediumDays,
    low: slaLowDays,
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="SLA Policy"
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
                initialValue={values[row.key]}
                disabled={!canManage}
                onChangeValue={value => {
                  setters[row.key](value);
                }}
              />
            ))}
          </View>
        )}

        {!canManage && (
          <Text className="text-center text-xs text-muted-foreground">
            Only organization owners and billing managers can change these settings.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
