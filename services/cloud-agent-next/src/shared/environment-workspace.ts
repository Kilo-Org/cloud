/**
 * Physical workspace layout of a session (plan "Wrapper: one workspace model").
 *
 * The one owner of where the checkouts and the Kilo cwd are. Every consumer asks
 * this module: the registration route directory, the credential grant directory,
 * the snapshot-launch expectation, the environment build and the prepare frame.
 * The logical worktree identity (`metadata.workspace.workspacePath`) is not
 * affected.
 *
 * Shared by the Worker and the wrapper bundle through the build protocol, so it
 * imports nothing Worker-only.
 */

/** The directory an isolated single-session sandbox gives its one checkout. */
export const ISOLATED_CONTAINER_WORKSPACE_PATH = '/workspace/app';
/** The parent of every repository directory of a V2 environment. */
export const WORKSPACE_PARENT_PATH = '/workspace';

/**
 * Whether an environment value is V2: it lists its repositories, one or several.
 * The one place that tells a V2 environment from a V1 one for any consumer that
 * treats the two differently, such as layout, credentials and sandbox allocation.
 */
export function isMultiRepositoryEnvironment<T extends { repositories?: unknown }>(
  environment: T | null | undefined
): environment is T & { repositories: NonNullable<T['repositories']> } {
  return environment?.repositories !== undefined;
}

/** The part of an environment repository that decides where it is checked out. */
type WorkspaceMember = { leaf: string; branch?: string };

export type WorkspaceRoot<Member> = {
  /** The git root: where the repository is cloned. */
  directory: string;
  /**
   * The environment repository checked out here. `null` for a V1 or no-environment
   * workspace, whose one repository is the session's own launch repository.
   */
  repository: Member | null;
  /**
   * The branch of the environment repository checked out here; `undefined` for a V1
   * root. The prepare frame carries it to the wrapper (`ControlPlaneWorkspaceRoot.branch`),
   * where the push rule and the diff base read it.
   */
  branch: string | undefined;
  /** Whether this root is the repository the session launched on. */
  launch: boolean;
};

export type EnvironmentWorkspace<Member> = {
  /** The Kilo cwd and the directory setup runs in. It is the route directory. */
  cwd: string;
  roots: WorkspaceRoot<Member>[];
};

/**
 * A V2 environment checks out under `/workspace`, which is the isolated sandbox's
 * own. A session directory that is not the isolated one belongs to a shared
 * sandbox, where `/workspace` is another session's too. Allocation rejects that
 * combination before a session registers, so reaching this is a broken invariant
 * and it fails loudly rather than clone into a shared directory.
 */
export class NonIsolatedMultiRepositoryWorkspaceError extends Error {
  constructor() {
    super('A multi-repository environment needs an isolated workspace');
    this.name = 'NonIsolatedMultiRepositoryWorkspaceError';
  }
}

/**
 * The layout of a session. `sessionDirectory` is the directory the control plane
 * resolved for the session (`getControlPlaneSessionDirectory`).
 *
 * - V1, or no environment: one root at the session directory, which is the cwd.
 * - V2 with one repository: one root at `/workspace/<leaf>`, which is the cwd.
 * - V2 with several repositories: a root at `/workspace/<leaf>` for each, and the
 *   cwd is `/workspace`.
 *
 * `isLaunch` tells the launch repository among the repositories of a V2
 * environment; without it no V2 root is the launch root.
 */
export function environmentWorkspace<Member extends WorkspaceMember>(input: {
  sessionDirectory: string;
  environment: { repositories?: readonly Member[] | undefined } | null | undefined;
  isLaunch?: (member: Member) => boolean;
}): EnvironmentWorkspace<Member> {
  const { environment } = input;
  if (!isMultiRepositoryEnvironment(environment)) {
    return {
      cwd: input.sessionDirectory,
      roots: [
        {
          directory: input.sessionDirectory,
          repository: null,
          branch: undefined,
          launch: true,
        },
      ],
    };
  }
  if (input.sessionDirectory !== ISOLATED_CONTAINER_WORKSPACE_PATH) {
    throw new NonIsolatedMultiRepositoryWorkspaceError();
  }
  const roots = environment.repositories.map((member): WorkspaceRoot<Member> => ({
    directory: `${WORKSPACE_PARENT_PATH}/${member.leaf}`,
    repository: member,
    branch: member.branch,
    launch: input.isLaunch?.(member) ?? false,
  }));
  const [only] = roots;
  return { cwd: roots.length === 1 && only ? only.directory : WORKSPACE_PARENT_PATH, roots };
}

/** The route directory of a session: `environmentWorkspace(...).cwd`. */
export function environmentWorkspaceDirectory(input: {
  sessionDirectory: string;
  environment: { repositories?: readonly WorkspaceMember[] | undefined } | null | undefined;
}): string {
  return environmentWorkspace(input).cwd;
}

/**
 * Where a root's repository sits below the Kilo cwd, as a path with `/`
 * separators: `''` when the root is the cwd, `web` for `/workspace/web` below
 * `/workspace`. A path that is relative to the cwd (a Kilo diff, a saved
 * worktree change) starts with this prefix; a path relative to the repository
 * does not. The one owner of that conversion for the Worker and the wrapper.
 */
export function rootPathPrefix(cwd: string, directory: string): string {
  if (directory === cwd) return '';
  const parent = cwd.endsWith('/') ? cwd : `${cwd}/`;
  if (!directory.startsWith(parent)) {
    throw new Error('A workspace root is not inside the workspace directory');
  }
  return directory.slice(parent.length);
}

/** A repository-relative path as a path relative to the cwd, given the root's `rootPathPrefix`. */
export function pathBelowCwd(prefix: string, repositoryPath: string): string {
  return prefix === '' ? repositoryPath : `${prefix}/${repositoryPath}`;
}
