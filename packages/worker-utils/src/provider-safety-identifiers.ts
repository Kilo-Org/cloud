import { createHash } from 'node:crypto';

const PROVIDER_HASH_SALT = 'd20250815';
const OPENROUTER_HASH_PEPPER = 'henk is a boss';

export function generateOpenRouterDownstreamSafetyIdentifier(userId: string): string {
  return createHash('sha256')
    .update(PROVIDER_HASH_SALT + OPENROUTER_HASH_PEPPER + userId)
    .digest('base64');
}
