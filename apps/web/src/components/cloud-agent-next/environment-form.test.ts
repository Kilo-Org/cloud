import { describe, expect, it } from '@jest/globals';
import { ENVIRONMENT_LIMITS } from '@kilocode/cloud-agent-profile';
import {
  toEnvironmentCommands,
  toEnvironmentPlainVars,
  toEnvironmentSecretChanges,
  validateEnvironmentForm,
  type EnvironmentSecretDraft,
} from './environment-form';

function secret(partial: Partial<EnvironmentSecretDraft>): EnvironmentSecretDraft {
  return { key: '', value: '', existing: false, deleted: false, ...partial };
}

function validForm() {
  return {
    name: 'Database',
    plainVars: [{ key: 'LOG_LEVEL', value: 'debug' }],
    secrets: [secret({ key: 'DATABASE_URL', value: 'postgres://localhost/db' })],
    commands: ['pnpm install'],
  };
}

describe('toEnvironmentSecretChanges', () => {
  it('omits an existing secret with no replacement so it is retained', () => {
    expect(
      toEnvironmentSecretChanges([secret({ key: 'TOKEN', existing: true, value: '' })])
    ).toEqual([]);
  });

  it('deletes an existing secret that was explicitly removed', () => {
    expect(
      toEnvironmentSecretChanges([secret({ key: 'TOKEN', existing: true, deleted: true })])
    ).toEqual([{ key: 'TOKEN', delete: true }]);
  });

  it('replaces an existing secret when a new value is entered', () => {
    expect(
      toEnvironmentSecretChanges([secret({ key: 'TOKEN', existing: true, value: 'next' })])
    ).toEqual([{ key: 'TOKEN', value: 'next' }]);
  });

  it('adds a new secret and ignores blank new rows', () => {
    expect(
      toEnvironmentSecretChanges([
        secret({ key: 'NEW_KEY', value: 'v' }),
        secret({ key: '', value: '' }),
      ])
    ).toEqual([{ key: 'NEW_KEY', value: 'v' }]);
  });
});

describe('toEnvironmentPlainVars', () => {
  it('trims keys and ignores fully blank rows', () => {
    expect(
      toEnvironmentPlainVars([
        { key: ' A ', value: '1' },
        { key: '', value: '' },
      ])
    ).toEqual({ A: '1' });
  });
});

describe('toEnvironmentCommands', () => {
  it('trims and drops blank commands', () => {
    expect(toEnvironmentCommands([' pnpm install ', '', '   '])).toEqual(['pnpm install']);
  });
});

describe('validateEnvironmentForm', () => {
  it('accepts a valid form', () => {
    expect(validateEnvironmentForm(validForm())).toBeNull();
  });

  it('rejects a reserved plaintext key', () => {
    expect(
      validateEnvironmentForm({ ...validForm(), plainVars: [{ key: 'HOME', value: '/root' }] })
    ).toMatch(/Reserved environment variable key/);
  });

  it('rejects a plaintext value over 256 characters', () => {
    expect(
      validateEnvironmentForm({
        ...validForm(),
        plainVars: [{ key: 'TOO_LONG', value: 'x'.repeat(257) }],
      })
    ).toMatch(/256 characters/);
  });

  it('rejects a secret value over 8192 characters', () => {
    expect(
      validateEnvironmentForm({
        ...validForm(),
        secrets: [secret({ key: 'BIG', value: 'x'.repeat(8193) })],
      })
    ).toMatch(/8192 characters/);
  });

  it('rejects a new secret with no value', () => {
    expect(
      validateEnvironmentForm({ ...validForm(), secrets: [secret({ key: 'TOKEN', value: '' })] })
    ).toMatch(/Enter a value for secret TOKEN/);
  });

  it('rejects more than 50 variables and secrets combined', () => {
    const plainVars = Array.from({ length: ENVIRONMENT_LIMITS.MAX_VARS + 1 }, (_, index) => ({
      key: `VAR_${index}`,
      value: 'v',
    }));
    expect(validateEnvironmentForm({ ...validForm(), plainVars, secrets: [] })).toMatch(
      /Maximum 50 variables and secrets/
    );
  });

  it('rejects more than 20 setup commands', () => {
    const commands = Array.from({ length: ENVIRONMENT_LIMITS.MAX_COMMANDS + 1 }, (_, i) => `c${i}`);
    expect(validateEnvironmentForm({ ...validForm(), commands })).toMatch(
      /Maximum 20 setup commands/
    );
  });

  it('rejects a command over 500 characters', () => {
    expect(validateEnvironmentForm({ ...validForm(), commands: ['x'.repeat(501)] })).toMatch(
      /1-500 characters/
    );
  });

  it('rejects a duplicate variable key', () => {
    expect(
      validateEnvironmentForm({
        ...validForm(),
        plainVars: [
          { key: 'DUP', value: '1' },
          { key: 'DUP', value: '2' },
        ],
      })
    ).toMatch(/Duplicate variable key/);
  });

  it('rejects the same key as both a variable and a secret', () => {
    expect(
      validateEnvironmentForm({
        ...validForm(),
        plainVars: [{ key: 'SHARED', value: '1' }],
        secrets: [secret({ key: 'SHARED', value: '2' })],
      })
    ).toMatch(/both a variable and a secret/);
  });
});
