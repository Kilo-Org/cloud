/**
 * Fly.io App Secrets REST API client.
 *
 * Manages per-app secrets stored in Fly's encrypted vault.
 * Secrets are injected as environment variables at machine boot.
 *
 * API docs: https://docs.machines.dev/swagger/index.html
 */

import { FlyApiError, FLY_API_BASE } from './client';

type FlySecretsConfig = {
  apiToken: string;
  appName: string;
};

type AppSecret = {
  name: string;
  digest: string;
  created_at?: string;
  updated_at?: string;
};

const SET_SECRET_RETRY_DELAYS_MS = [250, 1000];

async function secretsFetch(
  config: FlySecretsConfig,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const url = `${FLY_API_BASE}/v1/apps/${encodeURIComponent(config.appName)}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
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

function isRetryableSecretStatus(status: number): boolean {
  return status === 408 || status === 429 || [500, 502, 503, 504, 520].includes(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Set a single app secret. Returns the secrets version, which should be
 * passed as `min_secrets_version` to createMachine/updateMachine to ensure
 * the machine boots with this secret version available.
 *
 * POST /v1/apps/{app}/secrets/{name}
 */
export async function setAppSecret(
  config: FlySecretsConfig,
  name: string,
  value: string
): Promise<{ version: number }> {
  const path = `/secrets/${encodeURIComponent(name)}`;

  for (let attempt = 0; attempt <= SET_SECRET_RETRY_DELAYS_MS.length; attempt++) {
    const retryDelayMs = SET_SECRET_RETRY_DELAYS_MS[attempt];

    let resp: Response;
    try {
      resp = await secretsFetch(config, path, {
        method: 'POST',
        body: JSON.stringify({ value }),
      });
    } catch (err) {
      // Network-level failure (connection reset, DNS, TLS, etc.)
      if (retryDelayMs === undefined) throw err;
      await sleep(retryDelayMs);
      continue;
    }

    if (resp.ok) {
      const data: { version?: number } = await resp.json();
      return { version: data.version ?? 0 };
    }

    if (retryDelayMs === undefined || !isRetryableSecretStatus(resp.status)) {
      await assertOk(resp, 'setAppSecret');
      throw new Error('unreachable setAppSecret error state');
    }

    await sleep(retryDelayMs);
  }

  throw new Error('unreachable setAppSecret retry state');
}

/**
 * Delete an app secret.
 * DELETE /v1/apps/{app}/secrets/{name}
 */
export async function deleteAppSecret(config: FlySecretsConfig, name: string): Promise<void> {
  const resp = await secretsFetch(config, `/secrets/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (resp.status === 404) return; // already gone
  await assertOk(resp, 'deleteAppSecret');
}

/**
 * List app secret names and digests.
 * Values are not readable via the API.
 * GET /v1/apps/{app}/secrets
 */
export async function listAppSecrets(config: FlySecretsConfig): Promise<AppSecret[]> {
  const resp = await secretsFetch(config, '/secrets');
  await assertOk(resp, 'listAppSecrets');
  const data: { secrets: AppSecret[] } = await resp.json();
  return data.secrets ?? [];
}
