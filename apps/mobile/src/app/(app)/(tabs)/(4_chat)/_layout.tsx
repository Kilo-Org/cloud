import { Stack } from 'expo-router';
import { appSceneLayout } from '@/components/app-screen-layout';

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function ChatLayout() {
  return <Stack screenLayout={appSceneLayout} screenOptions={{ headerShown: false }} />;
}
