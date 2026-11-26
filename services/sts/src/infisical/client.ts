import { z } from 'zod';
import { MANAGER_FETCH_TIMEOUT_MS, MINTING_FOLDER } from '../constants';
import type { ManagerConfig } from '../env';

/** One minting credential; its value stays in the deploy-token object's memory. */
export type MintingSecretRead =
  | { status: 'ok'; value: string }
  | { status: 'missing' }
  | { status: 'unreachable'; detail: string; retryAfterMs: number | null };

/** The folders the refresher reads in each environment (design 4.2); `/ci` only for GitHub policies. */
export type ManagerFolder = '/workloads' | '/shared' | '/ci';

const LoginResponseSchema = z.object({
  accessToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
});

const SecretSchema = z.object({
  id: z.string().min(1),
  secretKey: z.string().min(1),
  secretValue: z.string(),
  version: z.number().int().nonnegative(),
  type: z.string(),
  secretPath: z.string().optional(),
  secretValueHidden: z.boolean(),
});

const ListResponseSchema = z.object({ secrets: z.array(SecretSchema) });

const NotFoundSchema = z.object({ error: z.string() });

/** One secret as the manager stores it in one folder. */
export type ManagerEntry = {
  path: string;
  name: string;
  id: string;
  version: number;
  value: string;
};

export type FolderRead =
  | { status: 'fresh'; entries: ManagerEntry[]; hidden: number; etag: string | null }
  | { status: 'not_modified' }
  | { status: 'unreachable'; detail: string; retryAfterMs: number | null };

/**
 * One Infisical dynamic secret: its name and the folder it sits in. Each sits alone in its own
 * folder, because a `dynamic-secrets` permission is scoped by folder and cannot name a secret.
 */
export type DynamicSecretRef = { name: string; path: string };

/**
 * https://infisical.com/docs/api-reference/endpoints/dynamic-secrets/create-lease. `data` is the
 * provider's output; the SQL provider returns the role's name and password under these keys.
 */
const LeaseCreatedSchema = z.object({
  lease: z.object({ id: z.uuid(), expireAt: z.iso.datetime({ offset: true }) }),
  data: z.object({ DB_USERNAME: z.string().min(1), DB_PASSWORD: z.string().min(1) }),
});

export type LeaseCreation =
  | { status: 'created'; leaseId: string; expiresAt: number; username: string; password: string }
  | { status: 'unreachable'; detail: string; retryAfterMs: number | null };

/**
 * What Infisical answers a lease revocation with: the lease row it deleted, or, when the revocation
 * statement failed, the row it kept with `status` "Failed to delete" (still HTTP 200; Infisical
 * retries it itself every few hours). Only `status` and the id are read; `statusDetails` holds the
 * database error and is never kept.
 */
const LeaseRevokedSchema = z.object({
  lease: z.object({ id: z.string(), status: z.string().nullish() }),
});

/** The 404 Infisical answers for a lease it does not have; other 404s are a misconfiguration. */
const LeaseNotFoundSchema = z.object({
  message: z.string().regex(/^Dynamic secret lease with ID '[^']*' not found$/),
});

/**
 * `revoked`: Infisical ran the revocation statement and deleted the lease. `gone`: Infisical no
 * longer has the lease (it expired and Infisical revoked it, or it was revoked before). Anything
 * else, a 200 that reports the lease kept included, is `unreachable`: the revocation stays owed.
 */
export type LeaseRevocation =
  | { status: 'revoked' }
  | { status: 'gone' }
  | { status: 'unreachable'; detail: string; retryAfterMs: number | null };

/** Tokens are reused until this long before they expire (design 4.2: they live 10 minutes). */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

class ManagerUnreachableError extends Error {
  constructor(
    readonly detail: string,
    readonly retryAfterMs: number | null
  ) {
    super(detail);
    this.name = 'ManagerUnreachableError';
  }
}

