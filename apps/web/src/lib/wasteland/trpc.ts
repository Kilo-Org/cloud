'use client';

/**
 * Wasteland tRPC client — talks directly to the Cloudflare Worker.
 *
 * Mirrors the Gastown tRPC client pattern. The browser fetches a short-lived
 * JWT from /api/wasteland/token and sends it as Bearer auth to the worker's
 * /trpc endpoint.
 */

import { createTRPCClient, httpBatchLink, httpLink, splitLink } from '@trpc/client';
import { z } from 'zod';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import type { inferRouterOutputs } from '@trpc/server';
import type { WrappedWastelandRouter } from '@/lib/wasteland/types/router';
import { WASTELAND_URL } from '@/lib/constants';

// ── Type exports ──────────────────────────────────────────────────────────
// Re-export the router type so frontend components can extract output types
// without importing from the worker package directly.
export type { WrappedWastelandRouter };
export type WastelandOutputs = inferRouterOutputs<WrappedWastelandRouter>;

// ── Token management ──────────────────────────────────────────────────────
// Fetches a short-lived JWT from /api/wasteland/token (session-cookie-authed)
// and caches it in memory. Refreshes automatically when near expiry.

let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;
let inflightRequest: Promise<string> | null = null;

async function fetchToken(): Promise<string> {
  const res = await fetch('/api/wasteland/token', { method: 'POST' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to fetch wasteland token: ${res.status} ${body}`);
  }
  const data: unknown = await res.json();
  const parsed = z.object({ token: z.string(), expiresAt: z.string() }).parse(data);
  cachedToken = parsed.token;
  tokenExpiresAt = new Date(parsed.expiresAt).getTime();
  return parsed.token;
}

export async function getToken(): Promise<string> {
  // Return cached token if still fresh (5 min buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }
  // Deduplicate concurrent requests
  if (!inflightRequest) {
    inflightRequest = fetchToken().finally(() => {
      inflightRequest = null;
    });
  }
  return inflightRequest;
}

// ── tRPC client ───────────────────────────────────────────────────────────

const wastelandTrpcUrl = `${WASTELAND_URL}/trpc`;

const headers = async () => {
  const token = await getToken();
  return { Authorization: `Bearer ${token}` };
};

export function createWastelandTRPCClient() {
  return createTRPCClient<WrappedWastelandRouter>({
    links: [
      splitLink({
        condition: op => op.context.skipBatch === true,
        true: httpLink({ url: wastelandTrpcUrl, headers }),
        false: httpBatchLink({ url: wastelandTrpcUrl, headers }),
      }),
    ],
  });
}

// ── React integration ─────────────────────────────────────────────────────
// Creates the same shape as the main tRPC utils (TRPCProvider, useTRPC, etc.)
// but typed against the Wasteland router served by the worker.

export const {
  TRPCProvider: WastelandTRPCProvider,
  useTRPC: useWastelandTRPC,
  useTRPCClient: useWastelandTRPCClient,
} = createTRPCContext<WrappedWastelandRouter>();
