import { Stack } from 'expo-router';

// formSheet screens (rename, invite, etc.) get registered here in a later
// task — see src/app/(app)/_layout.tsx for the Android fullSheetDetent pattern.
export default function OrganizationLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
