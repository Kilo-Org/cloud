import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseOptions, type Options } from './options.js';
import {
  ENVIRONMENTS,
  PROJECTS,
  confirm,
  findRepoRoot,
  question,
  readSecret,
  redeployLatest,
  resolveVault,
  resolveVercelContexts,
  setEnvDefault,
  setVariable,
  setVaultValue,
  stripSurroundingQuotes,
  trackedEnvFiles,
  type Environment,
} from './shared.js';

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

async function collectValues(
  options: Options,
  environments: readonly Environment[]
): Promise<Partial<Record<Environment, string>>> {
  const values: Partial<Record<Environment, string>> = {};
  for (const environment of environments) {
    const file = options.valueFiles[environment];
    if (file) {
      const value = stripSurroundingQuotes(
        normalizeFileValue(readFileSync(path.resolve(file), 'utf8'))
      );
      if (!value) throw new Error(`${environment} value file cannot be empty.`);
      values[environment] = value;
      continue;
    }

    while (!values[environment]) {
      const value = stripSurroundingQuotes(await readSecret(`${environment} value: `));
      if (value) values[environment] = value;
      else console.warn(`${environment} value cannot be empty. Please try again.`);
    }
  }
  return values;
}

async function collectDefaults(repoRoot: string, name: string): Promise<Map<string, string>> {
  const defaults = new Map<string, string>();
  for (const relativeFile of trackedEnvFiles(repoRoot)) {
    const value = stripSurroundingQuotes(
      await question(`${relativeFile}: default value for ${name} (press Return to skip): `)
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
  values: Partial<Record<Environment, string>>,
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
  const environments: readonly Environment[] = options.only ? [options.only] : ENVIRONMENTS;
  const sensitive = await askSensitivity(options.name);
  const repoRoot = findRepoRoot();
  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'kilo-web-env-'));

  try {
    const updatesProductionVault = sensitive && environments.includes('production');
    console.log(`Checking Vercel${updatesProductionVault ? ' and 1Password' : ''} access...`);
    const contexts = resolveVercelContexts(tempDirectory);
    const vault = updatesProductionVault ? resolveVault() : undefined;
    const values = await collectValues(options, environments);
    const defaults = options.only
      ? new Map<string, string>()
      : await collectDefaults(repoRoot, options.name);
    if (!options.only && defaults.size === 0) warnAboutMissingTrackedDefault(options.name);
    rejectMatchingTrackedValues(repoRoot, options.name, values, defaults);

    console.log('\nPlan');
    for (const environment of environments) {
      const type = sensitive && environment !== 'development' ? 'sensitive' : 'encrypted';
      for (const project of PROJECTS) console.log(`- ${project}/${environment}: ${type}`);
    }
    for (const [file, value] of defaults)
      console.log(`- ${file}: ${options.name}=${JSON.stringify(value)}`);
    console.log(`- 1Password: ${updatesProductionVault ? 'update Production copy' : 'skip'}`);
    console.log('- Deployments: ask after environment updates');

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

    for (const environment of environments) {
      const value = values[environment];
      if (!value) throw new Error(`Missing ${environment} value.`);
      for (const context of contexts) {
        console.log(`Setting ${context.project}/${environment}...`);
        setVariable(context, environment, options.name, value, sensitive);
      }
    }
    if (vault) {
      const productionValue = values.production;
      if (!productionValue) throw new Error('Missing production value.');
      console.log('Updating 1Password Production copy...');
      await setVaultValue(vault, options.name, productionValue);
    }

    const deployableEnvironments = environments.filter(
      (environment): environment is Exclude<Environment, 'development'> =>
        environment !== 'development'
    );
    if (
      deployableEnvironments.length > 0 &&
      (await confirm(
        `\nEnvironment changes only take effect in new deployments. Redeploy ${deployableEnvironments.join(' and ')} now?`
      ))
    ) {
      for (const environment of deployableEnvironments) {
        console.log(`Redeploying ${environment} in both Vercel projects...`);
        const deployments = await Promise.all(
          contexts.map(async context => ({
            project: context.project,
            url: await redeployLatest(context, environment),
          }))
        );
        for (const deployment of deployments) {
          console.log(`- ${deployment.project}: ${deployment.url}`);
        }
      }
    } else if (deployableEnvironments.length > 0) {
      console.log('Deployments skipped; the previous deployments still use the old value.');
    }

    console.log('\nDone. Rerun the same command if a provider failed partway through.');
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Environment update failed.');
  process.exitCode = 1;
});
