import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';

export const PROJECTS = ['kilocode-app', 'kilocode-global-app'] as const;
export const ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export const VAULT = 'Kilo Web ENV Production';

export type Project = (typeof PROJECTS)[number];
export type Environment = (typeof ENVIRONMENTS)[number];
export type Values = Record<Environment, string>;
export type VercelContext = {
  project: Project;
  projectId: string;
  orgId: string;
  stagingId: string;
  cwd: string;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(value: string, operation: string): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) return parsed;
  } catch {
    // The provider output is intentionally omitted because it may contain secrets.
  }
  throw new Error(`${operation} returned an unexpected response.`);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(record: JsonRecord, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] : undefined;
}

export function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.slice(0, 3).join(' ')} failed; provider output was redacted.`
    );
  }
  return result.stdout;
}

function vercel(
  context: Pick<VercelContext, 'cwd' | 'orgId' | 'projectId'> | undefined,
  args: string[],
  input?: string
): string {
  return run(
    'pnpm',
    [
      'dlx',
      '--yes',
      'vercel@53.3.1',
      ...args,
      '--scope',
      'kilocode',
      '--non-interactive',
      '--no-color',
      ...(context ? ['--cwd', context.cwd] : []),
    ],
    {
      cwd: context?.cwd,
      env: context
        ? {
            ...process.env,
            VERCEL_ORG_ID: context.orgId,
            VERCEL_PROJECT_ID: context.projectId,
          }
        : process.env,
      input,
    }
  );
}

export function resolveVercelContexts(tempDirectory: string): VercelContext[] {
  const whoami = parseJson(vercel(undefined, ['whoami', '--format=json']), 'Vercel login');
  const team = isRecord(whoami.team) ? whoami.team : undefined;
  const orgId = team ? stringValue(team, 'id') : undefined;
  if (!orgId || stringValue(team ?? {}, 'slug') !== 'kilocode') {
    throw new Error('Sign in to the kilocode Vercel team with `vercel login`.');
  }

  return PROJECTS.map(project => {
    const projectList = parseJson(
      vercel(undefined, ['project', 'list', '--filter', project, '--format=json']),
      `Resolve ${project}`
    );
    const match = records(projectList.projects).find(candidate => candidate.name === project);
    const projectId = match ? stringValue(match, 'id') : undefined;
    if (!projectId) throw new Error(`Could not resolve Vercel project ${project}.`);

    const base = { project, projectId, orgId, cwd: tempDirectory };
    const targetList = parseJson(vercel(base, ['target', 'list', '--format=json']), 'List targets');
    const staging = records(targetList.targets).find(candidate => candidate.slug === 'staging');
    const stagingId = staging ? stringValue(staging, 'id') : undefined;
    if (!stagingId) throw new Error(`${project} does not have a custom staging environment.`);
    return { ...base, stagingId };
  });
}

function target(context: VercelContext, environment: Environment): string {
  return environment === 'staging' ? context.stagingId : environment;
}

export function listVariables(
  context: VercelContext,
  environment: Environment
): Map<string, string> {
  const response = parseJson(
    vercel(context, ['env', 'list', target(context, environment), '--format=json']),
    `List ${context.project}/${environment}`
  );
  return new Map(
    records(response.envs)
      .map(variable => [stringValue(variable, 'key'), stringValue(variable, 'type')] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1]))
  );
}

export function setVariable(
  context: VercelContext,
  environment: Environment,
  name: string,
  value: string,
  sensitive: boolean
): void {
  const shouldBeSensitive = sensitive && environment !== 'development';
  vercel(
    context,
    [
      'env',
      'add',
      name,
      target(context, environment),
      '--force',
      shouldBeSensitive ? '--sensitive' : '--no-sensitive',
      '--yes',
    ],
    value
  );
  const type = listVariables(context, environment).get(name);
  const expected = shouldBeSensitive ? 'sensitive' : 'encrypted';
  if (type !== expected) {
    throw new Error(
      `${context.project}/${environment} has type ${type ?? 'missing'}, expected ${expected}.`
    );
  }
}

export function pullValue(
  context: VercelContext,
  environment: Environment,
  name: string
): string | undefined {
  const endpoint = `/v3/env/pull/${encodeURIComponent(context.projectId)}/${encodeURIComponent(target(context, environment))}?source=vercel-cli%3Aenv%3Apull`;
  const response = parseJson(vercel(context, ['api', endpoint, '--raw']), 'Pull Vercel values');
  const values = isRecord(response.env) ? response.env : undefined;
  return values && typeof values[name] === 'string' ? values[name] : undefined;
}

export function resolveVault(): string {
  run('op', ['whoami', '--format=json']);
  const vault = parseJson(run('op', ['vault', 'get', VAULT, '--format=json']), 'Resolve vault');
  const vaultId = stringValue(vault, 'id');
  if (!vaultId) throw new Error(`Could not resolve 1Password vault ${VAULT}.`);
  return vaultId;
}

function findVaultItem(vaultId: string, name: string): JsonRecord | undefined {
  const items = JSON.parse(
    run('op', ['item', 'list', '--vault', vaultId, '--format=json'])
  ) as unknown;
  const matches = records(items).filter(item => item.title === name);
  if (matches.length > 1) throw new Error(`More than one 1Password item is named ${name}.`);
  return matches[0];
}

export function setVaultValue(vaultId: string, name: string, value: string): void {
  const existing = findVaultItem(vaultId, name);
  if (!existing) {
    const item = {
      title: name,
      category: 'PASSWORD',
      fields: [{ id: 'password', label: 'password', type: 'CONCEALED', value }],
    };
    run('op', ['item', 'create', '--vault', vaultId, '--format=json', '-'], {
      input: JSON.stringify(item),
    });
    return;
  }

  const id = stringValue(existing, 'id');
  if (!id) throw new Error(`1Password item ${name} has no ID.`);
  const item = parseJson(
    run('op', ['item', 'get', id, '--vault', vaultId, '--format=json']),
    `Read ${name}`
  );
  const password = records(item.fields).find(field => field.id === 'password');
  if (!password || password.type !== 'CONCEALED') {
    throw new Error(`1Password item ${name} does not have a concealed password field.`);
  }
  password.value = value;
  run('op', ['item', 'edit', id, '--vault', vaultId, '--format=json'], {
    input: JSON.stringify(item),
  });
}

export function findRepoRoot(): string {
  let directory = process.cwd();
  while (path.dirname(directory) !== directory) {
    const packageFile = path.join(directory, 'package.json');
    if (existsSync(packageFile)) {
      const packageJson = JSON.parse(readFileSync(packageFile, 'utf8')) as { name?: string };
      if (packageJson.name === 'kilocode-monorepo') return directory;
    }
    directory = path.dirname(directory);
  }
  throw new Error('Run this command inside the kilocode-monorepo checkout.');
}

export function trackedEnvFiles(repoRoot: string): string[] {
  return run('git', ['ls-files', '-z', '--', '.env*', 'apps/web/.env*'], { cwd: repoRoot })
    .split('\0')
    .filter(file => {
      if (!file) return false;
      const inScope = !file.includes('/') || file.startsWith('apps/web/');
      const basename = path.basename(file);
      return (
        inScope &&
        basename.startsWith('.env') &&
        basename !== '.envrc' &&
        (!basename.includes('.local') || basename.includes('.example'))
      );
    });
}

export function setEnvDefault(file: string, name: string, value: string): void {
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const matches = lines.flatMap((line, index) =>
    new RegExp(`^${name}=`).test(line) ? [index] : []
  );
  if (matches.length > 1) throw new Error(`${file} declares ${name} more than once.`);
  const assignment = `${name}=${JSON.stringify(value)}`;
  if (matches.length === 1) lines[matches[0] ?? 0] = assignment;
  else lines.push(assignment);
  writeFileSync(file, lines.join('\n'));
}

export function question(prompt: string): Promise<string> {
  const interface_ = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    interface_.question(prompt, answer => {
      interface_.close();
      resolve(answer);
    });
  });
}

export async function confirm(prompt: string): Promise<boolean> {
  return ['y', 'yes'].includes((await question(`${prompt} [y/N] `)).trim().toLowerCase());
}

export function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Secret prompts require an interactive terminal; use the --*-file options instead.'
    );
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish();
          reject(new Error('Cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (character === '\u007f') value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}
