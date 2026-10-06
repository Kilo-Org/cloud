import { requireEnv } from '@kilocode/web-shared/lib/dotenvx';

// Gastown worker URL (client-side, inlined at build time)
// The browser talks directly to the gastown Cloudflare Worker for tRPC + WS.
// Must use NEXT_PUBLIC_ prefix so Next.js exposes it to the browser bundle.
export const GASTOWN_URL = requireEnv(
  'NEXT_PUBLIC_GASTOWN_URL',
  process.env.NEXT_PUBLIC_GASTOWN_URL
);

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

// Wasteland worker URL (client-side, inlined at build time)
// The browser talks directly to the Wasteland Cloudflare Worker for tRPC.
// Must use NEXT_PUBLIC_ prefix so Next.js exposes it to the browser bundle.
export const WASTELAND_URL = requireEnv(
  'NEXT_PUBLIC_WASTELAND_URL',
  process.env.NEXT_PUBLIC_WASTELAND_URL
);
