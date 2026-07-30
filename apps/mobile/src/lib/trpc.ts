import { type MobileRouter } from '@kilocode/trpc/mobile';
import { createTRPCClient, httpBatchLink, httpLink, splitLink } from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import * as SecureStore from 'expo-secure-store';

import { API_BASE_URL, E2E_LATENCY_MESSAGES_MS, E2E_LATENCY_SESSION_MS } from '@/lib/config';
import { AUTH_TOKEN_KEY } from '@/lib/storage-keys';

export const { TRPCProvider, useTRPC } = createTRPCContext<MobileRouter>();

const trpcUrl = `${API_BASE_URL}/api/trpc`;

/**
 * E2E-only artificial backend latency (repro for latency-dependent UI states,
 * e.g. the session-open empty flash). When E2E_LATENCY_* env vars are set at
 * Metro bundle time, matching procedure responses arrive late at the app —
 * the same condition a slow production backend creates. Disabled (0) unless
 * the env vars are explicitly set; never set them outside E2E.
 */
const E2E_LATENCY_RULES: readonly (readonly [procedure: string, delayMs: number])[] = [
  ['cliSessionsV2.get', E2E_LATENCY_SESSION_MS],
  ['cliSessionsV2.getSessionMessagesPage', E2E_LATENCY_MESSAGES_MS],
];

function requestUrlString(url: RequestInfo | URL): string {
  if (typeof url === 'string') {
    return url;
  }
  if (url instanceof URL) {
    return url.href;
  }
  return url.url;
}

function e2eLatencyForUrl(url: string): number {
  let delayMs = 0;
  for (const [procedure, procedureDelayMs] of E2E_LATENCY_RULES) {
    if (procedureDelayMs > delayMs && url.includes(procedure)) {
      delayMs = procedureDelayMs;
    }
  }
  return delayMs;
}

const e2eLatencyFetch: typeof fetch = async (url, init) => {
  const delayMs = e2eLatencyForUrl(requestUrlString(url));
  if (delayMs > 0) {
    await new Promise(resolve => {
      setTimeout(resolve, delayMs);
    });
  }
  return fetch(url, init);
};

const e2eFetch =
  E2E_LATENCY_SESSION_MS > 0 || E2E_LATENCY_MESSAGES_MS > 0 ? e2eLatencyFetch : fetch;

async function getAuthHeaders() {
  const token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  if (!token) {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}

export const trpcClient = createTRPCClient<MobileRouter>({
  links: [
    splitLink({
      condition: op => op.context.skipBatch === true,
      true: httpLink({
        url: trpcUrl,
        headers: getAuthHeaders,
        fetch: e2eFetch,
      }),
      false: httpBatchLink({
        url: trpcUrl,
        headers: getAuthHeaders,
        fetch: e2eFetch,
      }),
    }),
  ],
});
