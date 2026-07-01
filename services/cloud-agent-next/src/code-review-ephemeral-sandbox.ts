import type { SessionMetadata } from './persistence/session-metadata.js';
import type { Env } from './types.js';

export const CODE_REVIEW_EPHEMERAL_SANDBOX_DESTROY_DELAY_MS = 60_000;

type PolicyMetadata = Pick<SessionMetadata, 'identity'>;
type PolicyEnv = Pick<Env, 'CODE_REVIEW_EPHEMERAL_SANDBOX_ORG_IDS'>;

function parseOrgIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  );
}

export function resolveEphemeralSandboxPolicy(
  env: PolicyEnv,
  metadata: PolicyMetadata
): { enabled: boolean; destroyDelayMs: number } {
  const orgIds = parseOrgIds(env.CODE_REVIEW_EPHEMERAL_SANDBOX_ORG_IDS);
  const enabled =
    metadata.identity.createdOnPlatform === 'code-review' &&
    (orgIds.has('*') ||
      (metadata.identity.orgId !== undefined && orgIds.has(metadata.identity.orgId)));

  return {
    enabled,
    destroyDelayMs: CODE_REVIEW_EPHEMERAL_SANDBOX_DESTROY_DELAY_MS,
  };
}

export function isCodeReviewEphemeralSandboxId(sandboxId: string | undefined): boolean {
  return sandboxId?.startsWith('crv-') === true;
}
