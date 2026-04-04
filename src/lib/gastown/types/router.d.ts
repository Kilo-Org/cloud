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
    getDrainStatus: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        townId: string;
      };
      output: {
        draining: boolean;
        drainStartedAt: string | null;
      };
      meta: object;
    }>;
    /**
     * Check whether the current user is an admin viewing a town they don't own.
     * Used by the frontend to show an admin banner.
     */
    checkAdminAccess: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        townId: string;
      };
      output: {
        isAdminViewing: boolean;
        ownerUserId: string | null;
        ownerOrgId: string | null;
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
        townId?: string | undefined;
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
          agent_status_message: string | null;
          agent_status_updated_at: string | null;
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
          status: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open';
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
        townId?: string | undefined;
        status?: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open' | undefined;
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
        status: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open';
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
        townId?: string | undefined;
      };
      output: void;
      meta: object;
    }>;
    updateBead: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        rigId: string;
        beadId: string;
        townId?: string | undefined;
        title?: string | undefined;
        body?: string | null | undefined;
        status?: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open' | undefined;
        priority?: 'critical' | 'high' | 'low' | 'medium' | undefined;
        labels?: string[] | undefined;
        metadata?: Record<string, unknown> | undefined;
        rig_id?: string | null | undefined;
        parent_bead_id?: string | null | undefined;
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
        status: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open';
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
      meta: object;
    }>;
    listAgents: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        rigId: string;
        townId?: string | undefined;
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
        agent_status_message: string | null;
        agent_status_updated_at: string | null;
      }[];
      meta: object;
    }>;
    deleteAgent: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        rigId: string;
        agentId: string;
        townId?: string | undefined;
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
          status: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open';
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
          agent_status_message: string | null;
          agent_status_updated_at: string | null;
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
        uiContext?: string | undefined;
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
          inReview: number;
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
        owner_type: 'org' | 'user';
        owner_id?: string | undefined;
        created_by_user_id?: string | undefined;
        organization_id?: string | undefined;
        kilocode_token?: string | undefined;
        default_model?: string | undefined;
        role_models?:
          | {
              mayor?: string | undefined;
              refinery?: string | undefined;
              polecat?: string | undefined;
            }
          | undefined;
        small_model?: string | undefined;
        max_polecats_per_rig?: number | undefined;
        merge_strategy: 'direct' | 'pr';
        refinery?:
          | {
              gates: string[];
              auto_merge: boolean;
              require_clean_merge: boolean;
              code_review: boolean;
              auto_resolve_pr_feedback: boolean;
              auto_merge_delay_minutes: number | null;
            }
          | undefined;
        alarm_interval_active?: number | undefined;
        alarm_interval_idle?: number | undefined;
        container?:
          | {
              sleep_after_minutes?: number | undefined;
            }
          | undefined;
        staged_convoys_default: boolean;
        github_cli_pat?: string | undefined;
        git_author_name?: string | undefined;
        git_author_email?: string | undefined;
        disable_ai_coauthor: boolean;
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
          owner_type?: 'org' | 'user' | undefined;
          owner_id?: string | undefined;
          created_by_user_id?: string | undefined;
          organization_id?: string | undefined;
          kilocode_token?: string | undefined;
          default_model?: string | undefined;
          role_models?:
            | {
                mayor?: string | undefined;
                refinery?: string | undefined;
                polecat?: string | undefined;
              }
            | undefined;
          small_model?: string | undefined;
          max_polecats_per_rig?: number | undefined;
          merge_strategy?: 'direct' | 'pr' | undefined;
          refinery?:
            | {
                gates?: string[] | undefined;
                auto_merge?: boolean | undefined;
                require_clean_merge?: boolean | undefined;
                code_review?: boolean | undefined;
                auto_resolve_pr_feedback?: boolean | undefined;
                auto_merge_delay_minutes?: number | null | undefined;
              }
            | undefined;
          alarm_interval_active?: number | undefined;
          alarm_interval_idle?: number | undefined;
          container?:
            | {
                sleep_after_minutes?: number | undefined;
              }
            | undefined;
          staged_convoys_default?: boolean | undefined;
          github_cli_pat?: string | undefined;
          git_author_name?: string | undefined;
          git_author_email?: string | undefined;
          disable_ai_coauthor?: boolean | undefined;
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
        owner_type: 'org' | 'user';
        owner_id?: string | undefined;
        created_by_user_id?: string | undefined;
        organization_id?: string | undefined;
        kilocode_token?: string | undefined;
        default_model?: string | undefined;
        role_models?:
          | {
              mayor?: string | undefined;
              refinery?: string | undefined;
              polecat?: string | undefined;
            }
          | undefined;
        small_model?: string | undefined;
        max_polecats_per_rig?: number | undefined;
        merge_strategy: 'direct' | 'pr';
        refinery?:
          | {
              gates: string[];
              auto_merge: boolean;
              require_clean_merge: boolean;
              code_review: boolean;
              auto_resolve_pr_feedback: boolean;
              auto_merge_delay_minutes: number | null;
            }
          | undefined;
        alarm_interval_active?: number | undefined;
        alarm_interval_idle?: number | undefined;
        container?:
          | {
              sleep_after_minutes?: number | undefined;
            }
          | undefined;
        staged_convoys_default: boolean;
        github_cli_pat?: string | undefined;
        git_author_name?: string | undefined;
        git_author_email?: string | undefined;
        disable_ai_coauthor: boolean;
      };
      meta: object;
    }>;
    refreshContainerToken: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
      };
      output: void;
      meta: object;
    }>;
    forceRestartContainer: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
      };
      output: void;
      meta: object;
    }>;
    destroyContainer: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
      };
      output: void;
      meta: object;
    }>;
    getBeadEvents: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        rigId: string;
        townId?: string | undefined;
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
    getMergeQueueData: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        townId: string;
        rigId?: string | undefined;
        limit?: number | undefined;
        since?: string | undefined;
      };
      output: {
        needsAttention: {
          openPRs: {
            mrBead: {
              bead_id: string;
              status: string;
              title: string;
              body: string | null;
              rig_id: string | null;
              created_at: string;
              updated_at: string;
              metadata: Record<string, unknown>;
            };
            reviewMetadata: {
              branch: string;
              target_branch: string;
              merge_commit: string | null;
              pr_url: string | null;
              retry_count: number;
            };
            sourceBead: {
              bead_id: string;
              title: string;
              status: string;
              body: string | null;
            } | null;
            convoy: {
              convoy_id: string;
              title: string;
              total_beads: number;
              closed_beads: number;
              feature_branch: string | null;
              merge_mode: string | null;
            } | null;
            agent: {
              agent_id: string;
              name: string;
              role: string;
            } | null;
            rigName: string | null;
            staleSince: string | null;
            failureReason: string | null;
          }[];
          failedReviews: {
            mrBead: {
              bead_id: string;
              status: string;
              title: string;
              body: string | null;
              rig_id: string | null;
              created_at: string;
              updated_at: string;
              metadata: Record<string, unknown>;
            };
            reviewMetadata: {
              branch: string;
              target_branch: string;
              merge_commit: string | null;
              pr_url: string | null;
              retry_count: number;
            };
            sourceBead: {
              bead_id: string;
              title: string;
              status: string;
              body: string | null;
            } | null;
            convoy: {
              convoy_id: string;
              title: string;
              total_beads: number;
              closed_beads: number;
              feature_branch: string | null;
              merge_mode: string | null;
            } | null;
            agent: {
              agent_id: string;
              name: string;
              role: string;
            } | null;
            rigName: string | null;
            staleSince: string | null;
            failureReason: string | null;
          }[];
          stalePRs: {
            mrBead: {
              bead_id: string;
              status: string;
              title: string;
              body: string | null;
              rig_id: string | null;
              created_at: string;
              updated_at: string;
              metadata: Record<string, unknown>;
            };
            reviewMetadata: {
              branch: string;
              target_branch: string;
              merge_commit: string | null;
              pr_url: string | null;
              retry_count: number;
            };
            sourceBead: {
              bead_id: string;
              title: string;
              status: string;
              body: string | null;
            } | null;
            convoy: {
              convoy_id: string;
              title: string;
              total_beads: number;
              closed_beads: number;
              feature_branch: string | null;
              merge_mode: string | null;
            } | null;
            agent: {
              agent_id: string;
              name: string;
              role: string;
            } | null;
            rigName: string | null;
            staleSince: string | null;
            failureReason: string | null;
          }[];
        };
        activityLog: {
          event: {
            bead_event_id: string;
            bead_id: string;
            agent_id: string | null;
            event_type: string;
            old_value: string | null;
            new_value: string | null;
            metadata: Record<string, unknown>;
            created_at: string;
          };
          mrBead: {
            bead_id: string;
            title: string;
            type: string;
            status: string;
            rig_id: string | null;
            metadata: Record<string, unknown>;
          } | null;
          sourceBead: {
            bead_id: string;
            title: string;
            status: string;
          } | null;
          convoy: {
            convoy_id: string;
            title: string;
            total_beads: number;
            closed_beads: number;
            feature_branch: string | null;
            merge_mode: string | null;
          } | null;
          agent: {
            agent_id: string;
            name: string;
            role: string;
          } | null;
          rigName: string | null;
          reviewMetadata: {
            pr_url: string | null;
            branch: string | null;
            target_branch: string | null;
            merge_commit: string | null;
          } | null;
        }[];
      };
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
        staged: boolean;
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
    getConvoy: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        townId: string;
        convoyId: string;
      };
      output: {
        id: string;
        title: string;
        status: 'active' | 'landed';
        staged: boolean;
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
    closeConvoy: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
        convoyId: string;
      };
      output: {
        id: string;
        title: string;
        status: 'active' | 'landed';
        staged: boolean;
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
    startConvoy: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
        convoyId: string;
      };
      output: {
        id: string;
        title: string;
        status: 'active' | 'landed';
        staged: boolean;
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
    listOrgTowns: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        organizationId: string;
      };
      output: {
        id: string;
        name: string;
        owner_org_id: string;
        created_by_user_id: string;
        created_at: string;
        updated_at: string;
      }[];
      meta: object;
    }>;
    createOrgTown: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        organizationId: string;
        name: string;
      };
      output: {
        id: string;
        name: string;
        owner_org_id: string;
        created_by_user_id: string;
        created_at: string;
        updated_at: string;
      };
      meta: object;
    }>;
    deleteOrgTown: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        organizationId: string;
        townId: string;
      };
      output: void;
      meta: object;
    }>;
    listOrgRigs: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        organizationId: string;
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
    createOrgRig: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        organizationId: string;
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
    adminListBeads: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        townId: string;
        status?: 'closed' | 'failed' | 'in_progress' | 'open' | undefined;
        type?:
          | 'agent'
          | 'convoy'
          | 'escalation'
          | 'issue'
          | 'merge_request'
          | 'message'
          | 'molecule'
          | undefined;
        limit?: number | undefined;
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
        status: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open';
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
    adminListAgents: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        townId: string;
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
        agent_status_message: string | null;
        agent_status_updated_at: string | null;
      }[];
      meta: object;
    }>;
    adminForceRestartContainer: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
      };
      output: void;
      meta: object;
    }>;
    adminForceResetAgent: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
        agentId: string;
      };
      output: void;
      meta: object;
    }>;
    adminForceCloseBead: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
        beadId: string;
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
        status: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open';
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
      meta: object;
    }>;
    adminForceFailBead: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        townId: string;
        beadId: string;
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
        status: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open';
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
      meta: object;
    }>;
    adminGetAlarmStatus: import('@trpc/server').TRPCQueryProcedure<{
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
          inReview: number;
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
    adminGetTownEvents: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        townId: string;
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
    adminGetBead: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        townId: string;
        beadId: string;
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
        status: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open';
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
      } | null;
      meta: object;
    }>;
    debugAgentMetadata: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        townId: string;
      };
      output: never;
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
        getDrainStatus: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            townId: string;
          };
          output: {
            draining: boolean;
            drainStartedAt: string | null;
          };
          meta: object;
        }>;
        /**
         * Check whether the current user is an admin viewing a town they don't own.
         * Used by the frontend to show an admin banner.
         */
        checkAdminAccess: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            townId: string;
          };
          output: {
            isAdminViewing: boolean;
            ownerUserId: string | null;
            ownerOrgId: string | null;
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
            townId?: string | undefined;
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
              agent_status_message: string | null;
              agent_status_updated_at: string | null;
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
              status: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open';
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
            townId?: string | undefined;
            status?: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open' | undefined;
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
            status: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open';
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
            townId?: string | undefined;
          };
          output: void;
          meta: object;
        }>;
        updateBead: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            rigId: string;
            beadId: string;
            townId?: string | undefined;
            title?: string | undefined;
            body?: string | null | undefined;
            status?: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open' | undefined;
            priority?: 'critical' | 'high' | 'low' | 'medium' | undefined;
            labels?: string[] | undefined;
            metadata?: Record<string, unknown> | undefined;
            rig_id?: string | null | undefined;
            parent_bead_id?: string | null | undefined;
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
            status: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open';
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
          meta: object;
        }>;
        listAgents: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            rigId: string;
            townId?: string | undefined;
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
            agent_status_message: string | null;
            agent_status_updated_at: string | null;
          }[];
          meta: object;
        }>;
        deleteAgent: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            rigId: string;
            agentId: string;
            townId?: string | undefined;
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
              status: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open';
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
              agent_status_message: string | null;
              agent_status_updated_at: string | null;
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
            uiContext?: string | undefined;
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
              inReview: number;
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
            owner_type: 'org' | 'user';
            owner_id?: string | undefined;
            created_by_user_id?: string | undefined;
            organization_id?: string | undefined;
            kilocode_token?: string | undefined;
            default_model?: string | undefined;
            role_models?:
              | {
                  mayor?: string | undefined;
                  refinery?: string | undefined;
                  polecat?: string | undefined;
                }
              | undefined;
            small_model?: string | undefined;
            max_polecats_per_rig?: number | undefined;
            merge_strategy: 'direct' | 'pr';
            refinery?:
              | {
                  gates: string[];
                  auto_merge: boolean;
                  require_clean_merge: boolean;
                  code_review: boolean;
                  auto_resolve_pr_feedback: boolean;
                  auto_merge_delay_minutes: number | null;
                }
              | undefined;
            alarm_interval_active?: number | undefined;
            alarm_interval_idle?: number | undefined;
            container?:
              | {
                  sleep_after_minutes?: number | undefined;
                }
              | undefined;
            staged_convoys_default: boolean;
            github_cli_pat?: string | undefined;
            git_author_name?: string | undefined;
            git_author_email?: string | undefined;
            disable_ai_coauthor: boolean;
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
              owner_type?: 'org' | 'user' | undefined;
              owner_id?: string | undefined;
              created_by_user_id?: string | undefined;
              organization_id?: string | undefined;
              kilocode_token?: string | undefined;
              default_model?: string | undefined;
              role_models?:
                | {
                    mayor?: string | undefined;
                    refinery?: string | undefined;
                    polecat?: string | undefined;
                  }
                | undefined;
              small_model?: string | undefined;
              max_polecats_per_rig?: number | undefined;
              merge_strategy?: 'direct' | 'pr' | undefined;
              refinery?:
                | {
                    gates?: string[] | undefined;
                    auto_merge?: boolean | undefined;
                    require_clean_merge?: boolean | undefined;
                    code_review?: boolean | undefined;
                    auto_resolve_pr_feedback?: boolean | undefined;
                    auto_merge_delay_minutes?: number | null | undefined;
                  }
                | undefined;
              alarm_interval_active?: number | undefined;
              alarm_interval_idle?: number | undefined;
              container?:
                | {
                    sleep_after_minutes?: number | undefined;
                  }
                | undefined;
              staged_convoys_default?: boolean | undefined;
              github_cli_pat?: string | undefined;
              git_author_name?: string | undefined;
              git_author_email?: string | undefined;
              disable_ai_coauthor?: boolean | undefined;
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
            owner_type: 'org' | 'user';
            owner_id?: string | undefined;
            created_by_user_id?: string | undefined;
            organization_id?: string | undefined;
            kilocode_token?: string | undefined;
            default_model?: string | undefined;
            role_models?:
              | {
                  mayor?: string | undefined;
                  refinery?: string | undefined;
                  polecat?: string | undefined;
                }
              | undefined;
            small_model?: string | undefined;
            max_polecats_per_rig?: number | undefined;
            merge_strategy: 'direct' | 'pr';
            refinery?:
              | {
                  gates: string[];
                  auto_merge: boolean;
                  require_clean_merge: boolean;
                  code_review: boolean;
                  auto_resolve_pr_feedback: boolean;
                  auto_merge_delay_minutes: number | null;
                }
              | undefined;
            alarm_interval_active?: number | undefined;
            alarm_interval_idle?: number | undefined;
            container?:
              | {
                  sleep_after_minutes?: number | undefined;
                }
              | undefined;
            staged_convoys_default: boolean;
            github_cli_pat?: string | undefined;
            git_author_name?: string | undefined;
            git_author_email?: string | undefined;
            disable_ai_coauthor: boolean;
          };
          meta: object;
        }>;
        refreshContainerToken: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
          };
          output: void;
          meta: object;
        }>;
        forceRestartContainer: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
          };
          output: void;
          meta: object;
        }>;
        destroyContainer: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
          };
          output: void;
          meta: object;
        }>;
        getBeadEvents: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            rigId: string;
            townId?: string | undefined;
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
        getMergeQueueData: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            townId: string;
            rigId?: string | undefined;
            limit?: number | undefined;
            since?: string | undefined;
          };
          output: {
            needsAttention: {
              openPRs: {
                mrBead: {
                  bead_id: string;
                  status: string;
                  title: string;
                  body: string | null;
                  rig_id: string | null;
                  created_at: string;
                  updated_at: string;
                  metadata: Record<string, unknown>;
                };
                reviewMetadata: {
                  branch: string;
                  target_branch: string;
                  merge_commit: string | null;
                  pr_url: string | null;
                  retry_count: number;
                };
                sourceBead: {
                  bead_id: string;
                  title: string;
                  status: string;
                  body: string | null;
                } | null;
                convoy: {
                  convoy_id: string;
                  title: string;
                  total_beads: number;
                  closed_beads: number;
                  feature_branch: string | null;
                  merge_mode: string | null;
                } | null;
                agent: {
                  agent_id: string;
                  name: string;
                  role: string;
                } | null;
                rigName: string | null;
                staleSince: string | null;
                failureReason: string | null;
              }[];
              failedReviews: {
                mrBead: {
                  bead_id: string;
                  status: string;
                  title: string;
                  body: string | null;
                  rig_id: string | null;
                  created_at: string;
                  updated_at: string;
                  metadata: Record<string, unknown>;
                };
                reviewMetadata: {
                  branch: string;
                  target_branch: string;
                  merge_commit: string | null;
                  pr_url: string | null;
                  retry_count: number;
                };
                sourceBead: {
                  bead_id: string;
                  title: string;
                  status: string;
                  body: string | null;
                } | null;
                convoy: {
                  convoy_id: string;
                  title: string;
                  total_beads: number;
                  closed_beads: number;
                  feature_branch: string | null;
                  merge_mode: string | null;
                } | null;
                agent: {
                  agent_id: string;
                  name: string;
                  role: string;
                } | null;
                rigName: string | null;
                staleSince: string | null;
                failureReason: string | null;
              }[];
              stalePRs: {
                mrBead: {
                  bead_id: string;
                  status: string;
                  title: string;
                  body: string | null;
                  rig_id: string | null;
                  created_at: string;
                  updated_at: string;
                  metadata: Record<string, unknown>;
                };
                reviewMetadata: {
                  branch: string;
                  target_branch: string;
                  merge_commit: string | null;
                  pr_url: string | null;
                  retry_count: number;
                };
                sourceBead: {
                  bead_id: string;
                  title: string;
                  status: string;
                  body: string | null;
                } | null;
                convoy: {
                  convoy_id: string;
                  title: string;
                  total_beads: number;
                  closed_beads: number;
                  feature_branch: string | null;
                  merge_mode: string | null;
                } | null;
                agent: {
                  agent_id: string;
                  name: string;
                  role: string;
                } | null;
                rigName: string | null;
                staleSince: string | null;
                failureReason: string | null;
              }[];
            };
            activityLog: {
              event: {
                bead_event_id: string;
                bead_id: string;
                agent_id: string | null;
                event_type: string;
                old_value: string | null;
                new_value: string | null;
                metadata: Record<string, unknown>;
                created_at: string;
              };
              mrBead: {
                bead_id: string;
                title: string;
                type: string;
                status: string;
                rig_id: string | null;
                metadata: Record<string, unknown>;
              } | null;
              sourceBead: {
                bead_id: string;
                title: string;
                status: string;
              } | null;
              convoy: {
                convoy_id: string;
                title: string;
                total_beads: number;
                closed_beads: number;
                feature_branch: string | null;
                merge_mode: string | null;
              } | null;
              agent: {
                agent_id: string;
                name: string;
                role: string;
              } | null;
              rigName: string | null;
              reviewMetadata: {
                pr_url: string | null;
                branch: string | null;
                target_branch: string | null;
                merge_commit: string | null;
              } | null;
            }[];
          };
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
            staged: boolean;
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
        getConvoy: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            townId: string;
            convoyId: string;
          };
          output: {
            id: string;
            title: string;
            status: 'active' | 'landed';
            staged: boolean;
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
        closeConvoy: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
            convoyId: string;
          };
          output: {
            id: string;
            title: string;
            status: 'active' | 'landed';
            staged: boolean;
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
        startConvoy: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
            convoyId: string;
          };
          output: {
            id: string;
            title: string;
            status: 'active' | 'landed';
            staged: boolean;
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
        listOrgTowns: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            organizationId: string;
          };
          output: {
            id: string;
            name: string;
            owner_org_id: string;
            created_by_user_id: string;
            created_at: string;
            updated_at: string;
          }[];
          meta: object;
        }>;
        createOrgTown: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            organizationId: string;
            name: string;
          };
          output: {
            id: string;
            name: string;
            owner_org_id: string;
            created_by_user_id: string;
            created_at: string;
            updated_at: string;
          };
          meta: object;
        }>;
        deleteOrgTown: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            organizationId: string;
            townId: string;
          };
          output: void;
          meta: object;
        }>;
        listOrgRigs: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            organizationId: string;
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
        createOrgRig: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            organizationId: string;
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
        adminListBeads: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            townId: string;
            status?: 'closed' | 'failed' | 'in_progress' | 'open' | undefined;
            type?:
              | 'agent'
              | 'convoy'
              | 'escalation'
              | 'issue'
              | 'merge_request'
              | 'message'
              | 'molecule'
              | undefined;
            limit?: number | undefined;
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
            status: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open';
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
        adminListAgents: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            townId: string;
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
            agent_status_message: string | null;
            agent_status_updated_at: string | null;
          }[];
          meta: object;
        }>;
        adminForceRestartContainer: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
          };
          output: void;
          meta: object;
        }>;
        adminForceResetAgent: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
            agentId: string;
          };
          output: void;
          meta: object;
        }>;
        adminForceCloseBead: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
            beadId: string;
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
            status: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open';
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
          meta: object;
        }>;
        adminForceFailBead: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            townId: string;
            beadId: string;
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
            status: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open';
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
          meta: object;
        }>;
        adminGetAlarmStatus: import('@trpc/server').TRPCQueryProcedure<{
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
              inReview: number;
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
        adminGetTownEvents: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            townId: string;
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
        adminGetBead: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            townId: string;
            beadId: string;
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
            status: 'closed' | 'failed' | 'in_progress' | 'in_review' | 'open';
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
          } | null;
          meta: object;
        }>;
        debugAgentMetadata: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            townId: string;
          };
          output: never;
          meta: object;
        }>;
      }>
    >;
  }>
>;
export type WrappedGastownRouter = typeof wrappedGastownRouter;
