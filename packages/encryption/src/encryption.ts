import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  generateKeySync,
  publicEncrypt,
  privateDecrypt,
  constants,
} from 'node:crypto';

export class EncryptionConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EncryptionConfigurationError';
  }
}

export class EncryptionFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EncryptionFormatError';
  }
}

/**
 * Envelope encryption structure for RSA + AES encryption
 */
export type EncryptedEnvelope = {
  encryptedData: string; // AES-encrypted value (base64)
  encryptedDEK: string; // RSA-encrypted DEK (base64)
  algorithm: 'rsa-aes-256-gcm';
  version: 1;
};

// ---- RSA envelope encryption (asymmetric) ----

/**
 * Encrypts data using envelope encryption (AES + RSA)
 * 1. Generate random AES-256 key (DEK - Data Encryption Key)
 * 2. Encrypt value with DEK using AES-256-GCM
 * 3. Encrypt DEK with RSA public key
 * 4. Return both encrypted data and encrypted DEK
 */
export function encryptWithPublicKey(
  value: string,
  publicKeyPem: string | Buffer
): EncryptedEnvelope {
  if (!publicKeyPem) {
    throw new EncryptionConfigurationError('Public key parameter is required');
  }

  try {
    const dek = generateKeySync('aes', { length: 256 });
    const dekBuffer = dek.export();

    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', dekBuffer, iv);

    let encrypted = cipher.update(value, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    const authTag = cipher.getAuthTag();

    // Combine iv, encrypted data, and authTag for storage
    const encryptedDataBuffer = Buffer.concat([iv, encrypted, authTag]);
    const encryptedData = encryptedDataBuffer.toString('base64');

    // Encrypt DEK with RSA public key
    const encryptedDEKBuffer = publicEncrypt(
      {
        key: publicKeyPem,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      dekBuffer
    );
    const encryptedDEK = encryptedDEKBuffer.toString('base64');

    return {
      encryptedData,
      encryptedDEK,
      algorithm: 'rsa-aes-256-gcm',
      version: 1,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new EncryptionConfigurationError(`Encryption failed: ${error.message}`, {
        cause: error,
      });
    }
    throw new EncryptionConfigurationError('Encryption failed with unknown error');
  }
}

/**
 * Decrypts envelope-encrypted data using RSA private key
 * 1. Decrypt DEK using private key
 * 2. Decrypt data using decrypted DEK
 */
export function decryptWithPrivateKey(
  envelope: EncryptedEnvelope,
  privateKeyPem: string | Buffer
): string {
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
      throw new EncryptionConfigurationError(`Decryption failed: ${error.message}`, {
        cause: error,
      });
    }
    throw new EncryptionConfigurationError('Decryption failed with unknown error');
  }
}

// ---- Symmetric encryption ----

/**
 * Encrypts a value using AES-256-GCM with a symmetric key.
 * Format: iv:authTag:encrypted (all base64)
 */
export function encryptWithSymmetricKey(value: string, keyBase64: string): string {
  if (!keyBase64) {
    throw new EncryptionConfigurationError('Encryption key is required');
  }

  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new EncryptionConfigurationError('Encryption key must be exactly 32 bytes (256 bits)');
  }

  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(value, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypts a value encrypted with encryptWithSymmetricKey.
 */
export function decryptWithSymmetricKey(encryptedValue: string, keyBase64: string): string {
  if (!keyBase64) {
    throw new EncryptionConfigurationError('Encryption key is required');
  }

  const parts = encryptedValue.split(':');
  if (parts.length !== 3) {
    throw new EncryptionFormatError(
      'Invalid encrypted value format: expected iv:authTag:encrypted'
    );
  }
  const [ivBase64, authTagBase64, encrypted] = parts;

  const iv = Buffer.from(ivBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');
  const key = Buffer.from(keyBase64, 'base64');

  if (key.length !== 32) {
    throw new EncryptionConfigurationError('Encryption key must be exactly 32 bytes (256 bits)');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

// ---- Helpers for batch decryption ----

/**
 * Decrypt all encrypted secrets and return them as a plain Record<string, string>.
 */
export function decryptSecrets(
  encryptedSecrets: Record<string, EncryptedEnvelope>,
  privateKeyPem: string | Buffer
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, envelope] of Object.entries(encryptedSecrets)) {
    result[key] = decryptWithPrivateKey(envelope, privateKeyPem);
  }

  return result;
}

/**
 * Merge plaintext env vars with decrypted secrets.
 * Decrypted secrets override plaintext env vars if there are conflicts.
 */
export function mergeEnvVarsWithSecrets(
  envVars: Record<string, string> | undefined,
  encryptedSecrets: Record<string, EncryptedEnvelope> | undefined,
  privateKeyPem: string | Buffer | undefined
): Record<string, string> {
  const result: Record<string, string> = { ...(envVars ?? {}) };

  if (encryptedSecrets && Object.keys(encryptedSecrets).length > 0) {
    if (!privateKeyPem) {
      throw new EncryptionConfigurationError(
        'Private key is required to decrypt encrypted secrets'
      );
    }

    const decrypted = decryptSecrets(encryptedSecrets, privateKeyPem);

    for (const [key, value] of Object.entries(decrypted)) {
      result[key] = value;
    }
  }

  return result;
}
