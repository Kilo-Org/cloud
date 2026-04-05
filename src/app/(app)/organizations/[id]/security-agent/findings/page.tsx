import { SecurityFindingsPage } from '@/components/security-agent/SecurityFindingsPage';
import { Suspense } from 'react';

export default function OrgFindingsPage() {
  return (
    <Suspense>
      <SecurityFindingsPage />
    </Suspense>
  );
}
