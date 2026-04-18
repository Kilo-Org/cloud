import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type GogAuthListJson = {
  accounts?: Array<{
    email?: string;
  }>;
};

type GogTokenExportJson = {
  email?: string;
  client?: string;
  services?: string[];
  scopes?: string[];
  refresh_token?: string;
};

type GogCredentialsListJson = {
  clients?: Array<{
    client?: string;
    path?: string;
  }>;
};

type LegacyGoogleMigrationOptions = {
  apiKey: string;
  gatewayToken: string;
  sandboxId: string;
  checkinUrl: string;
  skipMigration?: boolean;
};

export type LegacyGoogleMigrationResult = {
  attempted: boolean;
  migrated: boolean;
  reason:
    | 'skipped'
    | 'auth_list_failed'
    | 'no_legacy_account'
    | 'token_export_failed'
    | 'missing_refresh_token'
    | 'credentials_list_failed'
    | 'missing_credentials_path'
    | 'invalid_credentials_file'
    | 'migration_endpoint_failed'
    | 'migrated';
};

function endpointFor(checkinUrl: string): string {
  const url = new URL(checkinUrl);
  url.pathname = '/api/controller/google/migrate-legacy';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function runGogJson(args: string[], env: NodeJS.ProcessEnv): Record<string, unknown> {
  const output = execFileSync('/usr/local/bin/gog.real', args, {
    env,
    encoding: 'utf8',
  }).toString();

  return JSON.parse(output) as Record<string, unknown>;
}

function mapServicesToCapabilities(services: readonly string[]): string[] {
  const capabilities = new Set<string>();
  for (const service of services) {
    if (service === 'calendar') capabilities.add('calendar_read');
    if (service === 'gmail') capabilities.add('gmail_read');
    if (service === 'drive' || service === 'docs' || service === 'sheets') {
      capabilities.add('drive_read');
    }
  }
  return [...capabilities].sort();
}

function parseClientCredentials(
  credsPath: string
): { clientId: string; clientSecret: string } | null {
  const raw = fs.readFileSync(credsPath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const directClientId = typeof parsed.client_id === 'string' ? parsed.client_id : null;
  const directClientSecret = typeof parsed.client_secret === 'string' ? parsed.client_secret : null;
  if (directClientId && directClientSecret) {
    return { clientId: directClientId, clientSecret: directClientSecret };
  }

  const installed = parsed.installed as Record<string, unknown> | undefined;
  if (installed) {
    const id = typeof installed.client_id === 'string' ? installed.client_id : null;
    const secret = typeof installed.client_secret === 'string' ? installed.client_secret : null;
    if (id && secret) {
      return { clientId: id, clientSecret: secret };
    }
  }

  const web = parsed.web as Record<string, unknown> | undefined;
  if (web) {
    const id = typeof web.client_id === 'string' ? web.client_id : null;
    const secret = typeof web.client_secret === 'string' ? web.client_secret : null;
    if (id && secret) {
      return { clientId: id, clientSecret: secret };
    }
  }

  return null;
}

export async function migrateLegacyGoogleCredentialsToBroker(
  options: LegacyGoogleMigrationOptions
): Promise<LegacyGoogleMigrationResult> {
  if (options.skipMigration) {
    return { attempted: false, migrated: false, reason: 'skipped' };
  }

  const gogEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GOG_KEYRING_BACKEND: 'file',
    GOG_KEYRING_PASSWORD: process.env.GOG_KEYRING_PASSWORD || 'kiloclaw',
    GOG_PLAIN: '',
    GOG_JSON: '1',
  };

  let authList: GogAuthListJson;
  try {
    authList = runGogJson(['auth', 'list', '--json'], gogEnv) as GogAuthListJson;
  } catch {
    return { attempted: true, migrated: false, reason: 'auth_list_failed' };
  }

  const email = authList.accounts?.find(a => typeof a.email === 'string')?.email;
  if (!email) {
    return { attempted: true, migrated: false, reason: 'no_legacy_account' };
  }

  const tmpPath = path.join(os.tmpdir(), `gog-legacy-token-${Date.now()}.json`);

  try {
    try {
      execFileSync(
        '/usr/local/bin/gog.real',
        ['auth', 'tokens', 'export', email, tmpPath, '--overwrite'],
        {
          env: gogEnv,
          encoding: 'utf8',
        }
      );
    } catch {
      return { attempted: true, migrated: false, reason: 'token_export_failed' };
    }

    const exportPayload = JSON.parse(fs.readFileSync(tmpPath, 'utf8')) as GogTokenExportJson;
    if (!exportPayload.refresh_token) {
      return { attempted: true, migrated: false, reason: 'missing_refresh_token' };
    }

    let credentialsList: GogCredentialsListJson;
    try {
      credentialsList = runGogJson(
        ['auth', 'credentials', 'list', '--json'],
        gogEnv
      ) as GogCredentialsListJson;
    } catch {
      return { attempted: true, migrated: false, reason: 'credentials_list_failed' };
    }
    const tokenClient = exportPayload.client || 'default';
    const credsPath =
      credentialsList.clients?.find(client => client.client === tokenClient)?.path ||
      credentialsList.clients?.find(client => client.client === 'default')?.path;

    if (!credsPath) {
      return { attempted: true, migrated: false, reason: 'missing_credentials_path' };
    }

    const credentials = parseClientCredentials(credsPath);
    if (!credentials) {
      return { attempted: true, migrated: false, reason: 'invalid_credentials_file' };
    }

    const body = {
      sandboxId: options.sandboxId,
      accountEmail: exportPayload.email || email,
      accountSubject: exportPayload.email || email,
      refreshToken: exportPayload.refresh_token,
      oauthClientId: credentials.clientId,
      oauthClientSecret: credentials.clientSecret,
      scopes: exportPayload.scopes || [],
      capabilities: mapServicesToCapabilities(exportPayload.services || []),
    };

    const endpoint = endpointFor(options.checkinUrl);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
        'x-kiloclaw-gateway-token': options.gatewayToken,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return { attempted: true, migrated: false, reason: 'migration_endpoint_failed' };
    }

    return { attempted: true, migrated: true, reason: 'migrated' };
  } catch {
    return { attempted: true, migrated: false, reason: 'token_export_failed' };
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}
