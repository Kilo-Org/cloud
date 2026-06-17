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
  while (true) {
    const answer = (await question(`Is ${name} sensitive? [Y/n] `)).trim().toLowerCase();
    if (!['', 'y', 'yes', 'n', 'no'].includes(answer)) {
      console.warn('Please answer yes or no.');
      continue;
    }
    const sensitive = !['n', 'no'].includes(answer);
    if (sensitive && name.startsWith('NEXT_PUBLIC_')) {
      console.warn('NEXT_PUBLIC_* values are browser-visible; answer no.');
      continue;
    }
    return sensitive;
  }
}

function normalizeFileValue(value: string): string {
  const trailingNewlineLength = value.endsWith('\r\n') ? 2 : value.endsWith('\n') ? 1 : 0;
  if (trailingNewlineLength === 0) return value;
  const valueWithoutTrailingNewline = value.slice(0, -trailingNewlineLength);
  return /[\r\n]/.test(valueWithoutTrailingNewline) ? value : valueWithoutTrailingNewline;
}

async function collectValues(options: Options): Promise<Values> {
  const values: Partial<Values> = {};
  for (const environment of ENVIRONMENTS) {
    const file = options.valueFiles[environment];
    if (file) {
      const value = normalizeFileValue(readFileSync(path.resolve(file), 'utf8'));
      if (!value) throw new Error(`${environment} value file cannot be empty.`);
      values[environment] = value;
      continue;
    }

    while (!values[environment]) {
      const value = await readSecret(`${environment} value: `);
      if (value) values[environment] = value;
      else console.warn(`${environment} value cannot be empty. Please try again.`);
    }
  }
  return values as Values;
}

async function collectDefaults(repoRoot: string, name: string): Promise<Map<string, string>> {
  const defaults = new Map<string, string>();
  for (const relativeFile of trackedEnvFiles(repoRoot)) {
    const value = await question(
      `${relativeFile}: default value for ${name} (press Return to skip): `
    );
    if (!value) continue;
    defaults.set(relativeFile, value);
  }
  return defaults;
}

function warnAboutMissingTrackedDefault(name: string): void {
  const border = '='.repeat(78);
  console.warn(`
\x1b[1;33m${border}
NO TRACKED ENV DEFAULT WILL BE ADDED

Make sure the application can start and run without ${name}. If the code requires
this variable, external contributors without access to shared secrets will run
into setup, test, or build failures.
${border}\x1b[0m
`);
}

function assignmentValue(content: string, name: string): string | undefined {
  const assignment = content.split('\n').find(line => line.startsWith(`${name}=`));
  if (!assignment) return undefined;
  const value = assignment.slice(name.length + 1);
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

function rejectMatchingTrackedValues(
  repoRoot: string,
  name: string,
  values: Values,
  defaults: Map<string, string>
): void {
  for (const relativeFile of trackedEnvFiles(repoRoot)) {
    const content = readFileSync(path.join(repoRoot, relativeFile), 'utf8');
    const trackedValue = defaults.get(relativeFile) ?? assignmentValue(content, name);
    const matchesRemoteValue = Object.values(values).some(value => trackedValue === value);
    if (matchesRemoteValue) {
      throw new Error(
        `${relativeFile} contains or would contain a remote environment value. Use a non-secret local default instead.`
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
    if (defaults.size === 0) warnAboutMissingTrackedDefault(options.name);
    rejectMatchingTrackedValues(repoRoot, options.name, values, defaults);

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
