/**
 * Encryption utilities for KiloClaw worker.
 *
 * Ported from the shared kilocode-backend encryption module
 * (src/lib/encryption.ts). Uses Node.js crypto via nodejs_compat.
 *
 * The encryption format uses RSA+AES envelope encryption:
 * - DEK (Data Encryption Key) is encrypted with RSA-OAEP using SHA-256
 * - Data is encrypted with AES-256-GCM using the DEK
 * - Format: { encryptedData, encryptedDEK, algorithm: 'rsa-aes-256-gcm', version: 1 }
 */

import { createDecipheriv, privateDecrypt, constants } from 'crypto';
import type { EncryptedEnvelope, EncryptedChannelTokens } from '../schemas/instance-config';

export class EncryptionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionConfigurationError';
  }
}

export class EncryptionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionFormatError';
  }
}

/**
 * Decrypt a single encrypted envelope using RSA private key.
 *
 * 1. Decrypt DEK using RSA-OAEP with SHA-256
 * 2. Decrypt data using AES-256-GCM with the DEK
 */
export function decryptWithPrivateKey(envelope: EncryptedEnvelope, privateKeyPem: string): string {
  if (!privateKeyPem) {
    throw new EncryptionConfigurationError('Private key parameter is required');
  }

  if (!envelope || typeof envelope !== 'object') {
    throw new EncryptionFormatError('Invalid envelope: must be an object');
  }

  if (envelope.algorithm !== 'rsa-aes-256-gcm') {
    throw new EncryptionFormatError(
      `Unsupported algorithm: ${String(envelope.algorithm)}. Expected: rsa-aes-256-gcm`
    );
  }

  if (envelope.version !== 1) {
    throw new EncryptionFormatError(
      `Unsupported version: ${String(envelope.version)}. Expected: 1`
    );
  }

  if (!envelope.encryptedData || !envelope.encryptedDEK) {
    throw new EncryptionFormatError('Invalid envelope: missing encryptedData or encryptedDEK');
  }

  try {
    // Decrypt DEK using private key
    const encryptedDEKBuffer = Buffer.from(envelope.encryptedDEK, 'base64');
    const dekBuffer = privateDecrypt(
      {
        key: privateKeyPem,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      encryptedDEKBuffer
    );

    // Decrypt data using decrypted DEK
    const encryptedDataBuffer = Buffer.from(envelope.encryptedData, 'base64');

    // Extract iv (first 16 bytes), encrypted data, and authTag (last 16 bytes)
    if (encryptedDataBuffer.length < 32) {
      throw new EncryptionFormatError('Invalid encrypted data: too short');
    }

    const iv = encryptedDataBuffer.subarray(0, 16);
    const authTag = encryptedDataBuffer.subarray(encryptedDataBuffer.length - 16);
    const encryptedData = encryptedDataBuffer.subarray(16, encryptedDataBuffer.length - 16);

    const decipher = createDecipheriv('aes-256-gcm', dekBuffer, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData, undefined, 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    if (error instanceof EncryptionFormatError) {
      throw error;
    }
    if (error instanceof Error) {
      throw new EncryptionConfigurationError(`Decryption failed: ${error.message}`);
    }
    throw new EncryptionConfigurationError('Decryption failed with unknown error');
  }
}

/**
 * Decrypt all encrypted secrets and return them as a plain Record<string, string>.
 */
export function decryptSecrets(
  encryptedSecrets: Record<string, EncryptedEnvelope>,
  privateKeyPem: string
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, envelope] of Object.entries(encryptedSecrets)) {
    result[key] = decryptWithPrivateKey(envelope, privateKeyPem);
  }

  return result;
}

/**
 * Merge plaintext env vars with decrypted secrets.
 * Decrypted secrets override plaintext env vars on key conflicts.
 */
export function mergeEnvVarsWithSecrets(
  envVars: Record<string, string> | undefined,
  encryptedSecrets: Record<string, EncryptedEnvelope> | undefined,
  privateKeyPem: string | undefined
): Record<string, string> {
  const result: Record<string, string> = { ...(envVars ?? {}) };

  if (encryptedSecrets && Object.keys(encryptedSecrets).length > 0) {
    if (!privateKeyPem) {
      throw new EncryptionConfigurationError(
        'AGENT_ENV_VARS_PRIVATE_KEY is required to decrypt encrypted secrets'
      );
    }

    const decrypted = decryptSecrets(encryptedSecrets, privateKeyPem);

    // Secrets override env vars
    for (const [key, value] of Object.entries(decrypted)) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Channel token env var mapping.
 * Maps channel config keys to the container env var names expected by start-openclaw.sh.
 */
const CHANNEL_ENV_MAP: Record<keyof EncryptedChannelTokens, string> = {
  telegramBotToken: 'TELEGRAM_BOT_TOKEN',
  discordBotToken: 'DISCORD_BOT_TOKEN',
  slackBotToken: 'SLACK_BOT_TOKEN',
  slackAppToken: 'SLACK_APP_TOKEN',
};

/**
 * Decrypt encrypted channel tokens and map to container env var names.
 *
 * Example: channels.telegramBotToken -> TELEGRAM_BOT_TOKEN
 */
export function decryptChannelTokens(
  channels: EncryptedChannelTokens,
  privateKeyPem: string
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const channelKey of Object.keys(CHANNEL_ENV_MAP) as (keyof EncryptedChannelTokens)[]) {
    const envelope = channels[channelKey];
    if (envelope) {
      result[CHANNEL_ENV_MAP[channelKey]] = decryptWithPrivateKey(envelope, privateKeyPem);
    }
  }

  return result;
}
