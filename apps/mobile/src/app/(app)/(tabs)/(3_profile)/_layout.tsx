import { Stack } from 'expo-router';

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
    // The Kilo Pass card on this route renders the purchase presentation and
    // the subscription state; refresh exactly those. Never the whole `kiloPass`
    // prefix: it also matches the 5-minute store-product catalog, and marking
    // that invalidated made every re-entry of the Kilo Pass screen re-issue
    // `getMobileStoreProducts` instead of painting the cached tiers.
    [['kiloPass', 'getPurchasePresentation']],
    [['kiloPass', 'getState']],
  ]);
  return <Stack screenOptions={{ headerShown: false }} />;
}
