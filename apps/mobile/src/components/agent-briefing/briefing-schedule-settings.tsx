import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { toast } from 'sonner-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { type BriefingPreferences } from '@/lib/agent-briefing';
import {
  briefingPickerDate,
  briefingPickerTime,
  briefingScheduleProblems,
} from '@/lib/agent-briefing-schedule';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { formatDate } from '@/lib/format';
import { dateTimeFormat } from '@/lib/intl-cache';
import { useTRPC } from '@/lib/trpc';

export function ScheduleSettings({
  preferences,
}: {
  readonly preferences: Pick<
    BriefingPreferences,
    'timezone' | 'nightStart' | 'morningStart' | 'morningEnd'
  >;
}) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const { t, i18n } = useTranslation();
  const offline = useOfflineBannerState();
  const draft = useRef({
    timezone: preferences.timezone,
    nightStart: preferences.nightStart,
    morningStart: preferences.morningStart,
    morningEnd: preferences.morningEnd,
  });
  const [times, setTimes] = useState({
    nightStart: preferences.nightStart,
    morningStart: preferences.morningStart,
    morningEnd: preferences.morningEnd,
  });
  const [activeTime, setActiveTime] = useState<keyof typeof times | null>(null);
  const [timezoneInvalid, setTimezoneInvalid] = useState(false);
  const [timesInvalid, setTimesInvalid] = useState(false);
  const [timezoneInputKey, setTimezoneInputKey] = useState(0);
  const update = useMutation(
    trpc.agentBriefing.updatePreferences.mutationOptions({
      onMutate: async input => {
        await client.cancelQueries({ queryKey: trpc.agentBriefing.preferences.pathKey() });
        const previous = client.getQueriesData<BriefingPreferences>({
          queryKey: trpc.agentBriefing.preferences.pathKey(),
        });
        client.setQueriesData<BriefingPreferences>(
          { queryKey: trpc.agentBriefing.preferences.pathKey() },
          data => (data ? { ...data, ...input } : data)
        );
        return { previous };
      },
      onSuccess: () => {
        announcingToast.success(t('agentBriefing.saved'));
      },
      onError: (_error, _input, context) => {
        for (const [key, value] of context?.previous ?? []) {
          client.setQueryData(key, value);
        }
        toast.error(t('common.couldNotSaveSetting'));
      },
      onSettled: () => {
        void client.invalidateQueries({ queryKey: trpc.agentBriefing.preferences.pathKey() });
      },
    })
  );
  const fields = [
    { key: 'nightStart', label: t('agentBriefing.nightStart') },
    { key: 'morningStart', label: t('agentBriefing.morningStart') },
    { key: 'morningEnd', label: t('agentBriefing.morningEnd') },
  ] as const;
  const save = () => {
    const next = draft.current;
    const problems = briefingScheduleProblems(next);
    setTimezoneInvalid(problems.timezone);
    setTimesInvalid(problems.times);
    if (problems.timezone || problems.times) {
      return;
    }
    update.mutate({ ...next, language: i18n.resolvedLanguage ?? i18n.language });
  };
  return (
    <View className="gap-4">
      <View className="gap-2">
        <FormField
          key={timezoneInputKey}
          label={t('agentBriefing.timezone')}
          defaultValue={draft.current.timezone}
          error={timezoneInvalid ? t('agentBriefing.invalidSchedule') : undefined}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={value => {
            draft.current.timezone = value.trim();
            setTimezoneInvalid(false);
          }}
        />
        <Text className="text-xs text-muted-foreground">{t('agentBriefing.timezoneHint')}</Text>
        <Button
          variant="ghost"
          disabled={offline || update.isPending}
          onPress={() => {
            draft.current.timezone = dateTimeFormat(undefined, {}).resolvedOptions().timeZone;
            setTimezoneInvalid(false);
            setTimezoneInputKey(key => key + 1);
          }}
        >
          <Text>{t('agentBriefing.deviceTimezone')}</Text>
        </Button>
      </View>
      {fields.map(field => {
        const time = times[field.key];
        const pickerValue = briefingPickerDate(time);
        return (
          <View key={field.key} className="gap-2">
            <Text className="text-sm">{field.label}</Text>
            <Button
              variant="outline"
              disabled={offline || update.isPending}
              accessibilityLabel={t('agentBriefing.scheduleTimeLabel', {
                label: field.label,
                time,
              })}
              onPress={() => {
                setActiveTime(field.key);
              }}
            >
              <Text>
                {formatDate(pickerValue, i18n.language, { hour: '2-digit', minute: '2-digit' })}
              </Text>
            </Button>
            {activeTime === field.key ? (
              <>
                <DateTimePicker
                  value={pickerValue}
                  mode="time"
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  locale={i18n.resolvedLanguage ?? i18n.language}
                  positiveButton={{ label: t('common.done') }}
                  negativeButton={{ label: t('common.cancel') }}
                  onDismiss={() => {
                    setActiveTime(null);
                  }}
                  onValueChange={(_event, date) => {
                    const next = briefingPickerTime(date);
                    draft.current[field.key] = next;
                    setTimes(current => ({ ...current, [field.key]: next }));
                    setTimesInvalid(false);
                    if (Platform.OS === 'android') {
                      setActiveTime(null);
                    }
                  }}
                />
                {Platform.OS === 'ios' ? (
                  <Button
                    variant="ghost"
                    onPress={() => {
                      setActiveTime(null);
                    }}
                  >
                    <Text>{t('common.done')}</Text>
                  </Button>
                ) : null}
              </>
            ) : null}
          </View>
        );
      })}
      <AccessibleStatus
        message={timesInvalid ? t('agentBriefing.invalidSchedule') : null}
        className="text-sm"
      />
      <Text className="text-xs text-muted-foreground">{t('agentBriefing.timeHint')}</Text>
      <Text className="text-xs text-muted-foreground">{t('agentBriefing.scheduleHint')}</Text>
      <Button disabled={offline} loading={update.isPending} onPress={save}>
        <Text>{t('common.save')}</Text>
      </Button>
    </View>
  );
}
