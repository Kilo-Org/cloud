import { Stack } from 'expo-router';
import { appSceneLayout } from '@/components/app-screen-layout';

import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function ProfileLayout() {
  useRouteForegroundRefresh([
    [['user']],
    [['organizations']],
    [['personalReviewAgent']],
    [['securityAgent']],
    [['kiloPass']],
    [['agentProfiles']],
  ]);
  return <Stack screenLayout={appSceneLayout} screenOptions={{ headerShown: false }} />;
}
