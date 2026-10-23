import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { toast } from 'sonner-native';

import { BriefingCreateReview } from './briefing-create-review';
import { BriefingPeriodPicker } from './briefing-period-picker';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Check } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { BRIEFING_PATH, useBriefingAccess, useBriefingPreferences } from '@/lib/agent-briefing';
import {
  type BriefingPeriod,
  briefingPeriodError,
  type BriefingPeriodPreset,
  resolveBriefingPeriod,
} from '@/lib/agent-briefing-period';
import { useCreateBriefing } from '@/lib/hooks/use-create-briefing';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

const PRESETS = [
  { value: 'last24Hours', key: 'agentBriefing.last24Hours' },
  { value: 'today', key: 'chat.conversationList.today' },
  { value: 'yesterday', key: 'chat.conversationList.yesterday' },
  { value: 'last7Days', key: 'agentBriefing.last7Days' },
  { value: 'custom', key: 'agentBriefing.customPeriod' },
] as const;

export function BriefingCreateScreen() {
  const { context } = useLocalSearchParams<{ context?: string }>();
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const access = useBriefingAccess();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const preferences = useBriefingPreferences(true);
  const offline = useOfflineBannerState();
  const creation = useCreateBriefing();
  const colors = useThemeColors();
  const [organizationId, setOrganizationId] = useState<string | null | undefined>(
    context === 'personal' ? null : context
  );
  const [preset, setPreset] = useState<BriefingPeriodPreset>('last24Hours');
  const [custom, setCustom] = useState<BriefingPeriod>(() => {
    const end = Date.now();
    return {
      startAt: new Date(end - 24 * 60 * 60 * 1000).toISOString(),
      endAt: new Date(end).toISOString(),
    };
  });
  const timezone = preferences.data?.timezone;
  const contexts =
    preferences.data?.contexts.filter(item => access.canRead(item.context.organizationId)) ?? [];
  const statusNotice = offline ? t('agentBriefing.createOffline') : creation.error;
  const selected = contexts.find(item => item.context.organizationId === organizationId);
  const configuration = JSON.stringify([
    timezone,
    language,
    selected?.context.id,
    selected?.model,
    selected?.maxDurationSeconds,
    selected?.maxSpendMicrodollars,
  ]);
  const previousConfiguration = useRef(configuration);
  useEffect(() => {
    if (previousConfiguration.current !== configuration) {
      previousConfiguration.current = configuration;
      creation.reset();
    }
  }, [configuration, creation]);
  const busy = creation.preparing || creation.creating;
  const periodError = preset === 'custom' ? briefingPeriodError(custom, Date.now()) : null;

  const review = () => {
    if (!timezone || !selected || offline) {
      return;
    }
    const now = Date.now();
    const period = resolveBriefingPeriod({ preset, timezone, custom, now });
    const invalid = period ? briefingPeriodError(period, now) : 'agentBriefing.invalidLocalTime';
    if (!period || invalid) {
      toast.error(t(invalid ?? 'agentBriefing.invalidPeriod'));
      return;
    }
    void creation.prepare({
      ...period,
      organizationId: organizationId ?? undefined,
      timezone,
      language,
    });
  };
  const confirm = async () => {
    if (!selected || !timezone || offline) {
      return;
    }
    const report = await creation.create();
    if (report) {
      router.replace(`${BRIEFING_PATH}/${report.id}` as Href);
    }
  };

  const header = (
    <ScreenHeader
      title={t('agentBriefing.create')}
      showBackButton
      backFallback={BRIEFING_PATH as Href}
    />
  );
  if (preferences.isPending && !offline) {
    return (
      <View className="flex-1 bg-background">
        {header}
        <View className="gap-4 p-4">
          <Skeleton className="h-32 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </View>
      </View>
    );
  }
  if (!preferences.data) {
    return (
      <View className="flex-1 bg-background">
        {header}
        <QueryError
          title={t('agentBriefing.loadError')}
          onRetry={() => {
            void preferences.refetch();
          }}
        />
      </View>
    );
  }
  return (
    <View className="flex-1 bg-background">
      {header}
      <ScrollView automaticallyAdjustKeyboardInsets contentContainerClassName="gap-5 p-4 pb-12">
        <View className="gap-2">
          <Text className="font-semibold">{t('agentBriefing.chooseContext')}</Text>
          <View className="flex-row flex-wrap gap-2">
            {contexts.map(item => (
              <Button
                key={item.context.id}
                size="sm"
                variant={organizationId === item.context.organizationId ? 'secondary' : 'outline'}
                className={
                  organizationId === item.context.organizationId
                    ? 'border border-primary'
                    : undefined
                }
                accessibilityState={{ selected: organizationId === item.context.organizationId }}
                disabled={busy}
                onPress={() => {
                  creation.reset();
                  setOrganizationId(item.context.organizationId);
                }}
              >
                {organizationId === item.context.organizationId ? (
                  <Check size={14} color={colors.primary} />
                ) : null}
                <Text>
                  {item.context.organizationId === null ? t('common.personal') : item.context.name}
                </Text>
              </Button>
            ))}
          </View>
          <Text className="text-xs text-muted-foreground">{t('agentBriefing.allContexts')}</Text>
          {organizationId !== undefined && !selected ? (
            <Text className="text-sm text-destructive">{t('common.accessDenied')}</Text>
          ) : null}
        </View>
        <View className="gap-2">
          <Text className="font-semibold">{t('agentBriefing.period')}</Text>
          <Text className="text-sm">
            {t('agentBriefing.timezone')}: {timezone}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {PRESETS.map(item => (
              <Button
                key={item.value}
                size="sm"
                variant={preset === item.value ? 'secondary' : 'outline'}
                className={preset === item.value ? 'border border-primary' : undefined}
                accessibilityState={{ selected: preset === item.value }}
                disabled={busy}
                onPress={() => {
                  creation.reset();
                  setPreset(item.value);
                }}
              >
                {preset === item.value ? <Check size={14} color={colors.primary} /> : null}
                <Text>{t(item.key)}</Text>
              </Button>
            ))}
          </View>
          {preset === 'custom' && timezone ? (
            <BriefingPeriodPicker
              period={custom}
              timezone={timezone}
              disabled={busy}
              onChange={next => {
                creation.reset();
                setCustom(next);
              }}
            />
          ) : null}
          <Text className="text-xs text-muted-foreground">{t('agentBriefing.periodHint')}</Text>
          {periodError ? <Text className="text-sm text-destructive">{t(periodError)}</Text> : null}
        </View>
        {creation.prepared && selected && timezone ? (
          <BriefingCreateReview
            prepared={creation.prepared}
            disabled={offline || busy}
            creating={creation.creating}
            onCreate={() => {
              void confirm();
            }}
            onReviewAgain={() => {
              creation.reset();
              review();
            }}
          />
        ) : (
          <Button
            disabled={offline || !selected || !timezone || Boolean(periodError)}
            loading={creation.preparing}
            onPress={review}
          >
            <Text>{t('agentBriefing.reviewBriefing')}</Text>
          </Button>
        )}
        {/* One reserved line below the action: a failure or the offline notice
            appears here without moving the button or the review above it. */}
        <View className="min-h-[20px]">
          {statusNotice ? <Text className="text-sm text-destructive">{statusNotice}</Text> : null}
        </View>
      </ScrollView>
    </View>
  );
}
