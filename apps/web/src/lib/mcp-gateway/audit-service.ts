import 'server-only';
import { mcp_gateway_audit_events } from '@kilocode/db/schema';
import type { GatewayAuditOutcome, GatewayOwnerScope } from '@kilocode/mcp-gateway';
import type { GatewayRepository } from './repository';

export function createAuditService(repository: GatewayRepository) {
  async function record(params: {
    actorUserId?: string | null;
    ownerScope: GatewayOwnerScope;
    ownerId: string;
    configId?: string | null;
    connectResourceId?: string | null;
    instanceId?: string | null;
    eventType: string;
    outcome: GatewayAuditOutcome;
    metadata?: Record<string, unknown>;
  }) {
    await repository.database.insert(mcp_gateway_audit_events).values({
      actor_kilo_user_id: params.actorUserId ?? null,
      owner_scope: params.ownerScope,
      owner_id: params.ownerId,
      config_id: params.configId ?? null,
      connect_resource_id: params.connectResourceId ?? null,
      instance_id: params.instanceId ?? null,
      event_type: params.eventType,
      outcome: params.outcome,
      correlation_metadata: params.metadata ?? {},
    });
  }

  return { record };
}

export type GatewayAuditService = ReturnType<typeof createAuditService>;
