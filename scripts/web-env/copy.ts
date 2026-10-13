import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CopyOptions } from './options.js';
import {
  ENVIRONMENTS,
  confirm,
  customEnvironmentId,
  decryptedEnvValues,
  integrationSlugs,
  listEnvRecords,
  readVaultValues,
  resolveVault,
  resolveVercelContexts,
  setVariable,
  type EnvRecord,
  type Environment,
  type VaultValues,
} from './shared.js';

type PlannedVariable = {
  name: string;
  sensitive: boolean;
  recordId: string;
  plainValue?: string;
};

type SkippedVariable = { name: string; reason: string };

type EnvironmentPlan = {
  variables: PlannedVariable[];
  skipped: SkippedVariable[];
};

const COPYABLE_TYPES = new Set(['plain', 'encrypted', 'sensitive']);

// `staging` is a Vercel custom environment, so its records are matched by ID
// rather than by the standard `target` list. Integration-owned records are left
// to the integration, which manages them per project.
export function planEnvironment(
  records: readonly EnvRecord[],
  environment: Environment,
  stagingId: string | undefined,
  exclude: ReadonlySet<string>,
  integrations: ReadonlyMap<string, string>
): EnvironmentPlan {
  const variables: PlannedVariable[] = [];
  const skipped: SkippedVariable[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    const applies =
      environment === 'staging'
        ? stagingId !== undefined && record.customEnvironmentIds.includes(stagingId)
        : record.target.includes(environment);
    if (!applies) continue;

    if (record.gitBranch) {
      skipped.push({ name: record.key, reason: `only applies to branch ${record.gitBranch}` });
      continue;
    }
    if (seen.has(record.key)) {
      throw new Error(`${record.key} is defined more than once for ${environment}.`);
    }
    seen.add(record.key);

    if (record.configurationId) {
      const integration = integrations.get(record.configurationId) ?? record.configurationId;
      skipped.push({
        name: record.key,
        reason: `managed by the ${integration} integration; add the project to it instead`,
      });
    } else if (exclude.has(record.key)) {
      skipped.push({ name: record.key, reason: 'excluded with --exclude' });
    } else if (!COPYABLE_TYPES.has(record.type)) {
      skipped.push({ name: record.key, reason: `unsupported Vercel type ${record.type}` });
    } else {
      variables.push({
        name: record.key,
        sensitive: record.type === 'sensitive',
        recordId: record.id,
        plainValue: record.type === 'plain' ? record.value : undefined,
      });
    }
  }

  const byName = (left: { name: string }, right: { name: string }) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  return { variables: variables.sort(byName), skipped: skipped.sort(byName) };
}

type ResolvedVariable = { name: string; sensitive: boolean; value: string };

function resolveValues(
  sourceProject: string,
  plan: EnvironmentPlan,
  decryptedValues: ReadonlyMap<string, string>,
  vaultValues: ReadonlyMap<string, string>
): { resolved: ResolvedVariable[]; missing: SkippedVariable[] } {
  const resolved: ResolvedVariable[] = [];
  const missing: SkippedVariable[] = [];
  for (const variable of plan.variables) {
    const value = variable.sensitive
      ? vaultValues.get(variable.name)
      : (variable.plainValue ?? decryptedValues.get(variable.recordId));
    if (value) {
      resolved.push({ name: variable.name, sensitive: variable.sensitive, value });
    } else if (value === '') {
      missing.push({ name: variable.name, reason: `empty in ${sourceProject}` });
    } else {
      missing.push({
        name: variable.name,
        reason: variable.sensitive
          ? 'sensitive in Vercel and missing from 1Password'
          : 'Vercel did not decrypt the value',
      });
    }
  }
  return { resolved, missing };
}

function printList(title: string, entries: readonly SkippedVariable[]): void {
  if (entries.length === 0) return;
  console.log(`  ${title}:`);
  for (const entry of entries) console.log(`  - ${entry.name}: ${entry.reason}`);
}

