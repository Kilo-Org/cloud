import { z } from 'zod';

/**
 * Wraps a Zod schema in z.any().pipe(schema) so the TS input type is `any`
 * (avoiding "excessively deep" instantiation with Rpc.Promisified DO stubs)
 * while still performing full runtime validation via the piped schema.
 */
function rpcSafe<T extends z.ZodTypeAny>(schema: T): z.ZodPipe<z.ZodAny, T> {
  return z.any().pipe(schema);
}

// Town (from GastownUserDO)
export const TownOutput = z.object({
  id: z.string(),
  name: z.string(),
  owner_user_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

// Rig (from GastownUserDO)
export const RigOutput = z.object({
  id: z.string(),
  town_id: z.string(),
  name: z.string(),
  git_url: z.string(),
  default_branch: z.string(),
  platform_integration_id: z.string().nullable().optional().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});

// Bead (output shape, after transforms)
export const BeadOutput = z.object({
  bead_id: z.string(),
  type: z.enum(['issue', 'message', 'escalation', 'merge_request', 'convoy', 'molecule', 'agent']),
  status: z.enum(['open', 'in_progress', 'in_review', 'closed', 'failed']),
  title: z.string(),
  body: z.string().nullable(),
  rig_id: z.string().nullable(),
  parent_bead_id: z.string().nullable(),
  assignee_agent_bead_id: z.string().nullable(),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  labels: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
});

// Agent
export const AgentOutput = z.object({
  id: z.string(),
  rig_id: z.string().nullable(),
  role: z.enum(['polecat', 'refinery', 'mayor']).or(z.string()),
  name: z.string(),
  identity: z.string(),
  status: z.enum(['idle', 'working', 'stalled', 'dead']).or(z.string()),
  current_hook_bead_id: z.string().nullable(),
  dispatch_attempts: z.number().default(0),
  last_activity_at: z.string().nullable(),
  checkpoint: z.unknown().optional(),
  created_at: z.string(),
  agent_status_message: z.string().nullable().optional().default(null),
  agent_status_updated_at: z.string().nullable().optional().default(null),
});

// BeadEvent (output shape, after transforms)
export const BeadEventOutput = z.object({
  bead_event_id: z.string(),
  bead_id: z.string(),
  agent_id: z.string().nullable(),
  event_type: z.string(),
  old_value: z.string().nullable(),
  new_value: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  // Optional fields for town-level events that tag the rig
  rig_id: z.string().optional(),
  rig_name: z.string().optional(),
});

// MayorSendResult
export const MayorSendResultOutput = z.object({
  agentId: z.string(),
  sessionStatus: z.enum(['idle', 'active', 'starting']),
});

// MayorStatus
export const MayorStatusOutput = z.object({
  configured: z.boolean(),
  townId: z.string().nullable(),
  session: z
    .object({
      agentId: z.string(),
      sessionId: z.string(),
      status: z.enum(['idle', 'active', 'starting']),
      lastActivityAt: z.string(),
    })
    .nullable(),
});

// StreamTicket
export const StreamTicketOutput = z.object({
  url: z.string(),
  ticket: z.string(),
});

// PtySession (passthrough for extra fields)
export const PtySessionOutput = z.object({
  pty: z.object({ id: z.string() }).passthrough(),
  wsUrl: z.string(),
});

// Convoy summary
export const ConvoyOutput = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['active', 'landed']),
  staged: z.boolean(),
  total_beads: z.number(),
  closed_beads: z.number(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  landed_at: z.string().nullable(),
  feature_branch: z.string().nullable(),
  merge_mode: z.string().nullable(),
});

// Detailed convoy status with per-bead breakdown and DAG edges
export const ConvoyDetailOutput = ConvoyOutput.extend({
  beads: z.array(
    z.object({
      bead_id: z.string(),
      title: z.string(),
      status: z.string(),
      rig_id: z.string().nullable(),
      assignee_agent_name: z.string().nullable(),
    })
  ),
  /** 'blocks' dependency edges between tracked beads — the execution DAG. */
  dependency_edges: z.array(
    z.object({
      bead_id: z.string(),
      depends_on_bead_id: z.string(),
    })
  ),
});

// SlingResult
export const SlingResultOutput = z.object({
  bead: BeadOutput,
  agent: AgentOutput,
});

// getRig enriched result
export const RigDetailOutput = z.object({
  id: z.string(),
  town_id: z.string(),
  name: z.string(),
  git_url: z.string(),
  default_branch: z.string(),
  platform_integration_id: z.string().nullable().optional().default(null),
  created_at: z.string(),
  updated_at: z.string(),
  agents: z.array(AgentOutput),
  beads: z.array(BeadOutput),
});

// ── rpcSafe wrappers ──────────────────────────────────────────────────
// tRPC's .output() forces TypeScript to check that the handler return type
// is assignable to the schema's input type. When handlers return values from
// Cloudflare Rpc.Promisified DO stubs, the deeply recursive proxy types
// exceed TS's instantiation depth limit. Wrapping with rpcSafe() (z.any().pipe)
// short-circuits the type check while preserving identical runtime validation.

export const RpcTownOutput = rpcSafe(TownOutput);
export const RpcRigOutput = rpcSafe(RigOutput);
export const RpcBeadOutput = rpcSafe(BeadOutput);
export const RpcAgentOutput = rpcSafe(AgentOutput);
export const RpcBeadEventOutput = rpcSafe(BeadEventOutput);
export const RpcMayorSendResultOutput = rpcSafe(MayorSendResultOutput);
export const RpcMayorStatusOutput = rpcSafe(MayorStatusOutput);
export const RpcStreamTicketOutput = rpcSafe(StreamTicketOutput);
export const RpcPtySessionOutput = rpcSafe(PtySessionOutput);
export const RpcConvoyOutput = rpcSafe(ConvoyOutput);
export const RpcConvoyDetailOutput = rpcSafe(ConvoyDetailOutput);
export const RpcSlingResultOutput = rpcSafe(SlingResultOutput);

// Alarm status
const AlarmStatusOutput = z.object({
  alarm: z.object({
    nextFireAt: z.string().nullable(),
    intervalMs: z.number(),
    intervalLabel: z.string(),
  }),
  agents: z.object({
    working: z.number(),
    idle: z.number(),
    stalled: z.number(),
    dead: z.number(),
    total: z.number(),
  }),
  beads: z.object({
    open: z.number(),
    inProgress: z.number(),
    inReview: z.number(),
    failed: z.number(),
    triageRequests: z.number(),
  }),
  patrol: z.object({
    guppWarnings: z.number(),
    guppEscalations: z.number(),
    stalledAgents: z.number(),
    orphanedHooks: z.number(),
  }),
  recentEvents: z.array(
    z.object({
      time: z.string(),
      type: z.string(),
      message: z.string(),
    })
  ),
});
export const RpcAlarmStatusOutput = rpcSafe(AlarmStatusOutput);
export const RpcRigDetailOutput = rpcSafe(RigDetailOutput);

// OrgTown (from GastownOrgDO)
export const OrgTownOutput = z.object({
  id: z.string(),
  name: z.string(),
  owner_org_id: z.string(),
  created_by_user_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export const RpcOrgTownOutput = rpcSafe(OrgTownOutput);
