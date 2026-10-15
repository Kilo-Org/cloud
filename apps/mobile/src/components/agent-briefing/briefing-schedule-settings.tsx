import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { type BriefingPreferences } from '@/lib/agent-briefing';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { dateTimeFormat } from '@/lib/intl-cache';
import { useTRPC } from '@/lib/trpc';

export function ScheduleSettings({ preferences }: { readonly preferences: BriefingPreferences }) {
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
    const validTimes = [next.nightStart, next.morningStart, next.morningEnd].every(value =>
      /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
    );
    let validZone = true;
    try {
      dateTimeFormat('en', { timeZone: next.timezone }).format();
    } catch {
      validZone = false;
    }
    const [night, morning, end] = [next.nightStart, next.morningStart, next.morningEnd].map(
      value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
    );
    const overlaps =
      night === undefined ||
      morning === undefined ||
      end === undefined ||
      ((morning - night + 1440) % 1440) + ((end - morning + 1440) % 1440) >= 1440;
    if (
      !validTimes ||
      !validZone ||
      overlaps ||
      next.nightStart === next.morningStart ||
      next.morningStart === next.morningEnd
    ) {
      toast.error(t('agentBriefing.invalidSchedule'));
      return;
    }
    update.mutate({ ...next, language: i18n.resolvedLanguage ?? i18n.language });
  };
  return (
    <View className="gap-4">
      <View className="gap-2">
        <Text className="text-sm">{t('agentBriefing.timezone')}</Text>
        <Input
          key={timezoneInputKey}
          defaultValue={draft.current.timezone}
          accessibilityLabel={t('agentBriefing.timezone')}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={value => {
            draft.current.timezone = value.trim();
          }}
        />
        <Button
          variant="ghost"
          disabled={offline || update.isPending}
          onPress={() => {
            draft.current.timezone = dateTimeFormat(undefined, {}).resolvedOptions().timeZone;
            setTimezoneInputKey(key => key + 1);
          }}
        >
          <Text>{t('agentBriefing.deviceTimezone')}</Text>
        </Button>
      </View>
      {fields.map(field => {
        const time = times[field.key];
        const pickerValue = new Date(2000, 0, 1, Number(time.slice(0, 2)), Number(time.slice(3)));
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
                {pickerValue.toLocaleTimeString(i18n.language, {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
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
                    const next = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                    draft.current[field.key] = next;
                    setTimes(current => ({ ...current, [field.key]: next }));
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
      <Text className="text-xs text-muted-foreground">{t('agentBriefing.timezoneHint')}</Text>
      <Text className="text-xs text-muted-foreground">{t('agentBriefing.timeHint')}</Text>
      <Button disabled={offline} loading={update.isPending} onPress={save}>
        <Text>{t('common.save')}</Text>
      </Button>
    </View>
  );
}
