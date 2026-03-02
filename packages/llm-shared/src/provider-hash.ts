import crypto from 'crypto';
import type { Provider } from './provider.js';

export function generateProviderSpecificHash(payload: string, provider: Provider): string {
  const salt = 'd20250815';
  const pepper = provider.id === 'openrouter' ? 'henk is a boss' : provider.id;
  return crypto
    .createHash('sha256')
    .update(salt + pepper + payload)
    .digest('base64');
}
