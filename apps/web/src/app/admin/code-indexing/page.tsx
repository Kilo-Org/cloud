import { Suspense } from 'react';
import { CodeIndexingTable } from '@/app/admin/components/CodeIndexingTable';
import { getUserFromAuth } from '@/lib/user.server';

export default async function CodeIndexingPage() {
  await getUserFromAuth({ adminOnly: true });
  return (
    <Suspense fallback={<div>Loading code indexing stats...</div>}>
      <CodeIndexingTable />
    </Suspense>
  );
}
