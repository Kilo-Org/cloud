import { SecurityFindingsPage } from '@/components/security-agent/SecurityFindingsPage';
import { Suspense } from 'react';

export default function FindingsPage() {
  return (
    <Suspense
      fallback={
        <div className="text-muted-foreground block py-16 text-center text-sm">
          Loading findings...
        </div>
      }
    >
      <SecurityFindingsPage />
    </Suspense>
  );
}
