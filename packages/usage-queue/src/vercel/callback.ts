import { handleCallback } from '@vercel/queue';
import { consumeVercelUsage } from './consumer';

export const POST = handleCallback(consumeVercelUsage, { visibilityTimeoutSeconds: 300 });
