import type { ManagerConfig } from '../env';
import { z } from 'zod';

const LoginResponseSchema = z.object({
  accessToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
});

const SecretSchema = z.object({
  secretKey: z.string().min(1),
  secretValue: z.string(),
  version: z.number().int().nonnegative(),
});

const ListResponseSchema = z.object({ secrets: z.array(SecretSchema) });

export type ManagerSecret = { value: string; version: number };

export type ManagerRead =
  | { status: 'fresh'; secrets: Record<string, ManagerSecret>; etag: string | null }
  | { status: 'not_modified' }
  | { status: 'unreachable'; detail: string };

/** Remaining token lifetime kept as a safety margin before STS logs in again. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

function failure(error: unknown, fallback: string): ManagerRead {
  return { status: 'unreachable', detail: error instanceof Error ? error.message : fallback };
}

/**
 * Plain-REST client for Infisical Cloud. Values and tokens stay inside this
 * instance: `detail` strings are fixed text plus a status code.
 */
export class InfisicalClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: ManagerConfig,
    private readonly signManagerJwt: () => Promise<string>
  ) {}

  private async login(): Promise<string> {
    const cached = this.token;
    if (cached && cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()) return cached.value;

    const jwt = await this.signManagerJwt();
    const response = await fetch(`${this.config.baseUrl}/api/v1/auth/oidc-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identityId: this.config.identityId, jwt }),
    });
    if (!response.ok) {
      throw new Error(`manager login failed with status ${response.status}`);
    }
    const body = LoginResponseSchema.parse(await response.json());
    this.token = {
      value: body.accessToken,
      expiresAt: Date.now() + body.expiresIn * 1000,
    };
    return body.accessToken;
  }

  async read(ifNoneMatch: string | null): Promise<ManagerRead> {
    let token: string;
    try {
      token = await this.login();
    } catch (error) {
      return failure(error, 'manager login failed');
    }

    const url = new URL(`${this.config.baseUrl}/api/v4/secrets`);
    url.searchParams.set('projectId', this.config.projectId);
    url.searchParams.set('environment', this.config.environmentSlug);
    url.searchParams.set('secretPath', this.config.secretPath);
    url.searchParams.set('recursive', 'false');

    const headers = new Headers({ authorization: `Bearer ${token}` });
    if (ifNoneMatch !== null) headers.set('if-none-match', ifNoneMatch);

    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch (error) {
      return failure(error, 'manager request failed');
    }

    if (response.status === 401 || response.status === 403) {
      // A revoked or rotated token must not be reused on the next attempt.
      this.token = null;
      return {
        status: 'unreachable',
        detail: `manager read denied with status ${response.status}`,
      };
    }
    if (response.status === 304) return { status: 'not_modified' };
    if (!response.ok) {
      return {
        status: 'unreachable',
        detail: `manager read failed with status ${response.status}`,
      };
    }

    const parsed = ListResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return {
        status: 'unreachable',
        detail: 'manager response did not match the expected shape',
      };
    }
    const secrets: Record<string, ManagerSecret> = {};
    for (const secret of parsed.data.secrets) {
      secrets[secret.secretKey] = { value: secret.secretValue, version: secret.version };
    }
    return { status: 'fresh', secrets, etag: response.headers.get('etag') };
  }
}
