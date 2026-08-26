import { describe, expect, it } from 'vitest';
import {
  generateSandboxCredential,
  hashSandboxCredential,
  parseBearerCredential,
  sandboxCredentialMatchesHash,
} from './credential.js';

describe('sandbox control credential', () => {
  it('generates a 256-bit hex credential', () => {
    const credential = generateSandboxCredential();
    expect(credential).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes and matches with constant-time comparison', async () => {
    const credential = generateSandboxCredential();
    const hash = await hashSandboxCredential(credential);
    await expect(sandboxCredentialMatchesHash(credential, hash)).resolves.toBe(true);
    await expect(sandboxCredentialMatchesHash('0'.repeat(64), hash)).resolves.toBe(false);
  });

  it('rejects empty and oversized presented credentials', async () => {
    const hash = await hashSandboxCredential(generateSandboxCredential());
    await expect(sandboxCredentialMatchesHash('', hash)).resolves.toBe(false);
    await expect(sandboxCredentialMatchesHash('a'.repeat(257), hash)).resolves.toBe(false);
  });

  it('parses Bearer credentials from the Authorization header', () => {
    expect(parseBearerCredential('Bearer abc')).toBe('abc');
    expect(parseBearerCredential('Basic abc')).toBeNull();
    expect(parseBearerCredential('token')).toBeNull();
    expect(parseBearerCredential(null)).toBeNull();
  });
});
