import { Redirect, useLocalSearchParams } from 'expo-router';

import {
  OrganizationInvoicesFixture,
  organizationInvoicesFixtureState,
} from '@/components/organization/organization-invoices-fixture';

export default function InvoicesFixtureRoute() {
  const { state } = useLocalSearchParams<{ state?: string }>();
  return __DEV__ ? (
    <OrganizationInvoicesFixture state={organizationInvoicesFixtureState(state)} />
  ) : (
    <Redirect href="/(app)" />
  );
}
