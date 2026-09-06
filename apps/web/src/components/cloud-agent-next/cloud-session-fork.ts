/**
 * Pure decision logic for "continue this session in a new Cloud Agent
 * session" (a cloud-to-cloud fork). The web UI mirrors the mobile Continue
 * flow: the source session's own runtime configuration (repository, model,
 * mode) is copied into a `prepareSession` clone request instead of asking the
 * user to re-pick a destination.
 *
 * This module stays free of tRPC, React, and server-only imports so the
 * derivation rules can be unit tested in isolation.
 */

/** The subset of a cloud session's runtime state this feature reads. */
export type CloudRuntimeConfig = {
  platform?: 'github' | 'gitlab' | 'bitbucket' | (string & {});
  githubRepo?: string;
  gitUrl?: string;
  mode?: string;
  model?: string;
  variant?: string;
  autoCommit?: boolean;
};

export type CloudForkRejectionReason =
  | 'not-a-cloud-session'
  | 'runtime-unavailable'
  | 'missing-model'
  | 'missing-mode'
  | 'invalid-mode'
  | 'missing-repository'
  | 'unsupported-platform'
  | 'unparseable-repository'
  | 'organization-mismatch';

export type CloudForkRepository =
  | { kind: 'github'; fullName: string }
  | { kind: 'gitlab'; projectPath: string };

export type CloudForkFields = {
  mode: string;
  model: string;
  variant?: string;
  autoCommit: boolean;
  repository: CloudForkRepository;
};

export type DeriveCloudSessionForkResult =
  | { ok: true; fields: CloudForkFields }
  | { ok: false; reason: CloudForkRejectionReason };

const MODE_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;
const GITLAB_PROJECT_PATTERN = /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/;

export function deriveCloudSessionForkFields(input: {
  session: { cloud_agent_session_id: string | null };
  runtime: CloudRuntimeConfig | null;
}): DeriveCloudSessionForkResult {
  const { session, runtime } = input;

  if (!session.cloud_agent_session_id) {
    return { ok: false, reason: 'not-a-cloud-session' };
  }

  if (!runtime) {
    return { ok: false, reason: 'runtime-unavailable' };
  }

  if (!runtime.model) {
    return { ok: false, reason: 'missing-model' };
  }

  const mode = runtime.mode;
  if (!mode) {
    return { ok: false, reason: 'missing-mode' };
  }
  if (!MODE_SLUG_PATTERN.test(mode)) {
    return { ok: false, reason: 'invalid-mode' };
  }

  const repository = deriveRepository(runtime);
  if (!repository.ok) {
    return repository;
  }

  return {
    ok: true,
    fields: {
      mode,
      model: runtime.model,
      ...(runtime.variant ? { variant: runtime.variant } : {}),
      autoCommit: runtime.autoCommit ?? false,
      repository: repository.fields,
    },
  };
}

function deriveRepository(
  runtime: CloudRuntimeConfig
): { ok: true; fields: CloudForkRepository } | { ok: false; reason: CloudForkRejectionReason } {
  switch (runtime.platform) {
    case 'github': {
      if (!runtime.githubRepo) {
        return { ok: false, reason: 'missing-repository' };
      }
      return { ok: true, fields: { kind: 'github', fullName: runtime.githubRepo } };
    }
    case 'gitlab': {
      if (!runtime.gitUrl) {
        return { ok: false, reason: 'missing-repository' };
      }
      const projectPath = parseGitLabProjectPath(runtime.gitUrl);
      if (!projectPath) {
        return { ok: false, reason: 'unparseable-repository' };
      }
      return { ok: true, fields: { kind: 'gitlab', projectPath } };
    }
    case 'bitbucket':
      return { ok: false, reason: 'unsupported-platform' };
    default:
      return { ok: false, reason: 'unsupported-platform' };
  }
}

/**
 * Extract the namespace/project path from a GitLab clone URL. Accepts https,
 * ssh://, and SCP-style URLs and strips a trailing `.git` or slash.
 * Returns `null` when the path does not contain at least a `group/project`.
 */
export function parseGitLabProjectPath(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  let path: string;
  const scpStyle = /^[^@/]+@[^:]+:(.+)$/.exec(trimmed);
  if (scpStyle) {
    path = scpStyle[1];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'ssh:') {
      return null;
    }
    path = parsed.pathname.replace(/^\/+/, '');
  }

  const projectPath = path.replace(/\.git$/i, '').replace(/\/+$/, '');
  return GITLAB_PROJECT_PATTERN.test(projectPath) ? projectPath : null;
}

