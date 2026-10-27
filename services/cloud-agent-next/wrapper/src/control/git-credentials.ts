import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExecResult } from '../utils.js';

/** Managed Git providers the platform can address a repository URL for. */
export type GitCredentialPlatform = 'github' | 'gitlab' | 'bitbucket';

/** Everything a credential record needs, minus the home it belongs to. */
type RepositoryCredential = {
  url: string;
  token: string | undefined;
  platform: GitCredentialPlatform | undefined;
};

/**
 * Where the image's read-only credential helper reads a per-session record:
 * `scripts/kilo-git-credential` resolves `$SESSION_HOME`, else `$HOME`, and matches
 * one `protocol`/`host` pair. The record lives in the runtime home, never in a
 * worktree, so no clone, checkout, diff capture or repository snapshot can carry it.
 */
const CREDENTIAL_RECORD_PATH = '.local/share/kilo/cloud-agent/git-credentials';

/**
 * The URL a worktree may hold. Git stores `remote.origin.url` verbatim, so the
 * platform VCS credential never appears in it: credentials reach git through the
 * pinned helper.
 *
 * Only HTTP(S) userinfo is a secret. An `ssh://git@host/...` remote needs its
 * username to pick the login, so only its password is dropped; SCP-style remotes
 * (`git@host:path`) carry no secret and are returned unchanged.
 */
export function credentialFreeGitUrl(gitUrl: string): string {
  try {
    const url = new URL(gitUrl);
    url.password = '';
    if (url.protocol === 'http:' || url.protocol === 'https:') url.username = '';
    return url.toString();
  } catch {
    return gitUrl;
  }
}

/** True when a remote URL carries a secret in its userinfo; an unparsable URL does not. */
export function gitUrlCarriesCredential(gitUrl: string): boolean {
  try {
    const url = new URL(gitUrl);
    if (url.password !== '') return true;
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username !== '';
  } catch {
    return false;
  }
}

export function gitCredentialUsername(platform: GitCredentialPlatform | undefined): string {
  switch (platform) {
    case 'gitlab':
      return 'oauth2';
    case 'bitbucket':
      return 'x-token-auth';
    case 'github':
    case undefined:
      return 'x-access-token';
  }
}

export function gitCredentialRecordPath(home: string): string {
  return path.join(home, CREDENTIAL_RECORD_PATH);
}

/**
 * The helper record for one repository host. A credential only travels over HTTPS,
 * so any other remote is rejected here rather than written somewhere git could
 * send it as userinfo.
 */
function repositoryCredentialRecord(credential: RepositoryCredential & { token: string }): string {
  let repositoryUrl: URL;
  try {
    repositoryUrl = new URL(credential.url);
  } catch {
    throw new Error('Repository Git credentials require a valid URL');
  }
  if (repositoryUrl.protocol !== 'https:' || !repositoryUrl.host) {
    throw new Error('Repository Git credentials require an HTTPS URL');
  }
  const username = gitCredentialUsername(credential.platform);
  const values = [credential.token, username, repositoryUrl.host];
  if (values.some(value => value.includes('\r') || value.includes('\n') || value.includes('\0'))) {
    throw new Error('Repository Git credentials contain invalid characters');
  }
  return `protocol=https\nhost=${repositoryUrl.host}\nusername=${username}\npassword=${credential.token}\n`;
}

async function replaceCredentialRecord(home: string, record: string): Promise<void> {
  const recordPath = gitCredentialRecordPath(home);
  const directory = path.dirname(recordPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temporaryPath = path.join(directory, `git-credentials.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(record, 'utf8');
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, recordPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Drop the record before a container snapshot and report whether it is verifiably
 * gone. A caller that cannot prove the removal must not let the snapshot run.
 */
export async function clearGitCredentialRecord(home: string): Promise<boolean> {
  const recordPath = gitCredentialRecordPath(home);
  try {
    await fs.rm(recordPath, { force: true });
    await fs.access(recordPath);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Install the token this route may use for its repository host, or remove a stale
 * record when it has none (a sibling in the same home may have left one). The
 * helper authenticates every later `git fetch`/`push` in the worktree, including
 * the agent's own, so origin can stay credential-free.
 *
 * A workspace remote may legitimately be HTTP or SSH; those carry no credential, so
 * only an HTTPS remote gets a record. `requireGitCredentialRecord` is the strict
 * form for a caller that has already rejected an authenticated non-HTTPS repository.
 */
export async function writeGitCredentialRecord(
  input: RepositoryCredential & { home: string }
): Promise<void> {
  if (!input.token) {
    await fs.rm(gitCredentialRecordPath(input.home), { force: true });
    return;
  }
  let record: string;
  try {
    record = repositoryCredentialRecord({ ...input, token: input.token });
  } catch {
    return;
  }
  await replaceCredentialRecord(input.home, record);
}

/**
 * The legacy ready path rejects an authenticated non-HTTPS repository before Git
 * runs, so its record must be built or refuse; a silent skip would let the agent's
 * `git push` fail with an authentication error instead.
 */
export async function requireGitCredentialRecord(
  input: RepositoryCredential & { home: string }
): Promise<void> {
  if (!input.token) {
    await fs.rm(gitCredentialRecordPath(input.home), { force: true });
    return;
  }
  await replaceCredentialRecord(
    input.home,
    repositoryCredentialRecord({ ...input, token: input.token })
  );
}

/**
 * Replace a credential-bearing `origin` with the same URL minus its userinfo. A
 * workspace prepared before the credential record existed, or one the agent
 * pointed at a token URL itself, is migrated here; a credential-free origin (a
 * fork the agent chose) is left alone. Never throws: the caller decides how loud
 * a failure is.
 */
export async function normalizeOriginCredential(input: {
  git: (args: string[]) => Promise<ExecResult>;
  directory: string;
}): Promise<'clean' | 'rewritten' | 'absent' | 'failed'> {
  const current = await input.git(['remote', 'get-url', 'origin']).catch(() => undefined);
  if (!current) return 'failed';
  if (current.exitCode !== 0) return 'absent';
  const origin = current.stdout.trim();
  if (!gitUrlCarriesCredential(origin)) return 'clean';
  const rewritten = await input
    .git(['remote', 'set-url', 'origin', credentialFreeGitUrl(origin)])
    .catch(() => undefined);
  return rewritten?.exitCode === 0 ? 'rewritten' : 'failed';
}
