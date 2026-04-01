/**
 * Pure domain logic for the onboarding wizard, extracted for testability.
 * No React imports, no 'use client' — safe to run in any environment.
 */

// ---------------------------------------------------------------------------
// Town name validation
// ---------------------------------------------------------------------------
export const TOWN_NAME_MAX_LENGTH = 48;

export function deriveDefaultTownName(userName: string | null | undefined): string {
  if (!userName) return '';
  const firstName = userName.split(/\s+/)[0];
  if (!firstName) return '';
  return `${firstName}'s Town`;
}

export function validateTownName(name: string): string | null {
  if (!name.trim()) return 'Town name is required';
  if (name.length > TOWN_NAME_MAX_LENGTH)
    return `Town name must be ${TOWN_NAME_MAX_LENGTH} characters or fewer`;
  return null;
}

// ---------------------------------------------------------------------------
// Git URL resolution
// ---------------------------------------------------------------------------
export function resolveGitUrlFromRepo(
  platform: 'github' | 'gitlab',
  fullName: string,
  gitlabInstanceUrl?: string
): string {
  if (platform === 'gitlab') {
    const baseUrl = (gitlabInstanceUrl ?? 'https://gitlab.com').replace(/\/+$/, '');
    return `${baseUrl}/${fullName}.git`;
  }
  return `https://github.com/${fullName}.git`;
}

// ---------------------------------------------------------------------------
// Model presets
// ---------------------------------------------------------------------------
export type ModelPreset = 'frontier' | 'balanced' | 'cost-effective' | 'free' | 'custom';

export type CustomModels = {
  mayor?: string;
  refinery?: string;
  polecat?: string;
};

export type PresetConfig = {
  key: ModelPreset;
  name: string;
  description: string;
  cost: string;
  models: {
    mayor: string;
    refinery: string;
    polecat: string;
  };
};

export const PRESETS: PresetConfig[] = [
  {
    key: 'frontier',
    name: 'Maximum Frontier',
    description: 'Best quality across all roles',
    cost: '$$$',
    models: {
      mayor: 'kilo-auto/frontier',
      refinery: 'kilo-auto/frontier',
      polecat: 'kilo-auto/frontier',
    },
  },
  {
    key: 'balanced',
    name: 'Balanced',
    description: 'Smart defaults — frontier review, balanced elsewhere',
    cost: '$$',
    models: {
      mayor: 'kilo-auto/balanced',
      refinery: 'kilo-auto/frontier',
      polecat: 'kilo-auto/balanced',
    },
  },
  {
    key: 'cost-effective',
    name: 'Cost-Effective',
    description: 'Balanced models everywhere for lower cost',
    cost: '$',
    models: {
      mayor: 'kilo-auto/balanced',
      refinery: 'kilo-auto/balanced',
      polecat: 'kilo-auto/balanced',
    },
  },
  {
    key: 'free',
    name: 'Free Tier',
    description: 'Try it out at no cost',
    cost: 'free',
    models: {
      mayor: 'kilo-auto/free',
      refinery: 'kilo-auto/free',
      polecat: 'kilo-auto/free',
    },
  },
];

/** Derive the config shape stored in OnboardingState from a preset. */
export function presetToConfig(preset: ModelPreset, customModels: CustomModels) {
  if (preset === 'custom') {
    const mayorModel = customModels.mayor ?? 'kilo-auto/balanced';
    return {
      default_model: mayorModel,
      role_models: {
        mayor: mayorModel,
        refinery: customModels.refinery ?? 'kilo-auto/balanced',
        polecat: customModels.polecat ?? 'kilo-auto/balanced',
      },
    };
  }

  const presetConfig = PRESETS.find(p => p.key === preset);
  if (!presetConfig) {
    return { default_model: 'kilo-auto/balanced', role_models: {} };
  }

  const { mayor, refinery, polecat } = presetConfig.models;

  // Only include role_models entries that differ from the default (mayor) model
  const role_models: Record<string, string> = {};
  if (refinery !== mayor) role_models.refinery = refinery;
  if (polecat !== mayor) role_models.polecat = polecat;

  return {
    default_model: mayor,
    role_models,
  };
}

// ---------------------------------------------------------------------------
// Task submission
// ---------------------------------------------------------------------------
export const FIRST_TASK_STORAGE_PREFIX = 'gastown_first_task_';

export type CreationPhase =
  | 'idle'
  | 'creating-town'
  | 'creating-rig'
  | 'configuring-models'
  | 'redirecting';

export const PHASE_LABELS: Record<CreationPhase, string> = {
  idle: '',
  'creating-town': 'Creating your town...',
  'creating-rig': 'Adding repository...',
  'configuring-models': 'Configuring models...',
  redirecting: 'Launching your town...',
};
