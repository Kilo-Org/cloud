import { describe, expect, it } from 'vitest';

import { generatedKeyInput, importedKeyInput, keyAlgorithmOf } from './key-input';

const PARSED = {
  algorithm: 'ssh-ed25519',
  publicKeyOpenssh: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest test',
  fingerprintSha256: 'SHA256:testFingerprint',
  encrypted: false,
};

describe('keyAlgorithmOf', () => {
  it('maps the core’s OpenSSH names onto the stored families', () => {
    expect(keyAlgorithmOf('ssh-ed25519')).toBe('ed25519');
    expect(keyAlgorithmOf('ssh-rsa')).toBe('rsa');
    expect(keyAlgorithmOf('ecdsa-sha2-nistp256')).toBe('ecdsa');
    expect(keyAlgorithmOf('ecdsa-sha2-nistp384')).toBe('ecdsa');
  });

  it('refuses an algorithm the store has no column value for', () => {
    expect(() => keyAlgorithmOf('ssh-dss')).toThrow(/Unsupported key algorithm/);
  });
});

describe('generatedKeyInput', () => {
  it('records a generated ed25519 key with its comment as the label', () => {
    expect(
      generatedKeyInput('laptop', {
        privateKeyOpenssh: 'PRIVATE',
        publicKeyOpenssh: PARSED.publicKeyOpenssh,
        fingerprintSha256: PARSED.fingerprintSha256,
      })
    ).toEqual({
      label: 'laptop',
      algorithm: 'ed25519',
      source: 'generated',
      privateKeyOpenssh: 'PRIVATE',
      publicKeyOpenssh: PARSED.publicKeyOpenssh,
      fingerprintSha256: PARSED.fingerprintSha256,
      passphrase: null,
    });
  });
});

describe('importedKeyInput', () => {
  it('keeps the pasted key material and the passphrase that opened it', () => {
    expect(
      importedKeyInput({ label: 'work', pem: 'PEM', parsed: PARSED, passphrase: 'secret' })
    ).toEqual({
      label: 'work',
      algorithm: 'ed25519',
      source: 'imported',
      privateKeyOpenssh: 'PEM',
      publicKeyOpenssh: PARSED.publicKeyOpenssh,
      fingerprintSha256: PARSED.fingerprintSha256,
      passphrase: 'secret',
    });
  });

  it('stores no passphrase for an unencrypted key', () => {
    expect(
      importedKeyInput({ label: 'work', pem: 'PEM', parsed: PARSED, passphrase: null }).passphrase
    ).toBeNull();
  });
});
