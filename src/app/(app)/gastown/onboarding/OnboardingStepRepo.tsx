'use client';

import { useOnboarding } from './OnboardingContext';

export function OnboardingStepRepo() {
  const { state } = useOnboarding();

  return (
    <div className="flex flex-col items-center justify-center py-12">
      <h2 className="text-xl font-semibold text-white/90">Connect a repo</h2>
      <p className="mt-2 text-sm text-white/40">Choose a repository for your agents to work on.</p>
      <div className="mt-6 rounded-lg border border-white/10 bg-white/[0.03] px-6 py-4 text-sm text-white/60">
        Step 2: Repo — current value: {state.repo?.fullName || '(none selected)'}
      </div>
    </div>
  );
}
