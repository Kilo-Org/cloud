/* eslint-disable no-literal-copy/no-literal-copy -- Development-only fixture; its labels never ship. */
import { Redirect, useLocalSearchParams } from 'expo-router';
import { Pressable, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';

/**
 * Development-only route for the header-balance proof: one centered header in
 * each trailing variant the measurement plan names, selected by
 * `?variant=cluster|back-only|no-back` (default `cluster`).
 *
 * `cluster` reproduces the Security Agent settings shape — a centered title
 * beside a Save-style 140dp trailing button and a back control — the
 * combination the fixed `centeredControls` mirror never covered. `back-only`
 * is the shipped combination the old mirror covered (regression guard);
 * `no-back` runs the row with no leading control at all.
 *
 * The route stays reachable only through the dev fixture deep link (mapped in
 * `src/app/+native-intent.tsx`), and a release build redirects.
 */
const VARIANTS = ['cluster', 'back-only', 'no-back'] as const;
type Variant = (typeof VARIANTS)[number];

/** The Save-style cluster: a compact icon slot plus a fixed-width primary. */
function SaveCluster() {
  return (
    <View className="flex-row items-center">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Fixture secondary"
        className="h-[48px] w-[48px] items-center justify-center"
      >
        <Text>◦</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Fixture save"
        className="ms-3 h-[48px] w-[48px] items-center justify-center rounded-full bg-accent"
      >
        <Text className="text-sm font-semibold text-primary-foreground">Save</Text>
      </Pressable>
    </View>
  );
}

function ClusterHeader() {
  return (
    <ScreenHeader
      title="Agent Settings"
      centerTitle
      showBackButton
      headerRight={<SaveCluster />}
      headerRightWidth={110}
    />
  );
}

function BackOnlyHeader() {
  return <ScreenHeader title="Agent Settings" centerTitle showBackButton />;
}

function NoBackHeader() {
  return (
    <ScreenHeader
      title="Agent Settings"
      centerTitle
      showBackButton={false}
      headerRight={<SaveCluster />}
      headerRightWidth={110}
    />
  );
}

const HEADERS = {
  cluster: ClusterHeader,
  'back-only': BackOnlyHeader,
  'no-back': NoBackHeader,
} satisfies Record<Variant, () => React.JSX.Element>;

export default function HeaderBalanceFixtureRoute() {
  const { variant } = useLocalSearchParams<{ variant?: string }>();
  const active: Variant = VARIANTS.includes(variant as Variant) ? (variant as Variant) : 'cluster';
  if (!__DEV__) {
    return <Redirect href="/(auth)/login" />;
  }
  const Header = HEADERS[active];
  return (
    <View className="flex-1 bg-background">
      <Header />
      <View className="flex-1 items-center justify-center">
        <Text testID="header-balance-variant">{`variant: ${active}`}</Text>
      </View>
    </View>
  );
}
