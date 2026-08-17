import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withProcessLockAsync } from '../process-lock';
import { mapWithConcurrency, resolveEnvSyncConcurrency } from './concurrency';
import type {
  DevVarsFileChange,
  EnvLocalAutoCreate,
  EnvSyncPlan,
  SecretStoreAutoCreate,
  SecretStoreWarning,
} from './types';
import { formatValue, readEnvFile } from './parse';

// ---------------------------------------------------------------------------
// ANSI color constants
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

// ---------------------------------------------------------------------------
// Plan display
// ---------------------------------------------------------------------------

function planHasChanges(plan: EnvSyncPlan): boolean {
  const hasDevVarsDrift = plan.devVarsChanges.some(c => c.isNew || c.keyChanges.length > 0);
  return (
    hasDevVarsDrift ||
    plan.envDevLocalChanges.length > 0 ||
    plan.envLocalAutoCreates.length > 0 ||
    plan.secretStoreAutoCreates.length > 0
  );
}

function displayPlan(plan: EnvSyncPlan): void {
  if (plan.missingEnvLocal) {
    console.error('⚠ .env.local not found — run: vercel env pull .env.local');
    return;
  }

  let hasOutput = false;

  // ── Group per-service items by workerDir ──────────────────────────────

  type ServiceGroup = {
    devVars: DevVarsFileChange | undefined;
    autoCreates: SecretStoreAutoCreate[];
    warning: SecretStoreWarning | undefined;
  };

  const serviceMap = new Map<string, ServiceGroup>();

  const getGroup = (dir: string): ServiceGroup => {
    let g = serviceMap.get(dir);
    if (!g) {
      g = { devVars: undefined, autoCreates: [], warning: undefined };
      serviceMap.set(dir, g);
    }
    return g;
  };

  for (const c of plan.devVarsChanges) getGroup(c.workerDir).devVars = c;
  for (const c of plan.secretStoreAutoCreates) getGroup(c.workerDir).autoCreates.push(c);
  for (const w of plan.secretStoreWarnings) getGroup(w.workerDir).warning = w;

  // ── Render each service ───────────────────────────────────────────────

  for (const [workerDir, group] of serviceMap) {
    const dv = group.devVars;
    const hasDevVars = dv && (dv.isNew || dv.keyChanges.length > 0 || dv.missingValues.length > 0);
    if (!hasDevVars && group.autoCreates.length === 0 && !group.warning) continue;

    if (hasOutput) console.log();
    console.log(`${CYAN}${workerDir}${RESET}`);

    // .dev.vars (skip keys already shown as ⊕ auto-creates)
    if (dv) {
      const autoCreateKeys = new Set(group.autoCreates.map(c => c.binding.secret_name));
      if (dv.isNew) {
        console.log(`  ${GREEN}+ .dev.vars${RESET} ${DIM}(new)${RESET}`);
      }
      for (const kc of dv.keyChanges) {
        if (autoCreateKeys.has(kc.key)) continue;
        if (kc.oldValue === undefined) {
          console.log(`    ${GREEN}+ ${kc.key}${RESET}`);
        } else {
          console.log(`    ${YELLOW}~ ${kc.key}${RESET}`);
        }
      }
      for (const missing of dv.missingValues) {
        console.log(`    ${RED}⚠ ${missing}${RESET} — no value found`);
      }
    }

    // Secrets store auto-creates
    for (const create of group.autoCreates) {
      console.log(
        `    ${GREEN}⊕${RESET} secret: ${create.binding.secret_name} ${DIM}@from ${create.sourceKey}${RESET}`
      );
    }

    // Secrets store warnings
    if (group.warning) {
      console.log(`    ${YELLOW}⚠${RESET} secrets_store — missing local secrets:`);
      for (const binding of group.warning.bindings) {
        console.log(
          `      ${binding.binding}: wrangler secrets-store secret create ${binding.store_id} --name ${binding.secret_name} --scopes workers`
        );
      }
    }

    hasOutput = true;
  }

  // ── .env.local auto-created values ───────────────────────────────────

  if (plan.envLocalAutoCreates.length > 0) {
    if (hasOutput) console.log();
    console.log(`${CYAN}✎ .env.local${RESET}`);
    for (const create of plan.envLocalAutoCreates) {
      const cmd = [create.command, ...create.args].join(' ');
      console.log(`    ${GREEN}⊕ ${create.key}${RESET} ${DIM}from \`${cmd}\`${RESET}`);
    }
    hasOutput = true;
  }

  // ── .env.development.local (not per-service) ─────────────────────────

  if (plan.envDevLocalChanges.length > 0) {
    if (hasOutput) console.log();
    console.log(`${CYAN}✎ .env.development.local${RESET}`);
    for (const change of plan.envDevLocalChanges) {
      if (change.oldValue === undefined) {
        console.log(`    ${GREEN}+ ${change.key}${RESET}`);
      } else {
        console.log(`    ${YELLOW}~ ${change.key}${RESET}`);
      }
    }
    hasOutput = true;
  }

  // ── Consistency warnings (cross-service) ──────────────────────────────

  if (plan.consistencyWarnings.length > 0) {
    if (hasOutput) console.log();
    for (const warning of plan.consistencyWarnings) {
      console.log(`${RED}✗ Shared secret mismatch: ${warning.sourceKey}${RESET}`);
      for (const entry of warning.entries) {
        const keyLabel =
          entry.workerKey !== warning.sourceKey
            ? `${entry.workerDir} (${entry.workerKey})`
            : entry.workerDir;
        console.log(`    ${keyLabel}`);
      }
    }
    hasOutput = true;
  }

  // @exec annotation failures (always shown, even if existing value is preserved)
  if (plan.execWarnings.length > 0) {
    if (hasOutput) console.log();
    for (const warning of plan.execWarnings) {
      const cmd = [warning.command, ...warning.args].join(' ');
      console.log(
        `${YELLOW}⚠ ${warning.workerDir}${RESET}: ${RED}${warning.key}${RESET} — \`${cmd}\` failed`
      );
      console.log(`    Run the command manually to diagnose.`);
    }
    hasOutput = true;
  }

  if (!hasOutput) {
    console.log(`${GREEN}✓ All env vars are up to date${RESET}`);
    return;
  }

  // ── Legend ─────────────────────────────────────────────────────────────

  console.log();
  console.log(
    `${DIM}${GREEN}+${RESET}${DIM} new  ${YELLOW}~${RESET}${DIM} changed  ${GREEN}⊕${RESET}${DIM} create secret  ${RED}⚠${RESET}${DIM} missing  ${RED}✗${RESET}${DIM} mismatch${RESET}`
  );
}

