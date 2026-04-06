import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvSyncPlan } from './types';
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

function truncateValue(value: string, maxLen = 50): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen - 1) + '…';
}

function planHasChanges(plan: EnvSyncPlan): boolean {
  const hasDevVarsDrift = plan.devVarsChanges.some(c => c.isNew || c.keyChanges.length > 0);
  return hasDevVarsDrift || plan.envDevLocalChanges.length > 0;
}

function displayPlan(plan: EnvSyncPlan): void {
  if (plan.missingEnvLocal) {
    console.error('⚠ .env.local not found — run: vercel env pull .env.local');
    return;
  }

  if (plan.lanIp) {
    console.log(`${DIM}LAN IP: ${plan.lanIp}${RESET}`);
    console.log();
  }

  let hasOutput = false;

  // .dev.vars changes
  if (plan.devVarsChanges.length > 0) {
    for (const change of plan.devVarsChanges) {
      if (change.isNew) {
        console.log(`${GREEN}+ ${change.workerDir}/.dev.vars${RESET} ${DIM}(new)${RESET}`);
      } else {
        console.log(`${CYAN}✎ ${change.workerDir}/.dev.vars${RESET}`);
        for (const kc of change.keyChanges) {
          if (kc.oldValue === undefined) {
            console.log(`    ${GREEN}+ ${kc.key}${RESET} = ${truncateValue(kc.newValue)}`);
          } else {
            console.log(
              `    ${YELLOW}~ ${kc.key}${RESET}: ${truncateValue(kc.oldValue)} → ${truncateValue(kc.newValue)}`
            );
          }
        }
      }
      for (const missing of change.missingValues) {
        console.log(`    ${RED}⚠ ${missing}${RESET} — no value found`);
      }
    }
    hasOutput = true;
  }

  // .env.development.local changes
  if (plan.envDevLocalChanges.length > 0) {
    if (hasOutput) console.log();
    console.log(`${CYAN}✎ .env.development.local${RESET}`);
    for (const change of plan.envDevLocalChanges) {
      if (change.oldValue === undefined) {
        console.log(`    ${GREEN}+ ${change.key}${RESET} = ${change.newValue}`);
      } else {
        console.log(
          `    ${YELLOW}~ ${change.key}${RESET}: ${truncateValue(change.oldValue)} → ${change.newValue}`
        );
      }
    }
    hasOutput = true;
  }

  // Secrets store warnings
  if (plan.secretStoreWarnings.length > 0) {
    if (hasOutput) console.log();
    for (const warning of plan.secretStoreWarnings) {
      console.log(
        `${YELLOW}⚠ ${warning.workerDir}${RESET} uses secrets_store — missing local secrets:`
      );
      for (const binding of warning.bindings) {
        console.log(
          `    ${binding.binding}: wrangler secrets-store secret create ${binding.store_id} --name ${binding.secret_name} --scopes workers`
        );
      }
    }
    hasOutput = true;
  }

  // Consistency warnings
  if (plan.consistencyWarnings.length > 0) {
    if (hasOutput) console.log();
    for (const warning of plan.consistencyWarnings) {
      console.log(`${RED}✗ Shared secret mismatch: ${warning.sourceKey}${RESET}`);
      for (const entry of warning.entries) {
        const keyLabel =
          entry.workerKey !== warning.sourceKey
            ? `${entry.workerDir} (${entry.workerKey})`
            : entry.workerDir;
        console.log(`    ${keyLabel}: ${truncateValue(entry.value)}`);
      }
    }
    hasOutput = true;
  }

  if (!hasOutput) {
    console.log(`${GREEN}✓ All env vars are up to date${RESET}`);
  }
}

// ---------------------------------------------------------------------------
// Plan application
// ---------------------------------------------------------------------------

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyPlan(plan: EnvSyncPlan, repoRoot: string): void {
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
    const envDevLocalPath = path.join(repoRoot, '.env.development.local');

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
