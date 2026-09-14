import { describe, expect, it } from 'vitest';
import {
  codeChallengeFromVerifier,
  generateCodeVerifier,
  isValidCodeChallenge,
  isValidCodeVerifier,
  verifyPkceS256,
} from './pkce';

describe('PKCE S256 (RFC 7636)', () => {
  it('matches the RFC 7636 appendix B known vector', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(await codeChallengeFromVerifier(verifier)).toBe(challenge);
    expect(await verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it('rejects a wrong verifier', async () => {
    const challenge = await codeChallengeFromVerifier(generateCodeVerifier());
    expect(await verifyPkceS256(generateCodeVerifier(), challenge)).toBe(false);
  });

  it('accepts only the RFC charset and 43..128 length', () => {
    expect(isValidCodeVerifier('a'.repeat(43))).toBe(true);
    expect(isValidCodeVerifier('a'.repeat(128))).toBe(true);
    expect(isValidCodeVerifier('a'.repeat(42))).toBe(false);
    expect(isValidCodeVerifier('a'.repeat(129))).toBe(false);
    expect(isValidCodeVerifier('has space')).toBe(false);
    expect(isValidCodeVerifier('unsafe+char/')).toBe(false);
    expect(isValidCodeVerifier(`~tilde.dot-dash_ok${'x'.repeat(43)}`)).toBe(true);
    expect(isValidCodeVerifier(null)).toBe(false);
  });

  it('challenge validation accepts base64url only (S256 output shape)', () => {
    expect(isValidCodeChallenge('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(isValidCodeChallenge('short')).toBe(false);
    expect(isValidCodeChallenge('has=padding+plus/slash')).toBe(false);
    expect(isValidCodeChallenge(null)).toBe(false);
  });

  it('generated verifier/challenge round-trips', async () => {
    const verifier = generateCodeVerifier();
    const challenge = await codeChallengeFromVerifier(verifier);
    expect(isValidCodeChallenge(challenge)).toBe(true);
    expect(await verifyPkceS256(verifier, challenge)).toBe(true);
  });
});
