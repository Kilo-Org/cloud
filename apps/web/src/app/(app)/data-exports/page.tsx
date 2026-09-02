import { notFound } from 'next/navigation';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { isCloudDataExportUIEnabled } from '@/lib/user-data-export-ui';
import { PageLayout } from '@/components/PageLayout';
import { DataExportsClient } from './DataExportsClient';
import { RequestDataDeletionCard } from './RequestDataDeletionCard';

export default async function DataExportsPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/data-exports');
  if ((await isCloudDataExportUIEnabled(user.google_user_email)) !== true) {
    notFound();
  }

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
