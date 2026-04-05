'use client';

import { Suspense } from 'react';
import { SessionsPageContent } from './SessionsPageContent';

export default function SessionsPage() {
  return (
    <Suspense
      fallback={<div className="flex h-screen items-center justify-center">Loading...</div>}
    >
      <SessionsPageContent />
    </Suspense>
  );
}
