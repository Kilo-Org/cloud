'use client';

import { useOnboarding } from './OnboardingContext';

export function OnboardingStepTask() {
  const { state } = useOnboarding();

  return (
    <div className="flex flex-col items-center justify-center py-12">
      <h2 className="text-xl font-semibold text-white/90">Give your first task</h2>
      <p className="mt-2 text-sm text-white/40">
        Tell your Mayor what to work on. This will be your first conversation.
      </p>
      <div className="mt-6 rounded-lg border border-white/10 bg-white/[0.03] px-6 py-4 text-sm text-white/60">
        Step 4: Task — current value: {state.firstTask || '(empty)'}
      </div>
    </div>
  );
}
