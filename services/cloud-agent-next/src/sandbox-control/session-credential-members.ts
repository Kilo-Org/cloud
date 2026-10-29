import {
  bitbucketCloneUrl,
  sameRepositoryIdentity,
  type EnvironmentReferenceRepository as EnvironmentMember,
} from '@kilocode/cloud-agent-profile';
import { isMultiRepositoryEnvironment } from '../environment-build/reference.js';
import type { ControlPlaneCredentialRepository } from '../shared/control-plane-protocol.js';
import { launchRepositoryIdentity, memberGitHubAccess } from '../session/environment-launch.js';
import { diagnosticCause } from './diagnostics.js';
import { parseCanonicalBitbucketCloneUrl } from '../types.js';
import type {
  AdditionalScmRepository,
  CredentialRepository,
  ScmGrant,
  SessionCredentialGrant,
} from './session-credentials.js';

/**
 * Credentials of a V2 environment (plan "Access and credentials").
 *
 * A V2 grant keeps the launch repository exactly as a V1 grant does, in the
 * scalar `repository` and `scm`. Every other member of the environment is one
 * entry of `additionalRepositories`, with its own capability. The sandbox holds
 * one alias for each purpose (`github`, `gitlab`, `bitbucket`); every entry of
 * that purpose carries the same alias. The proxy tells the members apart by the
 * request URL, never by the alias.
 */

/** The environment as the credential grant sees it: V2 lists its repositories. */
export type CredentialEnvironment = {
  repositories?: readonly EnvironmentMember[] | undefined;
};

/** The part of a grant that holds its repositories. */
export type GrantRepositories = Pick<
  SessionCredentialGrant,
  'repository' | 'scm' | 'additionalRepositories'
>;

/** One repository of a grant with the capability that serves it. */
export type GrantScmEntry = {
  repository: CredentialRepository;
  scm: ScmGrant;
  /** Index into `additionalRepositories`, or `undefined` for the launch repository. */
  additionalIndex: number | undefined;
};

/** The members of a V2 environment other than the launch repository, in order. */
export function additionalEnvironmentMembers(
  environment: CredentialEnvironment | null | undefined,
  launch: ControlPlaneCredentialRepository | undefined
): EnvironmentMember[] {
  if (!isMultiRepositoryEnvironment(environment)) return [];
  const members = environment.repositories;
  const launchIdentity = launch === undefined ? undefined : launchRepositoryIdentity(launch);
  if (launchIdentity === undefined) {
    throw new Error('A multi-repository session needs a launch repository that is a member');
  }
  const additional = members.filter(
    member => !sameRepositoryIdentity(member.identity, launchIdentity)
  );
  if (additional.length === members.length) {
    throw new Error('The launch repository is not a member of the environment');
  }
  return additional;
}

/**
 * The DO-private credential repository one environment member needs. A GitHub
 * member takes the access of the launch repository (see `memberGitHubAccess`).
 */
export function memberCredentialRepository(
  member: EnvironmentMember,
  launch: ControlPlaneCredentialRepository | undefined
): ControlPlaneCredentialRepository {
  const identity = member.identity;
  switch (identity.platform) {
    case 'github':
      return { type: 'github', repo: member.repoFullName, ...memberGitHubAccess(launch) };
    case 'gitlab':
      return { type: 'gitlab', url: identity.cloneUrl };
    case 'bitbucket':
      return {
        type: 'bitbucket',
        url: bitbucketCloneUrl(member.repoFullName),
        workspaceUuid: identity.workspaceUuid,
        repositoryUuid: identity.repositoryUuid,
      };
  }
}

/**
 * An additional repository whose capability could not be issued or renewed. It
 * names the repository, so the route failure can say which one of the
 * environment failed. The message carries no repository and no secret.
 */
export class EnvironmentMemberCredentialError extends Error {
  constructor(
    readonly repoFullName: string,
    options: { cause: unknown }
  ) {
    super('Environment repository credential is unavailable', options);
    this.name = 'EnvironmentMemberCredentialError';
  }
}

/** The diagnostic stage `failRoute` records for an {@link EnvironmentMemberCredentialError}. */
export function memberCredentialFailureStage(error: EnvironmentMemberCredentialError): string {
  return `member_credential_failed:${diagnosticCause(error.repoFullName).slice(0, 80)}`;
}

/**
 * Resolves the capability of each additional repository. `refresh` issues or
 * renews one capability. The issuances run together, because the Sandbox DO
 * serves credential requests from one queue and each issuance is a service
 * round trip. One failure fails the whole grant. The error names the first
 * failing repository in environment order, whatever order the issuances
 * settled in. A repository reuses the alias of an earlier entry of its purpose, so the
 * sandbox needs one alias for each purpose; the aliases are shared in
 * environment order after every capability has arrived.
 */
