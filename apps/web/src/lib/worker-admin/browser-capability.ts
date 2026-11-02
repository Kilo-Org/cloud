'use client';

export type BrowserCapabilityAudience = 'gastown-admin' | 'wasteland-admin';

type OperationLike = { path: string; input: unknown };

type Target = { kind: 'town' | 'wasteland'; id: string };

type CapabilityEntry = { capability: string; expiresAt: number };

const cache = new Map<string, CapabilityEntry>();
const inflight = new Map<string, Promise<CapabilityEntry | null>>();

function decodeTokenClaims(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const json = decodeURIComponent(
      Array.from(atob(padded), char => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join(
        ''
      )
    );
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

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

function cacheKey(target: Target, actions: string[]): string {
  return `${target.kind}:${target.id}:${actions.slice().sort().join(',')}`;
}

/**
 * Return the `X-Kilo-Worker-Capability` value for a browser tRPC batch, or
 * null when the caller is not an admin, the batch spans targets, or capability
 * issuance is unavailable. Falling back to null keeps today's legacy-claim
 * behavior while issuance is dark.
 */
export async function browserCapabilityHeader(params: {
  audience: BrowserCapabilityAudience;
  operations: readonly OperationLike[];
  getIdentityToken: () => Promise<string>;
  tokenEndpoint: '/api/gastown/token' | '/api/wasteland/token';
}): Promise<string | null> {
  const identityToken = await params.getIdentityToken();
  const claims = decodeTokenClaims(identityToken);
  if (claims?.isAdmin !== true) return null;

  const target = commonTarget(params.audience, params.operations);
  if (!target) return null;

  const actions = params.operations
    .map(operation => `trpc:${operation.path}`)
    .filter(action =>
      action.startsWith(`trpc:${params.audience === 'gastown-admin' ? 'gastown' : 'wasteland'}.`)
    );
  if (actions.length === 0) return null;

  const key = cacheKey(target, actions);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.capability;

  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(params.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminCapability: { target, actions } }),
      });
      if (!response.ok) return null;
      const body: unknown = await response.json().catch(() => null);
      const parsed =
        typeof body === 'object' && body !== null
          ? (body as { capability?: unknown; capabilityExpiresAt?: unknown })
          : {};
      if (typeof parsed.capability !== 'string' || typeof parsed.capabilityExpiresAt !== 'string') {
        return null;
      }
      const expiresAt = new Date(parsed.capabilityExpiresAt).getTime();
      if (!Number.isFinite(expiresAt)) return null;
      return { capability: parsed.capability, expiresAt };
    })().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, pending);
  }

  const entry = await pending;
  if (!entry) return null;
  const expiresAt = entry.expiresAt - 30_000;
  if (expiresAt > Date.now()) cache.set(key, { ...entry, expiresAt });
  return entry.capability;
}
