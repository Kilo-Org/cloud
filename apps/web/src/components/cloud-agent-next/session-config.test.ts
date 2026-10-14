import { describe, it, expect } from '@jest/globals';
import {
  dedupeCustomModeOptions,
  ensureSelectedCustomOption,
  isValidSessionConfig,
  modeControlValue,
  needsResumeConfiguration,
  normalizeAlias,
  type CustomModeOption,
} from './session-config';
import type { SessionConfig, ResumeConfig } from './types';

describe('needsResumeConfiguration', () => {
  it('returns false when no session is loaded', () => {
    expect(
      needsResumeConfiguration({
        currentDbSessionId: null,
        resumeConfig: null,
        persistedResumeConfig: null,
        sessionConfig: null,
      })
    ).toBe(false);
  });

  it('returns false when resumeConfig is provided', () => {
    const resumeConfig: ResumeConfig = {
      mode: 'code',
      model: 'anthropic/claude-3-5-sonnet',
    };

    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig,
        persistedResumeConfig: null,
        sessionConfig: null,
      })
    ).toBe(false);
  });

  it('returns false when persistedResumeConfig is provided', () => {
    const persistedResumeConfig: ResumeConfig = {
      mode: 'code',
      model: 'anthropic/claude-3-5-sonnet',
    };

    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig: null,
        persistedResumeConfig,
        sessionConfig: null,
      })
    ).toBe(false);
  });

  it('returns true for CLI session without valid config', () => {
    const invalidConfig: SessionConfig = {
      mode: 'code',
      model: '', // Empty model is invalid
      repository: '',
      sessionId: '',
    };

    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig: null,
        persistedResumeConfig: null,
        sessionConfig: invalidConfig,
      })
    ).toBe(true);
  });

  it('returns false for web session with valid config', () => {
    const validConfig: SessionConfig = {
      mode: 'code',
      model: 'anthropic/claude-3-5-sonnet',
      repository: 'owner/repo',
      sessionId: 'agent_xyz',
    };

    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig: null,
        persistedResumeConfig: null,
        sessionConfig: validConfig,
      })
    ).toBe(false);
  });

  it('returns true for legacy web session with invalid config (empty model)', () => {
    const invalidConfig: SessionConfig = {
      mode: 'code',
      model: '', // Legacy sessions may have empty model
      repository: '',
      sessionId: '',
    };

    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig: null,
        persistedResumeConfig: null,
        sessionConfig: invalidConfig,
      })
    ).toBe(true);
  });

  it('returns true when sessionConfig is null', () => {
    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig: null,
        persistedResumeConfig: null,
        sessionConfig: null,
      })
    ).toBe(true);
  });

  it('returns true for session with empty mode', () => {
    const invalidConfig: SessionConfig = {
      mode: '', // Empty mode is invalid, even after alias normalization
      model: 'anthropic/claude-3-5-sonnet',
      repository: 'owner/repo',
      sessionId: 'abc-123',
    };

    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig: null,
        persistedResumeConfig: null,
        sessionConfig: invalidConfig,
      })
    ).toBe(true);
  });

  it('returns false for session with a custom mode and a model', () => {
    const customConfig: SessionConfig = {
      mode: 'my-agent',
      model: 'anthropic/claude-3-5-sonnet',
      repository: 'owner/repo',
      sessionId: 'abc-123',
    };

    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig: null,
        persistedResumeConfig: null,
        sessionConfig: customConfig,
      })
    ).toBe(false);
  });

  it('prioritizes resumeConfig over invalid sessionConfig', () => {
    const resumeConfig: ResumeConfig = {
      mode: 'code',
      model: 'anthropic/claude-3-5-sonnet',
    };

    const invalidConfig: SessionConfig = {
      mode: 'code',
      model: '', // Invalid
      repository: '',
      sessionId: '',
    };

    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig,
        persistedResumeConfig: null,
        sessionConfig: invalidConfig,
      })
    ).toBe(false);
  });

  it('prioritizes persistedResumeConfig over invalid sessionConfig', () => {
    const persistedResumeConfig: ResumeConfig = {
      mode: 'code',
      model: 'anthropic/claude-3-5-sonnet',
    };

    const invalidConfig: SessionConfig = {
      mode: 'code',
      model: '', // Invalid
      repository: '',
      sessionId: '',
    };

    expect(
      needsResumeConfiguration({
        currentDbSessionId: 'abc-123',
        resumeConfig: null,
        persistedResumeConfig,
        sessionConfig: invalidConfig,
      })
    ).toBe(false);
  });
});

