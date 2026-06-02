import { constants } from 'fs';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import type { WrapperCommitCoAuthor } from '../../src/shared/wrapper-bootstrap.js';
import { git } from './utils.js';

const GIT_CONFIG_TIMEOUT_MS = 30_000;
const MANAGED_HOOKS_DIRECTORY_NAME = 'kilo-managed-hooks';
const MANAGED_STATE_FILENAME = 'state.json';
const COMMIT_TRAILER_FILENAME = 'co-author-trailer';
const CO_AUTHOR_EMAIL_FILENAME = 'co-author-email';
const MANAGED_HOOK_MARKER = '# Kilo managed commit co-author hook';
const GIT_HOOK_NAMES = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'p4-changelist',
  'p4-prepare-changelist',
  'p4-post-changelist',
  'p4-pre-submit',
  'post-index-change',
] as const;

type ManagedHookState = {
  originalHooksDirectory: string;
};

function validCommitCoAuthor(commitCoAuthor: WrapperCommitCoAuthor): boolean {
  return (
    !/[\r\n<>]/.test(commitCoAuthor.name) &&
    !/[\r\n<>]/.test(commitCoAuthor.email) &&
    commitCoAuthor.email.trim() === commitCoAuthor.email
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function gitDirectoryForWorkspace(workspacePath: string): Promise<string | null> {
  try {
    const result = await git(['rev-parse', '--absolute-git-dir'], {
      cwd: workspacePath,
      timeoutMs: GIT_CONFIG_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return null;
    const directory = result.stdout.trim();
    return directory.length > 0 ? directory : null;
  } catch {
    return null;
  }
}

async function effectiveHooksDirectory(workspacePath: string): Promise<string> {
  const result = await git(['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], {
    cwd: workspacePath,
    timeoutMs: GIT_CONFIG_TIMEOUT_MS,
  });
  const directory = result.stdout.trim();
  if (result.exitCode !== 0 || directory.length === 0) {
    throw new Error('Failed to resolve git hooks directory');
  }
  return directory;
}

async function readManagedState(statePath: string): Promise<ManagedHookState | null> {
  try {
    const value: unknown = JSON.parse(await readFile(statePath, 'utf8'));
    if (typeof value !== 'object' || value === null) return null;
    if (!('originalHooksDirectory' in value) || typeof value.originalHooksDirectory !== 'string') {
      return null;
    }
    return { originalHooksDirectory: value.originalHooksDirectory };
  } catch {
    return null;
  }
}

async function executableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function delegatedHookScript(originalHookPath: string): string {
  return [
    '#!/bin/sh',
    MANAGED_HOOK_MARKER,
    `original_hook=${shellQuote(originalHookPath)}`,
    'if [ -x "$original_hook" ]; then',
    '  exec "$original_hook" "$@"',
    'fi',
    'exit 0',
    '',
  ].join('\n');
}

function prepareCommitMessageHookScript(
  originalHookPath: string,
  trailerPath: string,
  coAuthorEmailPath: string
): string {
  return [
    '#!/bin/sh',
    MANAGED_HOOK_MARKER,
    'set -eu',
    `original_hook=${shellQuote(originalHookPath)}`,
    'if [ -x "$original_hook" ]; then',
    '  "$original_hook" "$@"',
    'fi',
    `co_author_email_file=${shellQuote(coAuthorEmailPath)}`,
    'co_author_email="$(cat "$co_author_email_file")"',
    'author_ident="$(git var GIT_AUTHOR_IDENT 2>/dev/null || true)"',
    'case "$author_ident" in',
    '  *"<$co_author_email>"*) exit 0 ;;',
    'esac',
    `trailer_file=${shellQuote(trailerPath)}`,
    'trailer="$(cat "$trailer_file")"',
    'if ! grep -Fqx -- "$trailer" "$1"; then',
    '  printf "\\n%s\\n" "$trailer" >> "$1"',
    'fi',
    '',
  ].join('\n');
}

async function installManagedHooks(
  managedHooksDirectory: string,
  state: ManagedHookState,
  trailer: string,
  coAuthorEmail: string
): Promise<void> {
  const trailerPath = join(managedHooksDirectory, COMMIT_TRAILER_FILENAME);
  const coAuthorEmailPath = join(managedHooksDirectory, CO_AUTHOR_EMAIL_FILENAME);
  await mkdir(managedHooksDirectory, { recursive: true });
  await writeFile(join(managedHooksDirectory, MANAGED_STATE_FILENAME), JSON.stringify(state));
  await writeFile(trailerPath, `${trailer}\n`);
  await writeFile(coAuthorEmailPath, `${coAuthorEmail}\n`);

  for (const hookName of GIT_HOOK_NAMES) {
    const originalHookPath = join(state.originalHooksDirectory, hookName);
    const managedHookPath = join(managedHooksDirectory, hookName);
    if (hookName === 'prepare-commit-msg') {
      await writeFile(
        managedHookPath,
        prepareCommitMessageHookScript(originalHookPath, trailerPath, coAuthorEmailPath)
      );
      await chmod(managedHookPath, 0o755);
      continue;
    }
    if (hookName === 'fsmonitor-watchman' && !(await executableFile(originalHookPath))) {
      await rm(managedHookPath, { force: true });
      continue;
    }
    await writeFile(managedHookPath, delegatedHookScript(originalHookPath));
    await chmod(managedHookPath, 0o755);
  }
}

export async function configureCommitCoAuthorHook(
  workspacePath: string,
  commitCoAuthor: WrapperCommitCoAuthor | undefined
): Promise<void> {
  const gitDirectory = await gitDirectoryForWorkspace(workspacePath);
  if (!gitDirectory) {
    if (commitCoAuthor) {
      throw new Error('Cannot configure commit co-author outside a git workspace');
    }
    return;
  }

  if (!commitCoAuthor) return;
  if (!validCommitCoAuthor(commitCoAuthor)) {
    throw new Error('Invalid commit co-author identity');
  }

  const managedHooksDirectory = join(gitDirectory, MANAGED_HOOKS_DIRECTORY_NAME);
  const statePath = join(managedHooksDirectory, MANAGED_STATE_FILENAME);
  const existingState = await readManagedState(statePath);
  const currentHooksDirectory = await effectiveHooksDirectory(workspacePath);
  let state: ManagedHookState;

  if (currentHooksDirectory === managedHooksDirectory) {
    if (!existingState) {
      throw new Error('Managed git hook state is missing');
    }
    state = existingState;
  } else {
    if (existingState) {
      await rm(managedHooksDirectory, { recursive: true, force: true });
    }
    state = {
      originalHooksDirectory: currentHooksDirectory,
    };
  }

  const trailer = `Co-authored-by: ${commitCoAuthor.name} <${commitCoAuthor.email}>`;
  await installManagedHooks(managedHooksDirectory, state, trailer, commitCoAuthor.email);
  if (currentHooksDirectory !== managedHooksDirectory) {
    const result = await git(['config', '--local', 'core.hooksPath', managedHooksDirectory], {
      cwd: workspacePath,
      timeoutMs: GIT_CONFIG_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error('Failed to configure git commit co-author hooks');
    }
  }
}
