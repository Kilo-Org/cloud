import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { isCloudDataExportUIEnabled } from '@/lib/user-data-export-ui';
import { PageLayout } from '@/components/PageLayout';
import { DataExportsClient } from './DataExportsClient';
import { RequestDataDeletionCard } from './RequestDataDeletionCard';

export default async function DataExportsPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/data-exports');
  const exportUIEnabled = (await isCloudDataExportUIEnabled(user.google_user_email)) === true;

  return (
    <PageLayout
      title={exportUIEnabled ? 'Data exports' : 'Data deletion'}
      subtitle={
        exportUIEnabled
          ? 'Request and download a copy of the data stored with your Kilo account.'
          : 'Request deletion of your Kilo account and its data through our support team.'
      }
    >
      {exportUIEnabled && <DataExportsClient />}
      <RequestDataDeletionCard />
    </PageLayout>
  );
}
