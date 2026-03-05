/* eslint-disable @typescript-eslint/consistent-type-imports */
import type { TRPCContext } from './init';
export declare const gastownRouter: import('@trpc/server').TRPCBuiltRouter<
  {
    ctx: TRPCContext;
    meta: object;
    errorShape: import('@trpc/server').TRPCDefaultErrorShape;
    transformer: false;
  },
  import('@trpc/server').TRPCDecorateCreateRouterOptions<{
    createTown: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        name: string;
      };
      output: {
        id: string;
        name: string;
        owner_user_id: string;
        created_at: string;
        updated_at: string;
      };
      meta: object;
    }>;
    listTowns: import('@trpc/server').TRPCQueryProcedure<{
      input: void;
      output: {
        id: string;
        name: string;
        owner_user_id: string;
        created_at: string;
        updated_at: string;
      }[];
      meta: object;
    }>;
    getTown: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        townId: string;
      };
      output: {
        id: string;
        name: string;
        owner_user_id: string;
        created_at: string;
        updated_at: string;
      };
      meta: object;
    }>;
    deleteTown: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
      };
      output: void;
      meta: object;
    }>;
    createRig: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
        name: string;
        gitUrl: string;
        defaultBranch?: string;
        platformIntegrationId?: string;
      };
      output: {
        id: string;
        town_id: string;
        name: string;
        git_url: string;
        default_branch: string;
        platform_integration_id: string;
        created_at: string;
        updated_at: string;
      };
      meta: object;
    }>;
    listRigs: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        townId: string;
      };
      output: {
        id: string;
        town_id: string;
        name: string;
        git_url: string;
        default_branch: string;
        platform_integration_id: string;
        created_at: string;
        updated_at: string;
      }[];
      meta: object;
    }>;
    getRig: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        rigId: string;
      };
      output: {
        id: string;
        town_id: string;
        name: string;
        git_url: string;
        default_branch: string;
        platform_integration_id: string;
        created_at: string;
        updated_at: string;
        agents: {
          id: string;
          rig_id: string | null;
          role: 'mayor' | 'polecat' | 'refinery' | 'witness';
          name: string;
          identity: string;
          status: 'dead' | 'idle' | 'stalled' | 'working';
          current_hook_bead_id: string | null;
          dispatch_attempts: number;
          last_activity_at: string | null;
          checkpoint?: unknown;
          created_at: string;
        }[];
        beads: {
          bead_id: string;
          type:
            | 'agent'
            | 'convoy'
            | 'escalation'
            | 'issue'
            | 'merge_request'
            | 'message'
            | 'molecule';
          status: 'closed' | 'failed' | 'in_progress' | 'open';
          title: string;
          body: string | null;
          rig_id: string | null;
          parent_bead_id: string | null;
          assignee_agent_bead_id: string | null;
          priority: 'critical' | 'high' | 'low' | 'medium';
          labels: string[];
          metadata: Record<string, unknown>;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          closed_at: string | null;
        }[];
      };
      meta: object;
    }>;
    deleteRig: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        rigId: string;
      };
      output: void;
      meta: object;
    }>;
    listBeads: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        rigId: string;
        status?: 'closed' | 'failed' | 'in_progress' | 'open';
      };
      output: {
        bead_id: string;
        type:
          | 'agent'
          | 'convoy'
          | 'escalation'
          | 'issue'
          | 'merge_request'
          | 'message'
          | 'molecule';
        status: 'closed' | 'failed' | 'in_progress' | 'open';
        title: string;
        body: string | null;
        rig_id: string | null;
        parent_bead_id: string | null;
        assignee_agent_bead_id: string | null;
        priority: 'critical' | 'high' | 'low' | 'medium';
        labels: string[];
        metadata: Record<string, unknown>;
        created_by: string | null;
        created_at: string;
        updated_at: string;
        closed_at: string | null;
      }[];
      meta: object;
    }>;
    deleteBead: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        rigId: string;
        beadId: string;
      };
      output: void;
      meta: object;
    }>;
    listAgents: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        rigId: string;
      };
      output: {
        id: string;
        rig_id: string | null;
        role: 'mayor' | 'polecat' | 'refinery' | 'witness';
        name: string;
        identity: string;
        status: 'dead' | 'idle' | 'stalled' | 'working';
        current_hook_bead_id: string | null;
        dispatch_attempts: number;
        last_activity_at: string | null;
        checkpoint?: unknown;
        created_at: string;
      }[];
      meta: object;
    }>;
    deleteAgent: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        rigId: string;
        agentId: string;
      };
      output: void;
      meta: object;
    }>;
    sling: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        rigId: string;
        title: string;
        body?: string;
        model?: string;
      };
      output: {
        bead: {
          bead_id: string;
          type:
            | 'agent'
            | 'convoy'
            | 'escalation'
            | 'issue'
            | 'merge_request'
            | 'message'
            | 'molecule';
          status: 'closed' | 'failed' | 'in_progress' | 'open';
          title: string;
          body: string | null;
          rig_id: string | null;
          parent_bead_id: string | null;
          assignee_agent_bead_id: string | null;
          priority: 'critical' | 'high' | 'low' | 'medium';
          labels: string[];
          metadata: Record<string, unknown>;
          created_by: string | null;
          created_at: string;
          updated_at: string;
          closed_at: string | null;
        };
        agent: {
          id: string;
          rig_id: string | null;
          role: 'mayor' | 'polecat' | 'refinery' | 'witness';
          name: string;
          identity: string;
          status: 'dead' | 'idle' | 'stalled' | 'working';
          current_hook_bead_id: string | null;
          dispatch_attempts: number;
          last_activity_at: string | null;
          checkpoint?: unknown;
          created_at: string;
        };
      };
      meta: object;
    }>;
    sendMessage: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
        message: string;
        model?: string;
        rigId?: string;
      };
      output: {
        agentId: string;
        sessionStatus: 'active' | 'idle' | 'starting';
      };
      meta: object;
    }>;
    getMayorStatus: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        townId: string;
      };
      output: {
        configured: boolean;
        townId?: string;
        session?: {
          agentId: string;
          sessionId: string;
          status: 'active' | 'idle' | 'starting';
          lastActivityAt: string;
        };
      };
      meta: object;
    }>;
    ensureMayor: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
      };
      output: {
        agentId: string;
        sessionStatus: 'active' | 'idle' | 'starting';
      };
      meta: object;
    }>;
    getAgentStreamUrl: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        agentId: string;
        townId: string;
      };
      output: {
        url: string;
        ticket: string;
      };
      meta: object;
    }>;
    createPtySession: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
        agentId: string;
      };
      output: {
        pty: {
          [x: string]: unknown;
          id: string;
        };
        wsUrl: string;
      };
      meta: object;
    }>;
    resizePtySession: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
        agentId: string;
        ptyId: string;
        cols: number;
        rows: number;
      };
      output: void;
      meta: object;
    }>;
    getTownConfig: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        townId: string;
      };
      output: {
        env_vars: Record<string, string>;
        git_auth: {
          github_token?: string;
          gitlab_token?: string;
          gitlab_instance_url?: string;
          platform_integration_id?: string;
        };
        owner_user_id?: string;
        kilocode_token?: string;
        default_model?: string;
        small_model?: string;
        max_polecats_per_rig?: number;
        merge_strategy: 'direct' | 'pr';
        refinery?: {
          gates: string[];
          auto_merge: boolean;
          require_clean_merge: boolean;
        };
        alarm_interval_active?: number;
        alarm_interval_idle?: number;
        container?: {
          sleep_after_minutes?: number;
        };
      };
      meta: object;
    }>;
    updateTownConfig: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
        config: Record<string, unknown>;
      };
      output: {
        env_vars: Record<string, string>;
        git_auth: {
          github_token?: string;
          gitlab_token?: string;
          gitlab_instance_url?: string;
          platform_integration_id?: string;
        };
        owner_user_id?: string;
        kilocode_token?: string;
        default_model?: string;
        small_model?: string;
        max_polecats_per_rig?: number;
        merge_strategy: 'direct' | 'pr';
        refinery?: {
          gates: string[];
          auto_merge: boolean;
          require_clean_merge: boolean;
        };
        alarm_interval_active?: number;
        alarm_interval_idle?: number;
        container?: {
          sleep_after_minutes?: number;
        };
      };
      meta: object;
    }>;
    getBeadEvents: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        rigId: string;
        beadId?: string;
        since?: string;
        limit?: number;
      };
      output: {
        bead_event_id: string;
        bead_id: string;
        agent_id: string | null;
        event_type: string;
        old_value: string | null;
        new_value: string | null;
        metadata: Record<string, unknown>;
        created_at: string;
        rig_id: string | null;
        rig_name?: string;
      }[];
      meta: object;
    }>;
    getTownEvents: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        townId: string;
        since?: string;
        limit?: number;
      };
      output: {
        bead_event_id: string;
        bead_id: string;
        agent_id: string | null;
        event_type: string;
        old_value: string | null;
        new_value: string | null;
        metadata: Record<string, unknown>;
        created_at: string;
        rig_id: string | null;
        rig_name?: string;
      }[];
      meta: object;
    }>;
  }>