export async function resolveAdditionalMembers(input: {
  members: ReadonlyArray<{
    repoFullName: string;
    repository: AdditionalScmRepository['repository'];
  }>;
  launchScm: ScmGrant;
  /** The persisted entries, aligned with `repositories`; the grant check proves the alignment. */
  existing: readonly AdditionalScmRepository[] | undefined;
  refresh: (
    repository: AdditionalScmRepository['repository'],
    existingScm: ScmGrant | undefined
  ) => Promise<ScmGrant>;
}): Promise<AdditionalScmRepository[]> {
  const settled = await Promise.allSettled(
    input.members.map(({ repository }, index) =>
      input.refresh(repository, input.existing?.[index]?.scm)
    )
  );
  const aliases = new Map<ScmGrant['purpose'], string>();
  if (input.launchScm.alias) aliases.set(input.launchScm.purpose, input.launchScm.alias);
  return input.members.map(({ repoFullName, repository }, index) => {
    const result = settled[index];
    if (result?.status === 'rejected') {
      throw new EnvironmentMemberCredentialError(repoFullName, { cause: result.reason });
    }
    const scm = result?.value;
    if (scm === undefined) throw new Error('A capability is missing');
    const shared = aliases.get(scm.purpose);
    if (shared === undefined && scm.alias) aliases.set(scm.purpose, scm.alias);
    return { repository, scm: shared === undefined ? scm : { ...scm, alias: shared } };
  });
}

/** The launch repository first, then the additional members in environment order. */
export function grantScmEntries(grant: GrantRepositories): GrantScmEntry[] {
  const entries: GrantScmEntry[] =
    grant.repository && grant.scm
      ? [{ repository: grant.repository, scm: grant.scm, additionalIndex: undefined }]
      : [];
  for (const [index, entry] of (grant.additionalRepositories ?? []).entries()) {
    entries.push({ ...entry, additionalIndex: index });
  }
  return entries;
}

/** The grant with one entry's capability replaced, in the slot the entry came from. */
export function withEntryScm(
  grant: SessionCredentialGrant,
  additionalIndex: number | undefined,
  scm: ScmGrant
): SessionCredentialGrant {
  if (additionalIndex === undefined) return { ...grant, scm };
  return {
    ...grant,
    additionalRepositories: (grant.additionalRepositories ?? []).map((entry, index) =>
      index === additionalIndex ? { ...entry, scm } : entry
    ),
  };
}

/** Each distinct alias a grant's repositories hold. */
export function grantScmAliases(grant: GrantRepositories): string[] {
  return [
    ...new Set(grantScmEntries(grant).flatMap(entry => (entry.scm.alias ? [entry.scm.alias] : []))),
  ];
}

/**
 * The entry whose capability serves a request. This only routes. Redemption
 * checks the request against the repository that the selected capability is
 * bound to, so a wrong selection fails there and the selector is never the
 * security boundary. Only entries that hold the alias
 * can serve it. The entry whose repository the URL names serves it. A URL that
 * names no member of this alias, such as a GraphQL call or a host the grant does
 * not know, is served by the first entry that holds the alias: the launch
 * repository whenever the alias is the launch repository's.
 */
export function selectScmEntry(
  grant: GrantRepositories,
  credential: string,
  url: URL
): GrantScmEntry | null {
  const holders = grantScmEntries(grant).filter(entry => entry.scm.alias === credential);
  const [first] = holders;
  if (first === undefined) return null;
  // A V1 grant has one entry and never reads the URL.
  if (holders.length === 1) return first;
  let best: { entry: GrantScmEntry; length: number } | undefined;
  for (const entry of holders) {
    const length = repositoryPathMatch(entry, url);
    if (length > 0 && (best === undefined || length > best.length)) best = { entry, length };
  }
  return best?.entry ?? first;
}

/**
 * How much of the request path names this entry's repository, or 0 when it names
 * none. A longer match wins, so a project never takes the request of a project
 * below it.
 */
