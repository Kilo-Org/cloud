import { Redirect, useLocalSearchParams } from 'expo-router';

import { PersonalInvoicesFixture } from '@/components/personal-invoices-fixture';

export default function PersonalInvoicesFixtureRoute() {
  const { state } = useLocalSearchParams<{ state?: string }>();
  return __DEV__ ? (
    <PersonalInvoicesFixture state={state === 'empty' ? 'empty' : 'listed'} />
  ) : (
    <Redirect href="/(app)" />
  );
}
