import { type Href, useRouter } from 'expo-router';
import { View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { EmptyStateContent } from '@/components/kiloclaw/empty-state-content';
import { ProfileAvatarButton } from '@/components/profile-avatar-button';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useForegroundInvalidateKiloclawState } from '@/lib/hooks/use-foreground-invalidate-kiloclaw-state';
import { useAllKiloClawInstances } from '@/lib/hooks/use-instance-context';
import { useKiloClawMobileOnboardingState } from '@/lib/hooks/use-kiloclaw-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export default function KiloClawTab() {
  const router = useRouter();
  const colors = useThemeColors();
  const { data: instances } = useAllKiloClawInstances();
  const isEmpty = instances?.length === 0;
  const onboardingQuery = useKiloClawMobileOnboardingState(isEmpty);
  useForegroundInvalidateKiloclawState();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="KiloClaw" showBackButton={false} headerRight={<ProfileAvatarButton />} />
      <Animated.View layout={LinearTransition} className="flex-1 items-center justify-center px-4">
        {onboardingQuery.isPending ? (
          <Animated.View exiting={FadeOut.duration(150)} className="w-full gap-3 px-4">
            <Skeleton className="h-48 w-full rounded-xl" />
          </Animated.View>
        ) : (
          <Animated.View entering={FadeIn.duration(200)}>
            <EmptyStateContent
              foregroundColor={colors.foreground}
              state={onboardingQuery.data}
              onCreate={() => {
                router.push('/(app)/onboarding' as Href);
              }}
            />
          </Animated.View>
        )}
      </Animated.View>
    </View>
  );
}
