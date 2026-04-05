/**
 * AdvancedConfig - Shared component for advanced configuration (profiles, env vars, setup commands)
 *
 * Used by:
 * - CloudSessionsPage for manual cloud agent sessions
 * - Webhook trigger forms for automatic triggers
 *
 * Orchestrates:
 * - ProfileSelector - Select a saved profile (handles secrets)
 * - EnvVarsDialog - Manual env vars (plaintext JSON editor)
 * - SetupCommandsDialog - Manual setup commands (JSON array editor)
 *
 * Key behaviors:
 * - Profile selection shows summary of what's in the profile
 * - Manual vars are merged with profile vars (manual takes precedence)
 * - Effective config count updates in real-time
 * - "Save as profile" button appears when manual vars are set (no profile selected)
 */
'use client';

import { memo, useMemo } from 'react';
import { Label } from '@/components/ui/label';
import { ProfileSelector } from '@/components/cloud-agent/ProfileSelector';
import { EnvVarsDialog } from '@/components/cloud-agent/EnvVarsDialog';
import { SetupCommandsDialog } from '@/components/cloud-agent/SetupCommandsDialog';
import { SaveProfileDialog } from '@/components/cloud-agent/SaveProfileDialog';

export type AdvancedConfigProps = {
  /** Organization ID (optional, for org context) */
  organizationId?: string;
  /** Currently selected profile ID */
  selectedProfileId?: string | null;
  /** Callback when profile selection changes */
  onProfileSelect: (profileId: string | null) => void;
  /** Manual environment variables (overrides profile values) */
  manualEnvVars: Record<string, string>;
  /** Manual setup commands (concatenated with profile commands) */
  manualSetupCommands: string[];
  /** Effective (merged) environment variables for display */
  effectiveEnvVars: Record<string, string>;
  /** Effective (merged) setup commands for display */
  effectiveSetupCommands: string[];
  /** Callback when manual env vars change */
  onManualEnvVarsChange: (vars: Record<string, string>) => void;
  /** Callback when manual setup commands change */
  onManualSetupCommandsChange: (commands: string[]) => void;
  /** Optional label override (defaults to "Advanced Configuration (Optional)") */
  label?: string;
  /** Optional description override */
  description?: string;
  /** Optional className for the container */
  className?: string;
};

/**
 * Shared AdvancedConfig component for profile and manual configuration
 */
export const AdvancedConfig = memo(function AdvancedConfig({
  organizationId,
  selectedProfileId,
  onProfileSelect,
  manualEnvVars,
  manualSetupCommands,
  effectiveEnvVars,
  effectiveSetupCommands,
  onManualEnvVarsChange,
  onManualSetupCommandsChange,
  label = 'Advanced Configuration (Optional)',
  description = 'Select a profile to load saved configurations, and manually configure additional environment variables and setup commands',
  className,
}: AdvancedConfigProps) {
  // Convert effective envVars to array format for SaveProfileDialog
  const envVarsArray = useMemo(() => {
    return Object.entries(effectiveEnvVars).map(([key, value]) => ({
      key,
      value,
      // We don't know if they were originally secrets since the value is masked
      // User can mark them as secrets in the editor if needed
      isSecret: value === '***',
    }));
  }, [effectiveEnvVars]);

  // Check if there are any manual additions (for showing Save as Profile)
  const hasManualConfig = Object.keys(manualEnvVars).length > 0 || manualSetupCommands.length > 0;

  // Counts for display
  const envVarsCount = Object.keys(effectiveEnvVars).length;
  const commandsCount = effectiveSetupCommands.length;
  const hasConfig = envVarsCount > 0 || commandsCount > 0;

  return (
    <div className={className ?? 'space-y-3'}>
      <Label>{label}</Label>

      {/* Profile Selector - Primary way to load env vars and commands */}
      <div className="flex items-center gap-2">
        <ProfileSelector
          organizationId={organizationId}
          selectedProfileId={selectedProfileId ?? null}
          onProfileSelect={onProfileSelect}
        />
        {!selectedProfileId && hasManualConfig && (
          <SaveProfileDialog
            organizationId={organizationId}
            envVars={envVarsArray}
            setupCommands={effectiveSetupCommands}
          />
        )}
      </div>

      {/* Manual override options */}
      <div className="flex flex-wrap gap-2">
        <EnvVarsDialog value={manualEnvVars} onChange={onManualEnvVarsChange} />
        <SetupCommandsDialog value={manualSetupCommands} onChange={onManualSetupCommandsChange} />
      </div>

      {/* Show effective config summary if there's any */}
      {hasConfig && (
        <p className="text-xs text-gray-400">
          {envVarsCount} environment variable
          {envVarsCount !== 1 ? 's' : ''}, {commandsCount} setup command
          {commandsCount !== 1 ? 's' : ''} configured
        </p>
      )}

      <p className="text-xs text-gray-400">{description}</p>
    </div>
  );
});
