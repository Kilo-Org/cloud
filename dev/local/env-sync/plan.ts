import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { services } from '../services';
import type {
  Annotation,
  DevVarsFileChange,
  EnvDevLocalChange,
  EnvSyncPlan,
  ExampleEntry,
  ExecWarning,
  KeyChange,
  SecretStoreBinding,
  SecretStoreWarning,
  ConsistencyWarning,
  EnvLocalAutoCreate,
} from './types';
import {
  parseEnvFile,
  readEnvFile,
  parseExampleFile,
  resolveAnnotatedValue,
  parseJsonc,
  generateDevVars,
} from './parse';

// ---------------------------------------------------------------------------
// Auto-created local secrets
// ---------------------------------------------------------------------------

const FLY_TOKEN_ENV_KEY = 'FLY_API_TOKEN';
const FLY_ORG_SLUG_ENV_KEY = 'FLY_ORG_SLUG';
const DEFAULT_FLY_ORG_SLUG = 'kilo-dev';

function createFlyTokenAutoCreate(flyOrgSlug: string): EnvLocalAutoCreate {
  return {
    key: FLY_TOKEN_ENV_KEY,
    command: 'fly',
    args: ['tokens', 'create', 'org', flyOrgSlug],
  };
}

// ---------------------------------------------------------------------------
// LAN IP detection
// ---------------------------------------------------------------------------

function detectLanIp(): string | undefined {
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Source key derivation (for cross-worker consistency checks)
// ---------------------------------------------------------------------------

function getEnvLocalSourceKey(key: string, annotation: Annotation): string | undefined {
  switch (annotation.type) {
    case 'from':
      return annotation.envLocalKey;
    case 'url':
      return undefined;
    case 'pkcs8':
      return key;
    case 'passthrough':
      return key;
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.kilo',
  'dev',
  '.next',
  '.turbo',
  'cloud-agent',
]);

function findDevVarsExamples(repoRoot: string): string[] {
  const results: string[] = [];

  function walk(dir: string, relPath: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), relPath ? `${relPath}/${entry.name}` : entry.name);
      } else if (entry.name === '.dev.vars.example') {
        results.push(relPath);
      }
    }
  }

  walk(repoRoot, '');
  return results.sort();
}

// ---------------------------------------------------------------------------
// Wrangler env detection from package.json dev script
// ---------------------------------------------------------------------------

