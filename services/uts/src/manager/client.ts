import { z } from 'zod';
import type { ManagerLoginJwtResult } from '../dos/UtsManagerAuthDO';
import { IDENTITY_STORE_FOLDER, type ManagerConfig } from './config';

/** One manager request; the rotation job retries on its next run, so a call never waits long. */
const MANAGER_FETCH_TIMEOUT_MS = 10_000;

/** A login access token is reused until this long before it expires (it lives 10 minutes). */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

const LoginResponseSchema = z.object({
  accessToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
});

/**
 * https://infisical.com/docs/api-reference/endpoints/secrets/create: the created secret, or, when
 * a change policy covers the folder, the approval request that waits for a secret admin.
 */
const CreateResponseSchema = z.union([
  z.object({ secret: z.object({ id: z.string().min(1) }) }),
  z.object({ approval: z.record(z.string(), z.unknown()) }),
]);

/** An identity-store login and the date of its rotation name the secret: `uts_app_a_20261126`. */
const SecretNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,62}_[0-9]{8}$/);

export type ManagerFailure =
  /** A timeout, a transport failure, 429 or 5xx: the next run tries again. */
  | { status: 'unreachable'; detail: string; retryAfterMs: number | null }
  /** A refused login, a missing permission or a malformed answer: a configuration error. */
  | { status: 'refused'; detail: string };

export type SecretWrite = { status: 'created' } | { status: 'approval_pending' } | ManagerFailure;

export type SecretDescription = { status: 'present' } | { status: 'missing' } | ManagerFailure;

class ManagerError extends Error {
  constructor(readonly failure: ManagerFailure) {
    super(failure.detail);
    this.name = 'ManagerError';
  }
}

function retryAfterMs(response: Response): number | null {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** Status-only detail: no body is kept, because a body can echo request data. */
function failureFor(response: Response, action: string): ManagerError {
  const detail = `manager ${action} failed with status ${response.status}`;
  if (response.status === 429 || response.status >= 500) {
    return new ManagerError({
      status: 'unreachable',
      detail,
      retryAfterMs: response.status === 429 ? retryAfterMs(response) : null,
    });
  }
  return new ManagerError({ status: 'refused', detail });
}

/**
 * The rotation job's client for the secrets manager (design 5.2). It logs in as
 * `uts-rotation-<environment>` with Infisical JWT Auth, using a login JWT from the manager login
 * key object, and only creates and describes secrets in `/admin/identity-store`; that identity
 * holds no other permission. Values and access tokens stay inside this instance and are never
 * logged.
 */
export class ManagerClient {
  #token: { value: string; expiresAt: number } | null = null;
  #pendingLogin: Promise<string> | null = null;

  constructor(
    private readonly config: ManagerConfig,
    private readonly signLoginJwt: () => Promise<ManagerLoginJwtResult>,
    // Called as a method, the platform `fetch` would receive this instance as `this`, which
    // workerd refuses ("Illegal invocation"); the arrow keeps the global receiver.
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)
  ) {}

  /** Creates `name` in `/admin/identity-store`; under the folder's change policy it waits for approval. */
  async createIdentityStoreSecret(name: string, value: string): Promise<SecretWrite> {
    const secretName = SecretNameSchema.parse(name);
    return await this.#guard(async () => {
      const token = await this.#login();
      // https://infisical.com/docs/api-reference/endpoints/secrets/create
      const response = await this.#fetch(`${this.config.baseUrl}/api/v4/secrets/${secretName}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: this.config.projectId,
          environment: this.config.environmentSlug,
          secretPath: IDENTITY_STORE_FOLDER,
          secretValue: value,
          type: 'shared',
        }),
      });
      this.#dropTokenOnAuthFailure(response);
      if (!response.ok) throw failureFor(response, 'create');
      const parsed = CreateResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        return { status: 'refused', detail: 'manager create response did not match' };
      }
      return 'secret' in parsed.data ? { status: 'created' } : { status: 'approval_pending' };
    });
  }

  /** Whether `name` exists in `/admin/identity-store`, without its value (`describeSecret`). */
  async describeIdentityStoreSecret(name: string): Promise<SecretDescription> {
    const secretName = SecretNameSchema.parse(name);
    return await this.#guard(async () => {
      const token = await this.#login();
      // https://infisical.com/docs/api-reference/endpoints/secrets/read
      const url = new URL(`${this.config.baseUrl}/api/v4/secrets/${secretName}`);
      url.searchParams.set('projectId', this.config.projectId);
      url.searchParams.set('environment', this.config.environmentSlug);
      url.searchParams.set('secretPath', IDENTITY_STORE_FOLDER);
      url.searchParams.set('viewSecretValue', 'false');
      url.searchParams.set('expandSecretReferences', 'false');
      url.searchParams.set('includeImports', 'false');
      const response = await this.#fetch(url, {
        headers: { authorization: `Bearer ${token}` },
      });
      this.#dropTokenOnAuthFailure(response);
      if (response.status === 404) return { status: 'missing' };
      if (!response.ok) throw failureFor(response, 'describe');
      return { status: 'present' };
    });
  }

  async #guard<Result>(work: () => Promise<Result>): Promise<Result | ManagerFailure> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ManagerError) return error.failure;
      throw error;
    }
  }

  #dropTokenOnAuthFailure(response: Response): void {
    // A revoked or expired token must not be reused on the next call.
    if (response.status === 401 || response.status === 403) this.#token = null;
  }

  async #fetch(input: URL | string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(input, {
        ...init,
        signal: AbortSignal.timeout(MANAGER_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new ManagerError({
        status: 'unreachable',
        detail: timedOut ? 'manager request timed out' : 'manager request failed',
        retryAfterMs: null,
      });
    }
  }

  /** Reuses a live access token; concurrent logins share one request. */
  #login(): Promise<string> {
    const cached = this.#token;
    if (cached !== null && cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()) {
      return Promise.resolve(cached.value);
    }
    if (this.#pendingLogin !== null) return this.#pendingLogin;
    const pending = this.#performLogin().finally(() => {
      this.#pendingLogin = null;
    });
    this.#pendingLogin = pending;
    return pending;
  }

  async #performLogin(): Promise<string> {
    let signed: ManagerLoginJwtResult;
    try {
      signed = await this.signLoginJwt();
    } catch {
      throw new ManagerError({
        status: 'unreachable',
        detail: 'login JWT could not be signed',
        retryAfterMs: null,
      });
    }
    if (signed.status === 'misconfigured') {
      throw new ManagerError({ status: 'refused', detail: 'login key object refused its name' });
    }
    // https://infisical.com/docs/api-reference/endpoints/jwt-auth/login
    const response = await this.#fetch(`${this.config.baseUrl}/api/v1/auth/jwt-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identityId: this.config.identityId, jwt: signed.jwt }),
    });
    if (!response.ok) throw failureFor(response, 'login');
    const parsed = LoginResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new ManagerError({ status: 'refused', detail: 'manager login response did not match' });
    }
    this.#token = {
      value: parsed.data.accessToken,
      expiresAt: Date.now() + parsed.data.expiresIn * 1000,
    };
    return parsed.data.accessToken;
  }
}

/** The secret a rotation writes: the login's name and the rotation date (design 5.2). */
export function rotationSecretName(login: string, date: Date): string {
  const day = date.toISOString().slice(0, 10).replaceAll('-', '');
  return SecretNameSchema.parse(`${login}_${day}`);
}
