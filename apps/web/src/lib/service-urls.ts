import { requireEnv } from '@kilocode/web-shared/lib/dotenvx';

// Kilo Chat worker URL (client-side, inlined at build time)
export const KILO_CHAT_URL = requireEnv(
  'NEXT_PUBLIC_KILO_CHAT_URL',
  process.env.NEXT_PUBLIC_KILO_CHAT_URL
);

// Event Service WebSocket URL (client-side, inlined at build time)
export const EVENT_SERVICE_URL = requireEnv(
  'NEXT_PUBLIC_EVENT_SERVICE_URL',
  process.env.NEXT_PUBLIC_EVENT_SERVICE_URL
);
