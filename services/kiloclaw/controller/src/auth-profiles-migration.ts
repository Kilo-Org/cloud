/**
 * Migrate kilocode `auth-profiles.json` entries from a plaintext key to an
 * env-backed `keyRef` SecretRef.
 *
 * Background: `openclaw onboard` (pre `--secret-input-mode ref`) wrote the
 * literal `KILOCODE_API_KEY` into `<agentDir>/auth-profiles.json` under
 * `profiles.kilocode:default.key` (older builds used the `api_key` alias).
 * OpenClaw's auth resolver prefers configured auth-profiles over env vars, so
 * once the literal is on disk, rotating `KILOCODE_API_KEY` in the gateway
 * process env has no effect — the gateway keeps authenticating with the stale
 * on-disk value. On 2026.6.1+ `openclaw doctor --fix` also imports the literal
 * into per-agent SQLite verbatim (it strips the plaintext only when a `keyRef`
 * is present), so a pre-doctor conversion is what keeps plaintext out of SQLite.
 *
 * Fix: rewrite each such profile to use a SecretRef that points back at the
 * same env var. OpenClaw's `buildPersistedAuthProfileSecretsStore` strips the
 * plaintext when `keyRef` is set, and runtime resolution reads
 * `process.env.KILOCODE_API_KEY` on every `secrets reload` — so rotation
 * becomes: update env var → call `openclaw secrets reload`.
 *
 * This migration is idempotent and safe to run on every boot (and every
 * rotation) — profiles already carrying a `keyRef` or lacking a plaintext key
 * are left untouched. Malformed JSON is logged and skipped, never fatal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './atomic-write';

const AUTH_PROFILES_FILENAME = 'auth-profiles.json';
const AGENT_SUBDIR = 'agent';
const KILOCODE_PROVIDER = 'kilocode';
const KILOCODE_ENV_VAR = 'KILOCODE_API_KEY';

// OpenClaw's auth-profile migrations (2026.6.x) back each store up as
// `<original>.<migration>.<epoch-ms>.bak` (via copyFileSync, so 0o644) before
// rewriting/removing the original. The backups can hold provider credentials.
// This allow-list covers every known migration suffix doctor produces.
const AUTH_MIGRATION_BACKUP_RE =
  /\.(sqlite-import|legacy-flat|api-key-alias|aws-sdk-profile|openai-provider-unification|oauth-ref)\.\d+\.bak$/;

export type AuthProfilesMigrationDeps = {
  existsSync: (p: string) => boolean;
  readdirSync: (dir: string) => string[];
  statSync: (p: string) => { isDirectory: () => boolean };
  readFileSync: (p: string, encoding: BufferEncoding) => string;
  writeFileSync: (p: string, data: string) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  unlinkSync: (p: string) => void;
  chmodSync: (p: string, mode: number) => void;
};

const defaultDeps: AuthProfilesMigrationDeps = {
  existsSync: p => fs.existsSync(p),
  readdirSync: dir => fs.readdirSync(dir),
  statSync: p => fs.statSync(p),
  readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
  writeFileSync: (p, data) => fs.writeFileSync(p, data),
  renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
  unlinkSync: p => fs.unlinkSync(p),
  chmodSync: (p, mode) => fs.chmodSync(p, mode),
};

export type AuthProfilesMigrationReport = {
  filesScanned: number;
  filesModified: number;
  profilesMigrated: number;
  // Files where a kilocode profile needed rewriting but the write failed. The
  // plaintext is still on disk; the pre-doctor caller treats this as fatal so
  // doctor does not import that plaintext into SQLite.
  filesFailed: number;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Resolve the conventional `<rootDir>/agents/*&#47;agent` directories that may
 * contain an `auth-profiles.json`. Returns absolute directory paths, each
 * expected to hold `auth-profiles.json` directly. Never throws.
 *
 * This intentionally only covers the standard layout (every agent created
 * through KiloClaw lives here). Custom/env-selected agent directories — which
 * only arise from undocumented, hand-rolled configuration — are out of scope;
 * the remediation for those rare cases is re-entering the credential.
 */
function collectAgentDirs(rootDir: string, deps: AuthProfilesMigrationDeps): string[] {
  const dirs = new Set<string>();

  const agentsDir = path.join(rootDir, 'agents');
  if (deps.existsSync(agentsDir)) {
    let agentIds: string[] = [];
    try {
      agentIds = deps.readdirSync(agentsDir);
    } catch (error) {
      console.warn(`[auth-profiles-migration] Failed to list ${agentsDir}:`, error);
    }
    for (const agentId of agentIds) {
      const agentRoot = path.join(agentsDir, agentId);
      try {
        if (!deps.statSync(agentRoot).isDirectory()) continue;
      } catch {
        continue;
      }
      dirs.add(path.join(agentRoot, AGENT_SUBDIR));
    }
  }

  return [...dirs];
}

/**
 * Rewrite a single profile in place. Returns true when the profile was
 * actually changed (so callers can track whether the file needs writing).
 */
function migrateProfile(profile: UnknownRecord): boolean {
  if (profile.type !== 'api_key') return false;
  if (profile.provider !== KILOCODE_PROVIDER) return false;
  if (profile.keyRef !== undefined) return false;
  // OpenClaw doctor normalizes the historical `api_key` field to `key` during
  // its SQLite import, so the literal may live under either name. Convert both
  // before doctor runs, otherwise the plaintext is imported verbatim.
  if (!isNonEmptyString(profile.key) && !isNonEmptyString(profile.api_key)) return false;

  delete profile.key;
  delete profile.api_key;
  profile.keyRef = {
    source: 'env',
    provider: 'default',
    id: KILOCODE_ENV_VAR,
  };
  return true;
}

