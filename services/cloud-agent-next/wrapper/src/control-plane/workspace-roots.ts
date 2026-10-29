import type {
  ControlPlaneRouteSpec,
  ControlPlaneSessionCredentialsPayload,
} from '../../../src/shared/control-plane-protocol.js';
import { WrapperBootstrapError } from '../bootstrap-error.js';
import type { WorkspaceInspection } from './workspace-stamp.js';

/**
 * The git roots of a route (plan "Wrapper: one workspace model"). A route has
 * one root at its directory, or, for a V2 environment, the roots its frame
 * lists. Every preparation step that touches git runs once for each root; the
 * route directory is the cwd and is not a git root unless it is the only one.
 */

/** One repository checkout, as the one-directory preparation functions take it. */
export type PrepareRoot = {
  directory: string;
  /** Names the repository in a failure and a progress line; absent for a route with one legacy root. */
  repoFullName: string | undefined;
  /** The route spec narrowed to this root: its directory, remote and branch. */
  spec: ControlPlaneRouteSpec;
};

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The control alias that serves a root's host: the launch repository's own, or
 * the one the grant holds for another host. Without one a root clones with no
 * alias, as a launch repository with no grant does.
 */
function aliasForHost(
  host: string | undefined,
  spec: ControlPlaneRouteSpec,
  credentials: ControlPlaneSessionCredentialsPayload | undefined
): string | undefined {
  if (host === undefined) return undefined;
  if (spec.git && hostOf(spec.git.url) === host) return spec.git.token ?? credentials?.git?.token;
  return credentials?.gitCredentials?.find(entry => hostOf(entry.url) === host)?.token;
}

/**
 * The roots of a route. A frame without `roots` is every V1 frame and any frame
 * an older Worker sent: one root at the route directory, which is what the
 * wrapper always did.
 */
export function prepareRoots(
  spec: ControlPlaneRouteSpec,
  credentials: ControlPlaneSessionCredentialsPayload | undefined
): PrepareRoot[] {
  // Each root has its own branch; the route's belong to the launch repository.
  const { roots, branch: _branch, branchMode: _branchMode, ...route } = spec;
  if (roots === undefined) return [{ directory: spec.directory, repoFullName: undefined, spec }];
  return roots.map(root => {
    const token = aliasForHost(hostOf(root.git.url), spec, credentials);
    return {
      directory: root.directory,
      repoFullName: root.repoFullName,
      spec: {
        ...route,
        directory: root.directory,
        branch: root.branch,
        ...(root.branchMode ? { branchMode: root.branchMode } : {}),
        git: {
          url: root.git.url,
          platform: root.git.platform,
          ...(token ? { token } : {}),
          ...(spec.git?.author ? { author: spec.git.author } : {}),
        },
      },
    };
  });
}

/**
 * A git root of a prepared route, for the steps that run after preparation:
 * auto-commit, the diff and recovery. Unlike `PrepareRoot` it needs no clone
 * URL or credential.
 */
export type RouteRoot = {
  directory: string;
  /** Names the repository in output; absent for a route with one legacy root. */
  repoFullName: string | undefined;
  /**
   * The branch somebody asked this root to check out. Absent for a legacy root
   * and for a root on the session's generated branch, which the frame marks
   * `branchMode: 'working'` by the Worker's `rootBranchMode` rule.
   */
  requestedBranch: string | undefined;
};

/** The roots of a route, one per repository; a route without `roots` has one at its directory. */
export function routeRoots(spec: Pick<ControlPlaneRouteSpec, 'directory' | 'roots'>): RouteRoot[] {
  if (spec.roots === undefined) {
    return [{ directory: spec.directory, repoFullName: undefined, requestedBranch: undefined }];
  }
  return spec.roots.map(root => ({
    directory: root.directory,
    repoFullName: root.repoFullName,
    requestedBranch: root.branchMode === 'working' ? undefined : root.branch,
  }));
}

/**
 * The one test that tells a V2 root from a V1 one: a V2 root names its repository,
 * the one root of a V1 or no-environment route does not (`routeRoots`).
 */
export function isEnvironmentRoot<Root extends { repoFullName: string | undefined }>(
  root: Root
): root is Root & { repoFullName: string } {
  return root.repoFullName !== undefined;
}

