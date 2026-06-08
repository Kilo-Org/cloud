import { GatewayExecutionContextSchema, type GatewayExecutionContext } from '@kilocode/mcp-gateway';

export function executionContextFromAuth(
  organizationId: string | undefined
): GatewayExecutionContext {
  if (!organizationId) return { type: 'personal' };
  return GatewayExecutionContextSchema.parse({ type: 'organization', organizationId });
}
