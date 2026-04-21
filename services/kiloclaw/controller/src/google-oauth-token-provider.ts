type GoogleOAuthTokenResponse = {
  accessToken: string;
  expiresAt: string;
  accountEmail: string;
  scopes: string[];
};

export type GoogleOAuthAccountStatus = {
  email: string;
  client: string;
  services: string[];
  scopes: string[];
  created_at: string;
  auth: string;
  profile: 'legacy' | 'kilo_owned';
  status: string;
};

type GoogleOAuthStatusResponse = {
  connected: boolean;
  accounts: GoogleOAuthAccountStatus[];
};

type GoogleOAuthTokenProviderOptions = {
  getApiKey: () => string;
  getGatewayToken: () => string;
  getSandboxId: () => string;
  getCheckinUrl: () => string;
  refreshSkewSeconds?: number;
  migrateLegacy?: () => Promise<{ migrated: boolean }>;
};

type CachedToken = GoogleOAuthTokenResponse & {
  expiresAtMs: number;
};

function normalizeCapabilities(capabilities: readonly string[]): string[] {
  return [...new Set(capabilities.map(capability => capability.trim()).filter(Boolean))].sort();
}

function cacheKeyForCapabilities(capabilities: readonly string[]): string {
  const normalized = normalizeCapabilities(capabilities);
  return normalized.join(',') || 'calendar_read';
}

function resolveControllerApiUrl(checkinUrl: string): string {
  const url = new URL(checkinUrl);
  url.pathname = '/api/controller/google/token';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function fetchFreshToken(
  endpoint: string,
  options: {
    apiKey: string;
    gatewayToken: string;
    sandboxId: string;
    capabilities: string[];
  }
): Promise<CachedToken> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
      'x-kiloclaw-gateway-token': options.gatewayToken,
    },
    body: JSON.stringify({ sandboxId: options.sandboxId, capabilities: options.capabilities }),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const error = typeof payload.error === 'string' ? payload.error : 'google_oauth_broker_failed';
    const reason = typeof payload.reason === 'string' ? payload.reason : null;
    throw new Error(reason ? `${error}:${reason}` : error);
  }

  const accessToken = typeof payload.accessToken === 'string' ? payload.accessToken : null;
  const expiresAt = typeof payload.expiresAt === 'string' ? payload.expiresAt : null;
  const accountEmail = typeof payload.accountEmail === 'string' ? payload.accountEmail : null;
  const scopes = Array.isArray(payload.scopes)
    ? payload.scopes.filter((scope): scope is string => typeof scope === 'string')
    : [];

  if (!accessToken || !expiresAt || !accountEmail) {
    throw new Error('google_oauth_broker_invalid_payload');
  }

  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error('google_oauth_broker_expired_token');
  }

  return {
    accessToken,
    expiresAt,
    accountEmail,
    scopes,
    expiresAtMs,
  };
}

async function fetchStatus(
  endpoint: string,
  options: {
    apiKey: string;
    gatewayToken: string;
    sandboxId: string;
  }
): Promise<GoogleOAuthStatusResponse> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
      'x-kiloclaw-gateway-token': options.gatewayToken,
    },
    body: JSON.stringify({ sandboxId: options.sandboxId }),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = typeof payload.error === 'string' ? payload.error : 'google_oauth_status_failed';
    throw new Error(error);
  }

  const accounts = Array.isArray(payload.accounts)
    ? payload.accounts.filter((item): item is GoogleOAuthAccountStatus => {
        if (!item || typeof item !== 'object') return false;
        const obj = item as Record<string, unknown>;
        return typeof obj.email === 'string' && typeof obj.client === 'string';
      })
    : [];

  return {
    connected: payload.connected === true,
    accounts,
  };
}

export class GoogleOAuthTokenProvider {
  private readonly refreshSkewMs: number;

  private readonly cache = new Map<string, CachedToken>();

  private readonly inflight = new Map<string, Promise<CachedToken>>();

  private migrationAttempted = false;

  constructor(private readonly options: GoogleOAuthTokenProviderOptions) {
    this.refreshSkewMs = (options.refreshSkewSeconds ?? 300) * 1000;
  }

  async getToken(capabilities: readonly string[]): Promise<GoogleOAuthTokenResponse> {
    const key = cacheKeyForCapabilities(capabilities);
    const normalizedCapabilities = key === 'calendar_read' ? ['calendar_read'] : key.split(',');

    const cached = this.cache.get(key);
    if (cached && cached.expiresAtMs - Date.now() > this.refreshSkewMs) {
      return {
        accessToken: cached.accessToken,
        expiresAt: cached.expiresAt,
        accountEmail: cached.accountEmail,
        scopes: cached.scopes,
      };
    }

    const inflight = this.inflight.get(key);
    if (inflight) {
      const token = await inflight;
      return {
        accessToken: token.accessToken,
        expiresAt: token.expiresAt,
        accountEmail: token.accountEmail,
        scopes: token.scopes,
      };
    }

    const endpoint = resolveControllerApiUrl(this.options.getCheckinUrl());
    const requestPromise = fetchFreshToken(endpoint, {
      apiKey: this.options.getApiKey(),
      gatewayToken: this.options.getGatewayToken(),
      sandboxId: this.options.getSandboxId(),
      capabilities: normalizedCapabilities,
    })
      .catch(async error => {
        const message = error instanceof Error ? error.message : String(error);
        const shouldTryMigration =
          !this.migrationAttempted &&
          typeof this.options.migrateLegacy === 'function' &&
          (message.includes('Google OAuth is not connected for this instance') ||
            message.includes('google_oauth_broker_failed'));

        if (shouldTryMigration) {
          this.migrationAttempted = true;
          const migrateLegacy = this.options.migrateLegacy;
          if (!migrateLegacy) {
            throw error;
          }

          const migrationResult = await migrateLegacy();
          if (migrationResult.migrated) {
            return await fetchFreshToken(endpoint, {
              apiKey: this.options.getApiKey(),
              gatewayToken: this.options.getGatewayToken(),
              sandboxId: this.options.getSandboxId(),
              capabilities: normalizedCapabilities,
            });
          }
        }

        throw error;
      })
      .then(token => {
        this.cache.set(key, token);
        return token;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, requestPromise);

    try {
      const token = await requestPromise;
      return {
        accessToken: token.accessToken,
        expiresAt: token.expiresAt,
        accountEmail: token.accountEmail,
        scopes: token.scopes,
      };
    } catch (error) {
      if (cached && cached.expiresAtMs > Date.now()) {
        return {
          accessToken: cached.accessToken,
          expiresAt: cached.expiresAt,
          accountEmail: cached.accountEmail,
          scopes: cached.scopes,
        };
      }
      throw error;
    }
  }

  async getStatus(): Promise<GoogleOAuthStatusResponse> {
    const base = resolveControllerApiUrl(this.options.getCheckinUrl());
    const endpoint = base.replace('/google/token', '/google/status');
    return await fetchStatus(endpoint, {
      apiKey: this.options.getApiKey(),
      gatewayToken: this.options.getGatewayToken(),
      sandboxId: this.options.getSandboxId(),
    });
  }
}
