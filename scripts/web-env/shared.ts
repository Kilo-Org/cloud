import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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
  orgId: string;
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
    const operation = `${command} ${args.slice(0, 3).join(' ')}`;
    if (command === 'op') {
      const output = [result.stderr, result.stdout, result.error?.message]
        .filter(Boolean)
        .join('\n')
        .trim();
      throw new Error(`${operation} failed${output ? `:\n${output}` : '.'}`);
    }
    throw new Error(`${operation} failed; provider output was redacted.`);
  }
  return result.stdout;
}

function vercel(context: VercelContext | undefined, args: string[], input?: string): string {
  return run(
    'pnpm',
    [
      'dlx',
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
            VERCEL_PROJECT_ID: context.project,
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

  return PROJECTS.map(project => ({ project, orgId, cwd: tempDirectory }));
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
      environment,
      '--force',
      shouldBeSensitive ? '--sensitive' : '--no-sensitive',
      '--yes',
    ],
    value
  );
}

export function resolveVault(): string {
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

const AUDIT_NOTE_PREFIX = 'Managed by pnpm web:env. Last updated by ';

function auditNote(): string {
  return `${AUDIT_NOTE_PREFIX}${os.userInfo().username} on ${os.hostname()} at ${new Date().toISOString()}.`;
}

function setAuditNote(item: JsonRecord, note: string): void {
  const fields = item.fields;
  if (!Array.isArray(fields)) throw new Error('1Password item does not have editable fields.');
  const notes = records(fields).find(field => field.id === 'notesPlain');
  if (!notes) {
    fields.push({
      id: 'notesPlain',
      label: 'notesPlain',
      type: 'STRING',
      purpose: 'NOTES',
      value: note,
    });
    return;
  }
  const existing = stringValue(notes, 'value') ?? '';
  const preserved = existing
    .split('\n')
    .filter(line => !line.startsWith(AUDIT_NOTE_PREFIX))
    .join('\n')
    .trimEnd();
  notes.value = preserved ? `${preserved}\n${note}` : note;
}

export function setVaultValue(vaultId: string, name: string, value: string): void {
  const note = auditNote();
  const existing = findVaultItem(vaultId, name);
  if (!existing) {
    const item = {
      title: name,
      category: 'PASSWORD',
      fields: [
        {
          id: 'password',
          label: 'password',
          type: 'CONCEALED',
          purpose: 'PASSWORD',
          value,
        },
        {
          id: 'notesPlain',
          label: 'notesPlain',
          type: 'STRING',
          purpose: 'NOTES',
          value: note,
        },
      ],
      sections: [],
    };
    const created = parseJson(
      run('op', ['item', 'create', '-', '--vault', vaultId, '--format=json'], {
        input: JSON.stringify(item),
      }),
      `Create ${name}`
    );
    const createdPassword = records(created.fields).find(field => field.id === 'password');
    const createdNotes = records(created.fields).find(field => field.id === 'notesPlain');
    if (createdPassword?.value !== value || createdNotes?.value !== note) {
      throw new Error(`1Password did not persist the new ${name} value and audit note.`);
    }
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
  setAuditNote(item, note);
  const expectedNotes = stringValue(
    records(item.fields).find(field => field.id === 'notesPlain') ?? {},
    'value'
  );
  const updated = parseJson(
    run('op', ['item', 'edit', id, '--vault', vaultId, '--format=json'], {
      input: JSON.stringify(item),
    }),
    `Update ${name}`
  );
  const updatedPassword = records(updated.fields).find(field => field.id === 'password');
  const updatedNotes = records(updated.fields).find(field => field.id === 'notesPlain');
  if (updatedPassword?.value !== value || updatedNotes?.value !== expectedNotes) {
    throw new Error(`1Password did not persist the updated ${name} value and audit note.`);
  }
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
  while (true) {
    const answer = (await question(`${prompt} [y/N] `)).trim().toLowerCase();
    if (!answer || answer === 'n' || answer === 'no') return false;
    if (answer === 'y' || answer === 'yes') return true;
    console.warn('Please answer yes or no.');
  }
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
