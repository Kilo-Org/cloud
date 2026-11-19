import { Redirect, useLocalSearchParams } from 'expo-router';

import {
  PersonalInvoicesFixture,
  personalInvoicesFixtureState,
} from '@/components/personal-invoices-fixture';

export default function PersonalInvoicesFixtureRoute() {
  const { state } = useLocalSearchParams<{ state?: string }>();
  return __DEV__ ? (
    <PersonalInvoicesFixture state={personalInvoicesFixtureState(state)} />
  ) : (
    <Redirect href="/(app)" />
  );
}
