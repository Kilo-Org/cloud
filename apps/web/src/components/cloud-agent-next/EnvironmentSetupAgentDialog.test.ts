import { describe, expect, it } from '@jest/globals';
import { parseSetupSecrets, setupRepositoriesError } from './EnvironmentSetupAgentDialog';

describe('setupRepositoriesError', () => {
  it('accepts a GitHub first repository', () => {
    expect(
      setupRepositoriesError([{ platform: 'github', fullName: 'Kilo-Org/kilocode' }])
    ).toBeNull();
  });

  it('requires a repository', () => {
    expect(setupRepositoriesError([])).toBe('Select a repository.');
  });

  it('requires the first repository to be on GitHub, even when a later one is', () => {
    expect(
      setupRepositoriesError([
        { platform: 'gitlab', projectPath: 'group/project' },
        { platform: 'github', fullName: 'Kilo-Org/kilocode' },
      ])
    ).toBe('The first repository must be on GitHub.');
  });
});

describe('parseSetupSecrets', () => {
  it('returns no secrets for blank input', () => {
    expect(parseSetupSecrets('  \n ')).toEqual({ secrets: {}, error: null });
  });

  it('parses every entered variable as a secret', () => {
    expect(parseSetupSecrets('API_KEY="abc"\nDEBUG=1')).toEqual({
      secrets: { API_KEY: 'abc', DEBUG: '1' },
      error: null,
    });
  });

  it('reports a key that has no value', () => {
    expect(parseSetupSecrets('API_KEY=')).toEqual({
      secrets: {},
      error: 'Enter a value for API_KEY.',
    });
  });

  it('reports a malformed line with its number', () => {
    const result = parseSetupSecrets('API_KEY=abc\nnot a pair');
    expect(result.secrets).toEqual({});
    expect(result.error).toMatch(/^Line 2: /);
  });

  it('reports a key that is entered twice', () => {
    expect(parseSetupSecrets('API_KEY=a\nAPI_KEY=b').error).toBe(
      'Line 2: API_KEY is entered twice.'
    );
  });
});
