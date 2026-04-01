import type { TRPCContext } from './init';

/**
 * JWT org membership shape included in the token. Re-declared here so
 * init.d.ts can reference it without importing from cloudflare-wasteland.
 */
export type JwtOrgMembership = { orgId: string; role: string };

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
        ownerType: 'user' | 'org';
        organizationId?: string | undefined;
        dolthubUpstream?: string | undefined;
        visibility?: 'public' | 'private' | undefined;
      };
      output: {
        wasteland_id: string;
        name: string;
        owner_type: 'user' | 'org';
        owner_user_id: string | null;
        organization_id: string | null;
        dolthub_upstream: string | null;
        visibility: 'public' | 'private';
        status: 'active' | 'deleted';
        created_at: string;
        updated_at: string;
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
        owner_type: 'user' | 'org';
        owner_user_id: string | null;
        organization_id: string | null;
        dolthub_upstream: string | null;
        visibility: 'public' | 'private';
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
        owner_type: 'user' | 'org';
        owner_user_id: string | null;
        organization_id: string | null;
        dolthub_upstream: string | null;
        visibility: 'public' | 'private';
        status: 'active' | 'deleted';
        created_at: string;
        updated_at: string;
      };
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
        owner_type: 'user' | 'org';
        owner_user_id: string | null;
        organization_id: string | null;
        dolthub_upstream: string | null;
        visibility: 'public' | 'private';
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
        visibility?: 'public' | 'private' | undefined;
        dolthubUpstream?: string | undefined;
      };
      output: {
        wasteland_id: string;
        name: string;
        owner_type: 'user' | 'org';
        owner_user_id: string | null;
        organization_id: string | null;
        dolthub_upstream: string | null;
        visibility: 'public' | 'private';
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
      };
      output: {
        user_id: string;
        dolthub_org: string;
        rig_handle: string | null;
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
    browseWantedBoard: import('@trpc/server').TRPCQueryProcedure<{
      input: {
        wastelandId: string;
      };
      output: {
        item_id: string;
        title: string;
        description: string;
        status: 'open' | 'claimed' | 'done';
        priority: 'low' | 'medium' | 'high' | 'critical';
        type: 'feature' | 'bug' | 'docs' | 'other';
        claimed_by: string | null;
        evidence: string | null;
        created_at: string;
        updated_at: string;
      }[];
      meta: object;
    }>;
    refreshWantedBoard: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
      };
      output: {
        item_id: string;
        title: string;
        description: string;
        status: 'open' | 'claimed' | 'done';
        priority: 'low' | 'medium' | 'high' | 'critical';
        type: 'feature' | 'bug' | 'docs' | 'other';
        claimed_by: string | null;
        evidence: string | null;
        created_at: string;
        updated_at: string;
      }[];
      meta: object;
    }>;
    claimWantedItem: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        itemId: string;
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
        priority?: 'low' | 'medium' | 'high' | undefined;
        type?: 'feature' | 'bug' | 'docs' | 'other' | undefined;
      };
      output: {
        success: boolean;
      };
      meta: object;
    }>;
    markWantedItemDone: import('@trpc/server').TRPCMutationProcedure<{
      input: {
        wastelandId: string;
        itemId: string;
        evidence: string;
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
    wasteland: typeof wastelandRouter;
  }>
>;
export type WrappedWastelandRouter = typeof wrappedWastelandRouter;
