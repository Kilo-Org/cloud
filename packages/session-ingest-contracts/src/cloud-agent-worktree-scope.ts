import { z } from 'zod';

import { containedKiloSessionIdSchema } from './cloud-agent-session-scope';
import { cloudAgentWorktreeIdSchema } from './rpc-contract';

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
  worktreeId: string;
  organizationId: string | null;
  memberRootKiloSessionIds: string[];
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

export function encodeCloudAgentSessionScopeV2Headers(
  scope: CloudAgentSessionScopeV2
): Required<CloudAgentSessionScopeV2HeaderInput> {
  return {
    worktreeId: scope.worktreeId,
    expectedOrganization: scope.organizationId ?? CLOUD_AGENT_SESSION_SCOPE_PERSONAL_ORGANIZATION,
    memberRootKiloSessionIds: scope.memberRootKiloSessionIds.join(','),
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
