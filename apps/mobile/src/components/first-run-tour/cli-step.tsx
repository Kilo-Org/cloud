import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { TourStepHero } from '@/components/first-run-tour/tour-step-hero';
import { TourStepHero } from '@/components/first-run-tour/tour-step-hero';
import { Button } from '@/components/ui/button';
import { Check, Monitor, Server } from '@/components/ui/icons';
import { InlineCodeText } from '@/components/ui/inline-code-text';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { type TourFacts } from '@/lib/first-run-tour';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type resolveInstancePickerViewState } from '@/lib/instance-picker-rows';

/**
 * Leg 2 of the first-run tour: connect a computer with `kilo remote`. The
 * body states come from the shared instance-picker classification
 * (`resolveInstancePickerViewState`), so the tour and the picker never
 * disagree about what "loading", "error", "waiting", or "connected" means.
 */

type TourCliStepProps = {
  facts: TourFacts;
  viewState: ReturnType<typeof resolveInstancePickerViewState>;
  isInstancesRefetching: boolean;
  onRefreshFacts: () => void;
  openNewSession: () => void;
  onFinish: () => void;
};

export function TourCliStep({
  facts,
  viewState,
  isInstancesRefetching,
  onRefreshFacts,
  openNewSession,
  onFinish,
}: Readonly<TourCliStepProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  return (
    <View className="flex-1">
      {/* Same `kilo remote` inline-code copy as the instance picker's empty
          state; the shared renderer styles the spans as code. */}
      <TourStepHero icon={Monitor}>
      <TourStepHero icon={Monitor}>
        <InlineCodeText variant="muted" className="px-4 text-center leading-6">
          {t('agentChat.instancePicker.noCliInstancesDescription')}
        </InlineCodeText>
      </TourStepHero>
      <View className="mt-6 min-h-9 flex-1 items-center">
      <View className="mt-6 min-h-9 flex-1 items-center">
        {viewState.kind === 'loading' ? (
          <View className="w-full gap-2">
            <Skeleton className="h-5 w-3/4 rounded-md" />
            <Skeleton className="h-5 w-1/2 rounded-md" />
          </View>
        ) : null}
        {viewState.kind === 'error' ? (
          <EmptyState
            icon={Server}
            placement="top"
            title={t('agentChat.instancePicker.couldNotLoad')}
            description={t('organization.boundary.loadErrorMessage')}
            action={
              <Button variant="outline" onPress={onRefreshFacts} loading={isInstancesRefetching}>
                <Text>{t('common.retry')}</Text>
              </Button>
            }
          />
        ) : null}
        {viewState.kind === 'ready' && viewState.instances.length === 0 ? (
          <View className="flex-row items-center gap-2">
            <Text variant="muted">{t('firstRunTour.waitingForComputer')}</Text>
            <Button
              size="sm"
              variant="ghost"
              onPress={onRefreshFacts}
              loading={isInstancesRefetching}
            >
              <Text className="text-base text-primary">{t('common.refresh')}</Text>
            </Button>
          </View>
        ) : null}
        {viewState.kind === 'ready' && viewState.instances.length > 0 ? (
          <View className="w-full gap-2">
            <View className="flex-row items-center gap-1.5">
              <Check size={18} color={colors.primary} />
              <Text variant="muted">
                {t('firstRunTour.computerConnected', {
                  name: facts.connectedInstance?.name ?? '',
                })}
              </Text>
            </View>
            {facts.hasCliSession ? (
              <View className="flex-row items-center gap-1.5">
                <Check size={18} color={colors.primary} />
                <Text variant="muted">{t('firstRunTour.cliSessionCreated')}</Text>
              </View>
            ) : (
              // The row Done waits on, while the live-session poll lags: a
              // labeled loading line with the same Refresh affordance as the
              // no-computer state, never a bare skeleton bar beside Refresh
              // (the blank pill read as an empty control — spot-check defect
              // on am2real-seg2-cli-07.png, 2026-09-10). The label is the
              // shared `common.loading` copy, so no new key is introduced.
              <View className="flex-row items-center gap-2">
                <Text variant="muted">{t('common.loading')}</Text>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={onRefreshFacts}
                  loading={isInstancesRefetching}
                >
                  <Text className="text-base text-primary">{t('common.refresh')}</Text>
                </Button>
              </View>
            )}
          </View>
        ) : null}
      </View>
      <View className="mt-auto flex-row gap-3 pb-6">
        {facts.connectedInstance ? (
          <Button size="lg" className="flex-1" onPress={openNewSession}>
            <Text className="text-base">{t('firstRunTour.startOnYourComputer')}</Text>
          </Button>
        ) : null}
        {/* Done waits for the leg's real outcome — a live `kilo remote`
            session, not the mere connection. While the session poll lags,
            the waiting row above keeps the wait visible with a Refresh. */}
        <Button
          size="lg"
          variant="secondary"
          className="flex-1"
          disabled={!facts.hasCliSession}
          onPress={onFinish}
        >
          <Text className="text-base">{t('common.done')}</Text>
        </Button>
      </View>
    </View>
  );
}