// ---------------------------------------------------------------------------
// Plan application
// ---------------------------------------------------------------------------

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertEnvValue(filePath: string, key: string, value: string): void {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    // File doesn't exist yet
  }

  const line = `${key}=${formatValue(value)}`;
  if (!content) {
    fs.writeFileSync(filePath, `${line}\n`, 'utf-8');
    return;
  }

  const regex = new RegExp(`^${escapeRegex(key)}=.*$`, 'm');
  if (regex.test(content)) {
    fs.writeFileSync(
      filePath,
      content.replace(regex, () => line),
      'utf-8'
    );
    return;
  }

  fs.writeFileSync(filePath, `${content.trimEnd()}\n${line}\n`, 'utf-8');
}

// ---------------------------------------------------------------------------
// .env.local auto-created values
// ---------------------------------------------------------------------------

function applyEnvLocalAutoCreates(creates: EnvLocalAutoCreate[], repoRoot: string): void {
  if (creates.length === 0) return;

  const envLocalPath = path.join(repoRoot, '.env.local');
  console.log('\nCreating .env.local values...');

  for (const create of creates) {
    const currentValue = readEnvFile(envLocalPath).get(create.key);
    if (currentValue) {
      console.log(`  ✓ ${create.key} already exists`);
      continue;
    }

    const result = spawnSync(create.command, create.args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });

    const value = result.stdout.trim();
    if (result.status !== 0 || !value) {
      const cmd = [create.command, ...create.args].join(' ');
      const errorOutput = result.stderr.trim();
      const suffix = errorOutput ? `: ${errorOutput}` : '';
      throw new Error(`Failed to create ${create.key} with \`${cmd}\`${suffix}`);
    }

    upsertEnvValue(envLocalPath, create.key, value);
    console.log(`  ✓ ${create.key}`);
  }
}

// ---------------------------------------------------------------------------
// Secrets store creation
// ---------------------------------------------------------------------------

type WranglerResult = {
  status: number;
  stderr: string;
  stdout: string;
};

type WranglerRunner = typeof runWrangler;

type ApplyPlanOptions = {
  concurrency?: number;
  missingSecretsOnly?: boolean;
  runWrangler?: WranglerRunner;
};

function runWrangler(
  repoRoot: string,
  workerDir: string,
  args: string[],
  input?: string
): Promise<WranglerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['wrangler', ...args], {
      cwd: path.join(repoRoot, workerDir),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.once('error', reject);
    child.once('close', code => resolve({ status: code ?? 1, stderr, stdout }));
    child.stdin.end(input);
  });
}

async function createSecretsStoreSecret(
  repoRoot: string,
  workerDir: string,
  storeId: string,
  secretName: string,
  value: string,
  runner: WranglerRunner = runWrangler
): Promise<void> {
  const result = await runner(
    repoRoot,
    workerDir,
    ['secrets-store', 'secret', 'create', storeId, '--name', secretName, '--scopes', 'workers'],
    `${value}\n` // Complete Wrangler's prompt without exposing the value in argv.
  );
  if (result.status !== 0) {
    const errorOutput = result.stderr.trim();
    throw new Error(
      `Failed to create Secrets Store secret ${secretName}${errorOutput ? `: ${errorOutput}` : ''}`
    );
  }
}

