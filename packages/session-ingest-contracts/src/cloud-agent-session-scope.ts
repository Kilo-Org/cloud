import { z } from 'zod';

import { KILO_SESSION_ID_LENGTH, KILO_SESSION_ID_PREFIX } from './kilo-session-id';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const cloudAgentSessionScopeProtocolVersion = '1' as const;

export const cloudAgentSessionScopeHeaders = {
  cloudAgentSessionId: 'X-Kilo-Cloud-Agent-Session',
  rootKiloSessionId: 'X-Kilo-Root-Session',
  protocolVersion: 'X-Kilo-Session-Scope-Protocol',
  trustedLineage: 'X-Kilo-Trusted-Session-Lineage',
} as const;

const CONTAINED_KILO_SESSION_ID_TAIL_LENGTH =
  KILO_SESSION_ID_LENGTH - KILO_SESSION_ID_PREFIX.length;

/**
 * A Kilo session id as a Cloud Agent scope assertion or lineage record carries it.
 * Looser than `KILO_SESSION_ID_PATTERN` on the tail, which accepts any alphanumerics
 * so ids minted before the canonical shape stay readable.
 */
export const containedKiloSessionIdSchema = z
  .string()
  .regex(
    new RegExp(
      `^${escapeRegExp(KILO_SESSION_ID_PREFIX)}[A-Za-z0-9]{${CONTAINED_KILO_SESSION_ID_TAIL_LENGTH}}$`
    )
  );

export const cloudAgentWorktreeIdSchema = z.templateLiteral(['worktree_', z.uuid()]);
export type CloudAgentWorktreeId = z.infer<typeof cloudAgentWorktreeIdSchema>;

export const cloudAgentSessionIdSchema = z.templateLiteral(['workspace_', z.uuid()]);

export const cloudAgentSessionScopeAssertionSchema = z.object({
  cloudAgentSessionId: z.string().min(1).max(256),
  rootKiloSessionId: containedKiloSessionIdSchema,
  protocolVersion: z.literal(cloudAgentSessionScopeProtocolVersion),
});

export type CloudAgentSessionScopeAssertion = z.infer<typeof cloudAgentSessionScopeAssertionSchema>;

export const cloudAgentChildSessionLineageSchema = z
  .object({
    sessionId: containedKiloSessionIdSchema,
    parentSessionId: containedKiloSessionIdSchema,
  })
  .strict();
export type CloudAgentChildSessionLineage = z.infer<typeof cloudAgentChildSessionLineageSchema>;