export async function runCopy(options: CopyOptions): Promise<void> {
  const environments: readonly Environment[] = options.only ? [options.only] : ENVIRONMENTS;
  const exclude = new Set(options.exclude);
  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'kilo-web-env-'));

  try {
    console.log('Checking Vercel access...');
    const { contexts, missingProjects } = resolveVercelContexts(tempDirectory);
    for (const project of [options.from, options.to]) {
      if (missingProjects.includes(project)) {
        throw new Error(`The Vercel project ${project} does not exist yet.`);
      }
    }
    const source = contexts.find(context => context.project === options.from);
    const destination = contexts.find(context => context.project === options.to);
    if (!source || !destination) throw new Error('Could not resolve the Vercel projects.');

    const stagingIds = environments.includes('staging')
      ? {
          source: customEnvironmentId(source, 'staging'),
          destination: customEnvironmentId(destination, 'staging'),
        }
      : undefined;
    if (stagingIds && !stagingIds.source) {
      throw new Error(`${options.from} has no staging custom environment.`);
    }
    if (stagingIds && !stagingIds.destination) {
      throw new Error(
        `${options.to} has no staging custom environment. Create it in Vercel, or pass --only.`
      );
    }

    console.log(`Reading ${options.from} environment variables...`);
    const records = listEnvRecords(source);
    const integrations = integrationSlugs(
      source,
      records.flatMap(record => (record.configurationId ? [record.configurationId] : []))
    );
    const plans = new Map(
      environments.map(environment => [
        environment,
        planEnvironment(records, environment, stagingIds?.source, exclude, integrations),
      ])
    );

    const sensitiveNames = [...plans].flatMap(([environment, plan]) =>
      environment === 'development'
        ? []
        : plan.variables.filter(variable => variable.sensitive).map(variable => variable.name)
    );
    let vaultValues = new Map<string, VaultValues>();
    if (sensitiveNames.length > 0) {
      console.log('Reading sensitive values from 1Password...');
      vaultValues = readVaultValues(resolveVault(), sensitiveNames);
    }

    console.log('Decrypting non-sensitive values...');
    const decryptedValues = await decryptedEnvValues(
      source,
      [...plans.values()].flatMap(plan =>
        plan.variables
          .filter(variable => !variable.sensitive && variable.plainValue === undefined)
          .map(variable => variable.recordId)
      )
    );

    const resolvedPlans = new Map<
      Environment,
      { resolved: ResolvedVariable[]; missing: SkippedVariable[]; skipped: SkippedVariable[] }
    >();
    for (const [environment, plan] of plans) {
      const environmentVaultValues = new Map<string, string>();
      if (environment !== 'development') {
        for (const [name, values] of vaultValues) {
          const value = values[environment];
          if (value) environmentVaultValues.set(name, value);
        }
      }
      resolvedPlans.set(environment, {
        ...resolveValues(options.from, plan, decryptedValues, environmentVaultValues),
        skipped: plan.skipped,
      });
    }

    console.log(`\nPlan: copy ${options.from} to ${options.to}`);
    for (const [environment, plan] of resolvedPlans) {
      const sensitiveCount = plan.resolved.filter(variable => variable.sensitive).length;
      console.log(
        `- ${environment}: set ${plan.resolved.length} variables (${sensitiveCount} sensitive, from 1Password)`
      );
      printList('Not copied, value unavailable', plan.missing);
      printList('Skipped', plan.skipped);
    }
    console.log('- Deployments: not redeployed; the next deploy picks up the new values');

    if (options.dryRun) {
      console.log('\nDry run complete; nothing changed.');
      return;
    }
    if (!(await confirm(`\nApply these changes to ${options.to}?`))) {
      console.log('Cancelled; nothing changed.');
      return;
    }

    for (const [environment, plan] of resolvedPlans) {
      for (const variable of plan.resolved) {
        console.log(`Setting ${options.to}/${environment} ${variable.name}...`);
        setVariable(destination, environment, variable.name, variable.value, variable.sensitive);
      }
    }

    if ([...resolvedPlans.values()].some(plan => plan.missing.length > 0)) {
      console.log(
        `\nSet the variables listed under "Not copied" with \`pnpm web:env set VARIABLE\`, which also stores sensitive values in 1Password.`
      );
    }
    console.log('\nDone. Rerun the same command if a provider failed partway through.');
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}
