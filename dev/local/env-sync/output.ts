import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  DevVarsFileChange,
  EnvSyncPlan,
  SecretStoreAutoCreate,
  SecretStoreWarning,
} from './types';
import { formatValue } from './parse';

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
    hasDevVarsDrift || plan.envDevLocalChanges.length > 0 || plan.secretStoreAutoCreates.length > 0
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
        `    ${GREEN}⊕${RESET} secret: ${create.binding.secret_name} ${DIM}@from ${create.envLocalKey}${RESET}`
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

// ---------------------------------------------------------------------------
// Secrets store creation
// ---------------------------------------------------------------------------

function createSecretsStoreSecret(
  repoRoot: string,
  workerDir: string,
  storeId: string,
  secretName: string,
  value: string
): boolean {
  const result = spawnSync(
    'pnpm',
    [
      'wrangler',
      'secrets-store',
      'secret',
      'create',
      storeId,
      '--name',
      secretName,
      '--scopes',
      'workers',
    ],
    {
      cwd: path.join(repoRoot, workerDir),
      encoding: 'utf-8',
      input: value, // Pass value via stdin for security
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  return result.status === 0;
}

function applySecretsStoreAutoCreates(creates: SecretStoreAutoCreate[], repoRoot: string): void {
  if (creates.length === 0) return;

  console.log('\nCreating secrets store secrets...');
  for (const create of creates) {
    const success = createSecretsStoreSecret(
      repoRoot,
      create.workerDir,
      create.binding.store_id,
      create.binding.secret_name,
      create.value
    );
    if (success) {
      console.log(`  ✓ ${create.binding.secret_name}`);
    } else {
      console.error(`  ✗ ${create.binding.secret_name} (failed)`);
    }
  }
}

function applyPlan(plan: EnvSyncPlan, repoRoot: string): void {
  // Create secrets store secrets first
  applySecretsStoreAutoCreates(plan.secretStoreAutoCreates, repoRoot);

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
          content = content.replace(regex, `${kc.key}=${formatValue(kc.newValue)}`);
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
        if (regex.test(content)) {
          content = content.replace(regex, `${change.key}=${change.newValue}`);
        } else {
          content = content.trimEnd() + `\n${change.key}=${change.newValue}\n`;
        }
      }
      fs.writeFileSync(envDevLocalPath, content, 'utf-8');
    } else {
      const lines = plan.envDevLocalChanges.map(c => `${c.key}=${c.newValue}`);
      fs.writeFileSync(envDevLocalPath, lines.join('\n') + '\n', 'utf-8');
    }
  }
}

export { planHasChanges, displayPlan, applyPlan };