export function cloudForkRejectionMessage(reason: CloudForkRejectionReason): string {
  switch (reason) {
    case 'not-a-cloud-session':
      return 'Only Cloud Agent sessions can be forked to a new Cloud Agent session.';
    case 'runtime-unavailable':
      return 'This session has no saved Cloud Agent configuration to copy.';
    case 'missing-model':
      return 'This session has no model selected to copy.';
    case 'missing-mode':
      return 'This session has no agent mode selected to copy.';
    case 'invalid-mode':
      return "This session's agent mode cannot be reused.";
    case 'missing-repository':
      return 'This session has no repository to copy.';
    case 'unsupported-platform':
      return 'Forking Bitbucket sessions to a new Cloud Agent session is not supported yet.';
    case 'unparseable-repository':
      return "This session's repository cannot be reused.";
    case 'organization-mismatch':
      return 'You can only fork this session inside its own organization.';
  }
}

/** The pieces of a `getWithRuntimeState` result this flow reads. */
export type CloudSessionForkRuntimeStateResult = {
  session: {
    session_id: string;
    cloud_agent_session_id: string | null;
    organization_id: string | null;
  };
  runtimeState: CloudRuntimeConfig | null;
};

/** Input the caller-bound `prepareSession` mutation must accept. */
export type CloudSessionForkCreateInput = {
  mode: string;
  model: string;
  variant?: string;
  autoCommit: boolean;
  cloneFromKiloSessionId: string;
  autoInitiate: true;
  operationKey: string;
  organizationId?: string;
  githubRepo?: string;
  gitlabProject?: string;
};

export type CloudSessionForkDeps = {
  getRuntimeState: (sessionId: string) => Promise<CloudSessionForkRuntimeStateResult>;
  createSession: (input: CloudSessionForkCreateInput) => Promise<{ kiloSessionId: string }>;
};

/** UI glue around `continueInNewCloudSession`: invalidation, navigation, errors. */
export type CloudForkFlowDeps = CloudSessionForkDeps & {
  invalidateSessionQueries: () => Promise<unknown> | unknown;
  navigateToSession: (kiloSessionId: string) => void;
  notifyError: (message: string) => void;
};

/**
 * Run a cloud-to-cloud fork and drive the success UI. Returns `true` when the
 * fork settled and navigation was requested; `false` when the source session
 * cannot be forked (after notifying the user why). Cache invalidation is
 * best-effort — a failure must not block navigation to the new session.
 */
export async function runCloudForkFlow(params: {
  sessionId: string;
  organizationId?: string;
  operationKey: string;
  deps: CloudForkFlowDeps;
}): Promise<boolean> {
  const { deps } = params;
  const result = await continueInNewCloudSession(params);

  if (!result.ok) {
    deps.notifyError(cloudForkRejectionMessage(result.reason));
    return false;
  }

  try {
    await deps.invalidateSessionQueries();
  } catch {
    // A failed cache invalidation is cosmetic; the fork already exists.
  }

  deps.navigateToSession(result.kiloSessionId);
  return true;
}

export type ContinueInNewCloudSessionResult =
  | { ok: true; kiloSessionId: string }
  | { ok: false; reason: CloudForkRejectionReason };

/**
 * Fork a source session into a brand-new Cloud Agent session and return the
 * new session id. The destination is cloned from the source transcript and
 * inherits the source runtime's repository, model, and mode.
 *
 * `organizationId` describes the context the user is acting from: a personal
 * listing passes nothing, an organization listing passes the organization id.
 * A fork must stay inside the source session's own organization, so a context
 * mismatch is rejected before any create call.
 */
export async function continueInNewCloudSession(params: {
  sessionId: string;
  organizationId?: string;
  operationKey: string;
  deps: CloudSessionForkDeps;
}): Promise<ContinueInNewCloudSessionResult> {
  const { sessionId, organizationId, operationKey, deps } = params;
  const { session, runtimeState } = await deps.getRuntimeState(sessionId);

  if (session.organization_id !== (organizationId ?? null)) {
    return { ok: false, reason: 'organization-mismatch' };
  }

  const derived = deriveCloudSessionForkFields({ session, runtime: runtimeState });
  if (!derived.ok) {
    return derived;
  }

  const { fields } = derived;
  const repositoryField =
    fields.repository.kind === 'github'
      ? { githubRepo: fields.repository.fullName }
      : { gitlabProject: fields.repository.projectPath };

  const { kiloSessionId } = await deps.createSession({
    mode: fields.mode,
    model: fields.model,
    ...(fields.variant ? { variant: fields.variant } : {}),
    autoCommit: fields.autoCommit,
    cloneFromKiloSessionId: sessionId,
    autoInitiate: true,
    operationKey,
    ...(organizationId ? { organizationId } : {}),
    ...repositoryField,
  });

  return { ok: true, kiloSessionId };
}

/** Relative chat URL for a session id in the given personal or org context. */
export function buildCloudChatSessionPath(
  organizationId: string | undefined,
  sessionId: string
): string {
  const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
  return `${basePath}/chat?sessionId=${sessionId}`;
}
