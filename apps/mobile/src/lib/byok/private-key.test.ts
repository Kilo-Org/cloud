// eslint-disable-next-line import/no-nodejs-modules -- test-only reference parse of the canonical key
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalPrivateKey } from './private-key';

/** A key file in one of the three labels a signing key carries. */
function signingKey(type: 'pkcs8' | 'pkcs1' | 'sec1'): string {
  const pair =
    type === 'sec1'
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = pair.privateKey.export({ type, format: 'pem' });
  return typeof pem === 'string' ? pem : pem.toString('utf8');
}

/** The canonical key, failing the test when the value is refused. */
function canonical(pem: string): string {
  const read = canonicalPrivateKey(pem);
  if (read.tag !== 'key') {
    throw new Error(`refused a key file: ${read.cause}`);
  }
  return read.pem;
}

/** The cause a value is refused with, or null for a key the gateway can sign with. */
function refusalCause(value: string): string | null {
  const read = canonicalPrivateKey(value);
  return read.tag === 'refused' ? read.cause : null;
}

/** A PEM with the given label and body lines, spelled as a reader would paste it. */
function block(label: string, lines: readonly string[]): string {
  return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`].join('\n');
}

describe('canonicalPrivateKey', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const exported = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const PEM = typeof exported === 'string' ? exported : exported.toString('utf8');

  // These three formats are the labels a signing key carries: PKCS#8 is
  // `PRIVATE KEY`, PKCS#1 is `RSA PRIVATE KEY` and SEC1 is `EC PRIVATE KEY`,
  // and each has to stay accepted.
  it.each(['pkcs8', 'pkcs1', 'sec1'] as const)('keeps a %s key the gateway can sign with', type => {
    expect(() => createPrivateKey(canonical(signingKey(type)))).not.toThrow();
  });

  it('puts the wrapping back whatever line breaks the paste kept', () => {
    const folded = PEM.replaceAll('\n', '');
    expect(() => createPrivateKey(folded)).toThrow();
    for (const pasted of [
      PEM,
      folded,
      PEM.replaceAll('\n', '\r\n'),
      PEM.split('\n')
        .map(line => `  ${line}`)
        .join('\n'),
      `  ${PEM}  `,
      // The value copied out of a downloaded service-account file: the line
      // breaks arrive as the two characters `\` and `n`.
      PEM.trim().replaceAll('\n', String.raw`\n`),
    ]) {
      const key = canonical(pasted);
      expect(() => createPrivateKey(key)).not.toThrow();
      expect(key).toBe(PEM.trim());
    }
  });

  it('refuses a value that is not a key block', () => {
    expect(refusalCause('not a key')).toBe('key-block');
  });

  it('refuses a truncated key block', () => {
    const truncated = PEM.trim()
      .split('\n')
      .filter(line => !line.startsWith('-----END '))
      .join('\n');
    expect(refusalCause(truncated)).toBe('key-block');
  });

  it('refuses a label a signing key does not carry', () => {
    expect(refusalCause(block('PUBLIC KEY', ['AAAA']))).toBe('key-block');
  });

  it('refuses a begin and end label that differ', () => {
    const mismatched = PEM.replace('-----END PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----');
    expect(refusalCause(mismatched)).toBe('key-block');
  });

  it('refuses a body that is not base64', () => {
    expect(refusalCause(block('RSA PRIVATE KEY', ['not base64!']))).toBe('key-block');
  });

  it('refuses a body whose length is not a whole number of bytes', () => {
    expect(refusalCause(block('RSA PRIVATE KEY', ['AAAAA']))).toBe('key-block');
  });

  it('refuses an encrypted key with the passphrase cause', () => {
    const encrypted = privateKey.export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase: 'x',
    });
    const pem = typeof encrypted === 'string' ? encrypted : encrypted.toString('utf8');
    expect(pem.startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----')).toBe(true);
    expect(refusalCause(pem)).toBe('key-encrypted');
  });

  it('refuses a legacy encrypted header under a signing label with the passphrase cause', () => {
    const legacy = block('RSA PRIVATE KEY', [
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-128-CBC,0123456789ABCDEF',
      '',
      'AAAA',
    ]);
    expect(refusalCause(legacy)).toBe('key-encrypted');
  });
});
