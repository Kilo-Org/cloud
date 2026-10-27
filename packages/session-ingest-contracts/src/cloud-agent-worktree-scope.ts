import { z } from 'zod';

import {
  containedKiloSessionIdSchema,
  cloudAgentWorktreeIdSchema,
} from './cloud-agent-session-scope';

export const cloudAgentSessionScopeProtocolVersionV2 = '2' as const;

export const cloudAgentSessionScopeV2Headers = {
  worktreeId: 'X-Kilo-Cloud-Agent-Worktree',
  expectedOrganization: 'X-Kilo-Expected-Organization',
  memberRootKiloSessionIds: 'X-Kilo-Member-Root-Sessions',
} as const;

export const CLOUD_AGENT_SESSION_SCOPE_PERSONAL_ORGANIZATION = 'personal' as const;

export const MAX_CLOUD_AGENT_SESSION_SCOPE_MEMBER_ROOTS = 32;
export const MAX_CLOUD_AGENT_SESSION_SCOPE_HEADER_BYTES = 4096;

export const cloudAgentSessionScopeV2AssertionSchema = z.object({
  protocolVersion: z.literal(cloudAgentSessionScopeProtocolVersionV2),
  worktreeId: cloudAgentWorktreeIdSchema,
  expectedOrganization: z.union([
    z.literal(CLOUD_AGENT_SESSION_SCOPE_PERSONAL_ORGANIZATION),
    z.uuid(),
  ]),
  memberRootKiloSessionIds: z
    .array(containedKiloSessionIdSchema)
    .min(1)
    .max(MAX_CLOUD_AGENT_SESSION_SCOPE_MEMBER_ROOTS),
});

export type CloudAgentSessionScopeV2Assertion = z.infer<
  typeof cloudAgentSessionScopeV2AssertionSchema
>;

export type CloudAgentSessionScopeV2 = {
  worktreeId: CloudAgentSessionScopeV2Assertion['worktreeId'];
  organizationId: CloudAgentSessionScopeV2Assertion['expectedOrganization'] | null;
  memberRootKiloSessionIds: CloudAgentSessionScopeV2Assertion['memberRootKiloSessionIds'];
};

export type CloudAgentSessionScopeV2HeaderInput = {
  worktreeId?: string;
  expectedOrganization?: string;
  memberRootKiloSessionIds?: string;
};

export type CloudAgentSessionScopeV2ParseResult =
  | { kind: 'ok'; scope: CloudAgentSessionScopeV2 }
  | { kind: 'invalid' };

function headerValue(value: string | undefined): string {
  return value ?? '';
}

export function measureCloudAgentSessionScopeV2HeaderBytes(
  input: CloudAgentSessionScopeV2HeaderInput
): number {
  const encoder = new TextEncoder();
  return (
    encoder.encode(headerValue(input.worktreeId)).length +
    encoder.encode(headerValue(input.expectedOrganization)).length +
    encoder.encode(headerValue(input.memberRootKiloSessionIds)).length
  );
}

/**
 * Encodes the v2 header block through the assertion schema, so every header
 * block this writes is one `parseCloudAgentSessionScopeV2Headers` accepts, and
 * throws when the scope is outside the contract.
 */
export function encodeCloudAgentSessionScopeV2Headers(
  scope: CloudAgentSessionScopeV2
): Required<CloudAgentSessionScopeV2HeaderInput> {
  const headers = tryEncodeCloudAgentSessionScopeV2Headers(scope);
  if (headers === null) {
    throw new Error('Cloud Agent session scope is not encodable');
  }
  return headers;
}

/**
 * Same encoding as `encodeCloudAgentSessionScopeV2Headers`, for callers holding
 * a scope they did not build themselves: it returns `null` instead of throwing
 * when the scope is outside the contract.
 */
export function tryEncodeCloudAgentSessionScopeV2Headers(
  scope: CloudAgentSessionScopeV2
): Required<CloudAgentSessionScopeV2HeaderInput> | null {
  const assertion = cloudAgentSessionScopeV2AssertionSchema.safeParse({
    protocolVersion: cloudAgentSessionScopeProtocolVersionV2,
    worktreeId: scope.worktreeId,
    expectedOrganization: scope.organizationId ?? CLOUD_AGENT_SESSION_SCOPE_PERSONAL_ORGANIZATION,
    memberRootKiloSessionIds: scope.memberRootKiloSessionIds,
  });
  if (!assertion.success) {
    return null;
  }
  return {
    worktreeId: assertion.data.worktreeId,
    expectedOrganization: assertion.data.expectedOrganization,
    memberRootKiloSessionIds: assertion.data.memberRootKiloSessionIds.join(','),
  };
}

export function parseCloudAgentSessionScopeV2Headers(
  input: CloudAgentSessionScopeV2HeaderInput
): CloudAgentSessionScopeV2ParseResult {
  const { worktreeId, expectedOrganization, memberRootKiloSessionIds } = input;
  if (
    worktreeId === undefined ||
    expectedOrganization === undefined ||
    memberRootKiloSessionIds === undefined
  ) {
    return { kind: 'invalid' };
  }
  if (
    measureCloudAgentSessionScopeV2HeaderBytes(input) > MAX_CLOUD_AGENT_SESSION_SCOPE_HEADER_BYTES
  ) {
    return { kind: 'invalid' };
  }

  const rawMemberRoots = memberRootKiloSessionIds.split(',');
  if (rawMemberRoots.some(value => value.trim().length === 0)) return { kind: 'invalid' };
  const normalizedMemberRoots = [...new Set(rawMemberRoots.map(value => value.trim()))];
  if (
    normalizedMemberRoots.length === 0 ||
    normalizedMemberRoots.length > MAX_CLOUD_AGENT_SESSION_SCOPE_MEMBER_ROOTS
  ) {
    return { kind: 'invalid' };
  }

  const parsed = cloudAgentSessionScopeV2AssertionSchema.safeParse({
    protocolVersion: cloudAgentSessionScopeProtocolVersionV2,
    worktreeId,
    expectedOrganization,
    memberRootKiloSessionIds: normalizedMemberRoots,
  });
  if (!parsed.success) return { kind: 'invalid' };

  return {
    kind: 'ok',
    scope: {
      worktreeId: parsed.data.worktreeId,
      organizationId:
        parsed.data.expectedOrganization === CLOUD_AGENT_SESSION_SCOPE_PERSONAL_ORGANIZATION
          ? null
          : parsed.data.expectedOrganization,
      memberRootKiloSessionIds: parsed.data.memberRootKiloSessionIds,
    },
  };
}
