import type { TRPCContext } from './init';
export declare const wastelandRouter: import('@trpc/server').TRPCBuiltRouter<
  {
    ctx: TRPCContext;
    meta: object;
    errorShape: import('@trpc/server').TRPCDefaultErrorShape;
    transformer: false;
  },
  import('@trpc/server').TRPCDecorateCreateRouterOptions<{
    createWasteland: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        name: string;
        ownerType: 'org' | 'user';
        organizationId?: string | undefined;
        dolthubUpstream?: string | undefined;
        visibility?: 'private' | 'public' | undefined;
      };
      output: {
        wasteland_id: string;
        name: string;
        owner_type: 'org' | 'user';
        owner_user_id: string | null;
        organization_id: string | null;
        dolthub_upstream: string | null;
        visibility: 'private' | 'public';
        status: 'active' | 'deleted';
        created_at: string;
        updated_at: string;
      };
      meta: object;
    }>;
    createUpstream: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        upstream: string;
        rigHandle?: string | undefined;
        rigDisplayName?: string | undefined;
        rigEmail?: string | undefined;
        visibility?: 'private' | 'public' | undefined;
      };
      output: {
        success: boolean;
        databaseCreated: boolean;
      };
      meta: object;
    }>;
    joinWasteland: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        rigHandle: string;
        rigDisplayName?: string | undefined;
        rigEmail?: string | undefined;
      };
      output: {
        forkOwner: string;
        forkRepo: string;
        forkUrl: string;
        rigHandle: string;
        registrationBranch: string;
        registrationPullId: string | null;
        registrationPullUrl: string | null;
        alreadyJoined: boolean;
      };
      meta: object;
    }>;
    listWastelands: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        organizationId?: string | undefined;
      };
      output: {
        wasteland_id: string;
        name: string;
        owner_type: 'org' | 'user';
        owner_user_id: string | null;
        organization_id: string | null;
        dolthub_upstream: string | null;
        visibility: 'private' | 'public';
        status: 'active' | 'deleted';
        created_at: string;
        updated_at: string;
      }[];
      meta: object;
    }>;
    getWasteland: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        wastelandId: string;
      };
      output: {
        wasteland_id: string;
        name: string;
        owner_type: 'org' | 'user';
        owner_user_id: string | null;
        organization_id: string | null;
        dolthub_upstream: string | null;
        visibility: 'private' | 'public';
        status: 'active' | 'deleted';
        created_at: string;
        updated_at: string;
      };
      meta: object;
    }>;
    resolveOwnerRepo: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        owner: string;
        repo: string;
      };
      output: {
        wastelandId: string;
        ownerType: 'org' | 'user';
        ownerUserId: string | null;
        organizationId: string | null;
        name: string;
      } | null;
      meta: object;
    }>;
    deleteWasteland: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
      };
      output: {
        success: boolean;
        wantedId: string;
        pr_url: string | null;
      };
      meta: object;
    }>;
    adminListWastelands: import('@trpc/server').TRPCQueryProcedure<{
      input: void;
      output: {
        wasteland_id: string;
        name: string;
        owner_type: 'org' | 'user';
        owner_user_id: string | null;
        organization_id: string | null;
        dolthub_upstream: string | null;
        visibility: 'private' | 'public';
        status: 'active' | 'deleted';
        created_at: string;
        updated_at: string;
      }[];
      meta: object;
    }>;
    listMembers: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        wastelandId: string;
      };
      output: {
        member_id: string;
        user_id: string;
        trust_level: number;
        role: 'contributor' | 'maintainer' | 'owner';
        joined_at: string;
      }[];
      meta: object;
    }>;
    addMember: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        userId: string;
        role?: 'contributor' | 'maintainer' | 'owner' | undefined;
        trustLevel?: number | undefined;
      };
      output: {
        member_id: string;
        user_id: string;
        trust_level: number;
        role: 'contributor' | 'maintainer' | 'owner';
        joined_at: string;
      };
      meta: object;
    }>;
    removeMember: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        memberId: string;
      };
      output: {
        success: boolean;
      };
      meta: object;
    }>;
    updateMember: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        memberId: string;
        role?: 'contributor' | 'maintainer' | 'owner' | undefined;
        trustLevel?: number | undefined;
      };
      output: {
        member_id: string;
        user_id: string;
        trust_level: number;
        role: 'contributor' | 'maintainer' | 'owner';
        joined_at: string;
      };
      meta: object;
    }>;
    updateWastelandConfig: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        name?: string | undefined;
        visibility?: 'private' | 'public' | undefined;
        dolthubUpstream?: string | undefined;
      };
      output: {
        wasteland_id: string;
        name: string;
        owner_type: 'org' | 'user';
        owner_user_id: string | null;
        organization_id: string | null;
        dolthub_upstream: string | null;
        visibility: 'private' | 'public';
        status: 'active' | 'deleted';
        created_at: string;
        updated_at: string;
      };
      meta: object;
    }>;
    storeCredential: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        dolthubToken: string;
        dolthubOrg: string;
        rigHandle?: string | undefined;
        isUpstreamAdmin?: boolean | undefined;
      };
      output: {
        user_id: string;
        dolthub_org: string;
        rig_handle: string | null;
        is_upstream_admin: boolean;
        connected_at: string;
      };
      meta: object;
    }>;
    getCredentialStatus: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        wastelandId: string;
      };
      output: {
        user_id: string;
        dolthub_org: string;
        rig_handle: string | null;
        is_upstream_admin: boolean;
        connected_at: string;
      } | null;
      meta: object;
    }>;
    setUpstreamAdmin: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        isUpstreamAdmin: boolean;
      };
      output: {
        user_id: string;
        dolthub_org: string;
        rig_handle: string | null;
        is_upstream_admin: boolean;
        connected_at: string;
      } | null;
      meta: object;
    }>;
    deleteCredential: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
      };
      output: {
        success: boolean;
      };
      meta: object;
    }>;
    connectKiloTown: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        townId: string;
      };
      output: {
        town_id: string;
        wasteland_id: string;
        connected_by: string;
        connected_at: string;
      };
      meta: object;
    }>;
    disconnectKiloTown: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        townId: string;
      };
      output: {
        success: boolean;
      };
      meta: object;
    }>;
    listConnectedTowns: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        wastelandId: string;
      };
      output: {
        town_id: string;
        wasteland_id: string;
        connected_by: string;
        connected_at: string;
      }[];
      meta: object;
    }>;
    browseWantedBoard: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        wastelandId: string;
      };
      output: {
        id: string;
        title: string;
        description: string | null;
        project: string | null;
        type: string | null;
        priority: string | number | null;
        tags: string | null;
        posted_by: string | null;
        claimed_by: string | null;
        status: string;
        effort_level: string | null;
        evidence_url: string | null;
        sandbox_required: string | number | null;
        sandbox_scope: string | null;
        sandbox_min_tier: string | null;
        created_at: string | null;
        updated_at: string | null;
      }[];
      meta: object;
    }>;
    listMyPendingClaims: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        wastelandId: string;
      };
      output: {
        items: Array<{
          item_id: string;
          pull_id: string;
          pr_url: string;
          from_branch: string;
          state: 'Open' | 'Closed' | 'Merged';
          created_at: string | null;
          updated_at: string | null;
        }>;
      };
      meta: object;
    }>;
    listMyForkBranches: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        wastelandId: string;
      };
      output: Array<{
        branchName: string;
        wantedId: string;
        wantedTitle: string | null;
        wantedRowOnBranch: {
          id: string;
          title: string;
          description: string | null;
          project: string | null;
          type: string | null;
          priority: string | number | null;
          tags: string | null;
          posted_by: string | null;
          claimed_by: string | null;
          status: string;
          effort_level: string | null;
          evidence_url: string | null;
          sandbox_required: string | number | null;
          sandbox_scope: string | null;
          sandbox_min_tier: string | null;
          created_at: string | null;
          updated_at: string | null;
        } | null;
        wantedStatusOnBranch: 'open' | 'claimed' | 'in_review' | 'completed' | 'unknown';
        wantedStatusOnMain: 'open' | 'claimed' | 'in_review' | 'completed' | 'unknown';
        divergence: 'in-sync' | 'ahead' | 'diverged';
        hasOpenPR: boolean;
        pullState: 'closed' | 'merged' | 'open' | null;
        prUrl: string | null;
        lastCommitAt: string | null;
      }>;
      meta: object;
    }>;
    discardBranch: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        wantedId: string;
      };
      output: {
        success: boolean;
      };
      meta: object;
    }>;
    publishBranch: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        wantedId: string;
      };
      output: {
        prUrl: string;
        prId: string;
      };
      meta: object;
    }>;
    listMyPulls: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        wastelandId: string;
      };
      output: Array<{
        pullId: string;
        title: string;
        state: 'open' | 'closed' | 'merged';
        branchName: string | null;
        fromBranchOwner: string | null;
        createdAt: string | null;
        updatedAt: string | null;
        mergeable: boolean;
        dolthubUrl: string;
      }>;
      meta: object;
    }>;
    claimWantedItem: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        itemId: string;
        direct?: boolean | undefined;
      };
      output: {
        success: boolean;
        pr_url: string | null;
      };
      meta: object;
    }>;
    unclaimWantedItem: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        itemId: string;
        direct?: boolean | undefined;
      };
      output: {
        success: boolean;
      };
      meta: object;
    }>;
    postWantedItem: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        title: string;
        description: string;
        priority?: 'critical' | 'high' | 'low' | 'medium' | undefined;
        type?: 'bug' | 'docs' | 'feature' | 'other' | undefined;
        direct?: boolean | undefined;
      };
      output: {
        success: boolean;
      };
      meta: object;
    }>;
    editWantedItem: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        itemId: string;
        title?: string | undefined;
        description?: string | undefined;
        priority?: 'critical' | 'high' | 'low' | 'medium' | undefined;
        type?: 'bug' | 'docs' | 'feature' | 'other' | undefined;
      };
      output: {
        success: boolean;
        pr_url: string | null;
      };
      meta: object;
    }>;
    markWantedItemDone: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        itemId: string;
        evidence: string;
        direct?: boolean | undefined;
      };
      output: {
        success: boolean;
        pr_url: string | null;
      };
      meta: object;
    }>;
    getForkCurrency: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        wastelandId: string;
      };
      output: {
        upstream: string;
        fork: string;
        upstreamHead: string | null;
        forkHead: string | null;
        isCurrent: boolean;
        syncUrl: string;
      };
      meta: object;
    }>;
    acceptWantedItem: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        itemId: string;
        submitterPullId?: string | undefined;
        submitterRigHandle?: string | undefined;
        submitterForkOwner?: string | undefined;
        completionId?: string | undefined;
        evidence?: string | undefined;
        quality: 'excellent' | 'fair' | 'good' | 'poor';
        reliability?: 'excellent' | 'fair' | 'good' | 'poor' | undefined;
        severity?: 'branch' | 'leaf' | 'root' | undefined;
        skillTags?: string[] | undefined;
        message?: string | undefined;
        direct?: boolean | undefined;
      };
      output: {
        success: boolean;
        pr_url: string | null;
        pr_id: string | null;
        merged: boolean;
        closed_submitter_pr: boolean;
      };
      meta: object;
    }>;
    rejectWantedItem: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        itemId: string;
        reason: string;
        direct?: boolean | undefined;
      };
      output: {
        success: boolean;
      };
      meta: object;
    }>;
    closeWantedItem: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        itemId: string;
        direct?: boolean | undefined;
      };
      output: {
        success: boolean;
      };
      meta: object;
    }>;
    mergeUpstreamPR: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        pullId: string;
      };
      output: {
        pull_id: string;
        state: string;
      };
      meta: object;
    }>;
    closeUpstreamPR: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        pullId: string;
      };
      output: {
        pull_id: string;
        state: string;
      };
      meta: object;
    }>;
    verifyUpstreamAdmin: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
      };
      output: {
        hasWriteAccess: boolean;
        error: string | null;
      };
      meta: object;
    }>;
    listInboxItems: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        wastelandId: string;
      };
      output: {
        items: (
          | {
              pull_id: string;
              title: string;
              state: string;
              from_branch: string | null;
              submitter: string | null;
              creator_name: string | null;
              created_at: string | null;
              fork_owner: string | null;
              updated_at: string | null;
              dolthub_url: string;
              kind: 'rig-registration';
              handle: string;
              display_name: string | null;
              dolthub_org: string | null;
              owner_email: string | null;
              hop_uri: string | null;
              gt_version: string | null;
            }
          | {
              pull_id: string;
              title: string;
              state: string;
              from_branch: string | null;
              submitter: string | null;
              creator_name: string | null;
              created_at: string | null;
              fork_owner: string | null;
              updated_at: string | null;
              dolthub_url: string;
              kind: 'wanted-post';
              item_id: string;
              item_title: string;
              description: string | null;
              type: string | null;
              priority: string | null;
              effort_level: string | null;
              tags: string | null;
              posted_by: string | null;
            }
          | {
              pull_id: string;
              title: string;
              state: string;
              from_branch: string | null;
              submitter: string | null;
              creator_name: string | null;
              created_at: string | null;
              fork_owner: string | null;
              updated_at: string | null;
              dolthub_url: string;
              kind: 'wanted-edit';
              subkind: 'delete' | 'unclaim' | 'update';
              item_id: string;
              item_title: string;
              submitter_is_poster: boolean | null;
              posted_by: string | null;
              status_transition: string | null;
            }
          | {
              pull_id: string;
              title: string;
              state: string;
              from_branch: string | null;
              submitter: string | null;
              creator_name: string | null;
              created_at: string | null;
              fork_owner: string | null;
              updated_at: string | null;
              dolthub_url: string;
              kind: 'work-submission';
              item_id: string;
              item_title: string;
              claimer: string;
              has_done: boolean;
              evidence_url: string | null;
              completion_id: string | null;
            }
          | {
              pull_id: string;
              title: string;
              state: string;
              from_branch: string | null;
              submitter: string | null;
              creator_name: string | null;
              created_at: string | null;
              fork_owner: string | null;
              updated_at: string | null;
              dolthub_url: string;
              kind: 'admin-action';
              subkind: 'accept' | 'accept-upstream' | 'close' | 'close-upstream' | 'reject';
              item_id: string;
              item_title: string;
              worker: string | null;
              acceptor: string | null;
              reject_reason: string | null;
              stamp: {
                quality: string | null;
                severity: string | null;
                skill_tags: string | null;
                message: string | null;
              } | null;
            }
          | {
              pull_id: string;
              title: string;
              state: string;
              from_branch: string | null;
              submitter: string | null;
              creator_name: string | null;
              created_at: string | null;
              fork_owner: string | null;
              updated_at: string | null;
              dolthub_url: string;
              kind: 'unknown';
              commit_subjects: string[];
            }
        )[];
      };
      meta: object;
    }>;
    commentOnUpstreamPR: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        pullId: string;
        comment: string;
      };
      output: {
        success: boolean;
      };
      meta: object;
    }>;
    listUpstreamRigs: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        wastelandId: string;
      };
      output: {
        rigs: {
          rig_handle: string;
          display_name: string | null;
          trust_level: number;
          registered_at: string | null;
          last_seen_at: string | null;
        }[];
      };
      meta: object;
    }>;
    getRig: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        wastelandId: string;
        handle: string;
      };
      output: {
        rig_handle: string;
        display_name: string | null;
        trust_level: number;
        dolthub_org: string | null;
        owner_email: string | null;
        hop_uri: string | null;
        gt_version: string | null;
        registered_at: string | null;
        last_seen_at: string | null;
      } | null;
      meta: object;
    }>;
    getWantedItem: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        wastelandId: string;
        itemId: string;
      };
      output: {
        id: string;
        title: string;
        description: string | null;
        project: string | null;
        type: string | null;
        priority: string | number | null;
        tags: string | null;
        posted_by: string | null;
        claimed_by: string | null;
        status: string;
        effort_level: string | null;
        evidence_url: string | null;
        sandbox_required: string | number | null;
        sandbox_scope: string | null;
        sandbox_min_tier: string | null;
        created_at: string | null;
        updated_at: string | null;
      } | null;
      meta: object;
    }>;
    listRigActivity: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        wastelandId: string;
        handle: string;
        limit?: number | undefined;
      };
      output: {
        posted: {
          id: string;
          title: string;
          description: string | null;
          project: string | null;
          type: string | null;
          priority: string | number | null;
          tags: string | null;
          posted_by: string | null;
          claimed_by: string | null;
          status: string;
          effort_level: string | null;
          evidence_url: string | null;
          sandbox_required: string | number | null;
          sandbox_scope: string | null;
          sandbox_min_tier: string | null;
          created_at: string | null;
          updated_at: string | null;
        }[];
        claimed: {
          id: string;
          title: string;
          description: string | null;
          project: string | null;
          type: string | null;
          priority: string | number | null;
          tags: string | null;
          posted_by: string | null;
          claimed_by: string | null;
          status: string;
          effort_level: string | null;
          evidence_url: string | null;
          sandbox_required: string | number | null;
          sandbox_scope: string | null;
          sandbox_min_tier: string | null;
          created_at: string | null;
          updated_at: string | null;
        }[];
        completions: {
          completion_id: string;
          wanted_id: string;
          wanted_title: string | null;
          completed_by: string | null;
          evidence: string | null;
          hop_uri: string | null;
          validated_by: string | null;
          stamp_id: string | null;
          completed_at: string | null;
        }[];
        stamps_authored: {
          stamp_id: string;
          author: string;
          subject: string;
          valence: string | null;
          confidence: string | number | null;
          severity: string | null;
          skill_tags: string | null;
          message: string | null;
          context_id: string | null;
          context_type: string | null;
          wanted_id: string | null;
          wanted_title: string | null;
        }[];
        stamps_received: {
          stamp_id: string;
          author: string;
          subject: string;
          valence: string | null;
          confidence: string | number | null;
          severity: string | null;
          skill_tags: string | null;
          message: string | null;
          context_id: string | null;
          context_type: string | null;
          wanted_id: string | null;
          wanted_title: string | null;
        }[];
      };
      meta: object;
    }>;
    setUpstreamRigTrust: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        rigHandle: string;
        trustLevel: number;
      };
      output: {
        success: boolean;
      };
      meta: object;
    }>;
  }>
