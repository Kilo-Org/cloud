import { describe, expect, it } from 'vitest';

import { createSshTestDatabase } from '../database.test-helpers';
import { trustHostKey } from '../known-hosts';
import { judgeHostKey } from './host-key';

const OFFERED = {
  hostPattern: '[web-1.kilo.test]:2222',
  algorithm: 'ssh-ed25519',
  fingerprintSha256: 'SHA256:offeredFingerprint',
};

describe('judgeHostKey', () => {
  it('calls an unstored host unknown', () => {
    const db = createSshTestDatabase();
    expect(judgeHostKey(db, OFFERED)).toEqual({ kind: 'unknown' });
  });

  it('trusts the stored key of the same algorithm', () => {
    const db = createSshTestDatabase();
    trustHostKey(db, {
      hostPattern: OFFERED.hostPattern,
      keyAlgorithm: OFFERED.algorithm,
      publicKeyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAIStored',
      fingerprintSha256: OFFERED.fingerprintSha256,
    });
    expect(judgeHostKey(db, OFFERED)).toEqual({ kind: 'trusted' });
  });

  it('reports the trusted fingerprint when the offered key differs', () => {
    const db = createSshTestDatabase();
    trustHostKey(db, {
      hostPattern: OFFERED.hostPattern,
      keyAlgorithm: OFFERED.algorithm,
      publicKeyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAIStored',
      fingerprintSha256: 'SHA256:storedFingerprint',
    });
    expect(judgeHostKey(db, OFFERED)).toEqual({
      kind: 'mismatch',
      knownFingerprintSha256: 'SHA256:storedFingerprint',
    });
  });

  it('treats a second algorithm on a known host as new for that algorithm', () => {
    const db = createSshTestDatabase();
    trustHostKey(db, {
      hostPattern: OFFERED.hostPattern,
      keyAlgorithm: 'ssh-rsa',
      publicKeyBase64: 'AAAAB3NzaC1yc2EAAAADAQABAAABAQStored',
      fingerprintSha256: 'SHA256:rsaFingerprint',
    });
    expect(judgeHostKey(db, OFFERED)).toEqual({ kind: 'unknown' });
  });
});
