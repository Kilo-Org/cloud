'use client';

import {
  ModeCombobox,
  NEXT_MODE_OPTIONS,
  type ModeComboboxProps,
} from '@/components/shared/ModeCombobox';
import { useBuiltinAgentSettings } from '@/hooks/useCloudAgentSettings';
import type { AgentMode } from './types';

export function CloudAgentModeCombobox({
  isLoading,
  ...props
}: Omit<ModeComboboxProps<AgentMode>, 'options'>) {
  const { data: agents, isLoading: isLoadingSettings, isError } = useBuiltinAgentSettings();
  const options = NEXT_MODE_OPTIONS.filter(
    mode =>
      mode.value === 'code' ||
      mode.value === props.value ||
      (agents !== undefined && agents[mode.value]?.disable !== true)
  );

  return (
    <>
      <ModeCombobox {...props} options={options} isLoading={isLoading || isLoadingSettings} />
      {agents === undefined && isError && (
        <span role="status" className="text-destructive text-xs">
          Could not load mode preferences. Refresh to try again.
        </span>
      )}
    </>
  );
}
