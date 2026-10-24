import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import {
  type BriefingPeriod,
  briefingWallTime,
  briefingWallTimeToInstant,
} from '@/lib/agent-briefing-period';
import { formatDate } from '@/lib/format';
import { parseTimestamp } from '@/lib/utils';

type PickerField = { endpoint: keyof BriefingPeriod; mode: 'date' | 'time' };

export function BriefingPeriodPicker({
  period,
  timezone,
  disabled,
  onChange,
}: {
  readonly period: BriefingPeriod;
  readonly timezone: string;
  readonly disabled: boolean;
  readonly onChange: (period: BriefingPeriod) => void;
}) {
  const { t, i18n } = useTranslation();
  const [active, setActive] = useState<PickerField | null>(null);
  const endpoints = [
    { endpoint: 'startAt', label: t('agentBriefing.periodStart') },
    { endpoint: 'endAt', label: t('agentBriefing.periodEnd') },
  ] as const;
  const wall = active ? briefingWallTime(Date.parse(period[active.endpoint]), timezone) : null;
  let pickerValue: Date | null = null;
  if (wall && active) {
    pickerValue =
      Platform.OS === 'ios' || active.mode === 'date'
        ? new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute))
        : new Date(2000, 0, 15, wall.hour, wall.minute);
  }
  return (
    <View className="gap-3">
      {endpoints.map(({ endpoint, label }) => (
        <View key={endpoint} className="gap-2">
          <Text className="text-sm">{label}</Text>
          <View className="flex-row flex-wrap gap-2">
            {(['date', 'time'] as const).map(mode => {
              const formatted = formatDate(parseTimestamp(period[endpoint]), i18n.language, {
                timeZone: timezone,
                ...(mode === 'date' ? { dateStyle: 'medium' } : { timeStyle: 'short' }),
              });
              return (
                <Button
                  key={mode}
                  variant="outline"
                  disabled={disabled}
                  accessibilityLabel={t('agentBriefing.scheduleTimeLabel', {
                    label,
                    time: formatted,
                  })}
                  onPress={() => {
                    setActive({ endpoint, mode });
                  }}
                >
                  <Text>{formatted}</Text>
                </Button>
              );
            })}
          </View>
        </View>
      ))}
      {active && wall && pickerValue && !disabled ? (
        <>
          <DateTimePicker
            value={pickerValue}
            mode={active.mode}
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            locale={i18n.resolvedLanguage ?? i18n.language}
            timeZoneName="UTC"
            positiveButton={{ label: t('common.done') }}
            negativeButton={{ label: t('common.cancel') }}
            onDismiss={() => {
              setActive(null);
            }}
            onValueChange={(_event, date) => {
              const ios = Platform.OS === 'ios';
              const next =
                active.mode === 'date'
                  ? {
                      ...wall,
                      year: date.getUTCFullYear(),
                      month: date.getUTCMonth() + 1,
                      day: date.getUTCDate(),
                    }
                  : {
                      ...wall,
                      hour: ios ? date.getUTCHours() : date.getHours(),
                      minute: ios ? date.getUTCMinutes() : date.getMinutes(),
                    };
              const instant = briefingWallTimeToInstant(next, timezone);
              if (instant === null) {
                toast.error(t('agentBriefing.invalidLocalTime'));
              } else {
                onChange({ ...period, [active.endpoint]: new Date(instant).toISOString() });
              }
              if (Platform.OS === 'android') {
                setActive(null);
              }
            }}
          />
          {Platform.OS === 'ios' ? (
            <Button
              variant="ghost"
              onPress={() => {
                setActive(null);
              }}
            >
              <Text>{t('common.done')}</Text>
            </Button>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
