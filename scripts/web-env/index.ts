import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyRemoteChanges, PartialRemoteFailureError } from './apply.js';
import { executeCommand, requireSuccess } from './command.js';
import {
  applyDotenvPatches,
  assertNoEnvironmentValuesInTrackedFiles,
  countKeyAssignments,
  createDotenvPatch,
  discoverTrackedDotenvFiles,
  renderDotenvPatchPreview,
  restoreDotenvPatches,
  verifyDotenvPatches,
  type DotenvPatch,
} from './dotenv-files.js';
import { OnePasswordAdapter } from './onepassword.js';
import {
  assertNonEmptyValues,
  buildWriteOperations,
  validateTargetPreconditions,
  validateVariableName,
  WEB_ENVIRONMENTS,
  WEB_ENV_PROJECTS,
  type EnvironmentValues,
  type TargetState,
  type WebEnvMode,
} from './plan.js';
import { createTerminalPrompts, UserAbortError, type PromptDriver } from './prompts.js';
import { readResumeJournal, type ResumeJournal } from './resume.js';
import { VercelAdapter } from './vercel.js';

type CliOptions = {
  mode: WebEnvMode;
  variableName: string;
  sensitive: boolean;
  dryRun: boolean;
  resumePath?: string;
};

function findRepoRoot(): string {
  let directory = process.cwd();
  while (true) {
    const packagePath = path.join(directory, 'package.json');
    if (existsSync(packagePath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'name' in parsed &&
          parsed.name === 'kilocode-monorepo'
        ) {
          return directory;
        }
      } catch {
        // Keep walking until the repository root is found.
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Could not find the kilocode-monorepo root.');
    directory = parent;
  }
}

const REPO_ROOT = findRepoRoot();

function usage(): string {
  return [
    'Usage:',
    '  pnpm web:env add VARIABLE_NAME [--no-sensitive] [--dry-run]',
    '  pnpm web:env update VARIABLE_NAME [--no-sensitive] [--dry-run]',
    '  pnpm web:env resume JOURNAL_PATH [--dry-run]',
  ].join('\n');
}

async function parseArgs(args: string[]): Promise<CliOptions> {
  const mode = args[0];
  if (mode !== 'add' && mode !== 'update' && mode !== 'resume') {
    throw new Error(usage());
  }

  const positional = args.filter(argument => !argument.startsWith('--'));
  const flags = args.filter(argument => argument.startsWith('--'));
  const unknownFlags = flags.filter(flag => flag !== '--no-sensitive' && flag !== '--dry-run');
  if (unknownFlags.length > 0) throw new Error(`Unknown option: ${unknownFlags[0]}\n\n${usage()}`);
  if (positional.length !== 2) throw new Error(usage());

  if (mode === 'resume') {
    if (flags.includes('--no-sensitive')) {
      throw new Error('Resume sensitivity is read from the journal; omit --no-sensitive.');
    }
    const resumePath = path.resolve(REPO_ROOT, positional[1] ?? '');
    const journal = await readResumeJournal(resumePath);
    return {
      mode,
      variableName: journal.variableName,
      sensitive: journal.sensitive,
      dryRun: flags.includes('--dry-run'),
      resumePath,
    };
  }

  return {
    mode,
    variableName: positional[1] ?? '',
    sensitive: !flags.includes('--no-sensitive'),
    dryRun: flags.includes('--dry-run'),
  };
}

function defaultRecommendation(relativePath: string, variableName: string): string {
  if (relativePath === 'apps/web/.env') return '';
  return `invalid-${variableName.toLowerCase().replaceAll('_', '-')}`;
}

async function collectEnvironmentValues(prompts: PromptDriver): Promise<EnvironmentValues> {
  const values: Partial<EnvironmentValues> = {};
  for (const environment of WEB_ENVIRONMENTS) {
    const modeAnswer = await prompts.askText(
      `Input mode for ${environment} (single-line/multiline)`,
      'single-line'
    );
    if (modeAnswer !== 'single-line' && modeAnswer !== 'multiline') {
      throw new Error('Input mode must be single-line or multiline.');
    }
    values[environment] = await prompts.askSecret(`${environment} value`, modeAnswer);
  }

  const development = values.development;
  const staging = values.staging;
  const production = values.production;
  if (development === undefined || staging === undefined || production === undefined) {
    throw new Error('All environment values are required.');
  }
  const complete = { development, staging, production } satisfies EnvironmentValues;
  assertNonEmptyValues(complete);
  return complete;
}

async function collectDotenvPatches(
  prompts: PromptDriver,
  variableName: string,
  values: EnvironmentValues
): Promise<{ files: string[]; patches: DotenvPatch[] }> {
  const files = await discoverTrackedDotenvFiles(REPO_ROOT, executeCommand);
  const patches: DotenvPatch[] = [];
  for (const relativePath of files) {
    const content = await readFile(path.join(REPO_ROOT, relativePath), 'utf8');
    const count = countKeyAssignments(content, variableName);
    if (count > 1) {
      throw new Error(`${relativePath} declares ${variableName} more than once.`);
    }
    const status = count === 1 ? 'currently declared' : 'not declared';
    const decision = await prompts.askText(
      `${relativePath} (${status}): set a safe default or skip? (set/skip)`,
      'set'
    );
    if (decision === 'skip') continue;
    if (decision !== 'set') throw new Error('Tracked dotenv decisions must be set or skip.');

    const recommendation = defaultRecommendation(relativePath, variableName);
    const defaultValue = await prompts.askText(
      `Safe non-secret default for ${relativePath}`,
      recommendation
    );
    patches.push(await createDotenvPatch(REPO_ROOT, relativePath, variableName, defaultValue));
  }
  await assertNoEnvironmentValuesInTrackedFiles(REPO_ROOT, files, patches, values);
  return { files, patches };
}

function showTrackedDiff(patches: DotenvPatch[], variableName: string): void {
  if (patches.length === 0) {
    console.log('\nTracked defaults: all files explicitly skipped.');
    return;
  }
  console.log('\nTracked default diff (invocation changes only):');
  console.log(renderDotenvPatchPreview(patches, variableName));
}

async function runFastChecks(): Promise<void> {
  const result = await executeCommand({
    command: 'pnpm',
    args: ['run', 'test:web-env'],
    cwd: REPO_ROOT,
    timeoutMs: 120_000,
  });
  requireSuccess(result, 'Web environment script checks');
  console.log('Fast checks passed.');
}

function printPlan(variableName: string, sensitive: boolean, mode: WebEnvMode): void {
  console.log('\nRedacted operation plan');
  console.log(`Variable: ${variableName}`);
  console.log(`Mode: ${mode}`);
  console.log(`Classification: ${sensitive ? 'sensitive' : 'non-sensitive'}`);
  for (const operation of buildWriteOperations(sensitive)) {
    console.log(`- ${operation.project}/${operation.environment}: ${operation.expectedType}`);
  }
  console.log(`- 1Password: ${sensitive ? 'write production value' : 'skipped'}`);
  console.log('- Deployment: not triggered');
}

function printFailureMatrix(journal: ResumeJournal): void {
  console.error('\nPartial operation status (no values):');
  for (const id of journal.completed) console.error(`- completed: ${id}`);
  console.error(`- failed: ${journal.failed}`);
  for (const id of journal.pending) console.error(`- pending: ${id}`);
  console.error(`- 1Password: ${journal.onePassword}`);
}

async function main(): Promise<void> {
  const options = await parseArgs(process.argv.slice(2));
  validateVariableName(options.variableName, options.sensitive);

  const prompts = createTerminalPrompts();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kilo-web-env-'));
  await chmod(tempRoot, 0o700);
  const vercel = new VercelAdapter(executeCommand, tempRoot);
  const onePassword = new OnePasswordAdapter(executeCommand);
  let patches: DotenvPatch[] = [];
  let patchesApplied = false;
  let remoteStarted = false;

  try {
    console.log('Running read-only preflight...');
    await vercel.initialize(!options.sensitive);
    if (options.sensitive) await onePassword.initialize();

    const states: TargetState[] = [];
    for (const environment of WEB_ENVIRONMENTS) {
      for (const project of WEB_ENV_PROJECTS) {
        states.push({
          project,
          environment,
          variable: await vercel.getVariable(project, environment, options.variableName),
        });
      }
    }
    if (options.mode !== 'resume') validateTargetPreconditions(options.mode, states);
    if (options.sensitive) {
      const existingItem = await onePassword.validateExistingItem(options.variableName);
      if (options.mode === 'add' && existingItem) {
        throw new Error(`1Password already contains an item titled ${options.variableName}.`);
      }
    }

    const values = await collectEnvironmentValues(prompts);
    if (options.mode !== 'resume') {
      const trackedDefaults = await collectDotenvPatches(prompts, options.variableName, values);
      patches = trackedDefaults.patches;
      await applyDotenvPatches(patches);
      patchesApplied = true;
      await verifyDotenvPatches(patches, options.variableName);
      showTrackedDiff(patches, options.variableName);
      await runFastChecks();
    }
    printPlan(options.variableName, options.sensitive, options.mode);

    if (options.dryRun) {
      if (patchesApplied) await restoreDotenvPatches(patches);
      console.log('\nDry run complete. No local or remote changes were retained.');
      return;
    }

    const confirmed = await prompts.confirm('Apply this plan?');
    if (!confirmed) {
      if (patchesApplied) await restoreDotenvPatches(patches);
      console.log('Cancelled. Tracked files were restored; no remote changes were made.');
      return;
    }

    remoteStarted = true;
    try {
      await applyRemoteChanges({
        repoRoot: REPO_ROOT,
        mode: options.mode,
        variableName: options.variableName,
        sensitive: options.sensitive,
        values,
        vercel,
        onePassword,
      });
    } catch (error) {
      if (error instanceof PartialRemoteFailureError) {
        printFailureMatrix(error.journal);
        console.error(`Resume with: pnpm web:env resume ${error.journalPath}`);
      }
      throw error;
    }

    if (options.resumePath) await rm(options.resumePath, { force: true });
    console.log('\nEnvironment variable update completed.');
    console.log('New deployments are required before staging or production uses the new value.');
  } catch (error) {
    if (patchesApplied && !remoteStarted) await restoreDotenvPatches(patches);
    throw error;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  if (error instanceof UserAbortError) {
    console.error('Cancelled.');
  } else if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error('Unexpected failure. Provider output was redacted.');
  }
  process.exitCode = 1;
});
