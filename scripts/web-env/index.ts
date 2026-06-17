import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ENVIRONMENTS,
  PROJECTS,
  confirm,
  findRepoRoot,
  question,
  readSecret,
  resolveVault,
  resolveVercelContexts,
  setEnvDefault,
  setVariable,
  setVaultValue,
  trackedEnvFiles,
  type Environment,
  type Values,
} from './shared.js';

type Options = {
  name: string;
  dryRun: boolean;
  valueFiles: Partial<Record<Environment, string>>;
};

function usage(): never {
  throw new Error(
    [
      'Usage: pnpm web:env set VARIABLE [--dry-run]',
      '       [--development-file PATH] [--staging-file PATH] [--production-file PATH]',
    ].join('\n')
  );
}

function parseOptions(args: string[]): Options {
  if (args[0] !== 'set' || !args[1]) usage();
  const name = args[1];
  const valueFiles: Partial<Record<Environment, string>> = {};
  let dryRun = false;

  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') dryRun = true;
    else {
      const match = argument?.match(/^--(development|staging|production)-file(?:=(.*))?$/);
      if (!match) usage();
      const environment = match[1] as Environment;
      const nextArgument = args[index + 1];
      const file = match[2] || nextArgument;
      if (!file) usage();
      if (!match[2]) index += 1;
      valueFiles[environment] = file;
    }
  }

  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new Error('Variable names must contain only uppercase letters, digits, and underscores.');
  }
  return { name, dryRun, valueFiles };
}

async function askSensitivity(name: string): Promise<boolean> {
  const answer = (await question(`Is ${name} sensitive? [Y/n] `)).trim().toLowerCase();
  if (!['', 'y', 'yes', 'n', 'no'].includes(answer)) throw new Error('Answer yes or no.');
  const sensitive = !['n', 'no'].includes(answer);
  if (sensitive && name.startsWith('NEXT_PUBLIC_')) {
    throw new Error('NEXT_PUBLIC_* values are browser-visible; answer no.');
  }
  return sensitive;
}

async function collectValues(options: Options): Promise<Values> {
  const values: Partial<Values> = {};
  for (const environment of ENVIRONMENTS) {
    const file = options.valueFiles[environment];
    const value = file
      ? readFileSync(path.resolve(file), 'utf8')
      : await readSecret(`${environment} value: `);
    if (!value) throw new Error(`${environment} value cannot be empty.`);
    values[environment] = value;
  }
  return values as Values;
}

async function collectDefaults(repoRoot: string, name: string): Promise<Map<string, string>> {
  const defaults = new Map<string, string>();
  for (const relativeFile of trackedEnvFiles(repoRoot)) {
    const decision = (await question(`${relativeFile}: set a safe default or skip? [set/Skip] `))
      .trim()
      .toLowerCase();
    if (!decision || decision === 'skip') continue;
    if (decision !== 'set') throw new Error('Answer set or skip.');

    const suggested = relativeFile === 'apps/web/.env' ? '' : `invalid-${name.toLowerCase()}`;
    const answer = await question(`Safe default for ${relativeFile} [${suggested}] `);
    const value = answer || suggested;
    defaults.set(relativeFile, value);
  }
  return defaults;
}

function warnAboutMatchingTrackedValues(
  repoRoot: string,
  values: Values,
  defaults: Map<string, string>
): void {
  for (const relativeFile of trackedEnvFiles(repoRoot)) {
    const content = readFileSync(path.join(repoRoot, relativeFile), 'utf8');
    const defaultValue = defaults.get(relativeFile);
    const matchesRemoteValue = Object.values(values).some(
      value => content.includes(value) || defaultValue === value
    );
    if (matchesRemoteValue) {
      console.warn(
        `\x1b[1;33mWARNING:\x1b[0m ${relativeFile} contains or will contain a value also used in a remote environment. This may be intentional.`
      );
    }
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const sensitive = await askSensitivity(options.name);
  const repoRoot = findRepoRoot();
  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'kilo-web-env-'));

  try {
    console.log('Checking Vercel and 1Password access...');
    const contexts = resolveVercelContexts(tempDirectory);
    const vaultId = sensitive ? resolveVault() : undefined;
    const values = await collectValues(options);
    const defaults = await collectDefaults(repoRoot, options.name);
    warnAboutMatchingTrackedValues(repoRoot, values, defaults);

    console.log('\nPlan');
    for (const environment of ENVIRONMENTS) {
      const type = sensitive && environment !== 'development' ? 'sensitive' : 'encrypted';
      for (const project of PROJECTS) console.log(`- ${project}/${environment}: ${type}`);
    }
    for (const [file, value] of defaults)
      console.log(`- ${file}: ${options.name}=${JSON.stringify(value)}`);
    console.log(`- 1Password: ${sensitive ? 'update Production copy' : 'skip'}`);
    console.log('- Deployments: not triggered');

    if (options.dryRun) {
      console.log('\nDry run complete; nothing changed.');
      return;
    }
    if (!(await confirm('\nApply these changes?'))) {
      console.log('Cancelled; nothing changed.');
      return;
    }

    for (const [relativeFile, value] of defaults) {
      setEnvDefault(path.join(repoRoot, relativeFile), options.name, value);
    }

    for (const environment of ENVIRONMENTS) {
      for (const context of contexts) {
        console.log(`Setting ${context.project}/${environment}...`);
        setVariable(context, environment, options.name, values[environment], sensitive);
      }
    }
    if (vaultId) {
      console.log('Updating 1Password Production copy...');
      setVaultValue(vaultId, options.name, values.production);
    }

    console.log('\nDone. Rerun the same command if a provider failed partway through.');
    console.log('Deploy Staging or Production separately when the new value should take effect.');
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Environment update failed.');
  process.exitCode = 1;
});
