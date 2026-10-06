import { requireEnv } from '@kilocode/web-shared/lib/dotenvx';

// Browser-facing Worker URLs, inlined at build time. They live in apps/web, not
// packages/web-shared, so the AI gateway does not require them to start.

export const GASTOWN_URL = requireEnv(
  'NEXT_PUBLIC_GASTOWN_URL',
  process.env.NEXT_PUBLIC_GASTOWN_URL
);

export const KILO_CHAT_URL = requireEnv(
  'NEXT_PUBLIC_KILO_CHAT_URL',
  process.env.NEXT_PUBLIC_KILO_CHAT_URL
);

export const EVENT_SERVICE_URL = requireEnv(
  'NEXT_PUBLIC_EVENT_SERVICE_URL',
  process.env.NEXT_PUBLIC_EVENT_SERVICE_URL
);

export const WASTELAND_URL = requireEnv(
  'NEXT_PUBLIC_WASTELAND_URL',
  process.env.NEXT_PUBLIC_WASTELAND_URL
);
