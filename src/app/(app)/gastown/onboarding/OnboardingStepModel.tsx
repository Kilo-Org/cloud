'use client';

import { useOnboarding } from './OnboardingContext';

export function OnboardingStepModel() {
  const { state } = useOnboarding();

  return (
    <div className="flex flex-col items-center justify-center py-12">
      <h2 className="text-xl font-semibold text-white/90">Choose your models</h2>
      <p className="mt-2 text-sm text-white/40">
        Pick a model configuration that fits your needs and budget.
      </p>
      <div className="mt-6 rounded-lg border border-white/10 bg-white/[0.03] px-6 py-4 text-sm text-white/60">
        Step 3: Model — current preset: {state.modelPreset}
      </div>
    </div>
  );
}
