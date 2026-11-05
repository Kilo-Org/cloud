'use client';

import React, { useEffect } from 'react';
import { StepUpCeremonyContent } from './StepUpDialog';
import { setStepUpInterstitialVisible } from './step-up-interstitial-state';
import type { StepUpRequirement } from './step-up-error';

export function AdminStepUpInterstitial({
  requirement,
  variant = 'embedded',
}: {
  requirement: StepUpRequirement;
  variant?: 'page' | 'embedded';
}) {
  useEffect(() => {
    setStepUpInterstitialVisible(true);
    return () => setStepUpInterstitialVisible(false);
  }, []);

  return (
    <section className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm">
        <StepUpCeremonyContent
          requirement={requirement}
          onVerified={() => window.location.reload()}
          onCancel={() => {}}
          dismissible={false}
          headings="plain"
          headingLevel={variant === 'page' ? 'h1' : 'h2'}
        />
      </div>
    </section>
  );
}
