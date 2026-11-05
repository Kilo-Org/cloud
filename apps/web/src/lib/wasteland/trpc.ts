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
import { WASTELAND_URL } from '@/lib/service-urls';
import {
  browserCapabilityHeader,
  type BrowserWorkerIdentity,
} from '@/lib/worker-admin/browser-capability';

// ── Type exports ──────────────────────────────────────────────────────────
// Re-export the router type so frontend components can extract output types
// without importing from the worker package directly.
export type { WrappedWastelandRouter };
export type WastelandOutputs = inferRouterOutputs<WrappedWastelandRouter>;

// ── Token management ──────────────────────────────────────────────────────
// Fetches a short-lived JWT from /api/wasteland/token (session-cookie-authed)
// and caches it in memory. Refreshes automatically when near expiry.

let cachedIdentity: BrowserWorkerIdentity | null = null;
let tokenExpiresAt: number = 0;
let inflightRequest: Promise<BrowserWorkerIdentity> | null = null;

async function fetchIdentity(): Promise<BrowserWorkerIdentity> {
  const res = await fetch('/api/wasteland/token', { method: 'POST' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to fetch wasteland token: ${res.status} ${body}`);
  }
  const data: unknown = await res.json();
  const parsed = z
    .object({
      token: z.string(),
      expiresAt: z.string(),
      admin: z.boolean().catch(false),
      capabilityIssuance: z.boolean().catch(false),
    })
    .parse(data);
  cachedIdentity = {
    token: parsed.token,
    admin: parsed.admin,
    capabilityIssuance: parsed.capabilityIssuance,
  };
  tokenExpiresAt = new Date(parsed.expiresAt).getTime();
  return cachedIdentity;
}

export async function getIdentity(): Promise<BrowserWorkerIdentity> {
  // Return cached identity if still fresh (5 min buffer)
  if (cachedIdentity && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedIdentity;
  }
  // Deduplicate concurrent requests
  if (!inflightRequest) {
    inflightRequest = fetchIdentity().finally(() => {
      inflightRequest = null;
    });
  }
  return inflightRequest;
}

export async function getToken(): Promise<string> {
  return (await getIdentity()).token;
}

// ── tRPC client ───────────────────────────────────────────────────────────

const wastelandTrpcUrl = `${WASTELAND_URL}/trpc`;

const headers = async (
  opts:
    | { op: { path: string; input: unknown } }
    | { opList: ReadonlyArray<{ path: string; input: unknown }> }
) => {
  const operations = 'opList' in opts ? opts.opList : [opts.op];
  const identity = await getIdentity();
  const capability = await browserCapabilityHeader({
    audience: 'wasteland-admin',
    operations,
    getIdentity: getIdentity,
    tokenEndpoint: '/api/wasteland/token',
  });
  return {
    Authorization: `Bearer ${identity.token}`,
    ...(capability ? { 'X-Kilo-Worker-Capability': capability } : {}),
  };
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
