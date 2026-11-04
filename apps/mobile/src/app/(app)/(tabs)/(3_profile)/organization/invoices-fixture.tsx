import { Redirect } from 'expo-router';

import { OrganizationInvoicesFixture } from '@/components/organization/organization-invoices-fixture';

export default function InvoicesFixtureRoute() {
  return __DEV__ ? <OrganizationInvoicesFixture /> : <Redirect href="/(app)" />;
}
