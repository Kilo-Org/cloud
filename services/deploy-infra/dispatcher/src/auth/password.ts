import { randomBytes, pbkdf2Sync, timingSafeEqual } from 'node:crypto';

const ITERATIONS = 100000;
const KEY_LENGTH = 64;
const DIGEST = 'sha256';

export type PasswordRecord = {
  passwordHash: string;
  salt: string;
  createdAt: number;
};

export function hashPassword(password: string): PasswordRecord {
  const salt = randomBytes(16).toString('hex');
  const passwordHash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
  return { passwordHash, salt, createdAt: Date.now() };
}

export function verifyPassword(password: string, record: PasswordRecord): boolean {
  const hash = pbkdf2Sync(password, record.salt, ITERATIONS, KEY_LENGTH, DIGEST);
  const storedHash = Buffer.from(record.passwordHash, 'hex');
  return timingSafeEqual(hash, storedHash);
}
