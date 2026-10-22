import { generateKeyPairSync } from 'node:crypto';

/**
 * Local-development envelope keypairs for the persisted credentials the
 * git-token-service worker encrypts and decrypts.
 *
 * Production generates one keypair per environment outside the repository and
 * keeps the private half in the Worker only. A local stack has no such
 * environment, so `pnpm dev:setup-env` generates one here instead; without it
 * every code-review read answers 503 from git-token-service (the Worker cannot
 * decrypt the stored credential) while the app still reports the provider as
 * connected.
 *
 * The values land in the root `.env.local`: `pnpm dev:env` copies same-named
 * keys into the Worker's `.dev.vars`, feeds `BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID`
 * into the local Secrets Store, and fills the web app's public half.
 */

const RSA_MODULUS_BITS = 4096;

export type EnvelopeKeySpec = {
  /** Stable non-secret key ID; a local stack never rotates envelopes. */
  readonly keyId: string;
  readonly keyIdEnv: string;
  readonly publicKeyEnv: string;
  readonly privateKeyEnv: string;
};

export const LOCAL_ENVELOPE_KEY_SPECS: readonly EnvelopeKeySpec[] = [
  {
    keyId: 'github-user-token-local-v1',
    keyIdEnv: 'USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID',
    publicKeyEnv: 'USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY',
    privateKeyEnv: 'USER_GITHUB_APP_TOKEN_ACTIVE_PRIVATE_KEY',
  },
  {
    keyId: 'platform-credential-local-v1',
    keyIdEnv: 'BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID',
    publicKeyEnv: 'BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY',
    privateKeyEnv: 'BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY',
  },
];

export type EnvelopeKeypair = {
  readonly keyId: string;
  /** Base64-encoded SPKI PEM, the shape both the web app and the Worker read. */
  readonly publicKey: string;
  /** Base64-encoded PKCS#8 PEM, read by git-token-service only. */
  readonly privateKey: string;
};

export function generateEnvelopeKeypair(): Omit<EnvelopeKeypair, 'keyId'> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: RSA_MODULUS_BITS,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    publicKey: Buffer.from(publicKey, 'utf8').toString('base64'),
    privateKey: Buffer.from(privateKey, 'utf8').toString('base64'),
  };
}

export type EnvelopeProvisioning =
  /** No value configured yet: the pair to write. */
  | { readonly status: 'generate'; readonly keypair: EnvelopeKeypair }
  /** All three values configured: reuse them so the stored envelopes still decrypt. */
  | { readonly status: 'keep'; readonly keypair: EnvelopeKeypair }
  /** Some of the three configured: keep exactly those and report the gap. */
  | {
      readonly status: 'incomplete';
      readonly configured: number;
      readonly keypair: EnvelopeKeypair;
    };

/**
 * Decide what a setup run should do with one envelope.
 *
 * Reuse matters as much as generation: a fresh keypair cannot decrypt a
 * credential that git-token-service stored under the previous one, so a
 * configured pair is always kept, and a half-configured pair keeps its own
 * values instead of being replaced by guesses or dropped.
 */
export function planEnvelopeProvisioning(
  spec: EnvelopeKeySpec,
  existing: (key: string) => string | undefined
): EnvelopeProvisioning {
  const keyId = existing(spec.keyIdEnv) ?? '';
  const publicKey = existing(spec.publicKeyEnv) ?? '';
  const privateKey = existing(spec.privateKeyEnv) ?? '';
  const configured = [keyId, publicKey, privateKey].filter(Boolean).length;
  if (configured === 3) {
    return { status: 'keep', keypair: { keyId, publicKey, privateKey } };
  }
  if (configured !== 0) {
    return { status: 'incomplete', configured, keypair: { keyId, publicKey, privateKey } };
  }
  return { status: 'generate', keypair: { keyId: spec.keyId, ...generateEnvelopeKeypair() } };
}
