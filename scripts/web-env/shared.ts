import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as readline from 'node:readline';
import { Writable } from 'node:stream';

export const PROJECTS = ['kilocode-app', 'kilocode-global-app'] as const;
export const ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export const VAULT = 'Kilo Web ENV Production';
const ONE_PASSWORD_ACCOUNT_URL = 'kilocode.1password.com';
const VERCEL_PACKAGE = 'vercel@53.3.1';
const VERCEL_COMMAND = `pnpm dlx ${VERCEL_PACKAGE}`;
const ONE_PASSWORD_CLI_DOCS = 'https://www.1password.dev/cli/get-started';

export type Project = (typeof PROJECTS)[number];
export type Environment = (typeof ENVIRONMENTS)[number];
export type VercelContext = {
  project: Project;
  orgId: string;
  cwd: string;
};
export type OnePasswordContext = {
  accountId: string;
  vaultId: string;
};
export type VaultEnvironment = Extract<Environment, 'staging' | 'production'>;

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

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

function onePasswordInstallInstructions(): string[] {
  return [
    'Install 1Password CLI (`op`). On macOS with Homebrew: `brew install 1password-cli`.',
    `Linux and manual install options: ${ONE_PASSWORD_CLI_DOCS}`,
    'After installing, verify with `op --version`, then sign in with `op signin`.',
  ];
}

function missingCommandMessage(command: string, args: string[]): string | undefined {
  if (command === 'op') {
    return [
      '1Password CLI (`op`) is not installed or is not on PATH.',
      ...onePasswordInstallInstructions(),
      `Verify access with \`op account list --format=json\`, then \`op vault get "${VAULT}" --account ${ONE_PASSWORD_ACCOUNT_URL} --format=json\`.`,
    ].join('\n');
  }

  if (command === 'pnpm' && args[0] === 'dlx' && args[1]?.startsWith('vercel@')) {
    return [
      'Vercel access checks require pnpm, but `pnpm` is not installed or is not on PATH.',
      'Install pnpm with Corepack (`corepack enable`) or enter the repo dev shell.',
      'Then verify access with `pnpm dlx vercel@53.3.1 whoami --scope kilocode --format=json`.',
    ].join('\n');
  }

  return undefined;
}

// Thrown when a required executable is absent. Its message already carries the
// full install/verify guidance, so callers rethrow it as-is instead of wrapping
// it in a provider-access error (which would repeat the same instructions).
class MissingCommandError extends Error {}

