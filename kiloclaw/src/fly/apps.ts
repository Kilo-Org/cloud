/**
 * Fly.io Apps + IP allocation REST API.
 *
 * Manages per-user Fly Apps: creation, existence checks, deletion,
 * and IP address allocation (IPv4 shared + IPv6).
 * All calls use the Machines REST API (https://api.machines.dev).
 *
 * App naming: `acct-{first 20 hex chars of SHA-256(userId)}`
 */

import { FlyApiError } from './client';

const FLY_API_BASE = 'https://api.machines.dev';

// -- App name derivation --

/**
 * Derive a deterministic Fly app name from a userId.
 *
 * Production: `acct-{first 20 hex chars of SHA-256(userId)}` (25 chars)
 * With prefix: `{prefix}-{first 20 hex chars}` (e.g. `dev-{hash}` = 24 chars)
 *
 * The hash portion is the same regardless of prefix, so you can compare
 * across environments by stripping the prefix.
 *
 * @param prefix - Environment prefix (e.g. "dev" for WORKER_ENV=development). Omit for production.
 */
export async function appNameFromUserId(userId: string, prefix?: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(userId);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  const hex = Array.from(hashArray.slice(0, 10))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return prefix ? `${prefix}-${hex}` : `acct-${hex}`;
}

// -- REST API helpers --

type FlyAppConfig = {
  apiToken: string;
};

type FlyApp = {
  id: string;
  created_at: number;
};

async function apiFetch(apiToken: string, path: string, init?: RequestInit): Promise<Response> {
  const url = `${FLY_API_BASE}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
}

async function assertOk(resp: Response, context: string): Promise<void> {
  if (!resp.ok) {
    const body = await resp.text();
    throw new FlyApiError(`Fly API ${context} failed (${resp.status}): ${body}`, resp.status, body);
  }
}

// -- Apps resource --

/**
 * Create a Fly App with its own isolated private network.
 * POST /v1/apps — returns 201 on success.
 *
 * Each per-user app gets `network: appName` so machines in different
 * user apps cannot reach each other over Fly's internal `.internal` DNS.
 */
export async function createApp(
  config: FlyAppConfig,
  appName: string,
  orgSlug: string
): Promise<FlyApp> {
  const resp = await apiFetch(config.apiToken, '/v1/apps', {
    method: 'POST',
    body: JSON.stringify({ app_name: appName, org_slug: orgSlug, network: appName }),
  });
  // 409 = app already exists (race with alarm retry or Fly API eventual consistency)
  if (resp.status === 409) return { id: appName, created_at: 0 };
  await assertOk(resp, 'createApp');
  return resp.json();
}

/**
 * Check if a Fly App exists.
 * GET /v1/apps/{app_name} — returns the app or null if 404.
 */
export async function getApp(config: FlyAppConfig, appName: string): Promise<FlyApp | null> {
  const resp = await apiFetch(config.apiToken, `/v1/apps/${encodeURIComponent(appName)}`);
  if (resp.status === 404) return null;
  await assertOk(resp, 'getApp');
  return resp.json();
}

/**
 * Delete a Fly App.
 * DELETE /v1/apps/{app_name}
 */
export async function deleteApp(config: FlyAppConfig, appName: string): Promise<void> {
  const resp = await apiFetch(config.apiToken, `/v1/apps/${encodeURIComponent(appName)}`, {
    method: 'DELETE',
  });
  if (resp.status === 404) return; // already gone
  await assertOk(resp, 'deleteApp');
}

// -- IP allocation --

/** Fly REST API response shape for POST /v1/apps/{app}/ip_assignments */
type IPAssignment = {
  ip: string;
  region: string;
  created_at: string;
  shared: boolean;
};

/**
 * Allocate an IP address for a Fly App.
 * POST /v1/apps/{app_name}/ip_assignments
 *
 * @param ipType - "v6" for dedicated IPv6, "shared_v4" for shared IPv4
 */
export async function allocateIP(
  apiToken: string,
  appName: string,
  ipType: 'v6' | 'shared_v4'
): Promise<IPAssignment> {
  const resp = await apiFetch(apiToken, `/v1/apps/${encodeURIComponent(appName)}/ip_assignments`, {
    method: 'POST',
    body: JSON.stringify({ type: ipType }),
  });
  // 409/422 = IP already allocated (safe to treat as success during retries)
  if (resp.status === 409 || resp.status === 422) {
    return { ip: '', region: '', created_at: '', shared: ipType === 'shared_v4' };
  }
  await assertOk(resp, 'allocateIP');
  return resp.json();
}
