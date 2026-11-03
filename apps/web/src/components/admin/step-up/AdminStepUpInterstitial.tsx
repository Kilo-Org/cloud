'use client';

import React from 'react';
import { StepUpCeremonyContent } from './StepUpDialog';
import type { StepUpRequirement } from './step-up-error';

export function AdminStepUpInterstitial({ requirement }: { requirement: StepUpRequirement }) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex min-h-screen items-center justify-center p-6"
    >
      <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Verify it is you</h1>
        <p className="mt-1 mb-4 text-sm text-muted-foreground">
          Admin access requires MFA verification for this browser session.
        </p>
        <StepUpCeremonyContent
          requirement={requirement}
          onVerified={() => window.location.reload()}
          onCancel={() => {}}
          dismissible={false}
        />
      </div>
    </main>
  );
}
