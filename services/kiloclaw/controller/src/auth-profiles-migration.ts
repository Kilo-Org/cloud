/**
 * Migrate kilocode `auth-profiles.json` entries from plaintext `key` to an
 * env-backed `keyRef` SecretRef.
 *
 * Background: `openclaw onboard` (pre `--secret-input-mode ref`) wrote the
 * literal `KILOCODE_API_KEY` into `<root>/agents/<id>/agent/auth-profiles.json`
 * under `profiles.kilocode:default.key`. OpenClaw's auth resolver prefers
 * configured auth-profiles over env vars, so once the literal is on disk,
 * rotating `KILOCODE_API_KEY` in the gateway process env has no effect —
 * the gateway keeps authenticating with the stale on-disk value.
 *
 * Fix: rewrite each such profile to use a SecretRef that points back at the
 * same env var. OpenClaw's `buildPersistedAuthProfileSecretsStore` strips
 * the plaintext `key` when `keyRef` is set, and runtime resolution reads
 * `process.env.KILOCODE_API_KEY` on every `secrets reload` — so rotation
 * becomes: update env var → call `openclaw secrets reload`.
 *
 * This migration is idempotent and safe to run on every boot (and every
 * rotation) — profiles already carrying a `keyRef` or lacking a plaintext
 * `key` are left untouched. Malformed JSON is logged and skipped, never
 * fatal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './atomic-write';

const AUTH_PROFILES_FILENAME = 'auth-profiles.json';
const AGENT_SUBDIR = 'agent';
const KILOCODE_PROVIDER = 'kilocode';
const KILOCODE_ENV_VAR = 'KILOCODE_API_KEY';

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
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Rewrite a single profile in place. Returns true when the profile was
 * actually changed (so callers can track whether the file needs writing).
 */
function migrateProfile(profile: UnknownRecord): boolean {
  if (profile.type !== 'api_key') return false;
  if (profile.provider !== KILOCODE_PROVIDER) return false;
  if (profile.keyRef !== undefined) return false;
  if (!isNonEmptyString(profile.key)) return false;

  delete profile.key;
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
 * never throws.
 */
function migrateOneFile(filePath: string, deps: AuthProfilesMigrationDeps): string[] {
  let raw: string;
  try {
    raw = deps.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.warn(`[auth-profiles-migration] Failed to read ${filePath}:`, error);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`[auth-profiles-migration] Failed to parse ${filePath}:`, error);
    return [];
  }

  if (!isRecord(parsed) || !isRecord(parsed.profiles)) {
    return [];
  }

  const migratedIds: string[] = [];
  for (const [id, profile] of Object.entries(parsed.profiles)) {
    if (!isRecord(profile)) continue;
    if (migrateProfile(profile)) {
      migratedIds.push(id);
    }
  }

  if (migratedIds.length === 0) return [];

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
    console.warn(`[auth-profiles-migration] Failed to write ${filePath}:`, error);
    return [];
  }

  return migratedIds;
}

/**
 * Scan `<rootDir>/agents/*&#47;agent/auth-profiles.json` and migrate each file
 * in place. `rootDir` is typically the openclaw state dir (e.g.
 * `/root/.openclaw`).
 *
 * Returns a report for logging. Never throws — individual file failures
 * produce warnings and are skipped.
 */
export function migrateKilocodeAuthProfilesToKeyRef(
  rootDir: string,
  deps: AuthProfilesMigrationDeps = defaultDeps
): AuthProfilesMigrationReport {
  const report: AuthProfilesMigrationReport = {
    filesScanned: 0,
    filesModified: 0,
    profilesMigrated: 0,
  };

  const agentsDir = path.join(rootDir, 'agents');
  if (!deps.existsSync(agentsDir)) {
    return report;
  }

  let agentIds: string[];
  try {
    agentIds = deps.readdirSync(agentsDir);
  } catch (error) {
    console.warn(`[auth-profiles-migration] Failed to list ${agentsDir}:`, error);
    return report;
  }

  for (const agentId of agentIds) {
    const agentRoot = path.join(agentsDir, agentId);
    try {
      if (!deps.statSync(agentRoot).isDirectory()) continue;
    } catch {
      continue;
    }

    const filePath = path.join(agentRoot, AGENT_SUBDIR, AUTH_PROFILES_FILENAME);
    if (!deps.existsSync(filePath)) continue;

    report.filesScanned += 1;
    const migratedIds = migrateOneFile(filePath, deps);
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
