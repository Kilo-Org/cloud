/** Encrypt a plaintext string. Returns base64(iv || ciphertext || tag). */
export declare function encryptToken(plaintext: string, key: CryptoKey): Promise<string>;
/** Decrypt a base64(iv || ciphertext || tag) string back to plaintext. */
export declare function decryptToken(encrypted: string, key: CryptoKey): Promise<string>;
/** Derive an AES-256-GCM CryptoKey from a secret string using PBKDF2. */
export declare function deriveEncryptionKey(secret: string): Promise<CryptoKey>;
