import { describe, expect, test } from '@jest/globals';

import {
  validateTownName,
  deriveDefaultTownName,
  TOWN_NAME_MAX_LENGTH,
  TOWN_NAME_PATTERN,
  resolveGitUrlFromRepo,
  presetToConfig,
  PRESETS,
  FIRST_TASK_STORAGE_PREFIX,
  PHASE_LABELS,
} from './onboarding.domain';

import type { ModelPreset, CreationPhase } from './onboarding.domain';

// ---------------------------------------------------------------------------
// validateTownName
// ---------------------------------------------------------------------------
describe('validateTownName', () => {
  test('returns error for empty string', () => {
    expect(validateTownName('')).toBe('Town name is required');
  });

  test('returns error for whitespace-only string', () => {
    expect(validateTownName('   ')).toBe('Town name is required');
  });

  test('returns null for a valid alphanumeric name', () => {
    expect(validateTownName('my-town')).toBeNull();
  });

  test('returns null for a single character name', () => {
    expect(validateTownName('a')).toBeNull();
  });

  test('returns null for a name with numbers', () => {
    expect(validateTownName('town-42')).toBeNull();
  });

  test('returns null for name at exactly max length', () => {
    const name = 'a'.repeat(TOWN_NAME_MAX_LENGTH);
    expect(validateTownName(name)).toBeNull();
  });

  test('returns error when name exceeds max length', () => {
    const name = 'a'.repeat(TOWN_NAME_MAX_LENGTH + 1);
    expect(validateTownName(name)).toBe(
      `Town name must be ${TOWN_NAME_MAX_LENGTH} characters or fewer`
    );
  });

  test('returns error for names with spaces', () => {
    expect(validateTownName('my town')).toBe('Only letters, numbers, and hyphens are allowed');
  });

  test('returns error for names with underscores', () => {
    expect(validateTownName('my_town')).toBe('Only letters, numbers, and hyphens are allowed');
  });

  test('returns error for names with special characters', () => {
    expect(validateTownName('my@town!')).toBe('Only letters, numbers, and hyphens are allowed');
  });

  test('returns error for names with dots', () => {
    expect(validateTownName('my.town')).toBe('Only letters, numbers, and hyphens are allowed');
  });

  test('returns error for names starting with a hyphen', () => {
    expect(validateTownName('-my-town')).toBe('Town name cannot start or end with a hyphen');
  });

  test('returns error for names ending with a hyphen', () => {
    expect(validateTownName('my-town-')).toBe('Town name cannot start or end with a hyphen');
  });

  test('returns error for a name that is just a hyphen', () => {
    expect(validateTownName('-')).toBe('Town name cannot start or end with a hyphen');
  });

  test('returns error for names starting and ending with hyphens', () => {
    expect(validateTownName('-town-')).toBe('Town name cannot start or end with a hyphen');
  });

  test('allows consecutive hyphens in the middle', () => {
    expect(validateTownName('my--town')).toBeNull();
  });

  test('allows uppercase letters', () => {
    expect(validateTownName('MyTown')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TOWN_NAME_MAX_LENGTH & TOWN_NAME_PATTERN
// ---------------------------------------------------------------------------
describe('TOWN_NAME_MAX_LENGTH', () => {
  test('is 48', () => {
    expect(TOWN_NAME_MAX_LENGTH).toBe(48);
  });
});

describe('TOWN_NAME_PATTERN', () => {
  test('matches alphanumeric and hyphens', () => {
    expect(TOWN_NAME_PATTERN.test('abc-123')).toBe(true);
    expect(TOWN_NAME_PATTERN.test('ABC')).toBe(true);
    expect(TOWN_NAME_PATTERN.test('')).toBe(true); // empty matches the *-quantifier
  });

  test('rejects non-alphanumeric, non-hyphen characters', () => {
    expect(TOWN_NAME_PATTERN.test('abc def')).toBe(false);
    expect(TOWN_NAME_PATTERN.test('abc_def')).toBe(false);
    expect(TOWN_NAME_PATTERN.test('abc.def')).toBe(false);
    expect(TOWN_NAME_PATTERN.test('abc@def')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveDefaultTownName
// ---------------------------------------------------------------------------
describe('deriveDefaultTownName', () => {
  test('returns empty string for null', () => {
    expect(deriveDefaultTownName(null)).toBe('');
  });

  test('returns empty string for undefined', () => {
    expect(deriveDefaultTownName(undefined)).toBe('');
  });

  test('returns empty string for empty string', () => {
    expect(deriveDefaultTownName('')).toBe('');
  });

  test('derives slug-town from a simple first name', () => {
    expect(deriveDefaultTownName('Alice')).toBe('alice-town');
  });

  test('uses only the first name (splits on whitespace)', () => {
    expect(deriveDefaultTownName('Bob Smith')).toBe('bob-town');
  });

  test('strips non-alphanumeric, non-hyphen characters', () => {
    expect(deriveDefaultTownName("O'Brien")).toBe('obrien-town');
  });

  test('handles names with accented characters by stripping them', () => {
    // accented chars like é are stripped by the regex /[^a-z0-9-]/g
    expect(deriveDefaultTownName('José')).toBe('jos-town');
  });

  test('returns empty string if first name reduces to empty after stripping', () => {
    expect(deriveDefaultTownName('!!!!')).toBe('');
  });

  test('handles multiple spaces between names', () => {
    expect(deriveDefaultTownName('Alice   Smith')).toBe('alice-town');
  });

  test('lowercases the result', () => {
    expect(deriveDefaultTownName('ALICE')).toBe('alice-town');
  });

  test('handles name with hyphens', () => {
    expect(deriveDefaultTownName('Mary-Jane Watson')).toBe('mary-jane-town');
  });
});

// ---------------------------------------------------------------------------
// resolveGitUrlFromRepo
// ---------------------------------------------------------------------------
describe('resolveGitUrlFromRepo', () => {
  test('returns github URL for github platform', () => {
    expect(resolveGitUrlFromRepo('github', 'octocat/hello-world')).toBe(
      'https://github.com/octocat/hello-world.git'
    );
  });

  test('returns gitlab.com URL for gitlab platform without custom instance', () => {
    expect(resolveGitUrlFromRepo('gitlab', 'group/project')).toBe(
      'https://gitlab.com/group/project.git'
    );
  });

  test('returns gitlab.com URL when gitlabInstanceUrl is undefined', () => {
    expect(resolveGitUrlFromRepo('gitlab', 'group/project', undefined)).toBe(
      'https://gitlab.com/group/project.git'
    );
  });

  test('uses custom gitlab instance URL', () => {
    expect(resolveGitUrlFromRepo('gitlab', 'group/project', 'https://gitlab.example.com')).toBe(
      'https://gitlab.example.com/group/project.git'
    );
  });

  test('strips trailing slashes from gitlab instance URL', () => {
    expect(resolveGitUrlFromRepo('gitlab', 'group/project', 'https://gitlab.example.com/')).toBe(
      'https://gitlab.example.com/group/project.git'
    );
  });

  test('strips multiple trailing slashes from gitlab instance URL', () => {
    expect(resolveGitUrlFromRepo('gitlab', 'group/project', 'https://gitlab.example.com///')).toBe(
      'https://gitlab.example.com/group/project.git'
    );
  });

  test('handles nested group paths on gitlab', () => {
    expect(resolveGitUrlFromRepo('gitlab', 'org/subgroup/project')).toBe(
      'https://gitlab.com/org/subgroup/project.git'
    );
  });
});

// ---------------------------------------------------------------------------
// presetToConfig
// ---------------------------------------------------------------------------
describe('presetToConfig', () => {
  test('returns frontier config with all roles set to kilo/frontier', () => {
    const config = presetToConfig('frontier', {});
    expect(config.default_model).toBe('kilo/frontier');
    // All roles are the same as default, so role_models should be empty
    expect(config.role_models).toEqual({});
  });

  test('returns balanced config with frontier for refinery only', () => {
    const config = presetToConfig('balanced', {});
    expect(config.default_model).toBe('kilo/balanced');
    expect(config.role_models).toEqual({ refinery: 'kilo/frontier' });
  });

  test('returns cost-effective config with all kilo/balanced', () => {
    const config = presetToConfig('cost-effective', {});
    expect(config.default_model).toBe('kilo/balanced');
    expect(config.role_models).toEqual({});
  });

  test('returns free config with all kilo/free', () => {
    const config = presetToConfig('free', {});
    expect(config.default_model).toBe('kilo/free');
    expect(config.role_models).toEqual({});
  });

  test('returns custom config with provided models', () => {
    const config = presetToConfig('custom', {
      mayor: 'openai/gpt-4.1',
      refinery: 'anthropic/claude-opus-4',
      polecat: 'openai/gpt-4.1-mini',
    });
    expect(config.default_model).toBe('openai/gpt-4.1');
    expect(config.role_models).toEqual({
      mayor: 'openai/gpt-4.1',
      refinery: 'anthropic/claude-opus-4',
      polecat: 'openai/gpt-4.1-mini',
    });
  });

  test('uses kilo/balanced as default for missing custom model values', () => {
    const config = presetToConfig('custom', {});
    expect(config.default_model).toBe('kilo/balanced');
    expect(config.role_models).toEqual({
      mayor: 'kilo/balanced',
      refinery: 'kilo/balanced',
      polecat: 'kilo/balanced',
    });
  });

  test('uses kilo/balanced for partially-specified custom models', () => {
    const config = presetToConfig('custom', { mayor: 'openai/gpt-4.1' });
    expect(config.default_model).toBe('openai/gpt-4.1');
    expect(config.role_models).toEqual({
      mayor: 'openai/gpt-4.1',
      refinery: 'kilo/balanced',
      polecat: 'kilo/balanced',
    });
  });

  test('returns fallback for unknown preset key', () => {
    const config = presetToConfig('nonexistent' as ModelPreset, {});
    expect(config.default_model).toBe('kilo/balanced');
    expect(config.role_models).toEqual({});
  });

  test('only includes role_models entries that differ from the default model', () => {
    // balanced: mayor=kilo/balanced, refinery=kilo/frontier, polecat=kilo/balanced
    // refinery differs from default (mayor), so only refinery appears
    const config = presetToConfig('balanced', {});
    expect(Object.keys(config.role_models)).toEqual(['refinery']);
  });
});

// ---------------------------------------------------------------------------
// PRESETS constant
// ---------------------------------------------------------------------------
describe('PRESETS', () => {
  test('contains exactly 4 presets', () => {
    expect(PRESETS).toHaveLength(4);
  });

  test('has the expected preset keys in order', () => {
    const keys = PRESETS.map(p => p.key);
    expect(keys).toEqual(['frontier', 'balanced', 'cost-effective', 'free']);
  });

  test('balanced is the second preset (index 1)', () => {
    expect(PRESETS[1].key).toBe('balanced');
  });

  test('each preset has name, description, cost, and models', () => {
    for (const preset of PRESETS) {
      expect(preset.name).toBeTruthy();
      expect(preset.description).toBeTruthy();
      expect(preset.cost).toBeTruthy();
      expect(preset.models).toBeDefined();
      expect(preset.models.mayor).toBeTruthy();
      expect(preset.models.refinery).toBeTruthy();
      expect(preset.models.polecat).toBeTruthy();
    }
  });

  test('free preset uses kilo/free for all roles', () => {
    const free = PRESETS.find(p => p.key === 'free');
    expect(free?.models).toEqual({
      mayor: 'kilo/free',
      refinery: 'kilo/free',
      polecat: 'kilo/free',
    });
  });
});

// ---------------------------------------------------------------------------
// FIRST_TASK_STORAGE_PREFIX
// ---------------------------------------------------------------------------
describe('FIRST_TASK_STORAGE_PREFIX', () => {
  test('has the expected value', () => {
    expect(FIRST_TASK_STORAGE_PREFIX).toBe('gastown_first_task_');
  });

  test('can be used to construct a valid storage key', () => {
    const townId = 'abc-123';
    const key = `${FIRST_TASK_STORAGE_PREFIX}${townId}`;
    expect(key).toBe('gastown_first_task_abc-123');
  });
});

// ---------------------------------------------------------------------------
// PHASE_LABELS
// ---------------------------------------------------------------------------
describe('PHASE_LABELS', () => {
  test('idle phase has empty label', () => {
    expect(PHASE_LABELS.idle).toBe('');
  });

  test('all non-idle phases have non-empty labels', () => {
    const nonIdlePhases: CreationPhase[] = [
      'creating-town',
      'creating-rig',
      'configuring-models',
      'redirecting',
    ];
    for (const phase of nonIdlePhases) {
      expect(PHASE_LABELS[phase]).toBeTruthy();
    }
  });

  test('covers all expected phases', () => {
    const expectedPhases: CreationPhase[] = [
      'idle',
      'creating-town',
      'creating-rig',
      'configuring-models',
      'redirecting',
    ];
    expect(Object.keys(PHASE_LABELS).sort()).toEqual([...expectedPhases].sort());
  });
});
