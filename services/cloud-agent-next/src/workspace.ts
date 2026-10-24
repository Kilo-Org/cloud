import {
  cloudAgentWorktreeIdSchema,
  type CloudAgentWorktreeId,
} from '@kilocode/session-ingest-contracts';

import { resolveSandboxIdClass, type SandboxKind } from './sandbox-placement.js';

/**
 * Sanitize a string for use in filesystem paths by replacing forbidden characters with dashes.
 * This handles user IDs that may contain characters like `/` or `:` (e.g., `oauth/google:1234`).
 */
export function sanitizeIdForPath(value: string): string {
  return value.replace(/[/:]/g, '-');
}

export const ISOLATED_CONTAINER_WORKSPACE_PATH = '/workspace/app';

const FORBIDDEN_PATH_SEGMENTS = new Set(['.', '..']);

/** Ids we generate ourselves: UUIDs and `workspace_<uuid>` session ids. */
const GENERATED_ID_SEGMENT = /^[A-Za-z0-9._-]+$/;

function invalidSegment(label: string): Error {
  return new Error(`Refusing to build a workspace path from an invalid ${label}`);
}

export function isGeneratedIdPathSegment(value: string): boolean {
  return GENERATED_ID_SEGMENT.test(value) && !FORBIDDEN_PATH_SEGMENTS.has(value);
}

/**
 * Build one path segment from a user id.
 *
 * A blank segment does not fail loudly, it collapses: an empty `userId` turns
 * `/workspace/<orgId>//sessions/<sessionId>` into
 * `/workspace/<orgId>/sessions/<sessionId>`, which looks plausible, does not
 * exist on disk, and falls outside the `external_directory` allowlist we derive
 * from the same workspace path. Reject the input instead of handing a silently
 * wrong root to the sandbox.
 *
 * User ids legitimately contain `/` and `:` (e.g. `oauth/google:1234`), so they
 * are rewritten rather than rejected.
 */
function requireUserIdPathSegment(userId: string | undefined): string {
  const sanitized = sanitizeIdForPath(userId?.trim() ?? '');
  if (!sanitized || FORBIDDEN_PATH_SEGMENTS.has(sanitized)) {
    throw invalidSegment('userId');
  }
  return sanitized;
}

/**
 * Build one path segment from an id we generate.
 *
 * Reject rather than rewrite, so the same id renders identically everywhere it
 * is used. Rewriting would let `getSessionWorkspacePath` and
 * `getSessionHomePath` disagree about one session: a session id of `x/y` would
 * yield the segment `x-y` in the workspace path and the directory `/home/x/y`
 * for the session home.
 */
function requireGeneratedIdPathSegment(value: string | undefined, label: string): string {
  if (value === undefined || !isGeneratedIdPathSegment(value)) {
    throw invalidSegment(label);
  }
  return value;
}

export function getBaseWorkspacePath(
  kilocodeOrganizationId: string | null | undefined,
  userId: string
): string {
  const safeUserId = requireUserIdPathSegment(userId);
  // Only an absent org id means "personal". A supplied-but-unusable value is
  // upstream corruption, and routing it here would silently place an org
  // session's workspace, allowlist, and cleanup root in the personal namespace.
  // `null` is accepted alongside `undefined` because absence is what it encodes:
  // the metadata schemas use `z.string().optional()`, which rejects `null` today,
  // but a future `nullish()` must not turn every personal session into a throw.
  if (kilocodeOrganizationId === null || kilocodeOrganizationId === undefined) {
    return `/workspace/${safeUserId}`;
  }
  return `/workspace/${requireGeneratedIdPathSegment(kilocodeOrganizationId, 'organization id')}/${safeUserId}`;
}

export function getSessionWorkspacePath(
  kilocodeOrganizationId: string | null | undefined,
  userId: string,
  sessionId: string
): string {
  const safeSessionId = requireGeneratedIdPathSegment(sessionId, 'session id');
  return `${getBaseWorkspacePath(kilocodeOrganizationId, userId)}/sessions/${safeSessionId}`;
}

export function getWorktreeWorkspacePath(
  kilocodeOrganizationId: string | null | undefined,
  userId: string,
  worktreeId: CloudAgentWorktreeId
): string {
  const parsed = cloudAgentWorktreeIdSchema.safeParse(worktreeId);
  if (!parsed.success) {
    throw invalidSegment('worktree id');
  }
  return `${getBaseWorkspacePath(kilocodeOrganizationId, userId)}/worktrees/${parsed.data}`;
}

function isIsolatedSingleSessionSandbox(
  sandboxId: string | undefined,
  sandboxKind: SandboxKind | undefined
): boolean {
  if (sandboxId === undefined || sandboxId.length === 0) return false;
  const kind = resolveSandboxIdClass({ sandboxId, sandboxKind });
  return kind === 'isolated-small' || kind === 'isolated-standard';
}

export function getControlPlaneSessionDirectory(input: {
  workspacePath: string | null | undefined;
  sandboxId: string | undefined;
  sandboxKind?: SandboxKind;
  orgId: string | undefined;
  userId: string;
  sessionId: string;
}): string {
  if (isIsolatedSingleSessionSandbox(input.sandboxId, input.sandboxKind)) {
    return ISOLATED_CONTAINER_WORKSPACE_PATH;
  }
  if (input.workspacePath !== undefined && input.workspacePath !== null) {
    return input.workspacePath;
  }
  return getSessionWorkspacePath(input.orgId, input.userId, input.sessionId);
}
