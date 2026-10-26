import { execFileSync } from 'node:child_process';
import { describe, expect, it } from '@jest/globals';
import {
  hasEnvironmentFormChanges,
  toEnvironmentCommands,
  toEnvironmentScript,
} from './environment-form';

describe('single environment script', () => {
  it('saves one multiline script and removes an empty script', () => {
    expect(toEnvironmentCommands('  pnpm install\npnpm build\n')).toEqual([
      'pnpm install\npnpm build',
    ]);
    expect(toEnvironmentCommands(' \n ')).toEqual([]);
    expect(toEnvironmentScript([])).toBe('');
    expect(toEnvironmentScript(['echo ready'])).toBe('echo ready');
  });

  it('preserves legacy script scopes, quoting, and explicit exits', () => {
    const script = toEnvironmentScript([
      "export LEGACY_SCOPE=first; printf '%s' \"it's working\"; exit 0",
      'printf "|%s" "${LEGACY_SCOPE-unset}"',
    ]);
    expect(execFileSync('bash', ['-e', '-o', 'pipefail', '-c', script], { encoding: 'utf8' })).toBe(
      "it's working|unset"
    );
    expect(toEnvironmentCommands(script)).toHaveLength(1);
  });

  it('stops after a failure in a legacy script', () => {
    const script = toEnvironmentScript(['false | cat', 'printf should-not-run']);
    try {
      execFileSync('bash', ['-e', '-o', 'pipefail', '-c', script], { encoding: 'utf8' });
      throw new Error('Expected the setup script to fail');
    } catch (error) {
      expect(error).toMatchObject({ status: 1, stdout: '' });
    }
  });
});

describe('hasEnvironmentFormChanges', () => {
  const saved = {
    script: toEnvironmentScript(['export A=1', 'echo "$A"']),
    variablesText: 'TOKEN=<unchanged>\nPLAIN="saved"',
    sandboxAllocation: 'cloudflare-single',
  };

  test('allows a build when the legacy script and secret markers stay untouched', () => {
    expect(hasEnvironmentFormChanges(saved, { ...saved })).toBe(false);
  });

  test.each([
    { script: 'pnpm install' },
    { variablesText: 'TOKEN="replacement"' },
    { variablesText: 'PLAIN="saved"' },
    { variablesText: 'TOKEN=<unchanged>\nPLAIN="changed"' },
    { variablesText: 'TOKEN="unterminated' },
    { sandboxAllocation: null },
  ])('blocks a build while the editor contains unsaved changes: %j', change => {
    expect(hasEnvironmentFormChanges(saved, { ...saved, ...change })).toBe(true);
  });

  test('allows a build after reverting the edits', () => {
    const draft = { ...saved, script: 'changed' };
    expect(hasEnvironmentFormChanges(saved, draft)).toBe(true);
    draft.script = saved.script;
    expect(hasEnvironmentFormChanges(saved, draft)).toBe(false);
  });
});
