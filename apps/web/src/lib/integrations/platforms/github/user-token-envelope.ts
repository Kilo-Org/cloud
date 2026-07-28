import 'server-only';

import { encryptKeyedEnvelope } from '@/lib/encryption';
import {
  USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID,
  USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY,
} from '@/lib/config.server';

// Single source of truth for the `standard` GitHub user-token envelope: scheme,
// active public key, and AAD. Every caller that stores a `user_github_app_tokens`
// credential (the production OAuth callback and the dev-only E2E seed) MUST use
// this helper so the envelope stays decryptable by git-token-service and the two
// paths cannot drift. Kept in a small dependency-light module so unit tests can
// import it without pulling the full authorization stack.
const GITHUB_USER_TOKEN_ENVELOPE_SCHEME = 'github-user-token-rsa-aes-256-gcm';

export function requireTokenEnvelopePublicKey(): { keyId: string; publicKeyPem: Buffer } {
  if (!USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID || !USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY) {
    throw new Error('GitHub user token envelope encryption is not configured');
  }
  return {
    keyId: USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID,
    publicKeyPem: Buffer.from(USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY, 'base64'),
  };
}

export function tokenEnvelopeAad(
  kiloUserId: string,
  githubUserId: string,
  tokenType: 'access' | 'refresh'
): string {
  return `github-user-authorization:v1:${kiloUserId}:standard:${githubUserId}:${tokenType}`;
}

export function encryptUserGithubTokenEnvelope(
  token: string,
  args: { kiloUserId: string; githubUserId: string; tokenType: 'access' | 'refresh' }
): string {
  return encryptKeyedEnvelope(
    token,
    GITHUB_USER_TOKEN_ENVELOPE_SCHEME,
    requireTokenEnvelopePublicKey(),
    tokenEnvelopeAad(args.kiloUserId, args.githubUserId, args.tokenType)
  );
}
