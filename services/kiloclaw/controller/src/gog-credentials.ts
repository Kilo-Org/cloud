/**
 * Sets up gogcli credentials by extracting a pre-built config tarball.
 *
 * When the container starts with KILOCLAW_GOG_CONFIG_TARBALL env var, this module:
 * 1. Base64-decodes the tarball to a temp file
 * 2. Extracts it to /root/.config/ (produces /root/.config/gogcli/)
 * 3. Sets GOG_KEYRING_BACKEND, GOG_KEYRING_PASSWORD, GOG_ACCOUNT env vars
 */
import path from 'node:path';

const GOG_CONFIG_DIR = '/root/.config/gogcli';

/**
 * Sanitize an account email into a filename, matching gog's internal logic.
 * Lowercase, then replace any non-alphanumeric character with underscore.
 */
export function sanitizeAccountForPath(account: string): string {
  const trimmed = account.toLowerCase().trim();
  if (!trimmed) return 'unknown';
  return trimmed.replace(/[^a-z0-9]/g, '_');
}

export type PatchDeps = {
  readFileSync: (path: string, encoding: 'utf-8') => string;
  writeFileSync: (path: string, data: string) => void;
  existsSync: (path: string) => boolean;
};

/**
 * Patch the gog gmail-watch state file with a newer historyId from the DO.
 * Only writes if the new value is numerically greater than the file's value.
 * Best-effort: logs warnings on failure, never throws.
 */
export function patchGogHistoryId(opts: {
  account: string;
  historyId: string;
  configDir?: string;
  deps?: PatchDeps;
}): void {
  const { account, historyId, configDir = GOG_CONFIG_DIR } = opts;

  let deps: PatchDeps;
  if (opts.deps) {
    deps = opts.deps;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    deps = {
      readFileSync: (p, enc) => fs.readFileSync(p, enc),
      writeFileSync: (p, data) => fs.writeFileSync(p, data),
      existsSync: p => fs.existsSync(p),
    };
  }

  const sanitized = sanitizeAccountForPath(account);
  const stateFilePath = path.join(configDir, 'state', 'gmail-watch', `${sanitized}.json`);

  if (!deps.existsSync(stateFilePath)) {
    console.warn(`[gog] State file not found, skipping historyId patch: ${stateFilePath}`);
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    const raw = deps.readFileSync(stateFilePath, 'utf-8');
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.warn(`[gog] Failed to parse state file, skipping historyId patch: ${stateFilePath}`);
    return;
  }

  const fileHistoryId = parsed.historyId;
  let fileValue: bigint;
  let envValue: bigint;
  try {
    fileValue = typeof fileHistoryId === 'string' ? BigInt(fileHistoryId) : BigInt(0);
    envValue = BigInt(historyId);
  } catch {
    console.warn(`[gog] Invalid historyId values, skipping patch`);
    return;
  }

  if (envValue <= fileValue) {
    return;
  }

  parsed.historyId = historyId;
  try {
    deps.writeFileSync(stateFilePath, JSON.stringify(parsed, null, 2));
    console.log(
      `[gog] Patched historyId in ${stateFilePath}: ${String(fileHistoryId)} → ${historyId}`
    );
  } catch {
    console.warn(`[gog] Failed to write state file: ${stateFilePath}`);
  }
}

export type GogCredentialsDeps = {
  mkdirSync: (dir: string, opts: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: Buffer) => void;
  unlinkSync: (path: string) => void;
  rmSync: (path: string, opts: { recursive: boolean; force: boolean }) => void;
  execFileSync: (file: string, args: string[]) => void;
};

/**
 * Extract gog config tarball if the corresponding env var is set.
 * Returns true if credentials were extracted, false if skipped.
 *
 * Side effect: mutates the passed `env` record by setting
 * GOG_KEYRING_BACKEND, GOG_KEYRING_PASSWORD, and GOG_ACCOUNT.
 */
export async function writeGogCredentials(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  configDir = GOG_CONFIG_DIR,
  deps?: Partial<GogCredentialsDeps>
): Promise<boolean> {
  const fs = await import('node:fs');
  const cp = await import('node:child_process');
  const d: GogCredentialsDeps = {
    mkdirSync: deps?.mkdirSync ?? ((dir, opts) => fs.default.mkdirSync(dir, opts)),
    writeFileSync: deps?.writeFileSync ?? ((p, data) => fs.default.writeFileSync(p, data)),
    unlinkSync: deps?.unlinkSync ?? (p => fs.default.unlinkSync(p)),
    rmSync: deps?.rmSync ?? ((p, opts) => fs.default.rmSync(p, opts)),
    execFileSync:
      deps?.execFileSync ??
      ((file, args) =>
        cp.default.execFileSync(file, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        })),
  };

  const tarballBase64 = env.KILOCLAW_GOG_CONFIG_TARBALL;

  if (!tarballBase64) {
    // Clean up stale config from a previous run (e.g. after disconnect)
    d.rmSync(configDir, { recursive: true, force: true });
    delete env.GOG_KEYRING_BACKEND;
    delete env.GOG_KEYRING_PASSWORD;
    delete env.GOG_ACCOUNT;
    return false;
  }

  // Remove stale config from a previous connection before extracting the new bundle.
  // Without this, files present in the old tarball but absent from the new one linger.
  d.rmSync(configDir, { recursive: true, force: true });

  // Decode tarball and extract to /root/.config/
  const parentDir = path.dirname(configDir);
  d.mkdirSync(parentDir, { recursive: true });

  const tarballBuffer = Buffer.from(tarballBase64, 'base64');

  const tmpTarball = path.join(parentDir, 'gogcli-config.tar.gz');
  d.writeFileSync(tmpTarball, tarballBuffer);

  try {
    d.execFileSync('tar', ['xzf', tmpTarball, '-C', parentDir]);
    console.log(`[gog] Extracted config tarball to ${configDir}`);
  } finally {
    try {
      d.unlinkSync(tmpTarball);
    } catch {
      // ignore cleanup errors
    }
  }

  // Set env vars for gog runtime.
  // GOG_KEYRING_PASSWORD is NOT a secret. The 99designs/keyring file backend
  // requires a password to operate, but gog runs inside a single-tenant VM
  // with no shared access. The value is arbitrary — it just needs to be
  // consistent across setup (google-setup/setup.mjs), container bootstrap
  // (bootstrap.ts), and here.
  env.GOG_KEYRING_BACKEND = 'file';
  env.GOG_KEYRING_PASSWORD = 'kiloclaw';
  if (env.KILOCLAW_GOOGLE_ACCOUNT_EMAIL) {
    env.GOG_ACCOUNT = env.KILOCLAW_GOOGLE_ACCOUNT_EMAIL;
  }

  const lastHistoryId = env.KILOCLAW_GMAIL_LAST_HISTORY_ID;
  if (lastHistoryId && env.KILOCLAW_GOOGLE_ACCOUNT_EMAIL) {
    patchGogHistoryId({
      account: env.KILOCLAW_GOOGLE_ACCOUNT_EMAIL,
      historyId: lastHistoryId,
      configDir,
    });
  }

  return true;
}
