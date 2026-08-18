import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { PageLayout } from '@/components/PageLayout';
import { DataExportsClient } from './DataExportsClient';
import { RequestDataDeletionCard } from './RequestDataDeletionCard';

export default async function DataExportsPage() {
  await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/data-exports');

  return (
    <PageLayout
      title="Data exports"
      subtitle="Request and download a copy of the data stored with your Kilo account."
    >
      <DataExportsClient />
      <RequestDataDeletionCard />
    </PageLayout>
  );
}
