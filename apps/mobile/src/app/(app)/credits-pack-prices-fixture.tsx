import { Redirect, useLocalSearchParams } from 'expo-router';

import {
  CreditPackPricesFixture,
  type CreditPackPricesFixtureState,
} from '@/components/credits/credit-pack-prices-fixture';

/**
 * Development-only route for the design gate: the Buy credits screen against
 * fixed store answers, so the priced and partly priced row states are
 * measurable on a device with no store connection. `?state=priced` prices every
 * pack and `?state=partly-priced` leaves the largest pack unpriced. The
 * development fixture path in `src/app/+native-intent.tsx` maps to it, and a
 * release build refuses the path outright so the fixture is never reachable.
 */
export default function CreditPackPricesFixtureRoute() {
  const { state } = useLocalSearchParams<{ state?: string }>();
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  const resolved: CreditPackPricesFixtureState =
    state === 'priced' || state === 'completing' ? state : 'partly-priced';
  return <CreditPackPricesFixture state={resolved} />;
}
