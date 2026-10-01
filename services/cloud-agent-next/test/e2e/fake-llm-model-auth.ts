/**
 * Model-route bearer verification for the deployed fake LLM Worker.
 *
 * Worker-only: it imports `@kilocode/worker-utils`, which the local Node fake
 * server and the local driver must not pull in (LD1). The local Node model
 * routes deliberately accept unauthenticated calls — the Next.js gateway dials
 * them with the static `local-fake-llm` credential
 * (`apps/web/src/lib/ai-gateway/local-fake-llm.ts`).
 *
 * `kiloTokenPayload` omits `tokenPurpose`/`credentialExchange` and a non-strict
 * Zod parse strips unknown keys, so a policy-bearing token can never be
 * detected from `verifyKiloToken`'s return value. The signature is therefore
 * verified with `verifyKiloToken` and the *raw* decoded payload is checked
 * separately for the claims an ordinary personal token must not carry.
 *
 * The pepper check mirrors the first half of production's API-token rule
 * (`apps/web/src/lib/user/server.ts`): an absent `apiTokenPepper` claim is
 * rejected, while an explicit `null` is accepted, because production compares
 * the claim to the account's stored pepper and a null pepper is valid for such
 * an account. That equality half cannot be replicated here — the fake has no
 * database access by design — so this is a shape check, not full gateway
 * semantics.
 */

import { extractBearerToken, verifyKiloToken, type KiloTokenPayload } from '@kilocode/worker-utils';

/**
 * Claims that only a non-ordinary (session, organization, delegated-workload,
 * runtime-authorized or audience-bound) token carries. Their presence rejects
 * the token on the model routes.
 */
export const FORBIDDEN_MODEL_TOKEN_CLAIMS = [
  'aud',
  'tokenPurpose',
  'credentialExchange',
  'runtimeAdmission',
  'runtimeAuthorization',
  'organizationId',
  'organizationRole',
] as const;

/** A Cloudflare Secrets Store binding (production) or a plain string (tests/local). */
export type NextAuthSecretBinding = { get(): Promise<string | null> } | string | undefined;

/** Resolve the binding, normalizing missing/empty values to null. */
export async function resolveNextAuthSecret(
  binding: NextAuthSecretBinding
): Promise<string | null> {
  if (binding === undefined || binding === null) return null;
  const value = typeof binding === 'string' ? binding : await binding.get();
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Decode the payload segment of an already-verified JWT.
 *
 * The token's signature has been checked before this is called, so no
 * verification is repeated here. `jose` is not a dependency of this package;
 * base64url + `atob` + `TextDecoder` is all the decode needs.
 */
export function decodeTrustedPayload(token: string): Record<string, unknown> {
  const segment = token.split('.')[1];
  if (!segment) throw new Error('token payload segment is missing');
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('token payload is not an object');
  }
  return parsed as Record<string, unknown>;
}

export type ModelRouteAuthResult =
  | { ok: true; payload: KiloTokenPayload }
  | { ok: false; status: number; message: string };

/**
 * Verify a bearer for the Worker's model routes.
 *
 * Order: bearer presence (401), secret availability (500), signature/expiry
 * (401), forbidden claims (401), present pepper claim (401).
 *
 * The pepper claim only has to be present: an explicit `null` is accepted, as
 * production accepts it for an account whose stored pepper is null.
 */
export async function verifyModelRouteBearer(
  authorization: string | undefined,
  secretBinding: NextAuthSecretBinding
): Promise<ModelRouteAuthResult> {
  const token = extractBearerToken(authorization);
  if (!token) {
    return { ok: false, status: 401, message: 'model authorization required' };
  }

  let secret: string | null;
  try {
    secret = await resolveNextAuthSecret(secretBinding);
  } catch {
    // A Secrets Store `get()` can reject transiently; surface it as the same
    // structured 500 the missing-secret path uses instead of an opaque throw.
    return {
      ok: false,
      status: 500,
      message: 'NEXTAUTH_SECRET could not be resolved on the fake LLM worker',
    };
  }
  if (!secret) {
    return {
      ok: false,
      status: 500,
      message: 'NEXTAUTH_SECRET is not configured on the fake LLM worker',
    };
  }

  let payload: KiloTokenPayload;
  try {
    payload = await verifyKiloToken(token, secret);
  } catch {
    return { ok: false, status: 401, message: 'invalid model token' };
  }

  let decoded: Record<string, unknown>;
  try {
    decoded = decodeTrustedPayload(token);
  } catch {
    return { ok: false, status: 401, message: 'invalid model token' };
  }

  const forbidden = FORBIDDEN_MODEL_TOKEN_CLAIMS.filter(claim => claim in decoded);
  if (forbidden.length > 0) {
    return {
      ok: false,
      status: 401,
      message: `model token carries unsupported claims: ${forbidden.join(', ')}`,
    };
  }

  if (decoded.apiTokenPepper === undefined) {
    return { ok: false, status: 401, message: 'model token pepper is not usable' };
  }

  return { ok: true, payload };
}
