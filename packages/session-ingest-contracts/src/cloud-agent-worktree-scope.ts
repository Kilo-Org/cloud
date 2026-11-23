import { z } from 'zod';

import { containedKiloSessionIdSchema } from './cloud-agent-session-scope';

export const cloudAgentWorktreeIdSchema = z.templateLiteral(['worktree_', z.uuid()]);
export type CloudAgentWorktreeId = z.infer<typeof cloudAgentWorktreeIdSchema>;

export const cloudAgentSessionScopeProtocolVersionV2 = '2' as const;

export const cloudAgentSessionScopeV2Headers = {
  worktreeId: 'X-Kilo-Cloud-Agent-Worktree',
  expectedOrganization: 'X-Kilo-Expected-Organization',
  memberRootKiloSessionIds: 'X-Kilo-Member-Root-Sessions',
} as const;

export const CLOUD_AGENT_SESSION_SCOPE_PERSONAL_ORGANIZATION = 'personal' as const;

/** The organization id a v2 scope asserts: a bare UUID, never the wire's personal sentinel. */
export const cloudAgentOrganizationIdSchema = z.uuid().brand<'CloudAgentOrganizationId'>();
export type CloudAgentOrganizationId = z.infer<typeof cloudAgentOrganizationIdSchema>;

export const MAX_CLOUD_AGENT_SESSION_SCOPE_MEMBER_ROOTS = 32;

/**
 * The budget for the sum of the encoded v2 header *values* only: the worktree
 * id, the organization, and the comma-joined member roots. Header names, the
 * `: ` separators, the line terminators, and the protocol header are left out,
 * deliberately, because the parser compares exactly the value bytes the encoder
 * writes. A caller that needs the true wire size adds that framing itself.
 */
export const MAX_CLOUD_AGENT_SESSION_SCOPE_HEADER_VALUE_BYTES = 4096;

export const cloudAgentSessionScopeV2AssertionSchema = z.object({
  protocolVersion: z.literal(cloudAgentSessionScopeProtocolVersionV2),
  worktreeId: cloudAgentWorktreeIdSchema,
  expectedOrganization: z.union([
    z.literal(CLOUD_AGENT_SESSION_SCOPE_PERSONAL_ORGANIZATION),
    cloudAgentOrganizationIdSchema,
  ]),
  /**
   * The member roots of the scope. The cap counts **entries**, and the two
   * callers apply it to different lists: the encoder validates the caller's
   * array as given, while `parseCloudAgentSessionScopeV2Headers` trims and
   * de-duplicates the header value first. On the wire the cap therefore counts
   * distinct roots, and a repeated array entry encodes unchanged but parses back
   * as one root.
   */
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
  organizationId: CloudAgentOrganizationId | null;
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

/**
 * Returns the encoded byte count of the three header values, the number
 * `MAX_CLOUD_AGENT_SESSION_SCOPE_HEADER_VALUE_BYTES` bounds.
 */
export function measureCloudAgentSessionScopeV2HeaderValueBytes(
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

/**
 * Parses a v2 header block. It splits the member-root value, trims each entry,
 * drops duplicates, then applies the same assertion schema, so the member-root
 * cap counts distinct roots.
 */
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
    measureCloudAgentSessionScopeV2HeaderValueBytes(input) >
    MAX_CLOUD_AGENT_SESSION_SCOPE_HEADER_VALUE_BYTES
  ) {
    return { kind: 'invalid' };
  }

  const rawMemberRoots = memberRootKiloSessionIds.split(',');
  if (rawMemberRoots.some(value => value.trim().length === 0)) return { kind: 'invalid' };
  const normalizedMemberRoots = [...new Set(rawMemberRoots.map(value => value.trim()))];

  const parsed = cloudAgentSessionScopeV2AssertionSchema.safeParse({
    protocolVersion: cloudAgentSessionScopeProtocolVersionV2,
    worktreeId,
    expectedOrganization,
    memberRootKiloSessionIds: normalizedMemberRoots,
  });
  if (!parsed.success) return { kind: 'invalid' };

  // The assertion union already resolved this arm to the branded domain id, so
  // the sentinel check is the only narrowing left.
  const parsedOrganization = parsed.data.expectedOrganization;

  return {
    kind: 'ok',
    scope: {
      worktreeId: parsed.data.worktreeId,
      organizationId:
        parsedOrganization === CLOUD_AGENT_SESSION_SCOPE_PERSONAL_ORGANIZATION
          ? null
          : parsedOrganization,
      memberRootKiloSessionIds: parsed.data.memberRootKiloSessionIds,
    },
  };
}
