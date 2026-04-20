'use client';

import type { ExecPreset } from './claw.types';
import {
  LEGACY_ONBOARDING_PERMISSIONS_STEP,
  LEGACY_ONBOARDING_TOTAL_STEPS,
} from './ClawOnboardingFlow.state';
import { OnboardingStepView } from './OnboardingStepView';
import { PermissionPresetCards } from './PermissionPresetCards';

export function PermissionStep({
  instanceRunning,
  currentStep = LEGACY_ONBOARDING_PERMISSIONS_STEP,
  totalSteps = LEGACY_ONBOARDING_TOTAL_STEPS,
  onSelect,
}: {
  instanceRunning: boolean;
  currentStep?: number;
  totalSteps?: number;
  onSelect: (preset: ExecPreset) => void;
}) {
  return (
    <OnboardingStepView
      currentStep={currentStep}
      totalSteps={totalSteps}
      title="Set Bot Permissions"
      description="Choose how your KiloClaw bot handles actions on your behalf."
      showProvisioningBanner={!instanceRunning}
    >
      <PermissionPresetCards onSelect={onSelect} />
    </OnboardingStepView>
  );
}
