import { createHash, createHmac } from 'crypto';
import { USER_DELETION_AUDIT_HMAC_KEY } from '@/lib/config.server';

export class DeletionHmacError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeletionHmacError';
  }
}

export function parseDeletionHmacKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new DeletionHmacError('USER_DELETION_AUDIT_HMAC_KEY is not configured');
  }
  const key = Buffer.from(trimmed, 'base64');
  if (key.length < 32) {
    throw new DeletionHmacError('USER_DELETION_AUDIT_HMAC_KEY must decode to at least 32 bytes');
  }
  return key;
}

export function getDeletionHmacKey(raw = USER_DELETION_AUDIT_HMAC_KEY): Buffer {
  return parseDeletionHmacKey(raw);
}

export function hmacDeletionEmail(normalizedEmail: string, key = getDeletionHmacKey()): string {
  return createHmac('sha256', key).update(normalizedEmail, 'utf8').digest('hex');
}

export function deletionAdvisoryLockKey(normalizedEmail: string): bigint {
  return createHash('sha256').update(normalizedEmail, 'utf8').digest().readBigInt64BE(0);
}

export function hmacResourceRef(resourceId: string, key = getDeletionHmacKey()): string {
  return createHmac('sha256', key).update(resourceId, 'utf8').digest('hex');
}
