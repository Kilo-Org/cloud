import { z } from 'zod';

export const cloudAgentFamilyProtocolVersion = '1' as const;

export const cloudAgentFamilyHeaders = {
  cloudAgentSessionId: 'X-Kilo-Cloud-Agent-Session',
  rootKiloSessionId: 'X-Kilo-Root-Session',
  protocolVersion: 'X-Kilo-Session-Family-Protocol',
} as const;

export const containedKiloSessionIdSchema = z.string().regex(/^ses_[A-Za-z0-9]{26}$/);

export const cloudAgentFamilyAssertionSchema = z.object({
  cloudAgentSessionId: z.string().min(1).max(256),
  rootKiloSessionId: containedKiloSessionIdSchema,
  protocolVersion: z.literal(cloudAgentFamilyProtocolVersion),
});

export type CloudAgentFamilyAssertion = z.infer<typeof cloudAgentFamilyAssertionSchema>;