describe('normalizeAlias', () => {
  it('keeps a custom runtimeState mode unchanged', () => {
    expect(normalizeAlias('my-agent')).toBe('my-agent');
  });

  it('maps build to code', () => {
    expect(normalizeAlias('build')).toBe('code');
  });

  it('maps architect to plan', () => {
    expect(normalizeAlias('architect')).toBe('plan');
  });

  it.each(['code', 'plan', 'debug', 'orchestrator', 'ask'])('keeps built-in %s', mode => {
    expect(normalizeAlias(mode)).toBe(mode);
  });

  it.each([null, undefined, ''])('stays empty for %s', mode => {
    expect(normalizeAlias(mode)).toBe('');
  });
});

describe('modeControlValue', () => {
  it('returns undefined for an empty control value', () => {
    expect(modeControlValue('')).toBeUndefined();
  });

  it('returns undefined for null and undefined', () => {
    expect(modeControlValue(null)).toBeUndefined();
    expect(modeControlValue(undefined)).toBeUndefined();
  });

  it('returns a custom slug unchanged', () => {
    expect(modeControlValue('my-agent')).toBe('my-agent');
  });

  it('maps build to code', () => {
    expect(modeControlValue('build')).toBe('code');
  });
});

describe('isValidSessionConfig', () => {
  it('accepts a custom slug with a model', () => {
    const config: SessionConfig = {
      mode: 'my-agent',
      model: 'anthropic/claude-3-5-sonnet',
      repository: 'owner/repo',
      sessionId: 'abc-123',
    };
    expect(isValidSessionConfig(config)).toBe(true);
  });

  it('accepts an aliased mode with a model', () => {
    const config: SessionConfig = {
      mode: 'build',
      model: 'anthropic/claude-3-5-sonnet',
      repository: 'owner/repo',
      sessionId: 'abc-123',
    };
    expect(isValidSessionConfig(config)).toBe(true);
  });

  it('rejects an empty mode', () => {
    const config: SessionConfig = {
      mode: '',
      model: 'anthropic/claude-3-5-sonnet',
      repository: 'owner/repo',
      sessionId: 'abc-123',
    };
    expect(isValidSessionConfig(config)).toBe(false);
  });

  it('rejects a null config', () => {
    expect(isValidSessionConfig(null)).toBe(false);
  });
});

describe('ensureSelectedCustomOption', () => {
  it('appends a missing custom slug once', () => {
    expect(ensureSelectedCustomOption([], 'my-agent')).toEqual([
      { value: 'my-agent', label: 'my-agent', description: '' },
    ]);
  });

  it('does not append a built-in slug', () => {
    expect(ensureSelectedCustomOption([], 'code')).toEqual([]);
  });

  it('does not append an empty slug', () => {
    expect(ensureSelectedCustomOption([], '')).toEqual([]);
  });

  it('does not append an already-present slug', () => {
    const custom: CustomModeOption[] = [{ value: 'my-agent', label: 'My Agent', description: '' }];
    expect(ensureSelectedCustomOption(custom, 'my-agent')).toHaveLength(1);
  });
});

describe('dedupeCustomModeOptions', () => {
  it('drops built-in slugs and duplicates', () => {
    const options: CustomModeOption[] = [
      { value: 'code', label: 'Code', description: '' },
      { value: 'my-agent', label: 'My Agent', description: '' },
      { value: 'my-agent', label: 'Duplicate', description: '' },
    ];
    expect(dedupeCustomModeOptions(options)).toEqual([
      { value: 'my-agent', label: 'My Agent', description: '' },
    ]);
  });

  it('drops an empty slug', () => {
    const options: CustomModeOption[] = [{ value: '', label: '', description: '' }];
    expect(dedupeCustomModeOptions(options)).toEqual([]);
  });
});
