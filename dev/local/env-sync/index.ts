import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { resolveTargets } from '../services';
import { computePlan, findDevVarsExamples } from './plan';
import { planHasChanges, displayPlan, applyPlan } from './output';
import type { SyncResult, CheckResult } from './types';

// ---------------------------------------------------------------------------
// ANSI color constants (used in CLI output below)
// ---------------------------------------------------------------------------

const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

// ---------------------------------------------------------------------------
// Confirmation prompt
// ---------------------------------------------------------------------------

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function resolveServiceFilter(targets?: string[]): Set<string> | undefined {
  if (!targets || targets.length === 0) return undefined;
  return new Set(resolveTargets(targets));
}

async function syncEnvVars(options: {
  repoRoot: string;
  check?: boolean;
  yes?: boolean;
  targets?: string[];
}): Promise<SyncResult> {
  const { repoRoot, check = false, yes = false, targets } = options;
  const serviceFilter = resolveServiceFilter(targets);
  const plan = computePlan(repoRoot, serviceFilter);

  if (plan.missingEnvLocal) {
    displayPlan(plan);
    return { ok: false, changed: 0, missing: 0 };
  }

  const hasChanges = planHasChanges(plan);
  const totalMissing = plan.devVarsChanges.reduce((sum, c) => sum + c.missingValues.length, 0);

  displayPlan(plan);

  if (check) {
    return { ok: !hasChanges, changed: plan.devVarsChanges.length, missing: totalMissing };
  }

  if (hasChanges) {
    const shouldApply = yes || (await confirm(`\nApply changes? [y/N] `));
    if (shouldApply) {
      applyPlan(plan, repoRoot);
      console.log(`\n${GREEN}✓ Applied${RESET}`);
    } else {
      console.log('Skipped.');
    }
  }

  return { ok: true, changed: plan.devVarsChanges.length, missing: totalMissing };
}

async function checkEnvVars(repoRoot: string, targets?: string[]): Promise<CheckResult> {
  const envLocalPath = path.join(repoRoot, '.env.local');
  if (!fs.existsSync(envLocalPath)) {
    return { ok: false, envLocalExists: false, missing: 0, workerCount: 0 };
  }

  const serviceFilter = resolveServiceFilter(targets);
  const plan = computePlan(repoRoot, serviceFilter);
  const totalMissing = plan.devVarsChanges.reduce((sum, c) => sum + c.missingValues.length, 0);
  const workerCount = findDevVarsExamples(repoRoot).length;

  return {
    ok:
      !plan.devVarsChanges.some(c => c.isNew || c.keyChanges.length > 0) &&
      plan.envDevLocalChanges.length === 0,
    envLocalExists: true,
    missing: totalMissing,
    workerCount,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function findRepoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 20; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'kilocode-backend') return dir;
      } catch {
        // Not valid JSON, keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not find repo root (package.json with name 'kilocode-backend')");
}

async function main() {
  const args = process.argv.slice(2);
  const checkMode = args.includes('--check');
  const yesMode = args.includes('--yes') || args.includes('-y');
  const targets = args.filter(a => !a.startsWith('-'));

  const repoRoot = findRepoRoot();

  if (checkMode) {
    const result = await checkEnvVars(repoRoot, targets.length > 0 ? targets : undefined);
    if (!result.envLocalExists) {
      console.error('✗ .env.local not found. Run: vercel env pull .env.local');
      process.exit(1);
    }
    if (!result.ok) {
      console.error(`\n✗ Env vars out of date. Run: pnpm dev:env`);
      process.exit(1);
    }
    console.log(`✓ All env vars up to date across ${result.workerCount} workers`);
    return;
  }

  const result = await syncEnvVars({
    repoRoot,
    yes: yesMode,
    targets: targets.length > 0 ? targets : undefined,
  });
  if (!result.ok) {
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, 'index.ts');
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { syncEnvVars, checkEnvVars };
export type { EnvSyncPlan, SyncResult, CheckResult } from './types';
