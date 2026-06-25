import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { getUserFromAuth } from '@/lib/user/server';
import { AskUsageContent } from '@/modules/ask-usage/client/AskUsageContent';

export default async function AskUsagePage() {
  const { user } = await getUserFromAuth({ adminOnly: true });
  if (!user) notFound();

  return (
    <Suspense
      fallback={
        <div className="flex h-[calc(100dvh-3.5rem)] items-center justify-center">Loading...</div>
      }
    >
      <AskUsageContent />
    </Suspense>
  );
}
