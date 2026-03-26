/**
 * Pure domain logic for the onboarding wizard, extracted for testability.
 * No React imports, no 'use client' — safe to run in any environment.
 */

// ---------------------------------------------------------------------------
// Town name validation
// ---------------------------------------------------------------------------
export const TOWN_NAME_MAX_LENGTH = 48;
export const TOWN_NAME_PATTERN = /^[a-zA-Z0-9-]*$/;

export function deriveDefaultTownName(userName: string | null | undefined): string {
  if (!userName) return '';
  const firstName = userName.split(/\s+/)[0];
  if (!firstName) return '';
  const slug = firstName.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return slug ? `${slug}-town` : '';
}

export function validateTownName(name: string): string | null {
  if (!name.trim()) return 'Town name is required';
  if (name.length > TOWN_NAME_MAX_LENGTH)
    return `Town name must be ${TOWN_NAME_MAX_LENGTH} characters or fewer`;
  if (!TOWN_NAME_PATTERN.test(name)) return 'Only letters, numbers, and hyphens are allowed';
  if (name.startsWith('-') || name.endsWith('-'))
    return 'Town name cannot start or end with a hyphen';
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
      mayor: 'kilo/frontier',
      refinery: 'kilo/frontier',
      polecat: 'kilo/frontier',
    },
  },
  {
    key: 'balanced',
    name: 'Balanced',
    description: 'Smart defaults — frontier review, balanced elsewhere',
    cost: '$$',
    models: {
      mayor: 'kilo/balanced',
      refinery: 'kilo/frontier',
      polecat: 'kilo/balanced',
    },
  },
  {
    key: 'cost-effective',
    name: 'Cost-Effective',
    description: 'Balanced models everywhere for lower cost',
    cost: '$',
    models: {
      mayor: 'kilo/balanced',
      refinery: 'kilo/balanced',
      polecat: 'kilo/balanced',
    },
  },
  {
    key: 'free',
    name: 'Free Tier',
    description: 'Try it out at no cost',
    cost: 'free',
    models: {
      mayor: 'kilo/free',
      refinery: 'kilo/free',
      polecat: 'kilo/free',
    },
  },
];

/** Derive the config shape stored in OnboardingState from a preset. */
export function presetToConfig(preset: ModelPreset, customModels: CustomModels) {
  if (preset === 'custom') {
    const mayorModel = customModels.mayor ?? 'kilo/balanced';
    return {
      default_model: mayorModel,
      role_models: {
        mayor: mayorModel,
        refinery: customModels.refinery ?? 'kilo/balanced',
        polecat: customModels.polecat ?? 'kilo/balanced',
      },
    };
  }

  const presetConfig = PRESETS.find(p => p.key === preset);
  if (!presetConfig) {
    return { default_model: 'kilo/balanced', role_models: {} };
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
