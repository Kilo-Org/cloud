import { describe, expect, it } from 'vitest';
import type { EncryptedEnvelope } from '@kilocode/encryption';
import { mergeEnvironmentWithInline } from './profile-session-config';

function envelope(seed: string): EncryptedEnvelope {
  return {
    encryptedData: `data-${seed}`,
    encryptedDEK: `dek-${seed}`,
    algorithm: 'rsa-aes-256-gcm',
    version: 1,
  };
}

describe('mergeEnvironmentWithInline', () => {
  it('returns inline values when no environment is passed', () => {
    const result = mergeEnvironmentWithInline(undefined, {
      envVars: { FOO: 'bar' },
      setupCommands: ['npm install'],
    });

    expect(result.envVars).toEqual({ FOO: 'bar' });
    expect(result.setupCommands).toEqual(['npm install']);
    expect(result.encryptedSecrets).toBeUndefined();
  });

  it('applies inline over the environment as the higher layer', () => {
    const result = mergeEnvironmentWithInline(
      { envVars: { REPO: 'env', SHARED: 'env' }, setupCommands: ['env-setup'] },
      { envVars: { SHARED: 'inline' }, setupCommands: ['inline-setup'] }
    );

    expect(result.envVars).toEqual({ REPO: 'env', SHARED: 'inline' });
    expect(result.setupCommands).toEqual(['env-setup', 'inline-setup']);
  });

  it('drops an environment secret when a higher layer sets the same key as plaintext', () => {
    const result = mergeEnvironmentWithInline(
      { encryptedSecrets: { API_KEY: envelope('env') } },
      { envVars: { API_KEY: 'plain' } }
    );

    expect(result.envVars).toEqual({ API_KEY: 'plain' });
    expect(result.encryptedSecrets).toBeUndefined();
  });

  it('drops an environment plaintext when a higher layer sets the same key as a secret', () => {
    const result = mergeEnvironmentWithInline(
      { envVars: { API_KEY: 'plain' } },
      { encryptedSecrets: { API_KEY: envelope('inline') } }
    );

    expect(result.envVars).toBeUndefined();
    expect(result.encryptedSecrets).toEqual({ API_KEY: envelope('inline') });
  });

  it('lets the later secret replace an earlier secret of the same key', () => {
    const result = mergeEnvironmentWithInline(
      { encryptedSecrets: { API_KEY: envelope('env') } },
      { encryptedSecrets: { API_KEY: envelope('inline') } }
    );

    expect(result.encryptedSecrets).toEqual({ API_KEY: envelope('inline') });
  });

  it('keeps same-layer secret-over-plaintext determinism', () => {
    const result = mergeEnvironmentWithInline(undefined, {
      envVars: { API_KEY: 'plain' },
      encryptedSecrets: { API_KEY: envelope('inline') },
    });

    expect(result.envVars).toBeUndefined();
    expect(result.encryptedSecrets).toEqual({ API_KEY: envelope('inline') });
  });
});
