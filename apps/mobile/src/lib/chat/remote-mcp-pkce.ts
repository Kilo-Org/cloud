import * as Crypto from 'expo-crypto';

/**
 * `pkce-challenge` for Hermes, which has no `crypto.subtle` and no global
 * `crypto.getRandomValues`. The MCP SDK's OAuth client imports that package for
 * PKCE (RFC 7636); `metro.config.js` resolves the import here, so the app
 * installs no global `crypto` that another library could mistake for Web Crypto.
 */

const VERIFIER_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
/** The largest multiple of the alphabet size below 256: a byte at or past it is redrawn, so every character is equally likely. */
const UNBIASED_BYTES = 256 - (256 % VERIFIER_ALPHABET.length);

function randomVerifier(length: number): string {
  let verifier = '';
  while (verifier.length < length) {
    for (const byte of Crypto.getRandomBytes(length - verifier.length)) {
      if (byte < UNBIASED_BYTES) {
        verifier += VERIFIER_ALPHABET.charAt(byte % VERIFIER_ALPHABET.length);
      }
    }
  }
  return verifier;
}

export default async function pkceChallenge(
  length = 43
): Promise<{ code_verifier: string; code_challenge: string }> {
  const verifier = randomVerifier(length);
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  const challenge = digest.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return { code_verifier: verifier, code_challenge: challenge };
}
