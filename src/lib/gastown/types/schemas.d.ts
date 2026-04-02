import { z } from 'zod';
export declare const TownOutput: z.ZodObject<
  {
    id: z.ZodString;
    name: z.ZodString;
    owner_user_id: z.ZodString;
    created_at: z.ZodString;
    updated_at: z.ZodString;
  },
  z.core.$strip
>;
export declare const RigOutput: z.ZodObject<
  {
    id: z.ZodString;
    town_id: z.ZodString;
    name: z.ZodString;
    git_url: z.ZodString;
    default_branch: z.ZodString;
    platform_integration_id: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
  },
  z.core.$strip
>;
export declare const BeadOutput: z.ZodObject<
  {
    bead_id: z.ZodString;
    type: z.ZodEnum<{
      agent: 'agent';
      convoy: 'convoy';
      escalation: 'escalation';
      issue: 'issue';
      merge_request: 'merge_request';
      message: 'message';
      molecule: 'molecule';
    }>;
    status: z.ZodEnum<{
      closed: 'closed';
      failed: 'failed';
      in_progress: 'in_progress';
      in_review: 'in_review';
      open: 'open';
    }>;
    title: z.ZodString;
    body: z.ZodNullable<z.ZodString>;
    rig_id: z.ZodNullable<z.ZodString>;
    parent_bead_id: z.ZodNullable<z.ZodString>;
    assignee_agent_bead_id: z.ZodNullable<z.ZodString>;
    priority: z.ZodEnum<{
      critical: 'critical';
      high: 'high';
      low: 'low';
      medium: 'medium';
    }>;
    labels: z.ZodArray<z.ZodString>;
    metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    created_by: z.ZodNullable<z.ZodString>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    closed_at: z.ZodNullable<z.ZodString>;
  },
  z.core.$strip
>;
export declare const AgentOutput: z.ZodObject<
  {
    id: z.ZodString;
    rig_id: z.ZodNullable<z.ZodString>;
    role: z.ZodUnion<
      [
        z.ZodEnum<{
          mayor: 'mayor';
          polecat: 'polecat';
          refinery: 'refinery';
        }>,
        z.ZodString,
      ]
    >;
    name: z.ZodString;
    identity: z.ZodString;
    status: z.ZodUnion<
      [
        z.ZodEnum<{
          dead: 'dead';
          idle: 'idle';
          stalled: 'stalled';
          working: 'working';
        }>,
        z.ZodString,
      ]
    >;
    current_hook_bead_id: z.ZodNullable<z.ZodString>;
    dispatch_attempts: z.ZodDefault<z.ZodNumber>;
    last_activity_at: z.ZodNullable<z.ZodString>;
    checkpoint: z.ZodOptional<z.ZodUnknown>;
    created_at: z.ZodString;
    agent_status_message: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    agent_status_updated_at: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
  },
  z.core.$strip
