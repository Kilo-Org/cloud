import { SecurityFindingsPage } from '@/components/security-agent/SecurityFindingsPage';
import { smartAppBannerItunes } from '@/lib/smart-app-banner';
import { Suspense } from 'react';

export const metadata = { itunes: smartAppBannerItunes('/security-agent/findings') };

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