function detectWranglerEnv(repoRoot: string, workerDir: string): string | undefined {
  const pkgPath = path.join(repoRoot, workerDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const devScript = pkg?.scripts?.dev;
    if (typeof devScript !== 'string') return undefined;
    const match = devScript.match(/--env\s+['"]?(\w+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Wrangler config: extract secrets_store_secrets bindings
// ---------------------------------------------------------------------------

function extractSecretsStoreBindings(repoRoot: string, workerDir: string): SecretStoreBinding[] {
  const wranglerPath = path.join(repoRoot, workerDir, 'wrangler.jsonc');
  if (!fs.existsSync(wranglerPath)) return [];

  try {
    const config = parseJsonc(fs.readFileSync(wranglerPath, 'utf-8')) as Record<string, unknown>;

    const envName = detectWranglerEnv(repoRoot, workerDir);

    // Check the env-specific config first, fall back to top-level
    let secretsSection: unknown;
    if (envName && config.env) {
      const envConfig = (config.env as Record<string, unknown>)[envName];
      if (envConfig && typeof envConfig === 'object') {
        secretsSection = (envConfig as Record<string, unknown>).secrets_store_secrets;
      }
    }
    if (!secretsSection) {
      secretsSection = config.secrets_store_secrets;
    }

    if (!Array.isArray(secretsSection)) return [];
    return secretsSection.map((s: { binding: string; store_id: string; secret_name: string }) => ({
      binding: s.binding,
      store_id: s.store_id,
      secret_name: s.secret_name,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Local secrets store check (via wrangler CLI)
// ---------------------------------------------------------------------------

function listLocalStoreSecrets(repoRoot: string, workerDir: string, storeId: string): string {
  const result = spawnSync('pnpm', ['wrangler', 'secrets-store', 'secret', 'list', storeId], {
    cwd: path.join(repoRoot, workerDir),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return result.status === 0 ? result.stdout : '';
}

// ---------------------------------------------------------------------------
// Plan computation
// ---------------------------------------------------------------------------

function computePlan(repoRoot: string, serviceFilter?: Set<string>): EnvSyncPlan {
  const envLocalPath = path.join(repoRoot, '.env.local');
  if (!fs.existsSync(envLocalPath)) {
    return {
      lanIp: undefined,
      devVarsChanges: [],
      envDevLocalChanges: [],
      envLocalAutoCreates: [],
      secretStoreWarnings: [],
      secretStoreAutoCreates: [],
      consistencyWarnings: [],
      execWarnings: [],
      missingEnvLocal: true,
    };
  }

  const lanIp = detectLanIp();
  const envLocal = parseEnvFile(fs.readFileSync(envLocalPath, 'utf-8'));
  const allWorkerDirs = findDevVarsExamples(repoRoot);

  // When filtering by service, only process dirs belonging to targeted services
  let workerDirs: string[];
  if (serviceFilter) {
    const allowedDirs = new Set<string>();
    for (const name of serviceFilter) {
      const svc = services.get(name);
      if (svc) allowedDirs.add(svc.dir);
    }
    workerDirs = allWorkerDirs.filter(d => allowedDirs.has(d));
  } else {
    workerDirs = allWorkerDirs;
  }

  // Build dir→useLanIp lookup
  const dirUsesLanIp = new Map<string, boolean>();
  for (const [, svc] of services) {
    if (svc.useLanIp) {
      dirUsesLanIp.set(svc.dir, true);
    }
  }

  // --- .dev.vars changes ---
  const devVarsChanges: DevVarsFileChange[] = [];
  const envLocalAutoCreates: EnvLocalAutoCreate[] = [];
  const execWarnings: ExecWarning[] = [];
  const allResolvedEntries = new Map<
    string,
    { vars: Map<string, string>; entries: ExampleEntry[] }
  >();

  for (const workerDir of workerDirs) {
    const examplePath = path.join(repoRoot, workerDir, '.dev.vars.example');
    const exampleContent = fs.readFileSync(examplePath, 'utf-8');
    const entries = parseExampleFile(exampleContent);
    const serviceUsesLanIp = dirUsesLanIp.get(workerDir) ?? false;
    const devVarsPath = path.join(repoRoot, workerDir, '.dev.vars');

    let existingContent: string | null = null;
    try {
      existingContent = fs.readFileSync(devVarsPath, 'utf-8');
    } catch {
      // File doesn't exist yet
    }
    const oldVars =
      existingContent !== null ? parseEnvFile(existingContent) : new Map<string, string>();

    const resolvedVars = new Map<string, string>();
    const resolvedSources = new Map<
      string,
      'env-local' | 'generated' | 'exec' | 'default' | 'missing'
    >();
    const unresolvedKeys: string[] = [];
    let shouldCreateFlyToken = false;

    for (const entry of entries) {
      const { value, resolved, source } = resolveAnnotatedValue(
        entry.key,
        entry,
        envLocal,
        lanIp,
        serviceUsesLanIp
      );
      resolvedVars.set(entry.key, value);
      resolvedSources.set(entry.key, source);

      const autoCreatesFlyToken =
        entry.key === FLY_TOKEN_ENV_KEY && !envLocal.get(FLY_TOKEN_ENV_KEY);
      if (autoCreatesFlyToken) {
        shouldCreateFlyToken = true;
      }

      if (!resolved && !autoCreatesFlyToken) {
        unresolvedKeys.push(entry.key);
        if (entry.annotation.type === 'exec') {
          execWarnings.push({
            workerDir,
            key: entry.key,
            command: entry.annotation.command,
            args: entry.annotation.args,
          });
        }
      }
    }

    if (
      shouldCreateFlyToken &&
      !envLocalAutoCreates.some(create => create.key === FLY_TOKEN_ENV_KEY)
    ) {
      const flyOrgSlug =
        oldVars.get(FLY_ORG_SLUG_ENV_KEY) ||
        resolvedVars.get(FLY_ORG_SLUG_ENV_KEY) ||
        DEFAULT_FLY_ORG_SLUG;
      envLocalAutoCreates.push(createFlyTokenAutoCreate(flyOrgSlug));
    }

    allResolvedEntries.set(workerDir, { vars: resolvedVars, entries });

    const isNew = existingContent === null;
    const keyChanges: KeyChange[] = [];
    let missingValues: string[];

    if (existingContent !== null) {
      // Only report keys as missing if the existing .dev.vars also lacks a value.
      // Keys that couldn't be resolved but already have a value in .dev.vars are
      // kept as-is — skip them from both missing warnings and key change diffs.
      const unresolvedSet = new Set(unresolvedKeys);
      missingValues = unresolvedKeys.filter(key => !oldVars.get(key));
      for (const [key, newVal] of resolvedVars) {
        if (unresolvedSet.has(key)) continue;
        const oldVal = oldVars.get(key);
        const source = resolvedSources.get(key);
        if (key === FLY_TOKEN_ENV_KEY && shouldCreateFlyToken) continue;
        if (oldVal && source === 'default') continue;
        if (oldVal !== newVal) {
          keyChanges.push({ key, oldValue: oldVal, newValue: newVal });
        }
      }
    } else {
      missingValues = unresolvedKeys;
    }

    if (isNew || keyChanges.length > 0 || missingValues.length > 0) {
      devVarsChanges.push({
        workerDir,
        isNew,
        keyChanges,
        missingValues,
        newFileContent: isNew ? generateDevVars(resolvedVars) : undefined,
      });
    }
  }

  // --- .env.development.local changes ---
  const envDevLocalChanges: EnvDevLocalChange[] = [];
  const processEnvDevLocal = !serviceFilter || serviceFilter.has('nextjs');

  const envDevLocalExamplePath = path.join(repoRoot, 'apps/web/.env.development.local.example');
  if (processEnvDevLocal && fs.existsSync(envDevLocalExamplePath)) {
    const envDevLocalPath = path.join(repoRoot, 'apps/web/.env.development.local');
    const envDevLocal = readEnvFile(envDevLocalPath);
    const exampleContent = fs.readFileSync(envDevLocalExamplePath, 'utf-8');
    const entries = parseExampleFile(exampleContent);

    for (const entry of entries) {
      const { value: expectedValue, resolved } = resolveAnnotatedValue(
        entry.key,
        entry,
        envLocal,
        lanIp,
        false // Next.js doesn't use LAN IP
      );

      if (!resolved) continue;

      // Effective value: .env.development.local overrides .env.local
      const effectiveValue = envDevLocal.get(entry.key) ?? envLocal.get(entry.key);
      const isMissing = !envDevLocal.has(entry.key);

      // Add change if: (1) key is missing from file, or (2) value differs from expected
      if (isMissing || effectiveValue !== expectedValue) {
        envDevLocalChanges.push({
          key: entry.key,
          oldValue: isMissing ? undefined : effectiveValue,
          newValue: expectedValue,
        });
      }
    }
  }

  // --- Secrets store warnings ---
  const secretStoreWarnings: SecretStoreWarning[] = [];
  const secretStoreAutoCreates: SecretStoreAutoCreate[] = [];
  // Cache keyed by workerDir+storeId — wrangler scopes secret visibility per worker locally
  const storeOutputCache = new Map<string, string>();

  for (const [name, svc] of services) {
    if (svc.type !== 'worker') continue;
    if (serviceFilter && !serviceFilter.has(name)) continue;
    const bindings = extractSecretsStoreBindings(repoRoot, svc.dir);
    if (bindings.length === 0) continue;

    const missingBindings: SecretStoreBinding[] = [];

    for (const b of bindings) {
      const cacheKey = `${svc.dir}:${b.store_id}`;
      let output = storeOutputCache.get(cacheKey);
      if (output === undefined) {
        output = listLocalStoreSecrets(repoRoot, svc.dir, b.store_id);
        storeOutputCache.set(cacheKey, output);
      }

      if (output.includes(b.secret_name)) {
        continue; // Secret exists, nothing to do
      }

      // Try to map secret name to .env.local key via naming convention
      // Strip _PROD or _DEV suffix to get base key
      const envLocalKey = b.secret_name.replace(/_(PROD|DEV)$/, '');
      const value = envLocal.get(envLocalKey);

      if (value) {
        // Can auto-create from .env.local
        secretStoreAutoCreates.push({
          workerDir: svc.dir,
          binding: b,
          envLocalKey,
          value,
        });
      } else {
        // Missing and no source value - warn
        missingBindings.push(b);
      }
    }

    if (missingBindings.length > 0) {
      secretStoreWarnings.push({ workerDir: svc.dir, bindings: missingBindings });
    }
  }

  // --- Cross-worker shared secret consistency ---
  const sharedSecretMap = new Map<
    string,
    { workerDir: string; workerKey: string; value: string }[]
  >();

  for (const [workerDir, { vars, entries }] of allResolvedEntries) {
    for (const entry of entries) {
      const value = vars.get(entry.key);
      if (!value) continue;
      const sourceKey = getEnvLocalSourceKey(entry.key, entry.annotation);
      if (!sourceKey) continue;
      const existing = sharedSecretMap.get(sourceKey) ?? [];
      existing.push({ workerDir, workerKey: entry.key, value });
      sharedSecretMap.set(sourceKey, existing);
    }
  }

  const consistencyWarnings: ConsistencyWarning[] = [];
  for (const [sourceKey, entries] of sharedSecretMap) {
    if (entries.length <= 1) continue;
    const distinctValues = new Set(entries.map(e => e.value));
    if (distinctValues.size > 1) {
      consistencyWarnings.push({ sourceKey, entries });
    }
  }

  return {
    lanIp,
    devVarsChanges,
    envDevLocalChanges,
    envLocalAutoCreates,
    secretStoreWarnings,
    secretStoreAutoCreates,
    consistencyWarnings,
    execWarnings,
    missingEnvLocal: false,
  };
}

export { computePlan, findDevVarsExamples };
