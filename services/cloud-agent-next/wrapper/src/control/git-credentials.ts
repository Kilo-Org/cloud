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

/**
 * One repository of a V2 build: the same fields as a host record. The record is
 * qualified by the path of `url`, which is the path Git sends back when
 * `credential.useHttpPath` is true, with its case as the clone URL has it.
 * Only the environment builder writes these, because it holds a real token for
 * each repository; a session writes one record for each host.
 */
export type GitCredentialSetEntry = {
  url: string;
  token: string;
  platform: GitCredentialPlatform | undefined;
};

function credentialSetRecord(entry: GitCredentialSetEntry): string {
  let repositoryUrl: URL;
  try {
    repositoryUrl = new URL(entry.url);
  } catch {
    throw new Error('Repository Git credentials require a valid URL');
  }
  if (repositoryUrl.protocol !== 'https:' || !repositoryUrl.host) {
    throw new Error('Repository Git credentials require an HTTPS URL');
  }
  const username = gitCredentialUsername(entry.platform);
  const recordPath = repositoryUrl.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
  if (recordPath === '') throw new Error('Repository Git credentials require a repository path');
  const values = [entry.token, username, repositoryUrl.host, recordPath];
  if (values.some(value => value.includes('\r') || value.includes('\n') || value.includes('\0'))) {
    throw new Error('Repository Git credentials contain invalid characters');
  }
  return `protocol=https\nhost=${repositoryUrl.host}\npath=${recordPath}\nusername=${username}\npassword=${entry.token}\n`;
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
 * Install the token this route may use for each repository host, or remove a
 * stale record when it has none (a sibling in the same home may have left one).
 * The helper authenticates every later `git fetch`/`push` in the worktree,
 * including the agent's own, so origin can stay credential-free.
 *
 * One record serves one host: the token is the same for every repository of a
 * host, so a V2 environment writes one record for each host it uses and never a
 * record for each repository. A V1 route passes one entry.
 *
 * A workspace remote may legitimately be HTTP or SSH; those carry no credential, so
 * only an HTTPS remote gets a record. `requireGitCredentialRecord` is the strict
 * form for a caller that has already rejected an authenticated non-HTTPS repository.
 */
export async function writeGitCredentialRecords(input: {
  home: string;
  credentials: readonly RepositoryCredential[];
}): Promise<void> {
  const records: string[] = [];
  for (const credential of input.credentials) {
    if (!credential.token) continue;
    try {
      records.push(repositoryCredentialRecord({ ...credential, token: credential.token }));
    } catch {
      // A non-HTTPS remote has no record.
    }
  }
  if (records.length === 0) {
    if (input.credentials.every(credential => !credential.token)) {
      await fs.rm(gitCredentialRecordPath(input.home), { force: true });
    }
    return;
  }
  await replaceCredentialRecord(input.home, records.join('\n'));
}

/**
 * The credentials of the hosts a V2 environment uses besides the launch
 * repository's host, as `writeGitCredentialRecords` takes them.
 */
export function additionalHostCredentials(
  entries:
    | ReadonlyArray<{ url: string; token: string; platform: GitCredentialPlatform }>
    | undefined
): RepositoryCredential[] {
  return (entries ?? []).map(entry => ({
    url: credentialFreeGitUrl(entry.url),
    token: entry.token,
    platform: entry.platform,
  }));
}

export function writeGitCredentialRecord(
  input: RepositoryCredential & { home: string }
): Promise<void> {
  return writeGitCredentialRecords({ home: input.home, credentials: [input] });
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
 * Replace the whole credential set with one path-qualified record per
 * repository, or clear it when none is left. A path query never falls back to a
 * host record, so an empty set must not leave a stale one behind. A renew
 * rewrites the whole file.
 */
export async function writeGitCredentialRecordSet(input: {
  home: string;
  entries: readonly GitCredentialSetEntry[];
}): Promise<void> {
  if (input.entries.length === 0) {
    await clearGitCredentialRecord(input.home);
    return;
  }
  const records = input.entries.map(credentialSetRecord);
  await replaceCredentialRecord(input.home, records.join('\n'));
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
