import { z } from 'zod';
import { CLOUDFLARE_FETCH_TIMEOUT_MS } from '../constants';

/** https://developers.cloudflare.com/api/ */
export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * One token policy as Cloudflare takes it: allow these permission groups on these resources.
 * https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/
 */
export type CloudflareTokenPolicy = {
  effect: 'allow';
  permission_groups: { id: string }[];
  resources: Record<string, '*'>;
};

/** One policy of a created token as Cloudflare returns it: every group with its name. */
const ReturnedPolicySchema = z.object({
  effect: z.string(),
  permission_groups: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })).min(1),
  resources: z.record(z.string(), z.string()),
});

const CreatedTokenSchema = z.object({
  success: z.literal(true),
  result: z.object({
    id: z.string().regex(/^[0-9a-f]{32}$/),
    value: z.string().min(1),
    expires_on: z.iso.datetime({ offset: true }),
    /**
     * Null when STS cannot read them: a group without its name, a resource value that is not a
     * string, or no policy at all. The token exists, so STS deletes it as a `grant_mismatch`
     * instead of treating the answer as unknown.
     */
    policies: z.array(ReturnedPolicySchema).min(1).nullable().catch(null),
  }),
});

const ListedTokensSchema = z.object({
  success: z.literal(true),
  result: z.array(
    z.object({
      id: z.string().regex(/^[0-9a-f]{32}$/),
      name: z.string(),
      expires_on: z.iso.datetime({ offset: true }).nullish(),
      status: z.string().optional(),
    })
  ),
});

const ListedScriptsSchema = z.object({
  success: z.literal(true),
  result: z.array(
    z.object({
      id: z.string().optional(),
      modified_on: z.iso.datetime({ offset: true }).optional(),
    })
  ),
});

/** One policy of a created token, as Cloudflare returned it. */
export type ReturnedTokenPolicy = {
  effect: string;
  permissionGroups: { id: string; name: string }[];
  resources: Record<string, string>;
};

/** What Cloudflare says about the token it made; never logged, `value` goes to the caller only. */
export type CreatedToken = {
  id: string;
  value: string;
  expiresAt: number;
  /** Null when Cloudflare's answer held no readable policy list (see `CreatedTokenSchema`). */
  policies: ReturnedTokenPolicy[] | null;
};

export type TokenCreation =
  | { status: 'created'; token: CreatedToken }
  /** Cloudflare answered 4xx: it made no token. */
  | {
      status: 'refused';
      httpStatus: number;
      credentialRefused: boolean;
      retryAfterMs: number | null;
    }
  /** A timeout, a transport error, a 5xx or an unreadable 200: a token may exist. */
  | { status: 'unknown'; detail: string; retryAfterMs: number | null };

/** A call that could not reach Cloudflare, or that Cloudflare refused. */
export type CloudflareUnreachable = {
  status: 'unreachable';
  detail: string;
  credentialRefused: boolean;
  retryAfterMs: number | null;
};

/** `gone`: Cloudflare no longer has the token (404). */
export type TokenDeletion = { status: 'deleted' } | { status: 'gone' } | CloudflareUnreachable;

export type ListedToken = { id: string; name: string; expiresAt: number | null };

export type TokenPage = { status: 'ok'; tokens: ListedToken[] } | CloudflareUnreachable;

/** A Worker script and when it last changed. */
export type ListedScript = { name: string; modifiedAt: number };

export type ScriptList = { status: 'ok'; scripts: ListedScript[] } | CloudflareUnreachable;

function retryAfterMs(response: Response): number | null {
  if (response.status !== 429) return null;
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function isCredentialRefused(status: number): boolean {
  return status === 401 || status === 403;
}

/** A transport failure or a timeout; the detail never holds a request or response body. */
class CloudflareTransportError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'CloudflareTransportError';
  }
}

