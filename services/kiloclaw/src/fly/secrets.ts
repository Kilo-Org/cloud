/**
 * Fly.io App Secrets REST API client.
 *
 * Manages per-app secrets stored in Fly's encrypted vault.
 * Secrets are injected as environment variables at machine boot.
 *
 * API docs: https://docs.machines.dev/swagger/index.html
 */

import { FlyApiError } from './client';

const FLY_API_BASE = 'https://api.machines.dev';

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
  const resp = await secretsFetch(config, `/secrets/${encodeURIComponent(name)}`, {
    method: 'POST',
    body: JSON.stringify({ value }),
  });
  await assertOk(resp, 'setAppSecret');
  const data: { version?: number } = await resp.json();
  return { version: data.version ?? 0 };
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
