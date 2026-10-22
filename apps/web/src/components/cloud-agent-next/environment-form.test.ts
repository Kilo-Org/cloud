import { execFileSync } from 'node:child_process';
import { describe, expect, it } from '@jest/globals';
import { toEnvironmentCommands, toEnvironmentScript } from './environment-form';

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
