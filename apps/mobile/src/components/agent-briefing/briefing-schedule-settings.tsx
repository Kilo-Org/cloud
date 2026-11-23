import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { type BriefingPreferences } from '@/lib/agent-briefing';
import {
  briefingPickerDate,
  briefingPickerTime,
  briefingScheduleProblems,
  type BriefingTimeRefusal,
} from '@/lib/agent-briefing-schedule';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { formatClockTime } from '@/lib/format';
import { dateTimeFormat } from '@/lib/intl-cache';
import { assertSurfaceFailureHandled, type SurfaceFeedback } from '@/lib/surface-feedback';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useBriefingLocale } from './briefing-locale';

/** The save's refusal: the server answered no, and nothing was stored. */
type BriefingScheduleFailure = { readonly kind: 'refused' };

/** The card's one line for a refused save, or nothing for any other phase. */
function saveStatusMessage(
  feedback: SurfaceFeedback<BriefingScheduleFailure>,
  t: (key: string) => string
): string | null {
  switch (feedback.status) {
    case 'failed': {
      // One refusal arm: the line above Save is the whole surface for it.
      return t('common.couldNotSaveSetting');
    }
    case 'idle':
    case 'pending':
    case 'succeeded': {
      return null;
    }
    default: {
      return assertSurfaceFailureHandled(feedback);
    }
  }
}

type StoredSchedule = Pick<
  BriefingPreferences,
  'timezone' | 'nightStart' | 'morningStart' | 'morningEnd'
>;

/**
 * The message each time refusal shows. An empty window names the window the
 * person has to change; a malformed clock borrows the time zone field's wording,
 * because the same save reported it.
 */
const TIME_REFUSAL_KEYS = {
  format: 'agentBriefing.invalidSchedule',
  emptyNight: 'agentBriefing.scheduleEmptyNight',
  emptyMorning: 'agentBriefing.scheduleEmptyMorning',
  fullDay: 'agentBriefing.scheduleFullDay',
} as const satisfies Record<BriefingTimeRefusal, string>;

export function ScheduleSettings({ preferences }: { readonly preferences: StoredSchedule }) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const { t } = useTranslation();
  const locale = useBriefingLocale();
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
  const [timeRefusal, setTimeRefusal] = useState<BriefingTimeRefusal | null>(null);
  const [timezoneInputKey, setTimezoneInputKey] = useState(0);
  // The save's own phase, in the shared primitive: a stale refusal cannot paint
  // over a newer attempt, and a second Save cannot start while one is pending.
  const saveFeedback = useSurfaceFeedback<BriefingScheduleFailure>();
  const saveFailure = saveFeedback.failure;
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
        // The cache returns to the stored plan; the card, not a toast, says the
        // save was refused, so the message stays where the values are.
        for (const [key, value] of context?.previous ?? []) {
          client.setQueryData(key, value);
        }
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
    setTimeRefusal(problems.times);
    if (problems.timezone || problems.times) {
      return;
    }
    const attempt = saveFeedback.begin();
    if (attempt === null) {
      return;
    }
    update.mutate(
      { ...next, language: locale },
      {
        onSuccess: () => {
          attempt.abandon();
        },
        onError: () => {
          attempt.fail({ kind: 'refused' });
        },
      }
    );
  };
  // A refused save keeps what the person typed, so a typo in one value never
  // costs the whole draft; the inline message says it was not stored, and
  // Discard is the one exit that goes back to the stored plan.
  const discardRefusedSave = () => {
    draft.current = {
      timezone: preferences.timezone,
      nightStart: preferences.nightStart,
      morningStart: preferences.morningStart,
      morningEnd: preferences.morningEnd,
    };
    setTimes({
      nightStart: preferences.nightStart,
      morningStart: preferences.morningStart,
      morningEnd: preferences.morningEnd,
    });
    // The timezone field is uncontrolled, so it rewrites only on a new key.
    setTimezoneInputKey(key => key + 1);
    setTimezoneInvalid(false);
    setTimeRefusal(null);
    saveFeedback.clearWhere(() => true);
  };
  return (
    <Card>
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
        <Text variant="caption">{t('agentBriefing.timezoneHint')}</Text>
        <Button
          variant="link"
          size="sm"
          className={cn(STATE_ACTION_CLASS, 'self-start')}
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
        // One value for what the button shows and announces, in the locale
        // convention the picker itself uses.
        const clock = formatClockTime(pickerValue, locale);
        return (
          <View key={field.key} className="gap-2">
            {/* The same label the text fields above wear: one relation, one
                size, whether its value is typed or picked. */}
            <FormFieldLabel label={field.label} />
            <Button
              variant="outline"
              disabled={offline || update.isPending}
              accessibilityLabel={t('agentBriefing.scheduleTimeLabel', {
                label: field.label,
                time: clock,
              })}
              onPress={() => {
                setActiveTime(field.key);
              }}
            >
              <Text>{clock}</Text>
            </Button>
            {activeTime === field.key ? (
              <>
                <DateTimePicker
                  value={pickerValue}
                  mode="time"
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  locale={locale}
                  positiveButton={{ label: t('common.done') }}
                  negativeButton={{ label: t('common.cancel') }}
                  onDismiss={() => {
                    setActiveTime(null);
                  }}
                  onValueChange={(_event, date) => {
                    const next = briefingPickerTime(date);
                    draft.current[field.key] = next;
                    setTimes(current => ({ ...current, [field.key]: next }));
                    setTimeRefusal(null);
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
        message={timeRefusal === null ? null : t(TIME_REFUSAL_KEYS[timeRefusal])}
        className="text-sm"
      />
      <Text variant="caption">{t('agentBriefing.timeHint')}</Text>
      <Text variant="caption">{t('agentBriefing.scheduleHint')}</Text>
      {saveFailure ? (
        <>
          <AccessibleStatus
            message={saveStatusMessage(saveFeedback.feedback, t)}
            className="text-sm"
          />
          <Button
            variant="ghost"
            size="sm"
            className={cn(STATE_ACTION_CLASS, 'self-start')}
            disabled={update.isPending}
            onPress={discardRefusedSave}
          >
            <Text>{t('common.discard')}</Text>
          </Button>
        </>
      ) : null}
      <Button disabled={offline} loading={update.isPending} onPress={save}>
        <Text>{t('common.save')}</Text>
      </Button>
    </Card>
  );
}