function resolveWranglerPersistenceDir(repoRoot: string, workerDir: string): string {
  const wranglerDir = path.join(repoRoot, workerDir, '.wrangler');
  try {
    return fs.realpathSync(wranglerDir);
  } catch {
    return wranglerDir;
  }
}

async function secretExists(
  create: SecretStoreAutoCreate,
  repoRoot: string,
  runner: WranglerRunner = runWrangler
): Promise<boolean> {
  const result = await runner(repoRoot, create.workerDir, [
    'secrets-store',
    'secret',
    'list',
    create.binding.store_id,
  ]);
  if (result.status !== 0) {
    const errorOutput = result.stderr.trim();
    throw new Error(
      `Failed to list Secrets Store secrets for ${create.workerDir}${errorOutput ? `: ${errorOutput}` : ''}`
    );
  }
  return result.stdout.includes(create.binding.secret_name);
}

async function applySecretsStoreAutoCreates(
  creates: SecretStoreAutoCreate[],
  repoRoot: string,
  options: ApplyPlanOptions = {}
): Promise<void> {
  if (creates.length === 0) return;

  console.log('\nCreating secrets store secrets...');
  const groups = new Map<string, SecretStoreAutoCreate[]>();
  for (const create of creates) {
    const persistenceDir = resolveWranglerPersistenceDir(repoRoot, create.workerDir);
    const group = groups.get(persistenceDir) ?? [];
    group.push(create);
    groups.set(persistenceDir, group);
  }

  await mapWithConcurrency(
    [...groups.entries()],
    options.concurrency ?? resolveEnvSyncConcurrency(),
    async ([persistenceDir, group]) => {
      const lockPath = path.join(persistenceDir, '.env-sync-secrets.lock');
      await withProcessLockAsync(
        lockPath,
        `Secrets Store for ${group[0]?.workerDir ?? persistenceDir}`,
        async () => {
          for (const create of group) {
            if (
              options.missingSecretsOnly &&
              (await secretExists(create, repoRoot, options.runWrangler))
            ) {
              console.log(`  ✓ ${create.binding.secret_name} already exists`);
              continue;
            }
            await createSecretsStoreSecret(
              repoRoot,
              create.workerDir,
              create.binding.store_id,
              create.binding.secret_name,
              create.value,
              options.runWrangler
            );
            console.log(`  ✓ ${create.binding.secret_name}`);
          }
        },
        30_000
      );
    }
  );
}

async function applyPlan(
  plan: EnvSyncPlan,
  repoRoot: string,
  options: ApplyPlanOptions = {}
): Promise<void> {
  // Create secrets store secrets first
  await applySecretsStoreAutoCreates(plan.secretStoreAutoCreates, repoRoot, options);

  for (const change of plan.devVarsChanges) {
    const devVarsPath = path.join(repoRoot, change.workerDir, '.dev.vars');

    if (change.newFileContent !== undefined) {
      fs.writeFileSync(devVarsPath, change.newFileContent, 'utf-8');
    } else {
      let content = fs.readFileSync(devVarsPath, 'utf-8');
      const appendLines: string[] = [];

      for (const kc of change.keyChanges) {
        const regex = new RegExp(`^${escapeRegex(kc.key)}=.*$`, 'm');
        if (regex.test(content)) {
          const line = `${kc.key}=${formatValue(kc.newValue)}`;
          content = content.replace(regex, () => line);
        } else {
          appendLines.push(`${kc.key}=${formatValue(kc.newValue)}`);
        }
      }

      if (appendLines.length > 0) {
        content = content.trimEnd() + '\n' + appendLines.join('\n') + '\n';
      }

      fs.writeFileSync(devVarsPath, content, 'utf-8');
    }
  }

  if (plan.envDevLocalChanges.length > 0) {
    const envDevLocalPath = path.join(repoRoot, 'apps/web/.env.development.local');

    let existingContent = '';
    try {
      existingContent = fs.readFileSync(envDevLocalPath, 'utf-8');
    } catch {
      // File doesn't exist yet
    }

    if (existingContent) {
      let content = existingContent;
      for (const change of plan.envDevLocalChanges) {
        const regex = new RegExp(`^${escapeRegex(change.key)}=.*$`, 'm');
        const line = `${change.key}=${formatValue(change.newValue)}`;
        if (regex.test(content)) {
          content = content.replace(regex, () => line);
        } else {
          content = content.trimEnd() + `\n${line}\n`;
        }
      }
      fs.writeFileSync(envDevLocalPath, content, 'utf-8');
    } else {
      const lines = plan.envDevLocalChanges.map(c => `${c.key}=${formatValue(c.newValue)}`);
      fs.writeFileSync(envDevLocalPath, lines.join('\n') + '\n', 'utf-8');
    }
  }
}

export { planHasChanges, displayPlan, applyEnvLocalAutoCreates, applyPlan };