function retryAfterMs(response: Response): number | null {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** Status-only detail: no response body is kept, because a body can echo request data. */
function unreachableFor(response: Response, action: string): ManagerUnreachableError {
  return new ManagerUnreachableError(
    `manager ${action} failed with status ${response.status}`,
    response.status === 429 ? retryAfterMs(response) : null
  );
}

async function managerFetch(input: URL | string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(MANAGER_FETCH_TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new ManagerUnreachableError(
      timedOut ? 'manager request timed out' : 'manager request failed',
      null
    );
  }
}

/**
 * Plain-REST client for Infisical Cloud. It logs in with Infisical JWT Auth using a JWT the
 * signer object issues, keeps the access token until shortly before it expires, and merges
 * concurrent logins into one. Values and tokens stay inside this instance.
 */
export class InfisicalClient {
  private token: { value: string; expiresAt: number } | null = null;
  private pendingLogin: Promise<string> | null = null;

  constructor(
    private readonly config: ManagerConfig,
    private readonly signLoginJwt: () => Promise<string>
  ) {}

  private login(): Promise<string> {
    const cached = this.token;
    if (cached !== null && cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()) {
      return Promise.resolve(cached.value);
    }
    if (this.pendingLogin !== null) return this.pendingLogin;
    const pending = this.performLogin().finally(() => {
      this.pendingLogin = null;
    });
    this.pendingLogin = pending;
    return pending;
  }

  private async performLogin(): Promise<string> {
    let jwt: string;
    try {
      jwt = await this.signLoginJwt();
    } catch {
      throw new ManagerUnreachableError('login JWT could not be signed', null);
    }
    // https://infisical.com/docs/api-reference/endpoints/jwt-auth/login
    const response = await managerFetch(`${this.config.baseUrl}/api/v1/auth/jwt-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identityId: this.config.identityId, jwt }),
    });
    if (!response.ok) throw unreachableFor(response, 'login');
    const parsed = LoginResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new ManagerUnreachableError('manager login response did not match', null);
    }
    this.token = {
      value: parsed.data.accessToken,
      expiresAt: Date.now() + parsed.data.expiresIn * 1000,
    };
    return parsed.data.accessToken;
  }

  /**
   * Reads one folder and everything below it. A folder the manager does not have is an empty
   * folder; a transport failure, a timeout, 429, 5xx, a refused login, another 4xx or a malformed
   * body is unreachable. https://infisical.com/docs/api-reference/endpoints/secrets/list
   * The minting credentials under `MINTING_FOLDER` never leave this method: the `/ci` read drops
   * them before anything else sees them (README "Cloudflare deploy tokens").
   */
  async readFolder(folder: ManagerFolder, ifNoneMatch: string | null): Promise<FolderRead> {
    try {
      return await this.performRead(folder, true, ifNoneMatch);
    } catch (error) {
      if (error instanceof ManagerUnreachableError) {
        return { status: 'unreachable', detail: error.detail, retryAfterMs: error.retryAfterMs };
      }
      throw error;
    }
  }

  /**
   * Reads one minting credential from `MINTING_FOLDER` itself, nothing below it. `missing` when the
   * folder or the name is absent, hidden from this identity, or a value in reference syntax.
   */
  async readMintingSecret(name: string): Promise<MintingSecretRead> {
    let read: FolderRead;
    try {
      read = await this.performRead(MINTING_FOLDER, false, null);
    } catch (error) {
      if (error instanceof ManagerUnreachableError) {
        return { status: 'unreachable', detail: error.detail, retryAfterMs: error.retryAfterMs };
      }
      throw error;
    }
    if (read.status !== 'fresh') {
      return { status: 'unreachable', detail: 'manager answered 304', retryAfterMs: null };
    }
    const entry = read.entries.find(
      candidate => candidate.path === MINTING_FOLDER && candidate.name === name
    );
    if (entry === undefined || entry.value === '' || entry.value.startsWith('${')) {
      return { status: 'missing' };
    }
    return { status: 'ok', value: entry.value };
  }

  private async performRead(
    folder: string,
    recursive: boolean,
    ifNoneMatch: string | null
  ): Promise<FolderRead> {
    const token = await this.login();
    const url = new URL(`${this.config.baseUrl}/api/v4/secrets`);
    url.searchParams.set('projectId', this.config.projectId);
    url.searchParams.set('environment', this.config.environmentSlug);
    url.searchParams.set('secretPath', folder);
    url.searchParams.set('recursive', String(recursive));
    url.searchParams.set('expandSecretReferences', 'false');
    url.searchParams.set('includeImports', 'false');
    url.searchParams.set('viewSecretValue', 'true');

    const headers = new Headers({ authorization: `Bearer ${token}` });
    if (ifNoneMatch !== null) headers.set('if-none-match', ifNoneMatch);
    const response = await managerFetch(url, { headers });

    if (response.status === 304) return { status: 'not_modified' };
    if (response.status === 404) {
      // Infisical names a missing folder `SecretPathNotFound`; any other 404 (a project or
      // environment that does not exist) is a misconfiguration and keeps the last copy.
      const body = NotFoundSchema.safeParse(await response.json().catch(() => null));
      if (body.success && body.data.error === 'SecretPathNotFound') {
        return { status: 'fresh', entries: [], hidden: 0, etag: null };
      }
      throw new ManagerUnreachableError('manager read failed with status 404', null);
    }
    if (response.status === 401 || response.status === 403) {
      // A revoked or rotated token must not be reused on the next attempt.
      this.token = null;
    }
    if (!response.ok) throw unreachableFor(response, 'read');

    const parsed = ListResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new ManagerUnreachableError('manager read response did not match', null);
    }
    const entries: ManagerEntry[] = [];
    let hidden = 0;
    for (const secret of parsed.data.secrets) {
      const path = (secret.secretPath ?? folder).replace(/(.)\/+$/, '$1');
      const minting = path === MINTING_FOLDER || path.startsWith(`${MINTING_FOLDER}/`);
      if (folder !== MINTING_FOLDER && minting) continue;
      if (secret.type !== 'shared') continue;
      if (secret.secretValueHidden) {
        hidden += 1;
        continue;
      }
      entries.push({
        path,
        name: secret.secretKey,
        id: secret.id,
        version: secret.version,
        value: secret.secretValue,
      });
    }
    return { status: 'fresh', entries, hidden, etag: response.headers.get('etag') };
  }

  /**
   * Creates one lease of `secret` for `ttlSeconds`. Never retried: a create that timed out may still
   * have made a role, which Infisical drops at its expiry and whose password nobody received. Any
   * refusal (a 4xx, such as a lifetime above the dynamic secret's Max TTL, or a login refused), a
   * 5xx, a timeout or a malformed body is unreachable, with a status-only detail.
   */
  async createLease(secret: DynamicSecretRef, ttlSeconds: number): Promise<LeaseCreation> {
    try {
      const response = await this.managerCall('lease create', '/api/v1/dynamic-secrets/leases', {
        method: 'POST',
        body: {
          dynamicSecretName: secret.name,
          ...this.leaseScope(secret),
          ttl: `${ttlSeconds}s`,
        },
      });
      if (!response.ok) throw unreachableFor(response, 'lease create');
      const parsed = LeaseCreatedSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        throw new ManagerUnreachableError('manager lease response did not match', null);
      }
      return {
        status: 'created',
        leaseId: parsed.data.lease.id,
        expiresAt: Date.parse(parsed.data.lease.expireAt),
        username: parsed.data.data.DB_USERNAME,
        password: parsed.data.data.DB_PASSWORD,
      };
    } catch (error) {
      return unreachableOutcome(error);
    }
  }

  /**
   * Revokes one lease: Infisical runs the revocation statement, then deletes the lease. Success is
   * only a 200 whose lease row carries no failure status, or the 404 Infisical answers for a lease it
   * no longer has. A 200 with a status (a row that stayed after an earlier failure included: the
   * next attempt then gets the 404), a malformed body or any other 404 keeps the revocation owed.
   * No body is logged.
   */
  async revokeLease(secret: DynamicSecretRef, leaseId: string): Promise<LeaseRevocation> {
    try {
      const response = await this.managerCall(
        'lease revoke',
        `/api/v1/dynamic-secrets/leases/${encodeURIComponent(leaseId)}`,
        { method: 'DELETE', body: this.leaseScope(secret) }
      );
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 404) {
        if (LeaseNotFoundSchema.safeParse(body).success) return { status: 'gone' };
        throw unreachableFor(response, 'lease revoke');
      }
      if (!response.ok) throw unreachableFor(response, 'lease revoke');
      const parsed = LeaseRevokedSchema.safeParse(body);
      if (!parsed.success || parsed.data.lease.id !== leaseId) {
        throw new ManagerUnreachableError('manager lease revoke response did not match', null);
      }
      if (parsed.data.lease.status != null) {
        throw new ManagerUnreachableError(
          'manager kept the lease: its revocation statement failed',
          null
        );
      }
      return { status: 'revoked' };
    } catch (error) {
      return unreachableOutcome(error);
    }
  }

  private leaseScope(secret: DynamicSecretRef): Record<string, string> {
    if (this.config.projectSlug === null) {
      throw new ManagerUnreachableError('no project slug is configured for leases', null);
    }
    return {
      projectSlug: this.config.projectSlug,
      environmentSlug: this.config.environmentSlug,
      path: secret.path,
    };
  }

  /** One JSON call with the current access token; a 401 or 403 drops the token for the next call. */
  private async managerCall(
    action: string,
    path: string,
    request: { method: 'POST' | 'DELETE'; body: Record<string, string> }
  ): Promise<Response> {
    const token = await this.login();
    const response = await managerFetch(`${this.config.baseUrl}${path}`, {
      method: request.method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
    });
    if (response.status === 401 || response.status === 403) {
      this.token = null;
      await response.body?.cancel();
      throw unreachableFor(response, action);
    }
    return response;
  }
}

function unreachableOutcome(error: unknown): {
  status: 'unreachable';
  detail: string;
  retryAfterMs: number | null;
} {
  if (error instanceof ManagerUnreachableError) {
    return { status: 'unreachable', detail: error.detail, retryAfterMs: error.retryAfterMs };
  }
  throw error;
}
