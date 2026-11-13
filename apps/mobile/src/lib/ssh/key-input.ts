import { type GeneratedKey, type ParsedKey } from '@kilocode/react-native-ssh';

import { type SSH_KEY_ALGORITHMS } from '@/lib/persist/schema';

import { type SshKeyInput } from './keys';

export type SshKeyAlgorithm = (typeof SSH_KEY_ALGORITHMS)[number];

/**
 * The store's algorithm for a key the package reported. The core names the
 * OpenSSH type (`ssh-ed25519`, `ecdsa-sha2-nistp256`); the row records the
 * family, which is what the editor shows and what a host authenticates with.
 */
export function keyAlgorithmOf(algorithm: string): SshKeyAlgorithm {
  if (algorithm.startsWith('ssh-ed25519')) {
    return 'ed25519';
  }
  if (algorithm.startsWith('ssh-rsa') || algorithm === 'rsa') {
    return 'rsa';
  }
  if (algorithm.startsWith('ecdsa-sha2-')) {
    return 'ecdsa';
  }
  throw new Error(`Unsupported key algorithm: ${algorithm}`);
}

export function generatedKeyInput(label: string, generated: GeneratedKey): SshKeyInput {
  return {
    label,
    algorithm: 'ed25519',
    source: 'generated',
    privateKeyOpenssh: generated.privateKeyOpenssh,
    publicKeyOpenssh: generated.publicKeyOpenssh,
    fingerprintSha256: generated.fingerprintSha256,
    passphrase: null,
  };
}

export function importedKeyInput(input: {
  label: string;
  pem: string;
  parsed: ParsedKey;
  passphrase: string | null;
}): SshKeyInput {
  return {
    label: input.label,
    algorithm: keyAlgorithmOf(input.parsed.algorithm),
    source: 'imported',
    privateKeyOpenssh: input.pem,
    publicKeyOpenssh: input.parsed.publicKeyOpenssh,
    fingerprintSha256: input.parsed.fingerprintSha256,
    passphrase: input.passphrase,
  };
}
