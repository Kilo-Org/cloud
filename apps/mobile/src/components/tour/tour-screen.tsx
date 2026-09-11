import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/screen-header';
import { TourCloudStep } from '@/components/tour/tour-cloud-step';
import { TourRemoteStep } from '@/components/tour/tour-remote-step';
import { Button } from '@/components/ui/button';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Cloud, type LucideIcon, Monitor, Sparkles } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTourCompletion } from '@/lib/tour/tour-completion';

/**
 * The first-sign-in tour shell.
 *
 * The fork is the only step the shell owns; each chosen path is rendered by
 * its own step component (s2 cloud, s3 remote), which reports completion back
 * through `onCompletedChange`. Skip and Android hardware Back are one decision
 * — record the per-account decision the instant the person dismisses, then pop
 * back to the screen that opened the tour (Home on auto-open, Profile on the
 * Tutorial replay). Nothing here ever clears the decision.
 */

type TourPath = 'fork' | 'cloud' | 'remote';

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
    <View className="flex-1 justify-center gap-8 px-6">
      <View className="items-center gap-4">
        <View className="h-20 w-20 items-center justify-center rounded-3xl border border-border bg-card">
          <Sparkles size={36} color={colors.foreground} />
        </View>
        <View className="items-center gap-1">
          <Text variant="h3" className="text-center">
            {t('tour.forkTitle')}
          </Text>
          <Text variant="muted" className="text-center text-base">
            {t('tour.forkSubtitle')}
          </Text>
        </View>
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
          body={t('tour.remoteOptionBody')}
          onPress={() => {
            onChoose('remote');
          }}
        />
      </View>
    </View>
  );
}

export function TourScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { userId } = useCurrentUserId();
  const { recordCompleted } = useTourCompletion(userId);

  const [path, setPath] = useState<TourPath>('fork');
  const [stepCompleted, setStepCompleted] = useState(false);

  // One dismissal decision: record it synchronously (the hook flips its
  // in-memory state before returning and persists in the background), then
  // return to whoever opened the tour.
  const dismiss = useCallback(() => {
    recordCompleted();
    router.back();
  }, [recordCompleted, router]);

  const choosePath = useCallback((next: Exclude<TourPath, 'fork'>) => {
    setStepCompleted(false);
    setPath(next);
  }, []);

  const handleCompletedChange = useCallback((completed: boolean) => {
    setStepCompleted(completed);
  }, []);

  // Android hardware Back must record the decision on the spot, exactly like
  // Skip. Returning `true` stops the modal's default pop, which would dismiss
  // without recording. The listener belongs to the route's focus, not merely
  // its mount: a step that pushes its own screen (the cloud step's New-session
  // form) blurs the tour, so Back there belongs to that screen — cancelling
  // the form is not a tour dismissal and must not record the decision.
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        dismiss();
        return true;
      });
      return () => {
        subscription.remove();
      };
    }, [dismiss])
  );

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader eyebrow={t('tour.eyebrow')} showBackButton={false} />

      <View className="flex-1">
        {path === 'fork' ? <ForkStep onChoose={choosePath} /> : null}
        {path === 'cloud' ? <TourCloudStep onCompletedChange={handleCompletedChange} /> : null}
        {path === 'remote' ? <TourRemoteStep onCompletedChange={handleCompletedChange} /> : null}
      </View>

      {/* Action bar: Skip is always available so a slow or failing step can
          never trap the person; Done appears only once a path is chosen and
          stays disabled until that step reports its real check. The bottom
          inset is dynamic, so it goes through `style` like ScreenHeader and
          the pr-review footers. */}
      <View
        className="flex-row items-center gap-3 px-6 pt-2"
        style={{ paddingBottom: Math.max(insets.bottom, 16) }}
      >
        <Button variant="ghost" className="flex-1" onPress={dismiss}>
          <Text>{t('tour.skip')}</Text>
        </Button>
        {path === 'fork' ? null : (
          <Button className="flex-1" disabled={!stepCompleted} onPress={dismiss}>
            <Text>{t('common.done')}</Text>
          </Button>
        )}
      </View>
    </View>
  );
}
