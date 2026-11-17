import { Redirect, useLocalSearchParams } from 'expo-router';

import {
  CreditPackPricesFixture,
  isCreditPackPricesFixtureState,
} from '@/components/credits/credit-pack-prices-fixture';

/**
 * Development-only route for the design gate: the Buy credits screen against
 * fixed store answers, so the priced, partly priced and unresolved states are
 * measurable on a device with no store connection. The development fixture path
 * in `src/app/+native-intent.tsx` maps to it, and a release build refuses the
 * path outright so the fixture is never reachable.
 */
export default function CreditPackPricesFixtureRoute() {
  const { state } = useLocalSearchParams<{ state?: string }>();
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  const fixtureState = isCreditPackPricesFixtureState(state) ? state : 'partly-priced';
  return <CreditPackPricesFixture state={fixtureState} />;
}