/** Whether the roots belong to a V2 environment, each naming its repository. */
export function hasEnvironmentRoots(
  roots: readonly { repoFullName: string | undefined }[]
): boolean {
  return roots.length > 0 && roots.every(isEnvironmentRoot);
}

/** A progress detail that says which repository it is about, when the route has several. */
export function rootProgressDetail(
  root: PrepareRoot,
  detail: string | undefined
): string | undefined {
  if (!isEnvironmentRoot(root)) return detail;
  return detail === undefined ? root.repoFullName : `${root.repoFullName}: ${detail}`;
}

/**
 * The same failure with the repository named in its message, so the log line
 * that ends a preparation says which of several repositories it stopped on. The
 * wire frame keeps its closed step and subtype.
 */
export function nameRepository(root: PrepareRoot, error: unknown): unknown {
  if (!isEnvironmentRoot(root) || !(error instanceof Error)) return error;
  const message = `${root.repoFullName}: ${error.message}`;
  if (!(error instanceof WrapperBootstrapError)) return new Error(message, { cause: error });
  return new WrapperBootstrapError({
    code: error.code,
    ...(error.subtype === undefined ? {} : { subtype: error.subtype }),
    message,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    ...(error.gitFailure === undefined ? {} : { gitFailure: error.gitFailure }),
    retryable: error.retryable,
  });
}

export type RootOperations = {
  inspect: (root: PrepareRoot) => Promise<WorkspaceInspection>;
  /** Reconciles a restored repository with the route; false leaves the caller to clone. */
  adopt: (root: PrepareRoot) => Promise<boolean>;
  /** Removes a root's directory so it can be cloned again. Never the cwd of several roots. */
  empty: (directory: string) => Promise<void>;
  hasGit: (directory: string) => Promise<boolean>;
  /** Clones when there is no repository, then checks out the root's branch. */
  clone: (root: PrepareRoot) => Promise<void>;
  log: (message: string) => void;
};

export type ReconciledRoots = {
  /** What each root's filesystem said before any work, in root order. */
  inspections: WorkspaceInspection[];
} &
  /** Every root has this allocation's stamp: a restart or a sibling session. */
  (
    | { kind: 'same' }
    | {
        kind: 'prepared';
        /** Every root that needed work was adopted from a snapshot; none was cloned. */
        adopted: boolean;
        /** At least one root had no repository and was cloned from scratch. */
        cloning: boolean;
      }
  );

/**
 * Brings every root to a checked-out repository. A root that is `same` is left
 * as it is. A `foreign` one is adopted from a snapshot, and when that fails its
 * directory alone is emptied and it is cloned. The others are cloned when they
 * have no repository and always checked out. A failure stops here, before any
 * setup, and names the repository.
 */
export async function reconcileRoots(
  roots: readonly PrepareRoot[],
  operations: RootOperations
): Promise<ReconciledRoots> {
  const inspections: WorkspaceInspection[] = [];
  for (const root of roots) inspections.push(await operations.inspect(root));
  if (inspections.every(inspection => inspection === 'same')) return { kind: 'same', inspections };
  const needWork = roots.filter((_root, index) => inspections[index] !== 'same');
  const adoptedRoots = new Set<PrepareRoot>();
  for (const [index, root] of roots.entries()) {
    if (inspections[index] !== 'foreign') continue;
    const startedAt = Date.now();
    const adopted = await operations.adopt(root);
    operations.log(
      `control-plane workspace adopt done session=${root.spec.sessionId} adopted=${adopted} elapsedMs=${Date.now() - startedAt}`
    );
    if (adopted) adoptedRoots.add(root);
    else await operations.empty(root.directory);
  }
  let cloning = false;
  for (const root of needWork) {
    if (adoptedRoots.has(root)) continue;
    // A clone happens only when there is no repository yet; a partly prepared
    // workspace is reused, as before.
    if (Boolean(root.spec.git) && !(await operations.hasGit(root.directory))) cloning = true;
    try {
      await operations.clone(root);
    } catch (error) {
      throw nameRepository(root, error);
    }
  }
  return { kind: 'prepared', inspections, adopted: adoptedRoots.size === needWork.length, cloning };
}