async function cloudflareFetch(
  credential: string,
  path: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }
): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${credential}` });
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  try {
    return await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(CLOUDFLARE_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new CloudflareTransportError(
      timedOut ? 'cloudflare request timed out' : 'cloudflare request failed'
    );
  }
}

/** Formats an epoch time as Cloudflare's `date-time` without milliseconds. */
export function cloudflareTime(epochMs: number): string {
  return new Date(Math.floor(epochMs / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * Plain-REST client for Cloudflare's account API tokens
 * (https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/) and the
 * account's Worker script list, authenticated
 * with the minting credential the caller passes on each call. No response body is kept in an
 * error detail: a body can echo request data.
 */
export class CloudflareTokens {
  constructor(private readonly accountId: string) {}

  /** `POST /accounts/{account_id}/tokens`. Never retried: a create that timed out may have made one. */
  async create(
    credential: string,
    request: {
      name: string;
      policies: CloudflareTokenPolicy[];
      notBefore: number;
      expiresAt: number;
    }
  ): Promise<TokenCreation> {
    let response: Response;
    try {
      response = await cloudflareFetch(credential, `/accounts/${this.accountId}/tokens`, {
        method: 'POST',
        body: {
          name: request.name,
          policies: request.policies,
          not_before: cloudflareTime(request.notBefore),
          expires_on: cloudflareTime(request.expiresAt),
        },
      });
    } catch (error) {
      if (error instanceof CloudflareTransportError) {
        return { status: 'unknown', detail: error.detail, retryAfterMs: null };
      }
      throw error;
    }
    if (response.status >= 400 && response.status < 500) {
      await response.body?.cancel();
      return {
        status: 'refused',
        httpStatus: response.status,
        credentialRefused: isCredentialRefused(response.status),
        retryAfterMs: retryAfterMs(response),
      };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return {
        status: 'unknown',
        detail: `cloudflare token create failed with status ${response.status}`,
        retryAfterMs: null,
      };
    }
    const parsed = CreatedTokenSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      return {
        status: 'unknown',
        detail: 'cloudflare token create response did not match',
        retryAfterMs: null,
      };
    }
    const { result } = parsed.data;
    return {
      status: 'created',
      token: {
        id: result.id,
        value: result.value,
        expiresAt: Date.parse(result.expires_on),
        policies:
          result.policies?.map(policy => ({
            effect: policy.effect,
            permissionGroups: policy.permission_groups.map(group => ({
              id: group.id,
              name: group.name,
            })),
            resources: policy.resources,
          })) ?? null,
      },
    };
  }

  /** `DELETE /accounts/{account_id}/tokens/{token_id}`. */
  async delete(credential: string, tokenId: string): Promise<TokenDeletion> {
    let response: Response;
    try {
      response = await cloudflareFetch(
        credential,
        `/accounts/${this.accountId}/tokens/${encodeURIComponent(tokenId)}`,
        { method: 'DELETE' }
      );
    } catch (error) {
      if (error instanceof CloudflareTransportError) {
        return {
          status: 'unreachable',
          detail: error.detail,
          credentialRefused: false,
          retryAfterMs: null,
        };
      }
      throw error;
    }
    await response.body?.cancel();
    if (response.status === 404) return { status: 'gone' };
    if (response.ok) return { status: 'deleted' };
    return {
      status: 'unreachable',
      detail: `cloudflare token delete failed with status ${response.status}`,
      credentialRefused: isCredentialRefused(response.status),
      retryAfterMs: retryAfterMs(response),
    };
  }

  /** `GET /accounts/{account_id}/tokens`, one page. */
  async list(credential: string, page: number, perPage: number): Promise<TokenPage> {
    let response: Response;
    try {
      response = await cloudflareFetch(
        credential,
        `/accounts/${this.accountId}/tokens?page=${page}&per_page=${perPage}`,
        { method: 'GET' }
      );
    } catch (error) {
      if (error instanceof CloudflareTransportError) {
        return {
          status: 'unreachable',
          detail: error.detail,
          credentialRefused: false,
          retryAfterMs: null,
        };
      }
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return {
        status: 'unreachable',
        detail: `cloudflare token list failed with status ${response.status}`,
        credentialRefused: isCredentialRefused(response.status),
        retryAfterMs: retryAfterMs(response),
      };
    }
    const parsed = ListedTokensSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      return {
        status: 'unreachable',
        detail: 'cloudflare token list response did not match',
        credentialRefused: false,
        retryAfterMs: null,
      };
    }
    return {
      status: 'ok',
      tokens: parsed.data.result.map(token => ({
        id: token.id,
        name: token.name,
        expiresAt: token.expires_on ? Date.parse(token.expires_on) : null,
      })),
    };
  }

  /**
   * `GET /accounts/{account_id}/workers/scripts`: every Worker script of the account with its
   * `modified_on`, in one answer; the endpoint has no pages
   * (https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/).
   * A script without a name or a time is left out.
   */
  async listScripts(credential: string): Promise<ScriptList> {
    let response: Response;
    try {
      response = await cloudflareFetch(credential, `/accounts/${this.accountId}/workers/scripts`, {
        method: 'GET',
      });
    } catch (error) {
      if (error instanceof CloudflareTransportError) {
        return {
          status: 'unreachable',
          detail: error.detail,
          credentialRefused: false,
          retryAfterMs: null,
        };
      }
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return {
        status: 'unreachable',
        detail: `cloudflare script list failed with status ${response.status}`,
        credentialRefused: isCredentialRefused(response.status),
        retryAfterMs: retryAfterMs(response),
      };
    }
    const parsed = ListedScriptsSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      return {
        status: 'unreachable',
        detail: 'cloudflare script list response did not match',
        credentialRefused: false,
        retryAfterMs: null,
      };
    }
    const scripts: ListedScript[] = [];
    for (const script of parsed.data.result) {
      if (script.id === undefined || script.modified_on === undefined) continue;
      scripts.push({ name: script.id, modifiedAt: Date.parse(script.modified_on) });
    }
    return { status: 'ok', scripts };
  }
}
