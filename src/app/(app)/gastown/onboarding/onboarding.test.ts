import { describe, expect, test } from '@jest/globals';

import {
  validateTownName,
  deriveDefaultTownName,
  TOWN_NAME_MAX_LENGTH,
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

  test('returns null for a valid name', () => {
    expect(validateTownName('my-town')).toBeNull();
  });

  test('returns null for a single character name', () => {
    expect(validateTownName('a')).toBeNull();
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

  test('allows spaces', () => {
    expect(validateTownName('My Town')).toBeNull();
  });

  test('allows special characters', () => {
    expect(validateTownName("Alice's Town")).toBeNull();
  });

  test('allows unicode characters', () => {
    expect(validateTownName("José's Town")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TOWN_NAME_MAX_LENGTH
// ---------------------------------------------------------------------------
describe('TOWN_NAME_MAX_LENGTH', () => {
  test('is 48', () => {
    expect(TOWN_NAME_MAX_LENGTH).toBe(48);
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

  test('derives possessive Town from a simple first name', () => {
    expect(deriveDefaultTownName('Alice')).toBe("Alice's Town");
  });

  test('uses only the first name (splits on whitespace)', () => {
    expect(deriveDefaultTownName('Bob Smith')).toBe("Bob's Town");
  });

  test('preserves special characters in first name', () => {
    expect(deriveDefaultTownName("O'Brien")).toBe("O'Brien's Town");
  });

  test('preserves accented characters', () => {
    expect(deriveDefaultTownName('José')).toBe("José's Town");
  });

  test('returns empty string for whitespace-only input', () => {
    expect(deriveDefaultTownName('   ')).toBe('');
  });

  test('handles multiple spaces between names', () => {
    expect(deriveDefaultTownName('Alice   Smith')).toBe("Alice's Town");
  });

  test('preserves casing', () => {
    expect(deriveDefaultTownName('ALICE')).toBe("ALICE's Town");
  });

  test('handles name with hyphens', () => {
    expect(deriveDefaultTownName('Mary-Jane Watson')).toBe("Mary-Jane's Town");
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
  test('returns frontier config with all roles set to kilo-auto/frontier', () => {
    const config = presetToConfig('frontier', {});
    expect(config.default_model).toBe('kilo-auto/frontier');
    // All roles are the same as default, so role_models should be empty
    expect(config.role_models).toEqual({});
  });

  test('returns balanced config with frontier for refinery only', () => {
    const config = presetToConfig('balanced', {});
    expect(config.default_model).toBe('kilo-auto/balanced');
    expect(config.role_models).toEqual({ refinery: 'kilo-auto/frontier' });
  });

  test('returns cost-effective config with all kilo-auto/balanced', () => {
    const config = presetToConfig('cost-effective', {});
    expect(config.default_model).toBe('kilo-auto/balanced');
    expect(config.role_models).toEqual({});
  });

  test('returns free config with all kilo-auto/free', () => {
    const config = presetToConfig('free', {});
    expect(config.default_model).toBe('kilo-auto/free');
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

  test('uses kilo-auto/balanced as default for missing custom model values', () => {
    const config = presetToConfig('custom', {});
    expect(config.default_model).toBe('kilo-auto/balanced');
    expect(config.role_models).toEqual({
      mayor: 'kilo-auto/balanced',
      refinery: 'kilo-auto/balanced',
      polecat: 'kilo-auto/balanced',
    });
  });

  test('uses kilo-auto/balanced for partially-specified custom models', () => {
    const config = presetToConfig('custom', { mayor: 'openai/gpt-4.1' });
    expect(config.default_model).toBe('openai/gpt-4.1');
    expect(config.role_models).toEqual({
      mayor: 'openai/gpt-4.1',
      refinery: 'kilo-auto/balanced',
      polecat: 'kilo-auto/balanced',
    });
  });

  test('returns fallback for unknown preset key', () => {
    const config = presetToConfig('nonexistent' as ModelPreset, {});
    expect(config.default_model).toBe('kilo-auto/balanced');
    expect(config.role_models).toEqual({});
  });

  test('only includes role_models entries that differ from the default model', () => {
    // balanced: mayor=kilo-auto/balanced, refinery=kilo-auto/frontier, polecat=kilo-auto/balanced
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

  test('free preset uses kilo-auto/free for all roles', () => {
    const free = PRESETS.find(p => p.key === 'free');
    expect(free?.models).toEqual({
      mayor: 'kilo-auto/free',
      refinery: 'kilo-auto/free',
      polecat: 'kilo-auto/free',
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
