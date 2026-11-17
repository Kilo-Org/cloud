import { AuthPageLayout } from '@/components/auth/AuthPageLayout';
import { PendingLinkForm } from '@/components/auth/PendingLinkForm';
import React from 'react';

export default async function PendingLinkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const params = await searchParams;
  return (
    <AuthPageLayout>
      <div className="mt-4 flex flex-col items-center">
        <PendingLinkForm initialError={params['error']} confirm={params['confirm'] === '1'} />
      </div>
    </AuthPageLayout>
  );
}
