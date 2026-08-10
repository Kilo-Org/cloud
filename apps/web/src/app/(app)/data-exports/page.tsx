import { getUserFromAuth } from '@/lib/user/server';
import { notFound } from 'next/navigation';
import { PageLayout } from '@/components/PageLayout';
import { DataExportsClient } from './DataExportsClient';

export default async function DataExportsPage() {
  const { user } = await getUserFromAuth({ adminOnly: false });
  if (!user) notFound();

  return (
    <PageLayout
      title="Data exports"
      subtitle="Request and download a copy of the data stored with your Kilo account."
    >
      <DataExportsClient />
    </PageLayout>
  );
}
