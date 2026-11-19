import { Redirect, useLocalSearchParams } from 'expo-router';

import { LowBalanceAlertRefusalFixture } from '@/components/organization/low-balance-alert-refusal-fixture';

/**
 * Development-only route for the design gate. It opens the low-balance alert
 * sheet's form in the state a rejected save leaves for a lapsed organization
 * plan: the refusal line above Save, which stays in its disabled style.
 *
 * `?billing=1` paints the reader who may change the plan — the sentence that
 * offers the step plus the billing step itself — so the gate can capture both
 * readers of the same element. Reached through the development fixture path in
 * `src/app/+native-intent.tsx`, and refused outright in a release build so the
 * fixture is never reachable.
 */
export default function LowBalanceAlertRefusalFixtureRoute() {
  const params = useLocalSearchParams<{ billing?: string | string[] }>();
  const billing = Array.isArray(params.billing) ? params.billing[0] : params.billing;
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return <LowBalanceAlertRefusalFixture canManageBilling={billing === '1'} />;
}
