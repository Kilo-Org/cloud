'use client';

import { useOnboarding } from './OnboardingContext';

export function OnboardingStepName() {
  const { state } = useOnboarding();

  return (
    <div className="flex flex-col items-center justify-center py-12">
      <h2 className="text-xl font-semibold text-white/90">Name your town</h2>
      <p className="mt-2 text-sm text-white/40">
        This is your workspace where agents will collaborate on your code.
      </p>
      <div className="mt-6 rounded-lg border border-white/10 bg-white/[0.03] px-6 py-4 text-sm text-white/60">
        Step 1: Name — current value: {state.townName || '(empty)'}
      </div>
    </div>
  );
}