/**
 * Migrate one `auth-profiles.json` file. Returns the list of profile ids that
 * were rewritten (empty when nothing changed). Swallows parse errors,
 * unreadable files, missing `profiles` maps, and write errors — the migration
 * never throws. `writeFailed` is true only when a kilocode profile needed
 * rewriting but the write threw (the plaintext is still on disk).
 */
function migrateOneFile(
  filePath: string,
  deps: AuthProfilesMigrationDeps
): { migratedIds: string[]; writeFailed: boolean } {
  let raw: string;
  try {
    raw = deps.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.warn(`[auth-profiles-migration] Failed to read ${filePath}:`, error);
    return { migratedIds: [], writeFailed: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`[auth-profiles-migration] Failed to parse ${filePath}:`, error);
    return { migratedIds: [], writeFailed: false };
  }

  if (!isRecord(parsed) || !isRecord(parsed.profiles)) {
    return { migratedIds: [], writeFailed: false };
  }

  const migratedIds: string[] = [];
  for (const [id, profile] of Object.entries(parsed.profiles)) {
    if (!isRecord(profile)) continue;
    if (migrateProfile(profile)) {
      migratedIds.push(id);
    }
  }

  if (migratedIds.length === 0) return { migratedIds: [], writeFailed: false };

  const serialized = JSON.stringify(parsed, null, 2);
  try {
    atomicWrite(
      filePath,
      serialized,
      {
        writeFileSync: deps.writeFileSync,
        renameSync: deps.renameSync,
        unlinkSync: deps.unlinkSync,
        chmodSync: deps.chmodSync,
      },
      { mode: 0o600 }
    );
  } catch (error) {
    // The plaintext is still on disk. Signal a failure so the pre-doctor caller
    // can abort before doctor imports it into SQLite.
    console.warn(`[auth-profiles-migration] Failed to write ${filePath}:`, error);
    return { migratedIds: [], writeFailed: true };
  }

  return { migratedIds, writeFailed: false };
}

/**
 * Migrate `<agentDir>/auth-profiles.json` for every conventional agent directory
 * in place. `rootDir` is typically the openclaw state dir (e.g. `/root/.openclaw`).
 *
 * Returns a report for logging. Never throws — individual file failures produce
 * warnings and are skipped.
 */
export function migrateKilocodeAuthProfilesToKeyRef(
  rootDir: string,
  deps: AuthProfilesMigrationDeps = defaultDeps
): AuthProfilesMigrationReport {
  const report: AuthProfilesMigrationReport = {
    filesScanned: 0,
    filesModified: 0,
    profilesMigrated: 0,
    filesFailed: 0,
  };

  for (const agentDir of collectAgentDirs(rootDir, deps)) {
    const filePath = path.join(agentDir, AUTH_PROFILES_FILENAME);
    if (!deps.existsSync(filePath)) continue;

    report.filesScanned += 1;
    const { migratedIds, writeFailed } = migrateOneFile(filePath, deps);
    if (writeFailed) report.filesFailed += 1;
    if (migratedIds.length > 0) {
      report.filesModified += 1;
      report.profilesMigrated += migratedIds.length;
      console.log(
        `[auth-profiles-migration] ${filePath}: migrated ${migratedIds.length} kilocode profile(s) to keyRef (${migratedIds.join(', ')})`
      );
    }
  }

  return report;
}

export type AuthProfileBackupHardenReport = {
  dirsScanned: number;
  backupsHardened: number;
  backupsFailed: number;
};

/**
 * Tighten the permissions of the credential backups OpenClaw's auth-profile
 * migrations leave behind under each resolved agent directory.
 *
 * Since 2026.6.x, `openclaw doctor --fix` rewrites/imports auth stores and backs
 * the original up as `<name>.<migration>.<epoch-ms>.bak` (sqlite-import,
 * legacy-flat, api-key-alias, aws-sdk-profile, openai-provider-unification,
 * oauth-ref) before removing it. Each backup is produced with `fs.copyFileSync`,
 * which does NOT preserve the source's `0o600` mode — it lands at `0o644`,
 * leaving a world-readable copy of whatever credential the original held.
 *
 * We deliberately do NOT delete these backups: OpenClaw can silently skip a
 * malformed profile while importing its siblings, and the backup is the only
 * recovery copy. Instead we strip the world/group bits so the credential is
 * owner-only (matching `/root/.openclaw` at `0o700` and the `0o600` auth files),
 * preserving recovery without the over-broad exposure. Never throws; individual
 * failures are logged and skipped.
 */
export function hardenAuthProfileMigrationBackups(
  rootDir: string,
  deps: AuthProfilesMigrationDeps = defaultDeps
): AuthProfileBackupHardenReport {
  const report: AuthProfileBackupHardenReport = {
    dirsScanned: 0,
    backupsHardened: 0,
    backupsFailed: 0,
  };

  for (const agentDir of collectAgentDirs(rootDir, deps)) {
    if (!deps.existsSync(agentDir)) continue;

    let entries: string[];
    try {
      entries = deps.readdirSync(agentDir);
    } catch (error) {
      console.warn(`[auth-profiles-migration] Failed to list ${agentDir}:`, error);
      continue;
    }
    report.dirsScanned += 1;

    for (const entry of entries) {
      if (!AUTH_MIGRATION_BACKUP_RE.test(entry)) continue;
      const backupPath = path.join(agentDir, entry);
      try {
        deps.chmodSync(backupPath, 0o600);
        report.backupsHardened += 1;
        console.log(`[auth-profiles-migration] hardened migration backup to 0o600 ${backupPath}`);
      } catch (error) {
        report.backupsFailed += 1;
        console.warn(`[auth-profiles-migration] failed to harden ${backupPath}:`, error);
      }
    }
  }

  return report;
}
