import 'server-only';

import { encryptWithPublicKey, type EncryptedEnvelope } from '@/lib/encryption';
import { AGENT_ENV_VARS_PUBLIC_KEY } from '@/lib/config.server';

/**
 * Encrypt a plaintext secret for the KiloClaw worker using the shared
 * AGENT_ENV_VARS_PUBLIC_KEY (same keypair as agent profiles and cloud-agent-next).
 *
 * The worker decrypts at container startup time using the corresponding private key.
 */
export function encryptKiloClawSecret(value: string): EncryptedEnvelope {
  if (!AGENT_ENV_VARS_PUBLIC_KEY) {
    throw new Error('AGENT_ENV_VARS_PUBLIC_KEY not configured');
  }
  const publicKey = Buffer.from(AGENT_ENV_VARS_PUBLIC_KEY, 'base64');
  return encryptWithPublicKey(value, publicKey);
}