export function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    includeFailureOutput?: boolean;
  } = {}
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });
  if (errorCode(result.error) === 'ENOENT') {
    const message = missingCommandMessage(command, args);
    if (message) throw new MissingCommandError(message);
  }
  if (result.status !== 0) {
    const operation = `${command} ${args.slice(0, 3).join(' ')}`;
    if (command === 'op' || options.includeFailureOutput) {
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

function vercel(
  context: VercelContext | undefined,
  args: string[],
  input?: string,
  options: { includeFailureOutput?: boolean } = {}
): string {
  return run(
    'pnpm',
    [
      'dlx',
      VERCEL_PACKAGE,
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
      includeFailureOutput: options.includeFailureOutput,
    }
  );
}

function vercelAsync(context: VercelContext, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const commandArgs = [
      'dlx',
      VERCEL_PACKAGE,
      ...args,
      '--scope',
      'kilocode',
      '--non-interactive',
      '--no-color',
      '--cwd',
      context.cwd,
    ];
    const child = spawn('pnpm', commandArgs, {
      cwd: context.cwd,
      env: {
        ...process.env,
        VERCEL_ORG_ID: context.orgId,
        VERCEL_PROJECT_ID: context.project,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const capture = (chunk: Buffer, keep: boolean) => {
      outputBytes += chunk.length;
      if (outputBytes > 10 * 1024 * 1024) {
        child.kill();
        fail(
          new Error(
            `pnpm ${commandArgs.slice(0, 3).join(' ')} failed; provider output exceeded 10 MiB.`
          )
        );
        return;
      }
      if (keep) stdout.push(chunk);
    };

    child.stdout.on('data', chunk => capture(Buffer.from(chunk), true));
    child.stderr.on('data', chunk => capture(Buffer.from(chunk), false));
    child.once('error', error => {
      if (errorCode(error) === 'ENOENT') {
        const message = missingCommandMessage('pnpm', commandArgs);
        if (message) {
          fail(new MissingCommandError(message));
          return;
        }
      }
      fail(error);
    });
    child.once('close', status => {
      if (settled) return;
      if (status === 0) {
        settled = true;
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      fail(
        new Error(`pnpm ${commandArgs.slice(0, 3).join(' ')} failed; provider output was redacted.`)
      );
    });
  });
}

function vercelAccessError(error: unknown): Error {
  const details = error instanceof Error ? error.message.trim() : '';
  return new Error(
    [
      'Could not verify Vercel access for the kilocode team.',
      `Run \`${VERCEL_COMMAND} login\` with an account that has access to the kilocode team.`,
      `Verify access with \`${VERCEL_COMMAND} whoami --scope kilocode --format=json\`.`,
      details ? `Vercel reported:\n${details}` : undefined,
    ]
      .filter(Boolean)
      .join('\n')
  );
}

function onePasswordAccessError(error: unknown): Error {
  const details = error instanceof Error ? error.message.trim() : '';
  return new Error(
    [
      `Could not verify 1Password access to the ${VAULT} vault.`,
      ...onePasswordInstallInstructions(),
      `Verify access with \`op account list --format=json\`, then \`op vault get "${VAULT}" --account ${ONE_PASSWORD_ACCOUNT_URL} --format=json\`.`,
      'If verification says the vault is missing or forbidden, ask for access to that vault.',
      details ? `1Password reported:\n${details}` : undefined,
    ]
      .filter(Boolean)
      .join('\n')
  );
}

export function resolveVercelContexts(tempDirectory: string): VercelContext[] {
  let whoami: JsonRecord;
  try {
    whoami = parseJson(
      vercel(undefined, ['whoami', '--format=json'], undefined, { includeFailureOutput: true }),
      'Vercel login'
    );
  } catch (error) {
    if (error instanceof MissingCommandError) throw error;
    throw vercelAccessError(error);
  }
  const team = isRecord(whoami.team) ? whoami.team : undefined;
  const orgId = team ? stringValue(team, 'id') : undefined;
  if (!orgId || stringValue(team ?? {}, 'slug') !== 'kilocode') {
    throw vercelAccessError(
      new Error('The authenticated Vercel account is not scoped to the kilocode team.')
    );
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

export async function redeployLatest(
  context: VercelContext,
  environment: Exclude<Environment, 'development'>
): Promise<string> {
  const response = parseJson(
    await vercelAsync(context, [
      'list',
      context.project,
      '--environment',
      environment,
      '--status',
      'READY',
      '--format=json',
    ]),
    `List ${context.project}/${environment} deployments`
  );
  const deployment = records(response.deployments)[0];
  const url = deployment ? stringValue(deployment, 'url') : undefined;
  if (!url) {
    throw new Error(`No ready deployment found for ${context.project}/${environment}.`);
  }

  return (await vercelAsync(context, ['redeploy', url, '--target', environment])).trim();
}

// setVaultValue streams the secret template to `op` over /dev/fd/3 (see
// runOpWithTemplate), which only exists on Unix. resolveVault calls this so the
// update flow fails before touching any provider; runOpWithTemplate re-checks as
// the authoritative gate in case setVaultValue is ever invoked on its own.
function assertSecureTemplateSupported(): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('1Password updates require macOS or Linux for secure template transport.');
  }
}

export function resolveVault(): OnePasswordContext {
  assertSecureTemplateSupported();
  let accounts: JsonRecord[];
  try {
    accounts = records(JSON.parse(run('op', ['account', 'list', '--format=json'])) as unknown);
  } catch (error) {
    if (error instanceof MissingCommandError) throw error;
    throw onePasswordAccessError(error);
  }
  const account = accounts.find(
    account => stringValue(account, 'url') === ONE_PASSWORD_ACCOUNT_URL
  );
  const accountId = account ? stringValue(account, 'account_uuid') : undefined;
  if (!accountId) {
    throw onePasswordAccessError(
      new Error(`Could not find the 1Password account ${ONE_PASSWORD_ACCOUNT_URL}.`)
    );
  }

  let vault: JsonRecord;
  try {
    vault = parseJson(
      run('op', ['vault', 'get', VAULT, '--account', accountId, '--format=json']),
      'Resolve vault'
    );
  } catch (error) {
    if (error instanceof MissingCommandError) throw error;
    throw onePasswordAccessError(error);
  }
  const vaultId = stringValue(vault, 'id');
  if (!vaultId) {
    throw onePasswordAccessError(new Error(`Could not resolve 1Password vault ${VAULT}.`));
  }
  return { accountId, vaultId };
}

function runOpWithTemplate(args: string[], template: string): Promise<string> {
  assertSecureTemplateSupported();
  return new Promise((resolve, reject) => {
    const operation = `op ${args.slice(0, 3).join(' ')}`;
    const child = spawn('op', args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxOutputBytes = 10 * 1024 * 1024;
    let outputBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const capture = (chunks: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill();
        fail(new Error(`${operation} failed; provider output exceeded 10 MiB.`));
        return;
      }
      chunks.push(chunk);
    };

    if (!child.stdout || !child.stderr) {
      child.kill();
      fail(new Error(`${operation} failed to open output pipes.`));
      return;
    }
    child.stdout.on('data', chunk => capture(stdout, Buffer.from(chunk)));
    child.stderr.on('data', chunk => capture(stderr, Buffer.from(chunk)));
    child.once('error', error => fail(new Error(`${operation} failed:\n${error.message}`)));
    child.once('close', status => {
      if (settled) return;
      if (status === 0) {
        settled = true;
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      const output = Buffer.concat([...stderr, ...stdout])
        .toString('utf8')
        .trim();
      fail(new Error(`${operation} failed${output ? `:\n${output}` : '.'}`));
    });

    const templateInput = child.stdio[3];
    if (!(templateInput instanceof Writable)) {
      child.kill();
      fail(new Error(`${operation} failed to open the secure template pipe.`));
      return;
    }
    templateInput.once('error', error => {
      child.kill();
      fail(new Error(`${operation} failed to write the secure template:\n${error.message}`));
    });
    templateInput.end(template);
  });
}

function findVaultItem(context: OnePasswordContext, name: string): JsonRecord | undefined {
  const items = JSON.parse(
    run('op', [
      'item',
      'list',
      '--vault',
      context.vaultId,
      '--account',
      context.accountId,
      '--format=json',
    ])
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

function vaultPasswordField(environment: VaultEnvironment, value: string): JsonRecord {
  if (environment === 'production') {
    return {
      id: 'password',
      label: 'password',
      type: 'CONCEALED',
      purpose: 'PASSWORD',
      value,
    };
  }
  return {
    id: 'password-staging',
    label: 'password (staging)',
    type: 'CONCEALED',
    value,
  };
}

function findVaultPasswordField(
  fields: JsonRecord[],
  environment: VaultEnvironment
): JsonRecord | undefined {
  const matches = fields.filter(field =>
    environment === 'production' ? field.id === 'password' : field.label === 'password (staging)'
  );
  if (matches.length > 1) {
    throw new Error(`1Password item has more than one ${environment} password field.`);
  }
  return matches[0];
}

export async function setVaultValue(
  context: OnePasswordContext,
  name: string,
  value: string,
  environment: VaultEnvironment
): Promise<void> {
  const note = auditNote();
  const existing = findVaultItem(context, name);
  if (!existing) {
    const item = {
      title: name,
      category: 'PASSWORD',
      fields: [
        vaultPasswordField(environment, value),
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
      await runOpWithTemplate(
        [
          'item',
          'create',
          '--template=/dev/fd/3',
          '--vault',
          context.vaultId,
          '--account',
          context.accountId,
          '--format=json',
        ],
        JSON.stringify(item)
      ),
      `Create ${name}`
    );
    const createdPassword = findVaultPasswordField(records(created.fields), environment);
    const createdNotes = records(created.fields).find(field => field.id === 'notesPlain');
    if (createdPassword?.value !== value || createdNotes?.value !== note) {
      throw new Error(
        `1Password did not persist the new ${name} ${environment} value and audit note.`
      );
    }
    return;
  }

  const id = stringValue(existing, 'id');
  if (!id) throw new Error(`1Password item ${name} has no ID.`);
  const item = parseJson(
    run('op', [
      'item',
      'get',
      id,
      '--vault',
      context.vaultId,
      '--account',
      context.accountId,
      '--format=json',
    ]),
    `Read ${name}`
  );
  const fields = records(item.fields);
  const password = findVaultPasswordField(fields, environment);
  if (password && password.type !== 'CONCEALED') {
    throw new Error(`1Password item ${name} does not have a concealed ${environment} field.`);
  }
  if (password) password.value = value;
  else {
    const itemFields = item.fields;
    if (!Array.isArray(itemFields)) {
      throw new Error('1Password item does not have editable fields.');
    }
    itemFields.push(vaultPasswordField(environment, value));
  }
  setAuditNote(item, note);
  const expectedNotes = stringValue(
    records(item.fields).find(field => field.id === 'notesPlain') ?? {},
    'value'
  );
  const updated = parseJson(
    await runOpWithTemplate(
      [
        'item',
        'edit',
        id,
        '--template=/dev/fd/3',
        '--vault',
        context.vaultId,
        '--account',
        context.accountId,
        '--format=json',
      ],
      JSON.stringify(item)
    ),
    `Update ${name}`
  );
  const updatedPassword = findVaultPasswordField(records(updated.fields), environment);
  const updatedNotes = records(updated.fields).find(field => field.id === 'notesPlain');
  if (updatedPassword?.value !== value || updatedNotes?.value !== expectedNotes) {
    throw new Error(
      `1Password did not persist the updated ${name} ${environment} value and audit note.`
    );
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

/**
 * Strip one matching pair of surrounding quotes. Users often paste dotenv-style
 * values (`"secret"`) into the prompt; those quotes must not be stored in Vercel
 * or `vercel env pull` writes broken / double-quoted assignments.
 */
export function stripSurroundingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }
  return value;
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
