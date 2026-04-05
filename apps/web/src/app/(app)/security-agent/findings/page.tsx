import { SecurityFindingsPage } from '@/components/security-agent/SecurityFindingsPage';
import { Suspense } from 'react';

export default function FindingsPage() {
  return (
    <Suspense>
      <SecurityFindingsPage />
    </Suspense>
  );
}
