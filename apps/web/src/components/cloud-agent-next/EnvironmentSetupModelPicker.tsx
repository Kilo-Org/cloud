'use client';

import { ModelCombobox } from '@/components/shared/ModelCombobox';
import { VariantCombobox } from '@/components/shared/VariantCombobox';
import type { EnvironmentSetupModelChoice } from './useEnvironmentSetupAgent';

export function EnvironmentSetupModelPicker({
  choice,
  disabled = false,
}: {
  choice: EnvironmentSetupModelChoice;
  disabled?: boolean;
}) {
  return (
    <>
      <ModelCombobox
        modal
        variant="compact"
        className="min-w-0 max-w-full"
        models={choice.options}
        value={choice.model}
        isLoading={choice.isLoading}
        disabled={disabled}
        onValueChange={choice.selectModel}
      />
      <VariantCombobox
        variants={choice.variants}
        value={choice.variant}
        className="min-w-0"
        disabled={disabled}
        onValueChange={choice.selectVariant}
      />
    </>
  );
}
