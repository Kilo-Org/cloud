'use client';

import type { ExecPreset } from './claw.types';
import { OnboardingStepView } from './OnboardingStepView';
import { PermissionPresetCards } from './PermissionPresetCards';

export function PermissionStep({
  instanceRunning,
  onSelect,
}: {
  instanceRunning: boolean;
  onSelect: (preset: ExecPreset) => void;
}) {
  return (
    <OnboardingStepView
      currentStep={3}
      totalSteps={5}
      title="Set Bot Permissions"
      description="Choose how your KiloClaw bot handles actions on your behalf."
      showProvisioningBanner={!instanceRunning}
    >
      <PermissionPresetCards onSelect={onSelect} />
    </OnboardingStepView>
  );
}
