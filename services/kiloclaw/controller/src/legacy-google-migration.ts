import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';

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
    | 'invalid_export_payload'
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

function combinedCommandOutput(result: SpawnSyncReturns<string>): string {
  return [result.stdout, result.stderr, result.error?.message]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n');
}

function runGogExport(args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync('/usr/local/bin/gog.real', args, {
    env,
    encoding: 'utf8',
  });

  return combinedCommandOutput(result);
}

function hasFile(pathToCheck: string): boolean {
  try {
    return fs.statSync(pathToCheck).isFile();
  } catch {
    return false;
  }
}

function isUnsupportedFlag(output: string, flagName: '--out' | '--overwrite'): boolean {
  const normalized = output.toLowerCase();
  if (!normalized.includes(flagName)) return false;

  return (
    normalized.includes('unknown flag') ||
    normalized.includes('unknown option') ||
    normalized.includes('unrecognized option') ||
    normalized.includes('flag provided but not defined')
  );
}

function exportTokenToFile(email: string, outPath: string, env: NodeJS.ProcessEnv): boolean {
  const firstAttemptOutput = runGogExport(
    ['auth', 'tokens', 'export', email, '--out', outPath, '--overwrite'],
    env
  );
  if (hasFile(outPath)) {
    return true;
  }

  if (!isUnsupportedFlag(firstAttemptOutput, '--out')) return false;

  // Backward-compatible fallback for older gog.real versions that still accept
  // positional output-path arguments.
  const secondAttemptOutput = runGogExport(
    ['auth', 'tokens', 'export', email, outPath, '--overwrite'],
    env
  );
  if (hasFile(outPath)) {
    return true;
  }

  if (!isUnsupportedFlag(secondAttemptOutput, '--overwrite')) return false;

  runGogExport(['auth', 'tokens', 'export', email, outPath, '--force'], env);
  return hasFile(outPath);
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

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asEmailLike(value: unknown): string | null {
  const normalized = asNonEmptyString(value);
  if (!normalized) return null;
  return normalized.includes('@') ? normalized : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gog-legacy-'));
  const tmpPath = path.join(tmpDir, 'token.json');

  try {
    const exported = exportTokenToFile(email, tmpPath, gogEnv);
    if (!exported) {
      return { attempted: true, migrated: false, reason: 'token_export_failed' };
    }

    try {
      fs.chmodSync(tmpPath, 0o600);
    } catch {
      // best effort: continue migration even if chmod is unsupported
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

    const accountEmail = asEmailLike(exportPayload.email) ?? asEmailLike(email);
    const accountSubject = asNonEmptyString(exportPayload.email) ?? asNonEmptyString(email);
    const refreshToken = asNonEmptyString(exportPayload.refresh_token);
    const oauthClientId = asNonEmptyString(credentials.clientId);
    const oauthClientSecret = asNonEmptyString(credentials.clientSecret);
    const scopes = asStringArray(exportPayload.scopes);
    const services = asStringArray(exportPayload.services);

    if (!accountEmail || !accountSubject || !refreshToken || !oauthClientId || !oauthClientSecret) {
      return { attempted: true, migrated: false, reason: 'invalid_export_payload' };
    }

    const body = {
      sandboxId: options.sandboxId,
      accountEmail,
      accountSubject,
      refreshToken,
      oauthClientId,
      oauthClientSecret,
      scopes,
      // CodeQL flags file-derived data flowing to outbound requests; we validate
      // the exported payload fields above and only derive capabilities from the
      // normalized gog services list before sending to the trusted broker endpoint.
      capabilities: mapServicesToCapabilities(services),
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
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (error) {
      console.error('[legacy-google-migration] failed to remove tmp dir', tmpDir, error);
    }
  }
}
