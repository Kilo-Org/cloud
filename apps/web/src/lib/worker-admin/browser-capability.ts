'use client';

import { findWorkerAdminAction } from '@kilocode/worker-utils/worker-admin-actions';

export type BrowserCapabilityAudience = 'gastown-admin' | 'wasteland-admin';

type OperationLike = { path: string; input: unknown };

type Target = { kind: 'town' | 'wasteland'; id: string };

export type BrowserWorkerIdentity = {
  token: string;
  admin: boolean;
  capabilityIssuance: boolean;
};

type CapabilityEntry = { capability: string; expiresAt: number; actions: Set<string> };

const NEGATIVE_CACHE_MS = 60_000;

const cache = new Map<string, CapabilityEntry>();
const negativeCache = new Map<string, number>();
const inflight = new Map<string, Promise<CapabilityEntry | null>>();

function targetForOperation(
  audience: BrowserCapabilityAudience,
  operation: OperationLike
): Target | null {
  if (typeof operation.input !== 'object' || operation.input === null) return null;
  const input = operation.input as Record<string, unknown>;
  if (audience === 'gastown-admin') {
    return typeof input.townId === 'string' ? { kind: 'town', id: input.townId } : null;
  }
  return typeof input.wastelandId === 'string'
    ? { kind: 'wasteland', id: input.wastelandId }
    : null;
}

function commonTarget(
  audience: BrowserCapabilityAudience,
  operations: readonly OperationLike[]
): Target | null {
  const targets = operations.map(operation => targetForOperation(audience, operation));
  const [first] = targets;
  if (!first) return null;
  return targets.every(target => target?.kind === first.kind && target.id === first.id)
    ? first
    : null;
}

function targetKey(audience: BrowserCapabilityAudience, target: Target): string {
  return `${audience}:${target.kind}:${target.id}`;
}

export function resetBrowserCapabilityCache(): void {
  cache.clear();
  negativeCache.clear();
  inflight.clear();
}

/**
 * Return the `X-Kilo-Worker-Capability` value for a browser tRPC batch, or
 * null when the caller is not an admin, capability issuance is disabled, the
 * batch spans targets, or issuance failed recently.
 *
 * At the default flags this is a no-op: capability issuance is advertised as
 * disabled by the token endpoint, so no extra request is made and admin
 * behavior is exactly the legacy path.
 */
export async function browserCapabilityHeader(params: {
  audience: BrowserCapabilityAudience;
  operations: readonly OperationLike[];
  getIdentity: () => Promise<BrowserWorkerIdentity>;
  tokenEndpoint: '/api/gastown/token' | '/api/wasteland/token';
}): Promise<string | null> {
  const identity = await params.getIdentity();
  if (!identity.admin || !identity.capabilityIssuance) return null;

  const target = commonTarget(params.audience, params.operations);
  if (!target) return null;

  const prefix = params.audience === 'gastown-admin' ? 'gastown' : 'wasteland';
  const actions = params.operations
    .map(operation => `trpc:${operation.path}`)
    .filter(action => {
      if (!action.startsWith(`trpc:${prefix}.`)) return false;
      return findWorkerAdminAction(params.audience, action)?.targetKind === target.kind;
    });
  if (actions.length === 0) return null;

  const key = targetKey(params.audience, target);

  for (let attempt = 0; attempt < 3; attempt++) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt <= Date.now()) cache.delete(key);
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      actions.every(action => cached.actions.has(action))
    ) {
      return cached.capability;
    }

    const retryAt = negativeCache.get(key);
    if (retryAt !== undefined) {
      if (retryAt > Date.now()) return null;
      negativeCache.delete(key);
    }

    const requested = new Set(actions);
    if (cached) {
      for (const action of cached.actions) requested.add(action);
    }
    const requestActions = [...requested].sort();

    let pending = inflight.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const response = await fetch(params.tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminCapability: { target, actions: requestActions } }),
          });
          if (!response.ok) return null;
          const body: unknown = await response.json().catch(() => null);
          const parsed =
            typeof body === 'object' && body !== null
              ? (body as { capability?: unknown; capabilityExpiresAt?: unknown })
              : {};
          if (
            typeof parsed.capability !== 'string' ||
            typeof parsed.capabilityExpiresAt !== 'string'
          ) {
            return null;
          }
          const expiresAt = new Date(parsed.capabilityExpiresAt).getTime();
          if (!Number.isFinite(expiresAt)) return null;
          return {
            capability: parsed.capability,
            expiresAt,
            actions: new Set(requestActions),
          };
        } catch {
          return null;
        }
      })().finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, pending);
    }

    const entry = await pending;
    if (!entry) {
      negativeCache.set(key, Date.now() + NEGATIVE_CACHE_MS);
      return null;
    }

    if (!actions.every(action => entry.actions.has(action))) {
      if (inflight.get(key) === pending) inflight.delete(key);
      cache.delete(key);
      continue;
    }

    const expiresAt = entry.expiresAt - 30_000;
    if (expiresAt > Date.now()) cache.set(key, { ...entry, expiresAt });
    return entry.capability;
  }

  return null;
}
