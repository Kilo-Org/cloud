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
import type { FlyMachine } from './types';

const FLY_API_BASE = 'https://api.machines.dev';

/**
 * Error thrown when a Fly app name collision is detected.
 * Two different userIds produced the same truncated SHA-256 hash,
 * resulting in the same Fly app name. This is a tenant isolation breach
 * at the network layer — machines from different users would share
 * a private network namespace.
 */
export class AppNameCollisionError extends Error {
  constructor(
    readonly appName: string,
    readonly requestingUserId: string
  ) {
    super(
      `Fly app name collision detected: app "${appName}" exists and belongs to a different user. ` +
        `Requesting userId: "${requestingUserId}". This indicates a SHA-256 hash truncation collision.`
    );
    this.name = 'AppNameCollisionError';
  }
}

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
 *
 * On 409 (app already exists), verifies ownership by listing machines
 * and checking that any existing machines belong to the requesting userId.
 * Throws AppNameCollisionError if the app belongs to a different user —
 * this indicates a SHA-256 hash truncation collision (see PC-1 finding).
 *
 * @param userId - The userId requesting this app. Used to verify ownership on 409.
 * @param userIdMetadataKey - The metadata key used to tag machines with userId.
 */
export async function createApp(
  config: FlyAppConfig,
  appName: string,
  orgSlug: string,
  userId: string,
  userIdMetadataKey: string
): Promise<FlyApp> {
  const resp = await apiFetch(config.apiToken, '/v1/apps', {
    method: 'POST',
    body: JSON.stringify({ app_name: appName, org_slug: orgSlug, network: appName }),
  });

  if (resp.status === 409) {
    // App already exists — could be a retry (same user) or a hash collision (different user).
    // Verify ownership by listing machines and checking their userId metadata.
    await verifyAppOwnership(config.apiToken, appName, userId, userIdMetadataKey);
    return { id: appName, created_at: 0 };
  }

  await assertOk(resp, 'createApp');
  return resp.json();
}

/**
 * Verify that an existing Fly app belongs to the expected userId.
 *
 * Lists machines in the app and checks the userId metadata tag.
 * If the app has machines belonging to a different user, throws
 * AppNameCollisionError. If the app is empty (no machines yet)
 * or all machines match the expected userId, returns normally.
 */
async function verifyAppOwnership(
  apiToken: string,
  appName: string,
  expectedUserId: string,
  userIdMetadataKey: string
): Promise<void> {
  const machinesResp = await apiFetch(apiToken, `/v1/apps/${encodeURIComponent(appName)}/machines`);

  // If we can't list machines (e.g. app in weird state), fail open —
  // this is the same behavior as before the collision check was added.
  if (!machinesResp.ok) return;

  const machines: FlyMachine[] = await machinesResp.json();

  // No machines = app exists but is empty (e.g. previous retry created the app
  // but crashed before creating a machine). Safe to proceed.
  if (machines.length === 0) return;

  // Check if any machine belongs to a different user.
  const foreignMachine = machines.find(
    m =>
      m.config?.metadata?.[userIdMetadataKey] !== undefined &&
      m.config.metadata[userIdMetadataKey] !== expectedUserId
  );

  if (foreignMachine) {
    throw new AppNameCollisionError(appName, expectedUserId);
  }
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
