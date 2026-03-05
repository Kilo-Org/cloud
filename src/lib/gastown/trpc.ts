'use client';

/**
 * Gastown tRPC client — talks directly to the Cloudflare Worker.
 *
 * This replaces the proxy path (browser → Next.js tRPC → gastown-client.ts → worker).
 * The browser fetches a short-lived JWT from /api/gastown/token and sends it
 * as Bearer auth to the worker's /trpc endpoint.
 */

import { createTRPCClient, httpBatchLink, httpLink, splitLink } from '@trpc/client';
import { z } from 'zod';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import type { inferRouterOutputs } from '@trpc/server';
import type { WrappedGastownRouter } from '@/lib/gastown/types/router';
import { GASTOWN_URL } from '@/lib/constants';

// ── Type exports ──────────────────────────────────────────────────────────
// Re-export the router type so frontend components can extract output types
// without importing from the worker package directly.
export type { WrappedGastownRouter };
export type GastownOutputs = inferRouterOutputs<WrappedGastownRouter>;

// ── Token management ──────────────────────────────────────────────────────
// Fetches a short-lived JWT from /api/gastown/token (session-cookie-authed)
// and caches it in memory. Refreshes automatically when near expiry.

let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;
let inflightRequest: Promise<string> | null = null;

async function fetchToken(): Promise<string> {
  const res = await fetch('/api/gastown/token', { method: 'POST' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to fetch gastown token: ${res.status} ${body}`);
  }
  const data: unknown = await res.json();
  const parsed = z.object({ token: z.string(), expiresAt: z.string() }).parse(data);
  cachedToken = parsed.token;
  tokenExpiresAt = new Date(parsed.expiresAt).getTime();
  return parsed.token;
}

async function getToken(): Promise<string> {
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

// ── WebSocket URL helper ──────────────────────────────────────────────────
// The worker returns relative paths for WebSocket endpoints (e.g. /api/towns/…/stream).
// The browser constructs the full ws(s):// URL using the known GASTOWN_URL.

export function gastownWsUrl(relativePath: string): string {
  const base = new URL(GASTOWN_URL);
  const protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${base.host}${relativePath}`;
}

// ── tRPC client ───────────────────────────────────────────────────────────

const gastownTrpcUrl = `${GASTOWN_URL}/trpc`;

const headers = async () => {
  const token = await getToken();
  return { Authorization: `Bearer ${token}` };
};

export function createGastownTRPCClient() {
  return createTRPCClient<WrappedGastownRouter>({
    links: [
      splitLink({
        condition: op => op.context.skipBatch === true,
        true: httpLink({ url: gastownTrpcUrl, headers }),
        false: httpBatchLink({ url: gastownTrpcUrl, headers }),
      }),
    ],
  });
}

// ── React integration ─────────────────────────────────────────────────────
// Creates the same shape as the main tRPC utils (TRPCProvider, useTRPC, etc.)
// but typed against the Gastown router served by the worker.

export const {
  TRPCProvider: GastownTRPCProvider,
  useTRPC: useGastownTRPC,
  useTRPCClient: useGastownTRPCClient,
} = createTRPCContext<WrappedGastownRouter>();
