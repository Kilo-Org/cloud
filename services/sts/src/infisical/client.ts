import { z } from 'zod';
import { MANAGER_FETCH_TIMEOUT_MS } from '../constants';
import type { ManagerConfig } from '../env';

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
   */
  async readFolder(folder: ManagerFolder, ifNoneMatch: string | null): Promise<FolderRead> {
    try {
      return await this.performRead(folder, ifNoneMatch);
    } catch (error) {
      if (error instanceof ManagerUnreachableError) {
        return { status: 'unreachable', detail: error.detail, retryAfterMs: error.retryAfterMs };
      }
      throw error;
    }
  }

  private async performRead(
    folder: ManagerFolder,
    ifNoneMatch: string | null
  ): Promise<FolderRead> {
    const token = await this.login();
    const url = new URL(`${this.config.baseUrl}/api/v4/secrets`);
    url.searchParams.set('projectId', this.config.projectId);
    url.searchParams.set('environment', this.config.environmentSlug);
    url.searchParams.set('secretPath', folder);
    url.searchParams.set('recursive', 'true');
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
      if (secret.type !== 'shared') continue;
      if (secret.secretValueHidden) {
        hidden += 1;
        continue;
      }
      entries.push({
        path: (secret.secretPath ?? folder).replace(/(.)\/+$/, '$1'),
        name: secret.secretKey,
        id: secret.id,
        version: secret.version,
        value: secret.secretValue,
      });
    }
    return { status: 'fresh', entries, hidden, etag: response.headers.get('etag') };
  }
}
