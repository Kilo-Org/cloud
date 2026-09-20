import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/screen-header';
import { TourRemoteStep } from '@/components/tour/tour-remote-step';
import { TourStepHeader } from '@/components/tour/tour-step-header';
import { Button } from '@/components/ui/button';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Cloud, type LucideIcon, Monitor, Sparkles } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { stripInlineCodeMarkers } from '@/i18n/plain-copy';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
import { PRESELECT_CLOUD_RUN_ON } from '@/lib/run-on-destination';
import { dismissTour } from '@/lib/tour/tour-dismiss';
import { useTourCompletion } from '@/lib/tour/tour-completion';

/**
 * The first-sign-in tour shell.
 *
 * The shell owns the fork. The Cloud card hands straight off to the
 * new-session page with the Cloud Agent preselected; the computer card opens
 * the instructions page, whose detected-computer tap hands off the same way
 * with that connection preselected. Either hand-off records the per-account
 * decision and replaces the tour, so the tour never re-opens. The computer
 * instructions page keeps a back control (and Android hardware Back agrees
 * with it) that returns to the fork — going back is not a decision, so it
 * records nothing. Skip and Android hardware Back on the fork are the one other
 * decision — record it the instant the person dismisses, then pop back to the
 * screen that opened the tour (Home on auto-open, Profile on the Tutorial
 * replay); a tour with nothing beneath it lands on Home instead (see
 * `dismissTour`). Nothing here ever clears the decision.
 */

type TourPath = 'fork' | 'remote';

type ForkStepProps = {
  onChoose: (path: 'cloud' | 'remote') => void;
};

type ForkOptionProps = {
  icon: LucideIcon;
  title: string;
  body: string;
  onPress: () => void;
};

/** One selectable fork card: icon tile, title, body. */
function ForkOption({ icon: Icon, title, body, onPress }: Readonly<ForkOptionProps>) {
  const colors = useThemeColors();

  return (
    <ChoiceRow
      selected={false}
      onPress={onPress}
      className="gap-3 rounded-xl border border-border bg-card px-4"
    >
      <View className="h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-secondary">
        <Icon size={22} color={colors.foreground} />
      </View>
      <View className="flex-1 gap-0.5">
        <Text className="text-base font-semibold text-foreground">{title}</Text>
        <Text variant="muted" className="text-sm">
          {body}
        </Text>
      </View>
    </ChoiceRow>
  );
}

function ForkStep({ onChoose }: Readonly<ForkStepProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="grow justify-center gap-8 px-6 py-6"
      keyboardShouldPersistTaps="handled"
    >
      {/* Centred in the band between the header and the Skip bar: the content
          container grows to the viewport (`grow`) and distributes its children
          in the middle (`justify-center`), so the block sits where the eye
          expects it instead of against the header. `grow` is a minimum, not a
          fixed height, so the block still scrolls: a large system font or a
          short screen starts at the top padding rather than being pushed over
          the header or the action bar. */}
      <View className="items-center gap-4">
        <TourStepHeader
          icon={<Sparkles size={36} color={colors.foreground} />}
          title={t('tour.forkTitle')}
          body={t('tour.forkSubtitle')}
        />
      </View>

      <View className="gap-3">
        <ForkOption
          icon={Cloud}
          title={t('tour.cloudOptionTitle')}
          body={t('tour.cloudOptionBody')}
          onPress={() => {
            onChoose('cloud');
          }}
        />
        <ForkOption
          icon={Monitor}
          title={t('tour.remoteOptionTitle')}
          body={stripInlineCodeMarkers(t('tour.remoteOptionBody'))}
          onPress={() => {
            onChoose('remote');
          }}
        />
      </View>
    </ScrollView>
  );
}

export function TourScreen() {
  const { t } = useTranslation();
  // `dismissTour` needs `canGoBack`/`back`; the hand-off needs the stack-safe
  // replace, so the two exits use two routers.
  const router = useRouter();
  const stackSafeRouter = useStackSafeReplace();
  const insets = useSafeAreaInsets();
  const { userId } = useCurrentUserId();
  const { recordCompleted } = useTourCompletion(userId);

  const [path, setPath] = useState<TourPath>('fork');

  // One dismissal decision: record it synchronously (the hook flips its
  // in-memory state before returning and persists in the background), then
  // leave the tour. The navigation half is guarded (see `dismissTour`): a tour
  // opened as the app's first route has nothing beneath it, and an unguarded
  // `router.back()` there would leave the modal up behind a development-only
  // GO_BACK banner instead of dismissing.
  const dismiss = useCallback(() => {
    recordCompleted();
    dismissTour(router);
  }, [recordCompleted, router]);

  // The hand-off ends the tour: record the decision, then open the
  // new-session page over the tour. The tour route and `/agent-chat/new` are
  // screens of the same native Stack, so a literal `router.replace` would swap
  // both in one native-stack commit — the Android Fabric `addViewAt` crash the
  // stack-safe replace exists for (KILO-APP-25). It pushes instead and drops
  // the tour route once the push transition has ended, the same end state
  // `replace` produces. The route param is transient — the stored run-on
  // preference is never written here.
  const handOff = useCallback(
    (value: string) => {
      recordCompleted();
      stackSafeRouter.replace(
        `/(app)/agent-chat/new?preselectRunOn=${encodeURIComponent(value)}` as Href
      );
    },
    [recordCompleted, stackSafeRouter]
  );

  const choosePath = useCallback(
    (next: 'cloud' | 'remote') => {
      if (next === 'cloud') {
        handOff(PRESELECT_CLOUD_RUN_ON);
        return;
      }
      setPath('remote');
    },
    [handOff]
  );

  // Returning to the fork from the computer step. Going back is not a
  // decision: it must not record the tour or navigate away.
  const toFork = useCallback(() => {
    setPath('fork');
  }, []);

  // Android hardware Back must agree with the visible control. On the computer
  // step it returns to the fork, exactly like the header's back control; on the
  // fork it records the decision and dismisses, exactly like Skip. Returning
  // `true` stops the modal's default pop, which would dismiss without
  // recording. The listener belongs to the route's focus, so leaving the tour —
  // through the hand-off's replace or Skip's back — releases it with the route.
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        if (path === 'remote') {
          toFork();
          return true;
        }
        dismiss();
        return true;
      });
      return () => {
        subscription.remove();
      };
    }, [dismiss, path, toFork])
  );

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        eyebrow={t('tour.eyebrow')}
        showBackButton={path === 'remote'}
        onBack={toFork}
      />

      <View className="flex-1">
        {path === 'fork' ? <ForkStep onChoose={choosePath} /> : null}
        {path === 'remote' ? <TourRemoteStep onChooseComputer={handOff} /> : null}
      </View>

      {/* Action bar: Skip is always available so a slow or failing computer
          list can never trap the person; every other exit is a hand-off from
          the step itself. The bottom inset is dynamic, so it goes through
          `style` like ScreenHeader and the pr-review footers. */}
      <View
        className="flex-row items-center gap-3 px-6 pt-2"
        style={{ paddingBottom: Math.max(insets.bottom, 16) }}
      >
        <Button variant="ghost" className="flex-1" onPress={dismiss}>
          <Text>{t('tour.skip')}</Text>
        </Button>
      </View>
    </View>
  );
}