function repositoryPathMatch(entry: GrantScmEntry, url: URL): number {
  const { repository, scm } = entry;
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname.toLowerCase();
  switch (repository.type) {
    case 'github': {
      const repo = repository.repo.toLowerCase();
      if (host === 'github.com') return prefixMatch(pathname, `/${repo}`, true);
      if (host === 'api.github.com') return prefixMatch(pathname, `/repos/${repo}`, false);
      return 0;
    }
    case 'gitlab': {
      const clone = safeUrl(repository.url);
      if (!clone || host !== clone.hostname.toLowerCase()) return 0;
      const gitPath = clone.pathname.toLowerCase().replace(/\.git$/, '');
      const git = prefixMatch(pathname, gitPath, true);
      if (git > 0 || !scm.gitlab?.projectPath) return git;
      const instance = safeUrl(scm.gitlab.instanceOrigin);
      if (!instance) return 0;
      const base = instance.pathname.replace(/\/+$/, '').toLowerCase();
      return apiProjectMatch(pathname, `${base}/api/v4/projects/`, [
        scm.gitlab.projectPath.toLowerCase(),
      ]);
    }
    case 'bitbucket': {
      const canonical = parseCanonicalBitbucketCloneUrl(repository.url);
      if (!canonical) return 0;
      const workspace = canonical.workspaceSlug.toLowerCase();
      const slug = canonical.repositorySlug.toLowerCase();
      if (host === 'bitbucket.org') return prefixMatch(pathname, `/${workspace}/${slug}`, true);
      if (host === 'api.bitbucket.org') {
        return bitbucketApiMatch(
          pathname,
          [workspace, repository.workspaceUuid],
          [slug, repository.repositoryUuid]
        );
      }
      return 0;
    }
    case 'git':
      return 0;
  }
}

/**
 * The length of `prefix` when `pathname` is that path, or a path below it. Git
 * adds a `.git` suffix to a repository path, so it counts as a boundary only
 * when `gitSuffix` is set.
 */
function prefixMatch(pathname: string, prefix: string, gitSuffix: boolean): number {
  if (!pathname.startsWith(prefix)) return 0;
  const rest = pathname.slice(prefix.length);
  const boundary =
    rest === '' ||
    rest.startsWith('/') ||
    (gitSuffix && (rest === '.git' || rest.startsWith('.git/')));
  return boundary ? prefix.length : 0;
}

/**
 * A GitLab API path names its project as one percent-encoded segment after
 * `projects/`, with `/` as `%2F`. A numeric project id matches no member.
 */
function apiProjectMatch(pathname: string, prefix: string, projectPaths: string[]): number {
  if (!pathname.startsWith(prefix)) return 0;
  const segment = pathname.slice(prefix.length).split('/')[0] ?? '';
  const decoded = safeDecode(segment);
  return decoded !== undefined && projectPaths.includes(decoded)
    ? prefix.length + segment.length
    : 0;
}

/**
 * Bitbucket API paths are `/2.0/repositories/{workspace}/{repository}`. Each
 * segment is the slug or the brace-wrapped UUID, which the CLI sends encoded.
 */
function bitbucketApiMatch(
  pathname: string,
  workspaceNames: string[],
  repositoryNames: string[]
): number {
  const prefix = '/2.0/repositories/';
  if (!pathname.startsWith(prefix)) return 0;
  const [workspace, repository] = pathname.slice(prefix.length).split('/');
  const workspaceName = workspace === undefined ? undefined : safeDecode(workspace);
  const repositoryName = repository === undefined ? undefined : safeDecode(repository);
  if (workspaceName === undefined || repositoryName === undefined) return 0;
  const matches = (value: string, names: string[]) =>
    names.some(name => value === name || value === `{${name}}`);
  return matches(workspaceName, workspaceNames) && matches(repositoryName, repositoryNames)
    ? prefix.length + (workspace?.length ?? 0) + 1 + (repository?.length ?? 0)
    : 0;
}

function safeDecode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Each capability of the additional entries with the alias that replaces it in text. */
export function additionalCredentialReplacements(
  grants: ReadonlyArray<SessionCredentialGrant | undefined>
): Array<[string, string]> {
  return grants.flatMap(grant =>
    (grant?.additionalRepositories ?? []).flatMap(({ scm }) =>
      scm.alias
        ? [scm.capability?.credential, scm.nativeToken].flatMap((token): Array<[string, string]> =>
            token && scm.alias ? [[token, scm.alias]] : []
          )
        : []
    )
  );
}

/**
 * The Git credential of each host other than the launch repository's, for the
 * wrapper to write one record per host. A host is the `gitUrl` host; the alias of
 * a purpose is the same for every repository of that host.
 */
export function additionalGitCredentials(
  grant: GrantRepositories
): Array<{ url: string; token: string; platform: ScmGrant['purpose'] }> {
  const seen = new Set<string>();
  const launchHost = hostOf(grant.scm?.gitUrl);
  if (launchHost !== undefined) seen.add(launchHost);
  const credentials: Array<{ url: string; token: string; platform: ScmGrant['purpose'] }> = [];
  for (const { scm } of grant.additionalRepositories ?? []) {
    const host = hostOf(scm.gitUrl);
    if (host === undefined || seen.has(host) || !scm.alias) continue;
    seen.add(host);
    credentials.push({ url: scm.gitUrl, token: scm.alias, platform: scm.purpose });
  }
  return credentials;
}

function hostOf(url: string | undefined): string | undefined {
  return url === undefined ? undefined : (safeUrl(url)?.host.toLowerCase() ?? undefined);
}