>;
export type GastownRouter = typeof gastownRouter;
/**
 * Wrapped router that nests gastownRouter under a `gastown` key.
 * This preserves the `trpc.gastown.X` call pattern on the frontend,
 * matching the existing RootRouter shape so components don't need
 * to change their procedure paths.
 */
export declare const wrappedGastownRouter: import('@trpc/server').TRPCBuiltRouter<
  {
    ctx: TRPCContext;
    meta: object;
    errorShape: import('@trpc/server').TRPCDefaultErrorShape;
    transformer: false;
  },
  import('@trpc/server').TRPCDecorateCreateRouterOptions<{
    gastown: import('@trpc/server').TRPCBuiltRouter<
      {
        ctx: TRPCContext;
        meta: object;
        errorShape: import('@trpc/server').TRPCDefaultErrorShape;
        transformer: false;
      },
      import('@trpc/server').TRPCDecorateCreateRouterOptions<{
        createTown: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            name: string;
          };
          output: {
            id: string;
            name: string;
            owner_user_id: string;
            created_at: string;
            updated_at: string;
          };
          meta: object;
        }>;
        listTowns: import('@trpc/server').TRPCQueryProcedure<{
          input: void;
          output: {
            id: string;
            name: string;
            owner_user_id: string;
            created_at: string;
            updated_at: string;
          }[];
          meta: object;
        }>;
        getTown: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            townId: string;
          };
          output: {
            id: string;
            name: string;
            owner_user_id: string;
            created_at: string;
            updated_at: string;
          };
          meta: object;
        }>;
        deleteTown: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
          };
          output: void;
          meta: object;
        }>;
        createRig: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
            name: string;
            gitUrl: string;
            defaultBranch?: string;
            platformIntegrationId?: string;
          };
          output: {
            id: string;
            town_id: string;
            name: string;
            git_url: string;
            default_branch: string;
            platform_integration_id: string;
            created_at: string;
            updated_at: string;
          };
          meta: object;
        }>;
        listRigs: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            townId: string;
          };
          output: {
            id: string;
            town_id: string;
            name: string;
            git_url: string;
            default_branch: string;
            platform_integration_id: string;
            created_at: string;
            updated_at: string;
          }[];
          meta: object;
        }>;
        getRig: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            rigId: string;
          };
          output: {
            id: string;
            town_id: string;
            name: string;
            git_url: string;
            default_branch: string;
            platform_integration_id: string;
            created_at: string;
            updated_at: string;
            agents: {
              id: string;
              rig_id: string | null;
              role: 'mayor' | 'polecat' | 'refinery' | 'witness';
              name: string;
              identity: string;
              status: 'dead' | 'idle' | 'stalled' | 'working';
              current_hook_bead_id: string | null;
              dispatch_attempts: number;
              last_activity_at: string | null;
              checkpoint?: unknown;
              created_at: string;
            }[];
            beads: {
              bead_id: string;
              type:
                | 'agent'
                | 'convoy'
                | 'escalation'
                | 'issue'
                | 'merge_request'
                | 'message'
                | 'molecule';
              status: 'closed' | 'failed' | 'in_progress' | 'open';
              title: string;
              body: string | null;
              rig_id: string | null;
              parent_bead_id: string | null;
              assignee_agent_bead_id: string | null;
              priority: 'critical' | 'high' | 'low' | 'medium';
              labels: string[];
              metadata: Record<string, unknown>;
              created_by: string | null;
              created_at: string;
              updated_at: string;
              closed_at: string | null;
            }[];
          };
          meta: object;
        }>;
        deleteRig: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            rigId: string;
          };
          output: void;
          meta: object;
        }>;
        listBeads: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            rigId: string;
            status?: 'closed' | 'failed' | 'in_progress' | 'open';
          };
          output: {
            bead_id: string;
            type:
              | 'agent'
              | 'convoy'
              | 'escalation'
              | 'issue'
              | 'merge_request'
              | 'message'
              | 'molecule';
            status: 'closed' | 'failed' | 'in_progress' | 'open';
            title: string;
            body: string | null;
            rig_id: string | null;
            parent_bead_id: string | null;
            assignee_agent_bead_id: string | null;
            priority: 'critical' | 'high' | 'low' | 'medium';
            labels: string[];
            metadata: Record<string, unknown>;
            created_by: string | null;
            created_at: string;
            updated_at: string;
            closed_at: string | null;
          }[];
          meta: object;
        }>;
        deleteBead: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            rigId: string;
            beadId: string;
          };
          output: void;
          meta: object;
        }>;
        listAgents: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            rigId: string;
          };
          output: {
            id: string;
            rig_id: string | null;
            role: 'mayor' | 'polecat' | 'refinery' | 'witness';
            name: string;
            identity: string;
            status: 'dead' | 'idle' | 'stalled' | 'working';
            current_hook_bead_id: string | null;
            dispatch_attempts: number;
            last_activity_at: string | null;
            checkpoint?: unknown;
            created_at: string;
          }[];
          meta: object;
        }>;
        deleteAgent: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            rigId: string;
            agentId: string;
          };
          output: void;
          meta: object;
        }>;
        sling: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            rigId: string;
            title: string;
            body?: string;
            model?: string;
          };
          output: {
            bead: {
              bead_id: string;
              type:
                | 'agent'
                | 'convoy'
                | 'escalation'
                | 'issue'
                | 'merge_request'
                | 'message'
                | 'molecule';
              status: 'closed' | 'failed' | 'in_progress' | 'open';
              title: string;
              body: string | null;
              rig_id: string | null;
              parent_bead_id: string | null;
              assignee_agent_bead_id: string | null;
              priority: 'critical' | 'high' | 'low' | 'medium';
              labels: string[];
              metadata: Record<string, unknown>;
              created_by: string | null;
              created_at: string;
              updated_at: string;
              closed_at: string | null;
            };
            agent: {
              id: string;
              rig_id: string | null;
              role: 'mayor' | 'polecat' | 'refinery' | 'witness';
              name: string;
              identity: string;
              status: 'dead' | 'idle' | 'stalled' | 'working';
              current_hook_bead_id: string | null;
              dispatch_attempts: number;
              last_activity_at: string | null;
              checkpoint?: unknown;
              created_at: string;
            };
          };
          meta: object;
        }>;
        sendMessage: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
            message: string;
            model?: string;
            rigId?: string;
          };
          output: {
            agentId: string;
            sessionStatus: 'active' | 'idle' | 'starting';
          };
          meta: object;
        }>;
        getMayorStatus: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            townId: string;
          };
          output: {
            configured: boolean;
            townId?: string;
            session?: {
              agentId: string;
              sessionId: string;
              status: 'active' | 'idle' | 'starting';
              lastActivityAt: string;
            };
          };
          meta: object;
        }>;
        ensureMayor: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
          };
          output: {
            agentId: string;
            sessionStatus: 'active' | 'idle' | 'starting';
          };
          meta: object;
        }>;
        getAgentStreamUrl: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            agentId: string;
            townId: string;
          };
          output: {
            url: string;
            ticket: string;
          };
          meta: object;
        }>;
        createPtySession: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
            agentId: string;
          };
          output: {
            pty: {
              [x: string]: unknown;
              id: string;
            };
            wsUrl: string;
          };
          meta: object;
        }>;
        resizePtySession: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
            agentId: string;
            ptyId: string;
            cols: number;
            rows: number;
          };
          output: void;
          meta: object;
        }>;
        getTownConfig: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            townId: string;
          };
          output: {
            env_vars: Record<string, string>;
            git_auth: {
              github_token?: string;
              gitlab_token?: string;
              gitlab_instance_url?: string;
              platform_integration_id?: string;
            };
            owner_user_id?: string;
            kilocode_token?: string;
            default_model?: string;
            small_model?: string;
            max_polecats_per_rig?: number;
            merge_strategy: 'direct' | 'pr';
            refinery?: {
              gates: string[];
              auto_merge: boolean;
              require_clean_merge: boolean;
            };
            alarm_interval_active?: number;
            alarm_interval_idle?: number;
            container?: {
              sleep_after_minutes?: number;
            };
          };
          meta: object;
        }>;
        updateTownConfig: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
            config: Record<string, unknown>;
          };
          output: {
            env_vars: Record<string, string>;
            git_auth: {
              github_token?: string;
              gitlab_token?: string;
              gitlab_instance_url?: string;
              platform_integration_id?: string;
            };
            owner_user_id?: string;
            kilocode_token?: string;
            default_model?: string;
            small_model?: string;
            max_polecats_per_rig?: number;
            merge_strategy: 'direct' | 'pr';
            refinery?: {
              gates: string[];
              auto_merge: boolean;
              require_clean_merge: boolean;
            };
            alarm_interval_active?: number;
            alarm_interval_idle?: number;
            container?: {
              sleep_after_minutes?: number;
            };
          };
          meta: object;
        }>;
        getBeadEvents: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            rigId: string;
            beadId?: string;
            since?: string;
            limit?: number;
          };
          output: {
            bead_event_id: string;
            bead_id: string;
            agent_id: string | null;
            event_type: string;
            old_value: string | null;
            new_value: string | null;
            metadata: Record<string, unknown>;
            created_at: string;
            rig_id: string | null;
            rig_name?: string;
          }[];
          meta: object;
        }>;
        getTownEvents: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            townId: string;
            since?: string;
            limit?: number;
          };
          output: {
            bead_event_id: string;
            bead_id: string;
            agent_id: string | null;
            event_type: string;
            old_value: string | null;
            new_value: string | null;
            metadata: Record<string, unknown>;
            created_at: string;
            rig_id: string | null;
            rig_name?: string;
          }[];
          meta: object;
        }>;
      }>
    >;
  }>
>;
export type WrappedGastownRouter = typeof wrappedGastownRouter;
