import { Stack } from 'expo-router';

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function AgentsLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