>;
export declare const BeadEventOutput: z.ZodObject<
  {
    bead_event_id: z.ZodString;
    bead_id: z.ZodString;
    agent_id: z.ZodNullable<z.ZodString>;
    event_type: z.ZodString;
    old_value: z.ZodNullable<z.ZodString>;
    new_value: z.ZodNullable<z.ZodString>;
    metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    created_at: z.ZodString;
    rig_id: z.ZodOptional<z.ZodString>;
    rig_name: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
>;
export declare const MayorSendResultOutput: z.ZodObject<
  {
    agentId: z.ZodString;
    sessionStatus: z.ZodEnum<{
      active: 'active';
      idle: 'idle';
      starting: 'starting';
    }>;
  },
  z.core.$strip
>;
export declare const MayorStatusOutput: z.ZodObject<
  {
    configured: z.ZodBoolean;
    townId: z.ZodNullable<z.ZodString>;
    session: z.ZodNullable<
      z.ZodObject<
        {
          agentId: z.ZodString;
          sessionId: z.ZodString;
          status: z.ZodEnum<{
            active: 'active';
            idle: 'idle';
            starting: 'starting';
          }>;
          lastActivityAt: z.ZodString;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$strip
>;
export declare const StreamTicketOutput: z.ZodObject<
  {
    url: z.ZodString;
    ticket: z.ZodString;
  },
  z.core.$strip
>;
export declare const PtySessionOutput: z.ZodObject<
  {
    pty: z.ZodObject<
      {
        id: z.ZodString;
      },
      z.core.$loose
    >;
    wsUrl: z.ZodString;
  },
  z.core.$strip
>;
export declare const ConvoyOutput: z.ZodObject<
  {
    id: z.ZodString;
    title: z.ZodString;
    status: z.ZodEnum<{
      active: 'active';
      landed: 'landed';
    }>;
    staged: z.ZodBoolean;
    total_beads: z.ZodNumber;
    closed_beads: z.ZodNumber;
    created_by: z.ZodNullable<z.ZodString>;
    created_at: z.ZodString;
    landed_at: z.ZodNullable<z.ZodString>;
    feature_branch: z.ZodNullable<z.ZodString>;
    merge_mode: z.ZodNullable<z.ZodString>;
  },
  z.core.$strip
>;
export declare const ConvoyDetailOutput: z.ZodObject<
  {
    id: z.ZodString;
    title: z.ZodString;
    status: z.ZodEnum<{
      active: 'active';
      landed: 'landed';
    }>;
    staged: z.ZodBoolean;
    total_beads: z.ZodNumber;
    closed_beads: z.ZodNumber;
    created_by: z.ZodNullable<z.ZodString>;
    created_at: z.ZodString;
    landed_at: z.ZodNullable<z.ZodString>;
    feature_branch: z.ZodNullable<z.ZodString>;
    merge_mode: z.ZodNullable<z.ZodString>;
    beads: z.ZodArray<
      z.ZodObject<
        {
          bead_id: z.ZodString;
          title: z.ZodString;
          status: z.ZodString;
          rig_id: z.ZodNullable<z.ZodString>;
          assignee_agent_name: z.ZodNullable<z.ZodString>;
        },
        z.core.$strip
      >
    >;
    dependency_edges: z.ZodArray<
      z.ZodObject<
        {
          bead_id: z.ZodString;
          depends_on_bead_id: z.ZodString;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$strip
>;
export declare const SlingResultOutput: z.ZodObject<
  {
    bead: z.ZodObject<
      {
        bead_id: z.ZodString;
        type: z.ZodEnum<{
          agent: 'agent';
          convoy: 'convoy';
          escalation: 'escalation';
          issue: 'issue';
          merge_request: 'merge_request';
          message: 'message';
          molecule: 'molecule';
        }>;
        status: z.ZodEnum<{
          closed: 'closed';
          failed: 'failed';
          in_progress: 'in_progress';
          in_review: 'in_review';
          open: 'open';
        }>;
        title: z.ZodString;
        body: z.ZodNullable<z.ZodString>;
        rig_id: z.ZodNullable<z.ZodString>;
        parent_bead_id: z.ZodNullable<z.ZodString>;
        assignee_agent_bead_id: z.ZodNullable<z.ZodString>;
        priority: z.ZodEnum<{
          critical: 'critical';
          high: 'high';
          low: 'low';
          medium: 'medium';
        }>;
        labels: z.ZodArray<z.ZodString>;
        metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        created_by: z.ZodNullable<z.ZodString>;
        created_at: z.ZodString;
        updated_at: z.ZodString;
        closed_at: z.ZodNullable<z.ZodString>;
      },
      z.core.$strip
    >;
    agent: z.ZodObject<
      {
        id: z.ZodString;
        rig_id: z.ZodNullable<z.ZodString>;
        role: z.ZodUnion<
          [
            z.ZodEnum<{
              mayor: 'mayor';
              polecat: 'polecat';
              refinery: 'refinery';
            }>,
            z.ZodString,
          ]
        >;
        name: z.ZodString;
        identity: z.ZodString;
        status: z.ZodUnion<
          [
            z.ZodEnum<{
              dead: 'dead';
              idle: 'idle';
              stalled: 'stalled';
              working: 'working';
            }>,
            z.ZodString,
          ]
        >;
        current_hook_bead_id: z.ZodNullable<z.ZodString>;
        dispatch_attempts: z.ZodDefault<z.ZodNumber>;
        last_activity_at: z.ZodNullable<z.ZodString>;
        checkpoint: z.ZodOptional<z.ZodUnknown>;
        created_at: z.ZodString;
        agent_status_message: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
        agent_status_updated_at: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
      },
      z.core.$strip
    >;
  },
  z.core.$strip
>;
export declare const RigDetailOutput: z.ZodObject<
  {
    id: z.ZodString;
    town_id: z.ZodString;
    name: z.ZodString;
    git_url: z.ZodString;
    default_branch: z.ZodString;
    platform_integration_id: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
    agents: z.ZodArray<
      z.ZodObject<
        {
          id: z.ZodString;
          rig_id: z.ZodNullable<z.ZodString>;
          role: z.ZodUnion<
            [
              z.ZodEnum<{
                mayor: 'mayor';
                polecat: 'polecat';
                refinery: 'refinery';
              }>,
              z.ZodString,
            ]
          >;
          name: z.ZodString;
          identity: z.ZodString;
          status: z.ZodUnion<
            [
              z.ZodEnum<{
                dead: 'dead';
                idle: 'idle';
                stalled: 'stalled';
                working: 'working';
              }>,
              z.ZodString,
            ]
          >;
          current_hook_bead_id: z.ZodNullable<z.ZodString>;
          dispatch_attempts: z.ZodDefault<z.ZodNumber>;
          last_activity_at: z.ZodNullable<z.ZodString>;
          checkpoint: z.ZodOptional<z.ZodUnknown>;
          created_at: z.ZodString;
          agent_status_message: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
          agent_status_updated_at: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
        },
        z.core.$strip
      >
    >;
    beads: z.ZodArray<
      z.ZodObject<
        {
          bead_id: z.ZodString;
          type: z.ZodEnum<{
            agent: 'agent';
            convoy: 'convoy';
            escalation: 'escalation';
            issue: 'issue';
            merge_request: 'merge_request';
            message: 'message';
            molecule: 'molecule';
          }>;
          status: z.ZodEnum<{
            closed: 'closed';
            failed: 'failed';
            in_progress: 'in_progress';
            in_review: 'in_review';
            open: 'open';
          }>;
          title: z.ZodString;
          body: z.ZodNullable<z.ZodString>;
          rig_id: z.ZodNullable<z.ZodString>;
          parent_bead_id: z.ZodNullable<z.ZodString>;
          assignee_agent_bead_id: z.ZodNullable<z.ZodString>;
          priority: z.ZodEnum<{
            critical: 'critical';
            high: 'high';
            low: 'low';
            medium: 'medium';
          }>;
          labels: z.ZodArray<z.ZodString>;
          metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
          created_by: z.ZodNullable<z.ZodString>;
          created_at: z.ZodString;
          updated_at: z.ZodString;
          closed_at: z.ZodNullable<z.ZodString>;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$strip
>;
export declare const RpcTownOutput: z.ZodPipe<
  z.ZodAny,
  z.ZodObject<
    {
      id: z.ZodString;
      name: z.ZodString;
      owner_user_id: z.ZodString;
      created_at: z.ZodString;
      updated_at: z.ZodString;
    },
    z.core.$strip
  >
>;
export declare const RpcRigOutput: z.ZodPipe<
  z.ZodAny,
  z.ZodObject<
    {
      id: z.ZodString;
      town_id: z.ZodString;
      name: z.ZodString;
      git_url: z.ZodString;
      default_branch: z.ZodString;
      platform_integration_id: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
      created_at: z.ZodString;
      updated_at: z.ZodString;
    },
    z.core.$strip
  >
>;
export declare const RpcBeadOutput: z.ZodPipe<
  z.ZodAny,
  z.ZodObject<
    {
      bead_id: z.ZodString;
      type: z.ZodEnum<{
        agent: 'agent';
        convoy: 'convoy';
        escalation: 'escalation';
        issue: 'issue';
        merge_request: 'merge_request';
        message: 'message';
        molecule: 'molecule';
      }>;
      status: z.ZodEnum<{
        closed: 'closed';
        failed: 'failed';
        in_progress: 'in_progress';
        in_review: 'in_review';
        open: 'open';
      }>;
      title: z.ZodString;
      body: z.ZodNullable<z.ZodString>;
      rig_id: z.ZodNullable<z.ZodString>;
      parent_bead_id: z.ZodNullable<z.ZodString>;
      assignee_agent_bead_id: z.ZodNullable<z.ZodString>;
      priority: z.ZodEnum<{
        critical: 'critical';
        high: 'high';
        low: 'low';
        medium: 'medium';
      }>;
      labels: z.ZodArray<z.ZodString>;
      metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
      created_by: z.ZodNullable<z.ZodString>;
      created_at: z.ZodString;
      updated_at: z.ZodString;
      closed_at: z.ZodNullable<z.ZodString>;
    },
    z.core.$strip
  >
>;
export declare const RpcAgentOutput: z.ZodPipe<
  z.ZodAny,
  z.ZodObject<
    {
      id: z.ZodString;
      rig_id: z.ZodNullable<z.ZodString>;
      role: z.ZodUnion<
        [
          z.ZodEnum<{
            mayor: 'mayor';
            polecat: 'polecat';
            refinery: 'refinery';
          }>,
          z.ZodString,
        ]
      >;
      name: z.ZodString;
      identity: z.ZodString;
      status: z.ZodUnion<
        [
          z.ZodEnum<{
            dead: 'dead';
            idle: 'idle';
            stalled: 'stalled';
            working: 'working';
          }>,
          z.ZodString,
        ]
      >;
      current_hook_bead_id: z.ZodNullable<z.ZodString>;
      dispatch_attempts: z.ZodDefault<z.ZodNumber>;
      last_activity_at: z.ZodNullable<z.ZodString>;
      checkpoint: z.ZodOptional<z.ZodUnknown>;
      created_at: z.ZodString;
      agent_status_message: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
      agent_status_updated_at: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    },
    z.core.$strip
  >
>;
export declare const RpcBeadEventOutput: z.ZodPipe<
  z.ZodAny,
  z.ZodObject<
    {
      bead_event_id: z.ZodString;
      bead_id: z.ZodString;
      agent_id: z.ZodNullable<z.ZodString>;
      event_type: z.ZodString;
      old_value: z.ZodNullable<z.ZodString>;
      new_value: z.ZodNullable<z.ZodString>;
      metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
      created_at: z.ZodString;
      rig_id: z.ZodOptional<z.ZodString>;
      rig_name: z.ZodOptional<z.ZodString>;
    },
    z.core.$strip
  >
>;
export declare const RpcMayorSendResultOutput: z.ZodPipe<
  z.ZodAny,
  z.ZodObject<
    {
      agentId: z.ZodString;
      sessionStatus: z.ZodEnum<{
        active: 'active';
        idle: 'idle';
        starting: 'starting';
      }>;
    },
    z.core.$strip
  >
>;
export declare const RpcMayorStatusOutput: z.ZodPipe<
  z.ZodAny,
  z.ZodObject<
    {
      configured: z.ZodBoolean;
      townId: z.ZodNullable<z.ZodString>;
      session: z.ZodNullable<
        z.ZodObject<
          {
            agentId: z.ZodString;
            sessionId: z.ZodString;
            status: z.ZodEnum<{
              active: 'active';
              idle: 'idle';
              starting: 'starting';
            }>;
            lastActivityAt: z.ZodString;
          },
          z.core.$strip
        >
      >;
    },
    z.core.$strip
  >
>;
export declare const RpcStreamTicketOutput: z.ZodPipe<
  z.ZodAny,
  z.ZodObject<
    {
      url: z.ZodString;
      ticket: z.ZodString;
    },
    z.core.$strip
  >
>;
export declare const RpcPtySessionOutput: z.ZodPipe<
  z.ZodAny,
  z.ZodObject<
    {
      pty: z.ZodObject<
        {
          id: z.ZodString;
        },
        z.core.$loose
      >;
      wsUrl: z.ZodString;
    },
    z.core.$strip
  >
>;
export declare const RpcConvoyOutput: z.ZodPipe<
  z.ZodAny,
  z.ZodObject<
    {
      id: z.ZodString;
      title: z.ZodString;
      status: z.ZodEnum<{
        active: 'active';
        landed: 'landed';
      }>;
      staged: z.ZodBoolean;
      total_beads: z.ZodNumber;
      closed_beads: z.ZodNumber;
      created_by: z.ZodNullable<z.ZodString>;
      created_at: z.ZodString;
      landed_at: z.ZodNullable<z.ZodString>;
      feature_branch: z.ZodNullable<z.ZodString>;
      merge_mode: z.ZodNullable<z.ZodString>;
    },
    z.core.$strip
  >
>;
export declare const RpcConvoyDetailOutput: z.ZodPipe<
  z.ZodAny,
  z.ZodObject<
    {
      id: z.ZodString;
      title: z.ZodString;
      status: z.ZodEnum<{
        active: 'active';
        landed: 'landed';
      }>;
      staged: z.ZodBoolean;
      total_beads: z.ZodNumber;
      closed_beads: z.ZodNumber;
      created_by: z.ZodNullable<z.ZodString>;
      created_at: z.ZodString;
      landed_at: z.ZodNullable<z.ZodString>;
      feature_branch: z.ZodNullable<z.ZodString>;
      merge_mode: z.ZodNullable<z.ZodString>;
      beads: z.ZodArray<
        z.ZodObject<
          {
            bead_id: z.ZodString;
            title: z.ZodString;
            status: z.ZodString;
            rig_id: z.ZodNullable<z.ZodString>;
            assignee_agent_name: z.ZodNullable<z.ZodString>;
          },
          z.core.$strip
        >
      >;
      dependency_edges: z.ZodArray<
        z.ZodObject<
          {
            bead_id: z.ZodString;
            depends_on_bead_id: z.ZodString;
          },
          z.core.$strip
        >
      >;
    },
    z.core.$strip
  >
>;
export declare const RpcSlingResultOutput: z.ZodPipe<
  z.ZodAny,
  z.ZodObject<
    {
      bead: z.ZodObject<
        {
          bead_id: z.ZodString;
          type: z.ZodEnum<{
            agent: 'agent';
            convoy: 'convoy';
            escalation: 'escalation';
            issue: 'issue';
            merge_request: 'merge_request';
            message: 'message';
            molecule: 'molecule';
          }>;
          status: z.ZodEnum<{
            closed: 'closed';
            failed: 'failed';
            in_progress: 'in_progress';
            in_review: 'in_review';
            open: 'open';
          }>;
          title: z.ZodString;
          body: z.ZodNullable<z.ZodString>;
          rig_id: z.ZodNullable<z.ZodString>;
          parent_bead_id: z.ZodNullable<z.ZodString>;
          assignee_agent_bead_id: z.ZodNullable<z.ZodString>;
          priority: z.ZodEnum<{
            critical: 'critical';
            high: 'high';
            low: 'low';
            medium: 'medium';
          }>;
          labels: z.ZodArray<z.ZodString>;
          metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
          created_by: z.ZodNullable<z.ZodString>;
          created_at: z.ZodString;
          updated_at: z.ZodString;
          closed_at: z.ZodNullable<z.ZodString>;
        },
        z.core.$strip
      >;
      agent: z.ZodObject<
        {
          id: z.ZodString;
          rig_id: z.ZodNullable<z.ZodString>;
          role: z.ZodUnion<
            [
              z.ZodEnum<{
                mayor: 'mayor';
                polecat: 'polecat';
                refinery: 'refinery';
              }>,
              z.ZodString,
            ]
          >;
          name: z.ZodString;
          identity: z.ZodString;
          status: z.ZodUnion<
            [
              z.ZodEnum<{
                dead: 'dead';
                idle: 'idle';
                stalled: 'stalled';
                working: 'working';
              }>,
              z.ZodString,
            ]
          >;
          current_hook_bead_id: z.ZodNullable<z.ZodString>;
          dispatch_attempts: z.ZodDefault<z.ZodNumber>;
          last_activity_at: z.ZodNullable<z.ZodString>;
          checkpoint: z.ZodOptional<z.ZodUnknown>;
          created_at: z.ZodString;
          agent_status_message: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
          agent_status_updated_at: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
        },
        z.core.$strip
      >;
    },
    z.core.$strip
  >
>;
export declare const RpcAlarmStatusOutput: z.ZodPipe<
  z.ZodAny,
  z.ZodObject<
    {
      alarm: z.ZodObject<
        {
          nextFireAt: z.ZodNullable<z.ZodString>;
          intervalMs: z.ZodNumber;
          intervalLabel: z.ZodString;
        },
        z.core.$strip
      >;
      agents: z.ZodObject<
        {
          working: z.ZodNumber;
          idle: z.ZodNumber;
          stalled: z.ZodNumber;
          dead: z.ZodNumber;
          total: z.ZodNumber;
        },
        z.core.$strip
      >;
      beads: z.ZodObject<
        {
          open: z.ZodNumber;
          inProgress: z.ZodNumber;
          inReview: z.ZodNumber;
          failed: z.ZodNumber;
          triageRequests: z.ZodNumber;
        },
        z.core.$strip
      >;
      patrol: z.ZodObject<
        {
          guppWarnings: z.ZodNumber;
          guppEscalations: z.ZodNumber;
          stalledAgents: z.ZodNumber;
          orphanedHooks: z.ZodNumber;
        },
        z.core.$strip
      >;
      recentEvents: z.ZodArray<
        z.ZodObject<
          {
            time: z.ZodString;
            type: z.ZodString;
            message: z.ZodString;
          },
          z.core.$strip
        >
      >;
    },
    z.core.$strip
  >
>;
export declare const RpcRigDetailOutput: z.ZodPipe<
  z.ZodAny,
  z.ZodObject<
    {
      id: z.ZodString;
      town_id: z.ZodString;
      name: z.ZodString;
      git_url: z.ZodString;
      default_branch: z.ZodString;
      platform_integration_id: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
      created_at: z.ZodString;
      updated_at: z.ZodString;
      agents: z.ZodArray<
        z.ZodObject<
          {
            id: z.ZodString;
            rig_id: z.ZodNullable<z.ZodString>;
            role: z.ZodUnion<
              [
                z.ZodEnum<{
                  mayor: 'mayor';
                  polecat: 'polecat';
                  refinery: 'refinery';
                }>,
                z.ZodString,
              ]
            >;
            name: z.ZodString;
            identity: z.ZodString;
            status: z.ZodUnion<
              [
                z.ZodEnum<{
                  dead: 'dead';
                  idle: 'idle';
                  stalled: 'stalled';
                  working: 'working';
                }>,
                z.ZodString,
              ]
            >;
            current_hook_bead_id: z.ZodNullable<z.ZodString>;
            dispatch_attempts: z.ZodDefault<z.ZodNumber>;
            last_activity_at: z.ZodNullable<z.ZodString>;
            checkpoint: z.ZodOptional<z.ZodUnknown>;
            created_at: z.ZodString;
            agent_status_message: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
            agent_status_updated_at: z.ZodDefault<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
          },
          z.core.$strip
        >
      >;
      beads: z.ZodArray<
        z.ZodObject<
          {
            bead_id: z.ZodString;
            type: z.ZodEnum<{
              agent: 'agent';
              convoy: 'convoy';
              escalation: 'escalation';
              issue: 'issue';
              merge_request: 'merge_request';
              message: 'message';
              molecule: 'molecule';
            }>;
            status: z.ZodEnum<{
              closed: 'closed';
              failed: 'failed';
              in_progress: 'in_progress';
              in_review: 'in_review';
              open: 'open';
            }>;
            title: z.ZodString;
            body: z.ZodNullable<z.ZodString>;
            rig_id: z.ZodNullable<z.ZodString>;
            parent_bead_id: z.ZodNullable<z.ZodString>;
            assignee_agent_bead_id: z.ZodNullable<z.ZodString>;
            priority: z.ZodEnum<{
              critical: 'critical';
              high: 'high';
              low: 'low';
              medium: 'medium';
            }>;
            labels: z.ZodArray<z.ZodString>;
            metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            created_by: z.ZodNullable<z.ZodString>;
            created_at: z.ZodString;
            updated_at: z.ZodString;
            closed_at: z.ZodNullable<z.ZodString>;
          },
          z.core.$strip
        >
      >;
    },
    z.core.$strip
  >
>;
export declare const MergeQueueDataOutput: z.ZodObject<
  {
    needsAttention: z.ZodObject<
      {
        openPRs: z.ZodArray<
          z.ZodObject<
            {
              mrBead: z.ZodObject<
                {
                  bead_id: z.ZodString;
                  status: z.ZodString;
                  title: z.ZodString;
                  body: z.ZodNullable<z.ZodString>;
                  rig_id: z.ZodNullable<z.ZodString>;
                  created_at: z.ZodString;
                  updated_at: z.ZodString;
                  metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                },
                z.core.$strip
              >;
              reviewMetadata: z.ZodObject<
                {
                  branch: z.ZodString;
                  target_branch: z.ZodString;
                  merge_commit: z.ZodNullable<z.ZodString>;
                  pr_url: z.ZodNullable<z.ZodString>;
                  retry_count: z.ZodNumber;
                },
                z.core.$strip
              >;
              sourceBead: z.ZodNullable<
                z.ZodObject<
                  {
                    bead_id: z.ZodString;
                    title: z.ZodString;
                    status: z.ZodString;
                    body: z.ZodNullable<z.ZodString>;
                  },
                  z.core.$strip
                >
              >;
              convoy: z.ZodNullable<
                z.ZodObject<
                  {
                    convoy_id: z.ZodString;
                    title: z.ZodString;
                    total_beads: z.ZodNumber;
                    closed_beads: z.ZodNumber;
                    feature_branch: z.ZodNullable<z.ZodString>;
                    merge_mode: z.ZodNullable<z.ZodString>;
                  },
                  z.core.$strip
                >
              >;
              agent: z.ZodNullable<
                z.ZodObject<
                  {
                    agent_id: z.ZodString;
                    name: z.ZodString;
                    role: z.ZodString;
                  },
                  z.core.$strip
                >
              >;
              rigName: z.ZodNullable<z.ZodString>;
              staleSince: z.ZodNullable<z.ZodString>;
              failureReason: z.ZodNullable<z.ZodString>;
            },
            z.core.$strip
          >
        >;
        failedReviews: z.ZodArray<
          z.ZodObject<
            {
              mrBead: z.ZodObject<
                {
                  bead_id: z.ZodString;
                  status: z.ZodString;
                  title: z.ZodString;
                  body: z.ZodNullable<z.ZodString>;
                  rig_id: z.ZodNullable<z.ZodString>;
                  created_at: z.ZodString;
                  updated_at: z.ZodString;
                  metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                },
                z.core.$strip
              >;
              reviewMetadata: z.ZodObject<
                {
                  branch: z.ZodString;
                  target_branch: z.ZodString;
                  merge_commit: z.ZodNullable<z.ZodString>;
                  pr_url: z.ZodNullable<z.ZodString>;
                  retry_count: z.ZodNumber;
                },
                z.core.$strip
              >;
              sourceBead: z.ZodNullable<
                z.ZodObject<
                  {
                    bead_id: z.ZodString;
                    title: z.ZodString;
                    status: z.ZodString;
                    body: z.ZodNullable<z.ZodString>;
                  },
                  z.core.$strip
                >
              >;
              convoy: z.ZodNullable<
                z.ZodObject<
                  {
                    convoy_id: z.ZodString;
                    title: z.ZodString;
                    total_beads: z.ZodNumber;
                    closed_beads: z.ZodNumber;
                    feature_branch: z.ZodNullable<z.ZodString>;
                    merge_mode: z.ZodNullable<z.ZodString>;
                  },
                  z.core.$strip
                >
              >;
              agent: z.ZodNullable<
                z.ZodObject<
                  {
                    agent_id: z.ZodString;
                    name: z.ZodString;
                    role: z.ZodString;
                  },
                  z.core.$strip
                >
              >;
              rigName: z.ZodNullable<z.ZodString>;
              staleSince: z.ZodNullable<z.ZodString>;
              failureReason: z.ZodNullable<z.ZodString>;
            },
            z.core.$strip
          >
        >;
        stalePRs: z.ZodArray<
          z.ZodObject<
            {
              mrBead: z.ZodObject<
                {
                  bead_id: z.ZodString;
                  status: z.ZodString;
                  title: z.ZodString;
                  body: z.ZodNullable<z.ZodString>;
                  rig_id: z.ZodNullable<z.ZodString>;
                  created_at: z.ZodString;
                  updated_at: z.ZodString;
                  metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                },
                z.core.$strip
              >;
              reviewMetadata: z.ZodObject<
                {
                  branch: z.ZodString;
                  target_branch: z.ZodString;
                  merge_commit: z.ZodNullable<z.ZodString>;
                  pr_url: z.ZodNullable<z.ZodString>;
                  retry_count: z.ZodNumber;
                },
                z.core.$strip
              >;
              sourceBead: z.ZodNullable<
                z.ZodObject<
                  {
                    bead_id: z.ZodString;
                    title: z.ZodString;
                    status: z.ZodString;
                    body: z.ZodNullable<z.ZodString>;
                  },
                  z.core.$strip
                >
              >;
              convoy: z.ZodNullable<
                z.ZodObject<
                  {
                    convoy_id: z.ZodString;
                    title: z.ZodString;
                    total_beads: z.ZodNumber;
                    closed_beads: z.ZodNumber;
                    feature_branch: z.ZodNullable<z.ZodString>;
                    merge_mode: z.ZodNullable<z.ZodString>;
                  },
                  z.core.$strip
                >
              >;
              agent: z.ZodNullable<
                z.ZodObject<
                  {
                    agent_id: z.ZodString;
                    name: z.ZodString;
                    role: z.ZodString;
                  },
                  z.core.$strip
                >
              >;
              rigName: z.ZodNullable<z.ZodString>;
              staleSince: z.ZodNullable<z.ZodString>;
              failureReason: z.ZodNullable<z.ZodString>;
            },
            z.core.$strip
          >
        >;
      },
      z.core.$strip
    >;
    activityLog: z.ZodArray<
      z.ZodObject<
        {
          event: z.ZodObject<
            {
              bead_event_id: z.ZodString;
              bead_id: z.ZodString;
              agent_id: z.ZodNullable<z.ZodString>;
              event_type: z.ZodString;
              old_value: z.ZodNullable<z.ZodString>;
              new_value: z.ZodNullable<z.ZodString>;
              metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
              created_at: z.ZodString;
            },
            z.core.$strip
          >;
          mrBead: z.ZodNullable<
            z.ZodObject<
              {
                bead_id: z.ZodString;
                title: z.ZodString;
                type: z.ZodString;
                status: z.ZodString;
                rig_id: z.ZodNullable<z.ZodString>;
                metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
              },
              z.core.$strip
            >
          >;
          sourceBead: z.ZodNullable<
            z.ZodObject<
              {
                bead_id: z.ZodString;
                title: z.ZodString;
                status: z.ZodString;
              },
              z.core.$strip
            >
          >;
          convoy: z.ZodNullable<
            z.ZodObject<
              {
                convoy_id: z.ZodString;
                title: z.ZodString;
                total_beads: z.ZodNumber;
                closed_beads: z.ZodNumber;
                feature_branch: z.ZodNullable<z.ZodString>;
                merge_mode: z.ZodNullable<z.ZodString>;
              },
              z.core.$strip
            >
          >;
          agent: z.ZodNullable<
            z.ZodObject<
              {
                agent_id: z.ZodString;
                name: z.ZodString;
                role: z.ZodString;
              },
              z.core.$strip
            >
          >;
          rigName: z.ZodNullable<z.ZodString>;
          reviewMetadata: z.ZodNullable<
            z.ZodObject<
              {
                pr_url: z.ZodNullable<z.ZodString>;
                branch: z.ZodNullable<z.ZodString>;
                target_branch: z.ZodNullable<z.ZodString>;
                merge_commit: z.ZodNullable<z.ZodString>;
              },
              z.core.$strip
            >
          >;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$strip
>;
export declare const RpcMergeQueueDataOutput: z.ZodPipe<
  z.ZodAny,
  z.ZodObject<
    {
      needsAttention: z.ZodObject<
        {
          openPRs: z.ZodArray<
            z.ZodObject<
              {
                mrBead: z.ZodObject<
                  {
                    bead_id: z.ZodString;
                    status: z.ZodString;
                    title: z.ZodString;
                    body: z.ZodNullable<z.ZodString>;
                    rig_id: z.ZodNullable<z.ZodString>;
                    created_at: z.ZodString;
                    updated_at: z.ZodString;
                    metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                  },
                  z.core.$strip
                >;
                reviewMetadata: z.ZodObject<
                  {
                    branch: z.ZodString;
                    target_branch: z.ZodString;
                    merge_commit: z.ZodNullable<z.ZodString>;
                    pr_url: z.ZodNullable<z.ZodString>;
                    retry_count: z.ZodNumber;
                  },
                  z.core.$strip
                >;
                sourceBead: z.ZodNullable<
                  z.ZodObject<
                    {
                      bead_id: z.ZodString;
                      title: z.ZodString;
                      status: z.ZodString;
                      body: z.ZodNullable<z.ZodString>;
                    },
                    z.core.$strip
                  >
                >;
                convoy: z.ZodNullable<
                  z.ZodObject<
                    {
                      convoy_id: z.ZodString;
                      title: z.ZodString;
                      total_beads: z.ZodNumber;
                      closed_beads: z.ZodNumber;
                      feature_branch: z.ZodNullable<z.ZodString>;
                      merge_mode: z.ZodNullable<z.ZodString>;
                    },
                    z.core.$strip
                  >
                >;
                agent: z.ZodNullable<
                  z.ZodObject<
                    {
                      agent_id: z.ZodString;
                      name: z.ZodString;
                      role: z.ZodString;
                    },
                    z.core.$strip
                  >
                >;
                rigName: z.ZodNullable<z.ZodString>;
                staleSince: z.ZodNullable<z.ZodString>;
                failureReason: z.ZodNullable<z.ZodString>;
              },
              z.core.$strip
            >
          >;
          failedReviews: z.ZodArray<
            z.ZodObject<
              {
                mrBead: z.ZodObject<
                  {
                    bead_id: z.ZodString;
                    status: z.ZodString;
                    title: z.ZodString;
                    body: z.ZodNullable<z.ZodString>;
                    rig_id: z.ZodNullable<z.ZodString>;
                    created_at: z.ZodString;
                    updated_at: z.ZodString;
                    metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                  },
                  z.core.$strip
                >;
                reviewMetadata: z.ZodObject<
                  {
                    branch: z.ZodString;
                    target_branch: z.ZodString;
                    merge_commit: z.ZodNullable<z.ZodString>;
                    pr_url: z.ZodNullable<z.ZodString>;
                    retry_count: z.ZodNumber;
                  },
                  z.core.$strip
                >;
                sourceBead: z.ZodNullable<
                  z.ZodObject<
                    {
                      bead_id: z.ZodString;
                      title: z.ZodString;
                      status: z.ZodString;
                      body: z.ZodNullable<z.ZodString>;
                    },
                    z.core.$strip
                  >
                >;
                convoy: z.ZodNullable<
                  z.ZodObject<
                    {
                      convoy_id: z.ZodString;
                      title: z.ZodString;
                      total_beads: z.ZodNumber;
                      closed_beads: z.ZodNumber;
                      feature_branch: z.ZodNullable<z.ZodString>;
                      merge_mode: z.ZodNullable<z.ZodString>;
                    },
                    z.core.$strip
                  >
                >;
                agent: z.ZodNullable<
                  z.ZodObject<
                    {
                      agent_id: z.ZodString;
                      name: z.ZodString;
                      role: z.ZodString;
                    },
                    z.core.$strip
                  >
                >;
                rigName: z.ZodNullable<z.ZodString>;
                staleSince: z.ZodNullable<z.ZodString>;
                failureReason: z.ZodNullable<z.ZodString>;
              },
              z.core.$strip
            >
          >;
          stalePRs: z.ZodArray<
            z.ZodObject<
              {
                mrBead: z.ZodObject<
                  {
                    bead_id: z.ZodString;
                    status: z.ZodString;
                    title: z.ZodString;
                    body: z.ZodNullable<z.ZodString>;
                    rig_id: z.ZodNullable<z.ZodString>;
                    created_at: z.ZodString;
                    updated_at: z.ZodString;
                    metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                  },
                  z.core.$strip
                >;
                reviewMetadata: z.ZodObject<
                  {
                    branch: z.ZodString;
                    target_branch: z.ZodString;
                    merge_commit: z.ZodNullable<z.ZodString>;
                    pr_url: z.ZodNullable<z.ZodString>;
                    retry_count: z.ZodNumber;
                  },
                  z.core.$strip
                >;
                sourceBead: z.ZodNullable<
                  z.ZodObject<
                    {
                      bead_id: z.ZodString;
                      title: z.ZodString;
                      status: z.ZodString;
                      body: z.ZodNullable<z.ZodString>;
                    },
                    z.core.$strip
                  >
                >;
                convoy: z.ZodNullable<
                  z.ZodObject<
                    {
                      convoy_id: z.ZodString;
                      title: z.ZodString;
                      total_beads: z.ZodNumber;
                      closed_beads: z.ZodNumber;
                      feature_branch: z.ZodNullable<z.ZodString>;
                      merge_mode: z.ZodNullable<z.ZodString>;
                    },
                    z.core.$strip
                  >
                >;
                agent: z.ZodNullable<
                  z.ZodObject<
                    {
                      agent_id: z.ZodString;
                      name: z.ZodString;
                      role: z.ZodString;
                    },
                    z.core.$strip
                  >
                >;
                rigName: z.ZodNullable<z.ZodString>;
                staleSince: z.ZodNullable<z.ZodString>;
                failureReason: z.ZodNullable<z.ZodString>;
              },
              z.core.$strip
            >
          >;
        },
        z.core.$strip
      >;
      activityLog: z.ZodArray<
        z.ZodObject<
          {
            event: z.ZodObject<
              {
                bead_event_id: z.ZodString;
                bead_id: z.ZodString;
                agent_id: z.ZodNullable<z.ZodString>;
                event_type: z.ZodString;
                old_value: z.ZodNullable<z.ZodString>;
                new_value: z.ZodNullable<z.ZodString>;
                metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                created_at: z.ZodString;
              },
              z.core.$strip
            >;
            mrBead: z.ZodNullable<
              z.ZodObject<
                {
                  bead_id: z.ZodString;
                  title: z.ZodString;
                  type: z.ZodString;
                  status: z.ZodString;
                  rig_id: z.ZodNullable<z.ZodString>;
                  metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
                },
                z.core.$strip
              >
            >;
            sourceBead: z.ZodNullable<
              z.ZodObject<
                {
                  bead_id: z.ZodString;
                  title: z.ZodString;
                  status: z.ZodString;
                },
                z.core.$strip
              >
            >;
            convoy: z.ZodNullable<
              z.ZodObject<
                {
                  convoy_id: z.ZodString;
                  title: z.ZodString;
                  total_beads: z.ZodNumber;
                  closed_beads: z.ZodNumber;
                  feature_branch: z.ZodNullable<z.ZodString>;
                  merge_mode: z.ZodNullable<z.ZodString>;
                },
                z.core.$strip
              >
            >;
            agent: z.ZodNullable<
              z.ZodObject<
                {
                  agent_id: z.ZodString;
                  name: z.ZodString;
                  role: z.ZodString;
                },
                z.core.$strip
              >
            >;
            rigName: z.ZodNullable<z.ZodString>;
            reviewMetadata: z.ZodNullable<
              z.ZodObject<
                {
                  pr_url: z.ZodNullable<z.ZodString>;
                  branch: z.ZodNullable<z.ZodString>;
                  target_branch: z.ZodNullable<z.ZodString>;
                  merge_commit: z.ZodNullable<z.ZodString>;
                },
                z.core.$strip
              >
            >;
          },
          z.core.$strip
        >
      >;
    },
    z.core.$strip
  >
>;
export declare const OrgTownOutput: z.ZodObject<
  {
    id: z.ZodString;
    name: z.ZodString;
    owner_org_id: z.ZodString;
    created_by_user_id: z.ZodString;
    created_at: z.ZodString;
    updated_at: z.ZodString;
  },
  z.core.$strip
>;
export declare const RpcOrgTownOutput: z.ZodPipe<
  z.ZodAny,
  z.ZodObject<
    {
      id: z.ZodString;
      name: z.ZodString;
      owner_org_id: z.ZodString;
      created_by_user_id: z.ZodString;
      created_at: z.ZodString;
      updated_at: z.ZodString;
    },
    z.core.$strip
  >
>;
