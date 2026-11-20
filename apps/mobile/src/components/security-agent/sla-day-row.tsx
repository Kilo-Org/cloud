import { isValidDayCount } from '@kilocode/app-shared/security-agent';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { formatNumber, parseLocalizedNumber } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

/** The four severities ·SLA tracks a remediation deadline for, in screen order. */
export type SlaSeverity = 'critical' | 'high' | 'medium' | 'low';

/** One severity's deadline row: its label, the sentence that explains it, and its field. */
export const SLA_ROWS = [
  {
    key: 'critical',
    labelKey: 'common.critical',
    descriptionKey: 'securityAgent.sla.criticalDescription',
  },
  {
    key: 'high',
    labelKey: 'securityAgent.sla.high',
    descriptionKey: 'securityAgent.sla.highDescription',
  },
  {
    key: 'medium',
    labelKey: 'securityAgent.sla.medium',
    descriptionKey: 'securityAgent.sla.mediumDescription',
  },
  {
    key: 'low',
    labelKey: 'securityAgent.sla.low',
    descriptionKey: 'securityAgent.sla.lowDescription',
  },
] as const satisfies readonly {
  key: SlaSeverity;
  labelKey: string;
  descriptionKey: string;
}[];

// Uncontrolled numeric TextInput — never pass `value` back on iOS (see
// apps/mobile/AGENTS.md). The ref holds the raw typed text; `days` holds
// the parsed number (or NaN while invalid) purely to drive dirty/validity.
export function SlaDayRow({
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
  const { t } = useTranslation();
  const rawRef = useRef(formatNumber(initialValue, i18n.language, { useGrouping: false }));
  const [days, setDays] = useState(initialValue);

  return (
    <View className={cn(ROW_TARGET_CLASS, 'flex-row items-center justify-between gap-3 px-4 py-3')}>
      <View className="min-w-0 flex-1">
        <Text className={cn('text-sm font-medium', disabled && 'text-muted-foreground')}>
          {label}
        </Text>
        <Text variant="muted" className="mt-0.5 text-xs">
          {description}
        </Text>
        {!isValidDayCount(days) && (
          <Text className="mt-1 text-xs text-destructive">
            {t('securityAgent.sla.invalidDayCount')}
          </Text>
        )}
      </View>
      <Input
        accessibilityLabel={t('securityAgent.sla.remediationDeadlineA11y', { label })}
        accessibilityHint={
          isValidDayCount(days) ? undefined : t('securityAgent.sla.enterWholeNumber')
        }
        className={cn(
          'w-16 rounded-md border border-input bg-background pl-2 pr-2 text-sm text-foreground',
          // The field's own read-only cue, as `FormField` paints it: the muted
          // title above says the row is off, and the box dims with it.
          disabled && 'opacity-50'
        )}
        textAlign="center"
        editable={!disabled}
        accessibilityState={{ disabled }}
        keyboardType="number-pad"
        defaultValue={rawRef.current}
        placeholderTextColor={colors.mutedForeground}
        onChangeText={text => {
          rawRef.current = text;
          const value = parseLocalizedNumber(text, i18n.language);
          const parsed = value !== null && Number.isInteger(value) ? value : Number.NaN;
          setDays(parsed);
          onChangeValue(parsed);
        }}
      />
    </View>
  );
}
