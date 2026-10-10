'use client';

/**
 * Session Form Atoms
 *
 * Jotai atoms for managing the cloud agent session creation form state.
 * Separates "manual" additions from "profile" config, with derived atoms
 * for the effective merged configuration.
 *
 * Key concepts:
 * - Manual config: What the user explicitly adds via dialogs
 * - Profile config: What comes from the selected profile
 * - Effective config: Profile + manual merged (manual takes precedence)
 */

import { atom } from 'jotai';
import type { EnvironmentSelectionState } from '@/components/cloud-agent-next/environment-selection';

export type EnvVar = {
  key: string;
  value: string;
  isSecret: boolean;
};

export type ProfileConfig = {
  vars: EnvVar[];
  commands: string[];
};

/**
 * Manual environment variables added by user via EnvVarsDialog
 * These override profile vars with the same key
 */
export const manualEnvVarsAtom = atom<Record<string, string>>({});

/**
 * Manual setup commands added by user via SetupCommandsDialog
 * These are appended to profile commands
 */
export const manualSetupCommandsAtom = atom<string[]>([]);

export const selectedProfileIdAtom = atom<string | null>(null);

/**
 * Currently selected repository environment, paired with the repository
 * identity it belongs to. The identity lives with the id so a remount can tell
 * a real repository change from a fresh component that lost local state, and
 * keep an existing selection.
 */
export const selectedEnvironmentAtom = atom<EnvironmentSelectionState>({
  id: null,
  identity: null,
});

/**
 * Whether we've auto-selected the default profile on initial load
 * Prevents re-selecting after user manually deselects
 */
export const hasAutoSelectedDefaultAtom = atom(false);

export const profileConfigAtom = atom<ProfileConfig | null>(null);

// ============================================================================
// Derived Atoms - Effective Configuration
// ============================================================================

export const effectiveEnvVarsAtom = atom(get => {
  const manual = get(manualEnvVarsAtom);
  const profileConfig = get(profileConfigAtom);

  const effective: Record<string, string> = {};

  if (profileConfig) {
    for (const v of profileConfig.vars) {
      effective[v.key] = v.value;
    }
  }

  for (const [key, value] of Object.entries(manual)) {
    effective[key] = value;
  }

  return effective;
});

/**
 * Effective setup commands: profile + manual merged
 * Manual commands are appended after profile commands (no duplicates)
 */
export const effectiveSetupCommandsAtom = atom(get => {
  const manual = get(manualSetupCommandsAtom);
  const profileConfig = get(profileConfigAtom);

  const profileCommands = profileConfig?.commands || [];

  const commandSet = new Set(profileCommands);
  const effectiveCommands = [...profileCommands];

  for (const cmd of manual) {
    if (!commandSet.has(cmd)) {
      effectiveCommands.push(cmd);
      commandSet.add(cmd);
    }
  }

  return effectiveCommands;
});

export const setManualEnvVarAtom = atom(
  null,
  (get, set, { key, value }: { key: string; value: string }) => {
    const current = get(manualEnvVarsAtom);
    set(manualEnvVarsAtom, { ...current, [key]: value });
  }
);

export const removeManualEnvVarAtom = atom(null, (get, set, key: string) => {
  const current = get(manualEnvVarsAtom);
  const { [key]: _, ...rest } = current;
  set(manualEnvVarsAtom, rest);
});

export const addManualCommandAtom = atom(null, (get, set, command: string) => {
  const current = get(manualSetupCommandsAtom);
  if (!current.includes(command)) {
    set(manualSetupCommandsAtom, [...current, command]);
  }
});

export const removeManualCommandAtom = atom(null, (get, set, index: number) => {
  const current = get(manualSetupCommandsAtom);
  set(
    manualSetupCommandsAtom,
    current.filter((_, i) => i !== index)
  );
});

export const setProfileConfigAtom = atom(null, (_get, set, config: ProfileConfig | null) => {
  set(profileConfigAtom, config);
});

export const selectProfileAtom = atom(null, (_get, set, profileId: string | null) => {
  set(selectedProfileIdAtom, profileId);
  // Don't clear config here - let the React Query effect update it
  // This preserves manual vars when switching profiles
});

export const resetSessionFormAtom = atom(null, (_get, set) => {
  set(manualEnvVarsAtom, {});
  set(manualSetupCommandsAtom, []);
  set(selectedProfileIdAtom, null);
  set(selectedEnvironmentAtom, { id: null, identity: null });
  set(hasAutoSelectedDefaultAtom, false);
  set(profileConfigAtom, null);
});
