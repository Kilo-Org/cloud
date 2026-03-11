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
        defaultBranch?: string | undefined;
        platformIntegrationId?: string | undefined;
      };
      output: {
        id: string;
        town_id: string;
        name: string;
        git_url: string;
        default_branch: string;
        platform_integration_id: string | null;
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
        platform_integration_id: string | null;
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
        platform_integration_id: string | null;
        created_at: string;
        updated_at: string;
        agents: {
          id: string;
          rig_id: string | null;
          role: string;
          name: string;
          identity: string;
          status: string;
          current_hook_bead_id: string | null;
          dispatch_attempts: number;
          last_activity_at: string | null;
          checkpoint?: unknown;
          created_at: string;
          agent_status_message?: string | null;
          agent_status_updated_at?: string | null;
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
        status?: 'closed' | 'failed' | 'in_progress' | 'open' | undefined;
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
        role: string;
        name: string;
        identity: string;
        status: string;
        current_hook_bead_id: string | null;
        dispatch_attempts: number;
        last_activity_at: string | null;
        checkpoint?: unknown;
        created_at: string;
        agent_status_message?: string | null;
        agent_status_updated_at?: string | null;
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
        body?: string | undefined;
        model?: string | undefined;
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
          role: string;
          name: string;
          identity: string;
          status: string;
          current_hook_bead_id: string | null;
          dispatch_attempts: number;
          last_activity_at: string | null;
          checkpoint?: unknown;
          created_at: string;
          agent_status_message?: string | null;
          agent_status_updated_at?: string | null;
        };
      };
      meta: object;
    }>;
    sendMessage: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
        message: string;
        model?: string | undefined;
        rigId?: string | undefined;
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
        townId: string | null;
        session: {
          agentId: string;
          sessionId: string;
          status: 'active' | 'idle' | 'starting';
          lastActivityAt: string;
        } | null;
      };
      meta: object;
    }>;
    getAlarmStatus: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        townId: string;
      };
      output: {
        alarm: {
          nextFireAt: string | null;
          intervalMs: number;
          intervalLabel: string;
        };
        agents: {
          working: number;
          idle: number;
          stalled: number;
          dead: number;
          total: number;
        };
        beads: {
          open: number;
          inProgress: number;
          failed: number;
          triageRequests: number;
        };
        patrol: {
          guppWarnings: number;
          guppEscalations: number;
          stalledAgents: number;
          orphanedHooks: number;
        };
        recentEvents: {
          time: string;
          type: string;
          message: string;
        }[];
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
          github_token?: string | undefined;
          gitlab_token?: string | undefined;
          gitlab_instance_url?: string | undefined;
          platform_integration_id?: string | undefined;
        };
        owner_user_id?: string | undefined;
        kilocode_token?: string | undefined;
        default_model?: string | undefined;
        small_model?: string | undefined;
        max_polecats_per_rig?: number | undefined;
        merge_strategy: 'direct' | 'pr';
        refinery?:
          | {
              gates: string[];
              auto_merge: boolean;
              require_clean_merge: boolean;
            }
          | undefined;
        alarm_interval_active?: number | undefined;
        alarm_interval_idle?: number | undefined;
        container?:
          | {
              sleep_after_minutes?: number | undefined;
            }
          | undefined;
      };
      meta: object;
    }>;
    updateTownConfig: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
        config: {
          env_vars?: Record<string, string> | undefined;
          git_auth?:
            | {
                github_token?: string | undefined;
                gitlab_token?: string | undefined;
                gitlab_instance_url?: string | undefined;
                platform_integration_id?: string | undefined;
              }
            | undefined;
          owner_user_id?: string | undefined;
          kilocode_token?: string | undefined;
          default_model?: string | undefined;
          small_model?: string | undefined;
          max_polecats_per_rig?: number | undefined;
          merge_strategy?: 'direct' | 'pr' | undefined;
          refinery?:
            | {
                gates?: string[] | undefined;
                auto_merge?: boolean | undefined;
                require_clean_merge?: boolean | undefined;
              }
            | undefined;
          alarm_interval_active?: number | undefined;
          alarm_interval_idle?: number | undefined;
          container?:
            | {
                sleep_after_minutes?: number | undefined;
              }
            | undefined;
        };
      };
      output: {
        env_vars: Record<string, string>;
        git_auth: {
          github_token?: string | undefined;
          gitlab_token?: string | undefined;
          gitlab_instance_url?: string | undefined;
          platform_integration_id?: string | undefined;
        };
        owner_user_id?: string | undefined;
        kilocode_token?: string | undefined;
        default_model?: string | undefined;
        small_model?: string | undefined;
        max_polecats_per_rig?: number | undefined;
        merge_strategy: 'direct' | 'pr';
        refinery?:
          | {
              gates: string[];
              auto_merge: boolean;
              require_clean_merge: boolean;
            }
          | undefined;
        alarm_interval_active?: number | undefined;
        alarm_interval_idle?: number | undefined;
        container?:
          | {
              sleep_after_minutes?: number | undefined;
            }
          | undefined;
      };
      meta: object;
    }>;
    getBeadEvents: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        rigId: string;
        beadId?: string | undefined;
        since?: string | undefined;
        limit?: number | undefined;
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
        rig_id?: string | undefined;
        rig_name?: string | undefined;
      }[];
      meta: object;
    }>;
    getTownEvents: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        townId: string;
        since?: string | undefined;
        limit?: number | undefined;
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
        rig_id?: string | undefined;
        rig_name?: string | undefined;
      }[];
      meta: object;
    }>;
    listConvoys: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        townId: string;
      };
      output: {
        id: string;
        title: string;
        status: 'active' | 'landed';
        total_beads: number;
        closed_beads: number;
        created_by: string | null;
        created_at: string;
        landed_at: string | null;
        feature_branch: string | null;
        merge_mode: string | null;
        beads: {
          bead_id: string;
          title: string;
          status: string;
          rig_id: string | null;
          assignee_agent_name: string | null;
        }[];
        dependency_edges: {
          bead_id: string;
          depends_on_bead_id: string;
        }[];
      }[];
      meta: object;
    }>;
    closeConvoy: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
        convoyId: string;
      };
      output: {
        id: string;
        title: string;
        status: 'active' | 'landed';
        total_beads: number;
        closed_beads: number;
        created_by: string | null;
        created_at: string;
        landed_at: string | null;
        feature_branch: string | null;
        merge_mode: string | null;
        beads: {
          bead_id: string;
          title: string;
          status: string;
          rig_id: string | null;
          assignee_agent_name: string | null;
        }[];
        dependency_edges: {
          bead_id: string;
          depends_on_bead_id: string;
        }[];
      } | null;
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
            defaultBranch?: string | undefined;
            platformIntegrationId?: string | undefined;
          };
          output: {
            id: string;
            town_id: string;
            name: string;
            git_url: string;
            default_branch: string;
            platform_integration_id: string | null;
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
            platform_integration_id: string | null;
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
            platform_integration_id: string | null;
            created_at: string;
            updated_at: string;
            agents: {
              id: string;
              rig_id: string | null;
              role: string;
              name: string;
              identity: string;
              status: string;
              current_hook_bead_id: string | null;
              dispatch_attempts: number;
              last_activity_at: string | null;
              checkpoint?: unknown;
              created_at: string;
              agent_status_message?: string | null;
              agent_status_updated_at?: string | null;
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
            status?: 'closed' | 'failed' | 'in_progress' | 'open' | undefined;
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
            role: string;
            name: string;
            identity: string;
            status: string;
            current_hook_bead_id: string | null;
            dispatch_attempts: number;
            last_activity_at: string | null;
            checkpoint?: unknown;
            created_at: string;
            agent_status_message?: string | null;
            agent_status_updated_at?: string | null;
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
            body?: string | undefined;
            model?: string | undefined;
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
              role: string;
              name: string;
              identity: string;
              status: string;
              current_hook_bead_id: string | null;
              dispatch_attempts: number;
              last_activity_at: string | null;
              checkpoint?: unknown;
              created_at: string;
              agent_status_message?: string | null;
              agent_status_updated_at?: string | null;
            };
          };
          meta: object;
        }>;
        sendMessage: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
            message: string;
            model?: string | undefined;
            rigId?: string | undefined;
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
            townId: string | null;
            session: {
              agentId: string;
              sessionId: string;
              status: 'active' | 'idle' | 'starting';
              lastActivityAt: string;
            } | null;
          };
          meta: object;
        }>;
        getAlarmStatus: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            townId: string;
          };
          output: {
            alarm: {
              nextFireAt: string | null;
              intervalMs: number;
              intervalLabel: string;
            };
            agents: {
              working: number;
              idle: number;
              stalled: number;
              dead: number;
              total: number;
            };
            beads: {
              open: number;
              inProgress: number;
              failed: number;
              triageRequests: number;
            };
            patrol: {
              guppWarnings: number;
              guppEscalations: number;
              stalledAgents: number;
              orphanedHooks: number;
            };
            recentEvents: {
              time: string;
              type: string;
              message: string;
            }[];
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
              github_token?: string | undefined;
              gitlab_token?: string | undefined;
              gitlab_instance_url?: string | undefined;
              platform_integration_id?: string | undefined;
            };
            owner_user_id?: string | undefined;
            kilocode_token?: string | undefined;
            default_model?: string | undefined;
            small_model?: string | undefined;
            max_polecats_per_rig?: number | undefined;
            merge_strategy: 'direct' | 'pr';
            refinery?:
              | {
                  gates: string[];
                  auto_merge: boolean;
                  require_clean_merge: boolean;
                }
              | undefined;
            alarm_interval_active?: number | undefined;
            alarm_interval_idle?: number | undefined;
            container?:
              | {
                  sleep_after_minutes?: number | undefined;
                }
              | undefined;
          };
          meta: object;
        }>;
        updateTownConfig: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
            config: {
              env_vars?: Record<string, string> | undefined;
              git_auth?:
                | {
                    github_token?: string | undefined;
                    gitlab_token?: string | undefined;
                    gitlab_instance_url?: string | undefined;
                    platform_integration_id?: string | undefined;
                  }
                | undefined;
              owner_user_id?: string | undefined;
              kilocode_token?: string | undefined;
              default_model?: string | undefined;
              small_model?: string | undefined;
              max_polecats_per_rig?: number | undefined;
              merge_strategy?: 'direct' | 'pr' | undefined;
              refinery?:
                | {
                    gates?: string[] | undefined;
                    auto_merge?: boolean | undefined;
                    require_clean_merge?: boolean | undefined;
                  }
                | undefined;
              alarm_interval_active?: number | undefined;
              alarm_interval_idle?: number | undefined;
              container?:
                | {
                    sleep_after_minutes?: number | undefined;
                  }
                | undefined;
            };
          };
          output: {
            env_vars: Record<string, string>;
            git_auth: {
              github_token?: string | undefined;
              gitlab_token?: string | undefined;
              gitlab_instance_url?: string | undefined;
              platform_integration_id?: string | undefined;
            };
            owner_user_id?: string | undefined;
            kilocode_token?: string | undefined;
            default_model?: string | undefined;
            small_model?: string | undefined;
            max_polecats_per_rig?: number | undefined;
            merge_strategy: 'direct' | 'pr';
            refinery?:
              | {
                  gates: string[];
                  auto_merge: boolean;
                  require_clean_merge: boolean;
                }
              | undefined;
            alarm_interval_active?: number | undefined;
            alarm_interval_idle?: number | undefined;
            container?:
              | {
                  sleep_after_minutes?: number | undefined;
                }
              | undefined;
          };
          meta: object;
        }>;
        getBeadEvents: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            rigId: string;
            beadId?: string | undefined;
            since?: string | undefined;
            limit?: number | undefined;
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
            rig_id?: string | undefined;
            rig_name?: string | undefined;
          }[];
          meta: object;
        }>;
        getTownEvents: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            townId: string;
            since?: string | undefined;
            limit?: number | undefined;
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
            rig_id?: string | undefined;
            rig_name?: string | undefined;
          }[];
          meta: object;
        }>;
        listConvoys: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            townId: string;
          };
          output: {
            id: string;
            title: string;
            status: 'active' | 'landed';
            total_beads: number;
            closed_beads: number;
            created_by: string | null;
            created_at: string;
            landed_at: string | null;
            feature_branch: string | null;
            merge_mode: string | null;
            beads: {
              bead_id: string;
              title: string;
              status: string;
              rig_id: string | null;
              assignee_agent_name: string | null;
            }[];
            dependency_edges: {
              bead_id: string;
              depends_on_bead_id: string;
            }[];
          }[];
          meta: object;
        }>;
        closeConvoy: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
            convoyId: string;
          };
          output: {
            id: string;
            title: string;
            status: 'active' | 'landed';
            total_beads: number;
            closed_beads: number;
            created_by: string | null;
            created_at: string;
            landed_at: string | null;
            feature_branch: string | null;
            merge_mode: string | null;
            beads: {
              bead_id: string;
              title: string;
              status: string;
              rig_id: string | null;
              assignee_agent_name: string | null;
            }[];
            dependency_edges: {
              bead_id: string;
              depends_on_bead_id: string;
            }[];
          } | null;
          meta: object;
        }>;
      }>
    >;
  }>
>;
export type WrappedGastownRouter = typeof wrappedGastownRouter;