>;
export type WastelandRouter = typeof wastelandRouter;
/**
 * Wrapped router that nests wastelandRouter under a `wasteland` key.
 * This preserves the `trpc.wasteland.X` call pattern on the frontend,
 * matching the Gastown wrapping convention.
 */
export declare const wrappedWastelandRouter: import('@trpc/server').TRPCBuiltRouter<
  {
    ctx: TRPCContext;
    meta: object;
    errorShape: import('@trpc/server').TRPCDefaultErrorShape;
    transformer: false;
  },
  import('@trpc/server').TRPCDecorateCreateRouterOptions<{
    wasteland: import('@trpc/server').TRPCBuiltRouter<
      {
        ctx: TRPCContext;
        meta: object;
        errorShape: import('@trpc/server').TRPCDefaultErrorShape;
        transformer: false;
      },
      import('@trpc/server').TRPCDecorateCreateRouterOptions<{
        createWasteland: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            name: string;
            ownerType: 'org' | 'user';
            organizationId?: string | undefined;
            dolthubUpstream?: string | undefined;
            visibility?: 'private' | 'public' | undefined;
          };
          output: {
            wasteland_id: string;
            name: string;
            owner_type: 'org' | 'user';
            owner_user_id: string | null;
            organization_id: string | null;
            dolthub_upstream: string | null;
            visibility: 'private' | 'public';
            status: 'active' | 'deleted';
            created_at: string;
            updated_at: string;
          };
          meta: object;
        }>;
        createUpstream: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            upstream: string;
            rigHandle?: string | undefined;
            rigDisplayName?: string | undefined;
            rigEmail?: string | undefined;
            visibility?: 'private' | 'public' | undefined;
          };
          output: {
            success: boolean;
            databaseCreated: boolean;
          };
          meta: object;
        }>;
        joinWasteland: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            rigHandle: string;
            rigDisplayName?: string | undefined;
            rigEmail?: string | undefined;
          };
          output: {
            forkOwner: string;
            forkRepo: string;
            forkUrl: string;
            rigHandle: string;
            registrationBranch: string;
            registrationPullId: string | null;
            registrationPullUrl: string | null;
            alreadyJoined: boolean;
          };
          meta: object;
        }>;
        listWastelands: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            organizationId?: string | undefined;
          };
          output: {
            wasteland_id: string;
            name: string;
            owner_type: 'org' | 'user';
            owner_user_id: string | null;
            organization_id: string | null;
            dolthub_upstream: string | null;
            visibility: 'private' | 'public';
            status: 'active' | 'deleted';
            created_at: string;
            updated_at: string;
          }[];
          meta: object;
        }>;
        getWasteland: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            wastelandId: string;
          };
          output: {
            wasteland_id: string;
            name: string;
            owner_type: 'org' | 'user';
            owner_user_id: string | null;
            organization_id: string | null;
            dolthub_upstream: string | null;
            visibility: 'private' | 'public';
            status: 'active' | 'deleted';
            created_at: string;
            updated_at: string;
          };
          meta: object;
        }>;
        resolveOwnerRepo: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            owner: string;
            repo: string;
          };
          output: {
            wastelandId: string;
            ownerType: 'org' | 'user';
            ownerUserId: string | null;
            organizationId: string | null;
            name: string;
          } | null;
          meta: object;
        }>;
        deleteWasteland: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
          };
          output: {
            success: boolean;
          };
          meta: object;
        }>;
        adminListWastelands: import('@trpc/server').TRPCQueryProcedure<{
          input: void;
          output: {
            wasteland_id: string;
            name: string;
            owner_type: 'org' | 'user';
            owner_user_id: string | null;
            organization_id: string | null;
            dolthub_upstream: string | null;
            visibility: 'private' | 'public';
            status: 'active' | 'deleted';
            created_at: string;
            updated_at: string;
          }[];
          meta: object;
        }>;
        listMembers: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            wastelandId: string;
          };
          output: {
            member_id: string;
            user_id: string;
            trust_level: number;
            role: 'contributor' | 'maintainer' | 'owner';
            joined_at: string;
          }[];
          meta: object;
        }>;
        addMember: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            userId: string;
            role?: 'contributor' | 'maintainer' | 'owner' | undefined;
            trustLevel?: number | undefined;
          };
          output: {
            member_id: string;
            user_id: string;
            trust_level: number;
            role: 'contributor' | 'maintainer' | 'owner';
            joined_at: string;
          };
          meta: object;
        }>;
        removeMember: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            memberId: string;
          };
          output: {
            success: boolean;
          };
          meta: object;
        }>;
        updateMember: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            memberId: string;
            role?: 'contributor' | 'maintainer' | 'owner' | undefined;
            trustLevel?: number | undefined;
          };
          output: {
            member_id: string;
            user_id: string;
            trust_level: number;
            role: 'contributor' | 'maintainer' | 'owner';
            joined_at: string;
          };
          meta: object;
        }>;
        updateWastelandConfig: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            name?: string | undefined;
            visibility?: 'private' | 'public' | undefined;
            dolthubUpstream?: string | undefined;
          };
          output: {
            wasteland_id: string;
            name: string;
            owner_type: 'org' | 'user';
            owner_user_id: string | null;
            organization_id: string | null;
            dolthub_upstream: string | null;
            visibility: 'private' | 'public';
            status: 'active' | 'deleted';
            created_at: string;
            updated_at: string;
          };
          meta: object;
        }>;
        storeCredential: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            dolthubToken: string;
            dolthubOrg: string;
            rigHandle?: string | undefined;
            isUpstreamAdmin?: boolean | undefined;
          };
          output: {
            user_id: string;
            dolthub_org: string;
            rig_handle: string | null;
            is_upstream_admin: boolean;
            connected_at: string;
          };
          meta: object;
        }>;
        getCredentialStatus: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            wastelandId: string;
          };
          output: {
            user_id: string;
            dolthub_org: string;
            rig_handle: string | null;
            is_upstream_admin: boolean;
            connected_at: string;
          } | null;
          meta: object;
        }>;
        setUpstreamAdmin: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            isUpstreamAdmin: boolean;
          };
          output: {
            user_id: string;
            dolthub_org: string;
            rig_handle: string | null;
            is_upstream_admin: boolean;
            connected_at: string;
          } | null;
          meta: object;
        }>;
        deleteCredential: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
          };
          output: {
            success: boolean;
          };
          meta: object;
        }>;
        connectKiloTown: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            townId: string;
          };
          output: {
            town_id: string;
            wasteland_id: string;
            connected_by: string;
            connected_at: string;
          };
          meta: object;
        }>;
        disconnectKiloTown: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            townId: string;
          };
          output: {
            success: boolean;
          };
          meta: object;
        }>;
        listConnectedTowns: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            wastelandId: string;
          };
          output: {
            town_id: string;
            wasteland_id: string;
            connected_by: string;
            connected_at: string;
          }[];
          meta: object;
        }>;
        browseWantedBoard: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            wastelandId: string;
          };
          output: {
            id: string;
            title: string;
            description: string | null;
            project: string | null;
            type: string | null;
            priority: string | number | null;
            tags: string | null;
            posted_by: string | null;
            claimed_by: string | null;
            status: string;
            effort_level: string | null;
            evidence_url: string | null;
            sandbox_required: string | number | null;
            sandbox_scope: string | null;
            sandbox_min_tier: string | null;
            created_at: string | null;
            updated_at: string | null;
          }[];
          meta: object;
        }>;
        listMyPendingClaims: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            wastelandId: string;
          };
          output: {
            items: Array<{
              item_id: string;
              pull_id: string;
              pr_url: string;
              from_branch: string;
              state: 'Open' | 'Closed' | 'Merged';
              created_at: string | null;
              updated_at: string | null;
            }>;
          };
          meta: object;
        }>;
        listMyForkBranches: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            wastelandId: string;
          };
          output: Array<{
            branchName: string;
            wantedId: string;
            wantedTitle: string | null;
            wantedRowOnBranch: {
              id: string;
              title: string;
              description: string | null;
              project: string | null;
              type: string | null;
              priority: string | number | null;
              tags: string | null;
              posted_by: string | null;
              claimed_by: string | null;
              status: string;
              effort_level: string | null;
              evidence_url: string | null;
              sandbox_required: string | number | null;
              sandbox_scope: string | null;
              sandbox_min_tier: string | null;
              created_at: string | null;
              updated_at: string | null;
            } | null;
            wantedStatusOnBranch: 'open' | 'claimed' | 'in_review' | 'completed' | 'unknown';
            wantedStatusOnMain: 'open' | 'claimed' | 'in_review' | 'completed' | 'unknown';
            divergence: 'in-sync' | 'ahead' | 'diverged';
            hasOpenPR: boolean;
            pullState: 'closed' | 'merged' | 'open' | null;
            prUrl: string | null;
            lastCommitAt: string | null;
          }>;
          meta: object;
        }>;
        discardBranch: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            wantedId: string;
          };
          output: {
            success: boolean;
          };
          meta: object;
        }>;
        publishBranch: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            wantedId: string;
          };
          output: {
            prUrl: string;
            prId: string;
          };
          meta: object;
        }>;
        listMyPulls: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            wastelandId: string;
          };
          output: Array<{
            pullId: string;
            title: string;
            state: 'open' | 'closed' | 'merged';
            branchName: string | null;
            fromBranchOwner: string | null;
            createdAt: string | null;
            updatedAt: string | null;
            mergeable: boolean;
            dolthubUrl: string;
          }>;
          meta: object;
        }>;
        claimWantedItem: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            itemId: string;
            direct?: boolean | undefined;
          };
          output: {
            success: boolean;
            pr_url: string | null;
          };
          meta: object;
        }>;
        unclaimWantedItem: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            itemId: string;
            direct?: boolean | undefined;
          };
          output: {
            success: boolean;
          };
          meta: object;
        }>;
        postWantedItem: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            title: string;
            description: string;
            priority?: 'critical' | 'high' | 'low' | 'medium' | undefined;
            type?: 'bug' | 'docs' | 'feature' | 'other' | undefined;
            direct?: boolean | undefined;
          };
          output: {
            success: boolean;
            wantedId: string;
            pr_url: string | null;
          };
          meta: object;
        }>;
        editWantedItem: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            itemId: string;
            title?: string | undefined;
            description?: string | undefined;
            priority?: 'critical' | 'high' | 'low' | 'medium' | undefined;
            type?: 'bug' | 'docs' | 'feature' | 'other' | undefined;
          };
          output: {
            success: boolean;
            pr_url: string | null;
          };
          meta: object;
        }>;
        markWantedItemDone: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            itemId: string;
            evidence: string;
            direct?: boolean | undefined;
          };
          output: {
            success: boolean;
            pr_url: string | null;
          };
          meta: object;
        }>;
        getForkCurrency: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            wastelandId: string;
          };
          output: {
            upstream: string;
            fork: string;
            upstreamHead: string | null;
            forkHead: string | null;
            isCurrent: boolean;
            syncUrl: string;
          };
          meta: object;
        }>;
        acceptWantedItem: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            itemId: string;
            submitterPullId?: string | undefined;
            submitterRigHandle?: string | undefined;
            submitterForkOwner?: string | undefined;
            completionId?: string | undefined;
            evidence?: string | undefined;
            quality: 'excellent' | 'fair' | 'good' | 'poor';
            reliability?: 'excellent' | 'fair' | 'good' | 'poor' | undefined;
            severity?: 'branch' | 'leaf' | 'root' | undefined;
            skillTags?: string[] | undefined;
            message?: string | undefined;
            direct?: boolean | undefined;
          };
          output: {
            success: boolean;
            pr_url: string | null;
            pr_id: string | null;
            merged: boolean;
            closed_submitter_pr: boolean;
          };
          meta: object;
        }>;
        rejectWantedItem: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            itemId: string;
            reason: string;
            direct?: boolean | undefined;
          };
          output: {
            success: boolean;
          };
          meta: object;
        }>;
        closeWantedItem: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            itemId: string;
            direct?: boolean | undefined;
          };
          output: {
            success: boolean;
          };
          meta: object;
        }>;
        mergeUpstreamPR: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            pullId: string;
          };
          output: {
            pull_id: string;
            state: string;
          };
          meta: object;
        }>;
        closeUpstreamPR: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            pullId: string;
          };
          output: {
            pull_id: string;
            state: string;
          };
          meta: object;
        }>;
        verifyUpstreamAdmin: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
          };
          output: {
            hasWriteAccess: boolean;
            error: string | null;
          };
          meta: object;
        }>;
        listInboxItems: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            wastelandId: string;
          };
          output: {
            items: (
              | {
                  pull_id: string;
                  title: string;
                  state: string;
                  from_branch: string | null;
                  submitter: string | null;
                  creator_name: string | null;
                  created_at: string | null;
                  fork_owner: string | null;
                  updated_at: string | null;
                  dolthub_url: string;
                  kind: 'rig-registration';
                  handle: string;
                  display_name: string | null;
                  dolthub_org: string | null;
                  owner_email: string | null;
                  hop_uri: string | null;
                  gt_version: string | null;
                }
              | {
                  pull_id: string;
                  title: string;
                  state: string;
                  from_branch: string | null;
                  submitter: string | null;
                  creator_name: string | null;
                  created_at: string | null;
                  fork_owner: string | null;
                  updated_at: string | null;
                  dolthub_url: string;
                  kind: 'wanted-post';
                  item_id: string;
                  item_title: string;
                  description: string | null;
                  type: string | null;
                  priority: string | null;
                  effort_level: string | null;
                  tags: string | null;
                  posted_by: string | null;
                }
              | {
                  pull_id: string;
                  title: string;
                  state: string;
                  from_branch: string | null;
                  submitter: string | null;
                  creator_name: string | null;
                  created_at: string | null;
                  fork_owner: string | null;
                  updated_at: string | null;
                  dolthub_url: string;
                  kind: 'wanted-edit';
                  subkind: 'delete' | 'unclaim' | 'update';
                  item_id: string;
                  item_title: string;
                  submitter_is_poster: boolean | null;
                  posted_by: string | null;
                  status_transition: string | null;
                }
              | {
                  pull_id: string;
                  title: string;
                  state: string;
                  from_branch: string | null;
                  submitter: string | null;
                  creator_name: string | null;
                  created_at: string | null;
                  fork_owner: string | null;
                  updated_at: string | null;
                  dolthub_url: string;
                  kind: 'work-submission';
                  item_id: string;
                  item_title: string;
                  claimer: string;
                  has_done: boolean;
                  evidence_url: string | null;
                  completion_id: string | null;
                }
              | {
                  pull_id: string;
                  title: string;
                  state: string;
                  from_branch: string | null;
                  submitter: string | null;
                  creator_name: string | null;
                  created_at: string | null;
                  fork_owner: string | null;
                  updated_at: string | null;
                  dolthub_url: string;
                  kind: 'admin-action';
                  subkind: 'accept' | 'accept-upstream' | 'close' | 'close-upstream' | 'reject';
                  item_id: string;
                  item_title: string;
                  worker: string | null;
                  acceptor: string | null;
                  reject_reason: string | null;
                  stamp: {
                    quality: string | null;
                    severity: string | null;
                    skill_tags: string | null;
                    message: string | null;
                  } | null;
                }
              | {
                  pull_id: string;
                  title: string;
                  state: string;
                  from_branch: string | null;
                  submitter: string | null;
                  creator_name: string | null;
                  created_at: string | null;
                  fork_owner: string | null;
                  updated_at: string | null;
                  dolthub_url: string;
                  kind: 'unknown';
                  commit_subjects: string[];
                }
            )[];
          };
          meta: object;
        }>;
        commentOnUpstreamPR: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            pullId: string;
            comment: string;
          };
          output: {
            success: boolean;
          };
          meta: object;
        }>;
        listUpstreamRigs: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            wastelandId: string;
          };
          output: {
            rigs: {
              rig_handle: string;
              display_name: string | null;
              trust_level: number;
              registered_at: string | null;
              last_seen_at: string | null;
            }[];
          };
          meta: object;
        }>;
        getRig: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            wastelandId: string;
            handle: string;
          };
          output: {
            rig_handle: string;
            display_name: string | null;
            trust_level: number;
            dolthub_org: string | null;
            owner_email: string | null;
            hop_uri: string | null;
            gt_version: string | null;
            registered_at: string | null;
            last_seen_at: string | null;
          } | null;
          meta: object;
        }>;
        getWantedItem: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            wastelandId: string;
            itemId: string;
          };
          output: {
            id: string;
            title: string;
            description: string | null;
            project: string | null;
            type: string | null;
            priority: string | number | null;
            tags: string | null;
            posted_by: string | null;
            claimed_by: string | null;
            status: string;
            effort_level: string | null;
            evidence_url: string | null;
            sandbox_required: string | number | null;
            sandbox_scope: string | null;
            sandbox_min_tier: string | null;
            created_at: string | null;
            updated_at: string | null;
          } | null;
          meta: object;
        }>;
        listRigActivity: import('@trpc/server').TRPCQueryProcedure<{
          input: {
            wastelandId: string;
            handle: string;
            limit?: number | undefined;
          };
          output: {
            posted: {
              id: string;
              title: string;
              description: string | null;
              project: string | null;
              type: string | null;
              priority: string | number | null;
              tags: string | null;
              posted_by: string | null;
              claimed_by: string | null;
              status: string;
              effort_level: string | null;
              evidence_url: string | null;
              sandbox_required: string | number | null;
              sandbox_scope: string | null;
              sandbox_min_tier: string | null;
              created_at: string | null;
              updated_at: string | null;
            }[];
            claimed: {
              id: string;
              title: string;
              description: string | null;
              project: string | null;
              type: string | null;
              priority: string | number | null;
              tags: string | null;
              posted_by: string | null;
              claimed_by: string | null;
              status: string;
              effort_level: string | null;
              evidence_url: string | null;
              sandbox_required: string | number | null;
              sandbox_scope: string | null;
              sandbox_min_tier: string | null;
              created_at: string | null;
              updated_at: string | null;
            }[];
            completions: {
              completion_id: string;
              wanted_id: string;
              wanted_title: string | null;
              completed_by: string | null;
              evidence: string | null;
              hop_uri: string | null;
              validated_by: string | null;
              stamp_id: string | null;
              completed_at: string | null;
            }[];
            stamps_authored: {
              stamp_id: string;
              author: string;
              subject: string;
              valence: string | null;
              confidence: string | number | null;
              severity: string | null;
              skill_tags: string | null;
              message: string | null;
              context_id: string | null;
              context_type: string | null;
              wanted_id: string | null;
              wanted_title: string | null;
            }[];
            stamps_received: {
              stamp_id: string;
              author: string;
              subject: string;
              valence: string | null;
              confidence: string | number | null;
              severity: string | null;
              skill_tags: string | null;
              message: string | null;
              context_id: string | null;
              context_type: string | null;
              wanted_id: string | null;
              wanted_title: string | null;
            }[];
          };
          meta: object;
        }>;
        setUpstreamRigTrust: import('@trpc/server').TRPCMutationProcedure<{
          input: {
            wastelandId: string;
            rigHandle: string;
            trustLevel: number;
          };
          output: {
            success: boolean;
          };
          meta: object;
        }>;
      }>
    >;
  }>
>;
export type WrappedWastelandRouter = typeof wrappedWastelandRouter;
