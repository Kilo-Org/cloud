import { SecurityFindingsPage } from '@/components/security-agent/SecurityFindingsPage';
import { Suspense } from 'react';

export default function FindingsPage() {
  return (
    <Suspense
      fallback={
        <output className="text-muted-foreground block py-16 text-center text-sm">
          Loading findings...
        </output>
      }
    >
      <SecurityFindingsPage />
    </Suspense>
  );
}
