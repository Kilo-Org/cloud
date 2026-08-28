import { z } from 'zod';

export const cloudAgentSessionScopeProtocolVersion = '1' as const;

export const cloudAgentSessionScopeHeaders = {
  cloudAgentSessionId: 'X-Kilo-Cloud-Agent-Session',
  rootKiloSessionId: 'X-Kilo-Root-Session',
  protocolVersion: 'X-Kilo-Session-Scope-Protocol',
  trustedLineage: 'X-Kilo-Trusted-Session-Lineage',
} as const;

export const containedKiloSessionIdSchema = z.string().regex(/^ses_[A-Za-z0-9]{26}$/);

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
