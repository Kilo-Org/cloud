import type { TRPCContext } from './init';
export declare const wastelandRouter: import("@trpc/server").TRPCBuiltRouter<{
    ctx: TRPCContext;
    meta: object;
    errorShape: import("@trpc/server").TRPCDefaultErrorShape;
    transformer: false;
}, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
    createWasteland: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            name: string;
            ownerType: "org" | "user";
            organizationId?: string | undefined;
            dolthubUpstream?: string | undefined;
            visibility?: "private" | "public" | undefined;
        };
        output: {
            wasteland_id: string;
            name: string;
            owner_type: "org" | "user";
            owner_user_id: string | null;
            organization_id: string | null;
            dolthub_upstream: string | null;
            visibility: "private" | "public";
            status: "active" | "deleted";
            created_at: string;
            updated_at: string;
        };
        meta: object;
    }>;
    createUpstream: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wastelandId: string;
            upstream: string;
            rigHandle?: string | undefined;
            rigDisplayName?: string | undefined;
            rigEmail?: string | undefined;
        };
        output: {
            success: boolean;
        };
        meta: object;
    }>;
    listWastelands: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            organizationId?: string | undefined;
        };
        output: {
            wasteland_id: string;
            name: string;
            owner_type: "org" | "user";
            owner_user_id: string | null;
            organization_id: string | null;
            dolthub_upstream: string | null;
            visibility: "private" | "public";
            status: "active" | "deleted";
            created_at: string;
            updated_at: string;
        }[];
        meta: object;
    }>;
    getWasteland: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            wastelandId: string;
        };
        output: {
            wasteland_id: string;
            name: string;
            owner_type: "org" | "user";
            owner_user_id: string | null;
            organization_id: string | null;
            dolthub_upstream: string | null;
            visibility: "private" | "public";
            status: "active" | "deleted";
            created_at: string;
            updated_at: string;
        };
        meta: object;
    }>;
    deleteWasteland: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wastelandId: string;
        };
        output: {
            success: boolean;
        };
        meta: object;
    }>;
    adminListWastelands: import("@trpc/server").TRPCQueryProcedure<{
        input: void;
        output: {
            wasteland_id: string;
            name: string;
            owner_type: "org" | "user";
            owner_user_id: string | null;
            organization_id: string | null;
            dolthub_upstream: string | null;
            visibility: "private" | "public";
            status: "active" | "deleted";
            created_at: string;
            updated_at: string;
        }[];
        meta: object;
    }>;
    listMembers: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            wastelandId: string;
        };
        output: {
            member_id: string;
            user_id: string;
            trust_level: number;
            role: "contributor" | "maintainer" | "owner";
            joined_at: string;
        }[];
        meta: object;
    }>;
    addMember: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wastelandId: string;
            userId: string;
            role?: "contributor" | "maintainer" | "owner" | undefined;
            trustLevel?: number | undefined;
        };
        output: {
            member_id: string;
            user_id: string;
            trust_level: number;
            role: "contributor" | "maintainer" | "owner";
            joined_at: string;
        };
        meta: object;
    }>;
    removeMember: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wastelandId: string;
            memberId: string;
        };
        output: {
            success: boolean;
        };
        meta: object;
    }>;
    updateMember: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wastelandId: string;
            memberId: string;
            role?: "contributor" | "maintainer" | "owner" | undefined;
            trustLevel?: number | undefined;
        };
        output: {
            member_id: string;
            user_id: string;
            trust_level: number;
            role: "contributor" | "maintainer" | "owner";
            joined_at: string;
        };
        meta: object;
    }>;
    updateWastelandConfig: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wastelandId: string;
            name?: string | undefined;
            visibility?: "private" | "public" | undefined;
            dolthubUpstream?: string | undefined;
        };
        output: {
            wasteland_id: string;
            name: string;
            owner_type: "org" | "user";
            owner_user_id: string | null;
            organization_id: string | null;
            dolthub_upstream: string | null;
            visibility: "private" | "public";
            status: "active" | "deleted";
            created_at: string;
            updated_at: string;
        };
        meta: object;
    }>;
    storeCredential: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wastelandId: string;
            dolthubToken: string;
            dolthubOrg: string;
            rigHandle?: string | undefined;
            doltCredsJwk?: string | undefined;
            doltUserName?: string | undefined;
            doltUserEmail?: string | undefined;
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
    getCredentialStatus: import("@trpc/server").TRPCQueryProcedure<{
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
    setUpstreamAdmin: import("@trpc/server").TRPCMutationProcedure<{
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
    deleteCredential: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wastelandId: string;
        };
        output: {
            success: boolean;
        };
        meta: object;
    }>;
    containerStatus: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            wastelandId: string;
        };
        output: {
            joined: boolean;
            upstream: string | null;
            dolthubOrg: string | null;
            hasToken: boolean;
            hasJwk: boolean;
            doltCredPubKey: string | null;
            wlVersion: string;
            uptime: number;
            lastOperation: string | null;
        };
        meta: object;
    }>;
    containerJoin: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wastelandId: string;
        };
        output: {
            success: boolean;
        };
        meta: object;
    }>;
    connectKiloTown: import("@trpc/server").TRPCMutationProcedure<{
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
    disconnectKiloTown: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wastelandId: string;
            townId: string;
        };
        output: {
            success: boolean;
        };
        meta: object;
    }>;
    listConnectedTowns: import("@trpc/server").TRPCQueryProcedure<{
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
    browseWantedBoard: import("@trpc/server").TRPCQueryProcedure<{
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
    claimWantedItem: import("@trpc/server").TRPCMutationProcedure<{
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
    unclaimWantedItem: import("@trpc/server").TRPCMutationProcedure<{
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
    postWantedItem: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wastelandId: string;
            title: string;
            description: string;
            priority?: "critical" | "high" | "low" | "medium" | undefined;
            type?: "bug" | "docs" | "feature" | "other" | undefined;
            direct?: boolean | undefined;
        };
        output: {
            success: boolean;
        };
        meta: object;
    }>;
    markWantedItemDone: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wastelandId: string;
            itemId: string;
            evidence: string;
            direct?: boolean | undefined;
        };
        output: {
            success: boolean;
        };
        meta: object;
    }>;
    acceptWantedItem: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wastelandId: string;
            itemId: string;
            quality: "excellent" | "fair" | "good" | "poor";
            message?: string | undefined;
            direct?: boolean | undefined;
        };
        output: {
            success: boolean;
        };
        meta: object;
    }>;
    rejectWantedItem: import("@trpc/server").TRPCMutationProcedure<{
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
    closeWantedItem: import("@trpc/server").TRPCMutationProcedure<{
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
    mergeUpstreamPR: import("@trpc/server").TRPCMutationProcedure<{
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
    closeUpstreamPR: import("@trpc/server").TRPCMutationProcedure<{
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
    verifyUpstreamAdmin: import("@trpc/server").TRPCMutationProcedure<{
        input: {
            wastelandId: string;
        };
        output: {
            hasWriteAccess: boolean;
            error: string | null;
        };
        meta: object;
    }>;
    listInboxItems: import("@trpc/server").TRPCQueryProcedure<{
        input: {
            wastelandId: string;
        };
        output: {
            items: ({
                pull_id: string;
                title: string;
                state: string;
                from_branch: string | null;
                submitter: string | null;
                creator_name: string | null;
                created_at: string | null;
                updated_at: string | null;
                kind: "rig-registration";
                handle: string;
                display_name: string | null;
                dolthub_org: string | null;
                owner_email: string | null;
                hop_uri: string | null;
                gt_version: string | null;
            } | {
                pull_id: string;
                title: string;
                state: string;
                from_branch: string | null;
                submitter: string | null;
                creator_name: string | null;
                created_at: string | null;
                updated_at: string | null;
                kind: "wanted-post";
                item_id: string;
                item_title: string;
                description: string | null;
                type: string | null;
                priority: string | null;
                effort_level: string | null;
                tags: string | null;
                posted_by: string | null;
            } | {
                pull_id: string;
                title: string;
                state: string;
                from_branch: string | null;
                submitter: string | null;
                creator_name: string | null;
                created_at: string | null;
                updated_at: string | null;
                kind: "wanted-edit";
                subkind: "delete" | "unclaim" | "update";
                item_id: string;
                item_title: string;
                submitter_is_poster: boolean | null;
                posted_by: string | null;
                status_transition: string | null;
            } | {
                pull_id: string;
                title: string;
                state: string;
                from_branch: string | null;
                submitter: string | null;
                creator_name: string | null;
                created_at: string | null;
                updated_at: string | null;
                kind: "work-submission";
                item_id: string;
                item_title: string;
                claimer: string;
                has_done: boolean;
                evidence_url: string | null;
                completion_id: string | null;
            } | {
                pull_id: string;
                title: string;
                state: string;
                from_branch: string | null;
                submitter: string | null;
                creator_name: string | null;
                created_at: string | null;
                updated_at: string | null;
                kind: "admin-action";
                subkind: "accept" | "accept-upstream" | "close" | "close-upstream" | "reject";
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
            } | {
                pull_id: string;
                title: string;
                state: string;
                from_branch: string | null;
                submitter: string | null;
                creator_name: string | null;
                created_at: string | null;
                updated_at: string | null;
                kind: "unknown";
                commit_subjects: string[];
            })[];
        };
        meta: object;
    }>;
    commentOnUpstreamPR: import("@trpc/server").TRPCMutationProcedure<{
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
    listUpstreamRigs: import("@trpc/server").TRPCQueryProcedure<{
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
    setUpstreamRigTrust: import("@trpc/server").TRPCMutationProcedure<{
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
}>>;
export type WastelandRouter = typeof wastelandRouter;
/**
 * Wrapped router that nests wastelandRouter under a `wasteland` key.
 * This preserves the `trpc.wasteland.X` call pattern on the frontend,
 * matching the Gastown wrapping convention.
 */
export declare const wrappedWastelandRouter: import("@trpc/server").TRPCBuiltRouter<{
    ctx: TRPCContext;
    meta: object;
    errorShape: import("@trpc/server").TRPCDefaultErrorShape;
    transformer: false;
}, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
    wasteland: import("@trpc/server").TRPCBuiltRouter<{
        ctx: TRPCContext;
        meta: object;
        errorShape: import("@trpc/server").TRPCDefaultErrorShape;
        transformer: false;
    }, import("@trpc/server").TRPCDecorateCreateRouterOptions<{
        createWasteland: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                name: string;
                ownerType: "org" | "user";
                organizationId?: string | undefined;
                dolthubUpstream?: string | undefined;
                visibility?: "private" | "public" | undefined;
            };
            output: {
                wasteland_id: string;
                name: string;
                owner_type: "org" | "user";
                owner_user_id: string | null;
                organization_id: string | null;
                dolthub_upstream: string | null;
                visibility: "private" | "public";
                status: "active" | "deleted";
                created_at: string;
                updated_at: string;
            };
            meta: object;
        }>;
        createUpstream: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                wastelandId: string;
                upstream: string;
                rigHandle?: string | undefined;
                rigDisplayName?: string | undefined;
                rigEmail?: string | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        listWastelands: import("@trpc/server").TRPCQueryProcedure<{
            input: {
                organizationId?: string | undefined;
            };
            output: {
                wasteland_id: string;
                name: string;
                owner_type: "org" | "user";
                owner_user_id: string | null;
                organization_id: string | null;
                dolthub_upstream: string | null;
                visibility: "private" | "public";
                status: "active" | "deleted";
                created_at: string;
                updated_at: string;
            }[];
            meta: object;
        }>;
        getWasteland: import("@trpc/server").TRPCQueryProcedure<{
            input: {
                wastelandId: string;
            };
            output: {
                wasteland_id: string;
                name: string;
                owner_type: "org" | "user";
                owner_user_id: string | null;
                organization_id: string | null;
                dolthub_upstream: string | null;
                visibility: "private" | "public";
                status: "active" | "deleted";
                created_at: string;
                updated_at: string;
            };
            meta: object;
        }>;
        deleteWasteland: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                wastelandId: string;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        adminListWastelands: import("@trpc/server").TRPCQueryProcedure<{
            input: void;
            output: {
                wasteland_id: string;
                name: string;
                owner_type: "org" | "user";
                owner_user_id: string | null;
                organization_id: string | null;
                dolthub_upstream: string | null;
                visibility: "private" | "public";
                status: "active" | "deleted";
                created_at: string;
                updated_at: string;
            }[];
            meta: object;
        }>;
        listMembers: import("@trpc/server").TRPCQueryProcedure<{
            input: {
                wastelandId: string;
            };
            output: {
                member_id: string;
                user_id: string;
                trust_level: number;
                role: "contributor" | "maintainer" | "owner";
                joined_at: string;
            }[];
            meta: object;
        }>;
        addMember: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                wastelandId: string;
                userId: string;
                role?: "contributor" | "maintainer" | "owner" | undefined;
                trustLevel?: number | undefined;
            };
            output: {
                member_id: string;
                user_id: string;
                trust_level: number;
                role: "contributor" | "maintainer" | "owner";
                joined_at: string;
            };
            meta: object;
        }>;
        removeMember: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                wastelandId: string;
                memberId: string;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        updateMember: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                wastelandId: string;
                memberId: string;
                role?: "contributor" | "maintainer" | "owner" | undefined;
                trustLevel?: number | undefined;
            };
            output: {
                member_id: string;
                user_id: string;
                trust_level: number;
                role: "contributor" | "maintainer" | "owner";
                joined_at: string;
            };
            meta: object;
        }>;
        updateWastelandConfig: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                wastelandId: string;
                name?: string | undefined;
                visibility?: "private" | "public" | undefined;
                dolthubUpstream?: string | undefined;
            };
            output: {
                wasteland_id: string;
                name: string;
                owner_type: "org" | "user";
                owner_user_id: string | null;
                organization_id: string | null;
                dolthub_upstream: string | null;
                visibility: "private" | "public";
                status: "active" | "deleted";
                created_at: string;
                updated_at: string;
            };
            meta: object;
        }>;
        storeCredential: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                wastelandId: string;
                dolthubToken: string;
                dolthubOrg: string;
                rigHandle?: string | undefined;
                doltCredsJwk?: string | undefined;
                doltUserName?: string | undefined;
                doltUserEmail?: string | undefined;
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
        getCredentialStatus: import("@trpc/server").TRPCQueryProcedure<{
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
        setUpstreamAdmin: import("@trpc/server").TRPCMutationProcedure<{
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
        deleteCredential: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                wastelandId: string;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        containerStatus: import("@trpc/server").TRPCQueryProcedure<{
            input: {
                wastelandId: string;
            };
            output: {
                joined: boolean;
                upstream: string | null;
                dolthubOrg: string | null;
                hasToken: boolean;
                hasJwk: boolean;
                doltCredPubKey: string | null;
                wlVersion: string;
                uptime: number;
                lastOperation: string | null;
            };
            meta: object;
        }>;
        containerJoin: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                wastelandId: string;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        connectKiloTown: import("@trpc/server").TRPCMutationProcedure<{
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
        disconnectKiloTown: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                wastelandId: string;
                townId: string;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        listConnectedTowns: import("@trpc/server").TRPCQueryProcedure<{
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
        browseWantedBoard: import("@trpc/server").TRPCQueryProcedure<{
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
        claimWantedItem: import("@trpc/server").TRPCMutationProcedure<{
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
        unclaimWantedItem: import("@trpc/server").TRPCMutationProcedure<{
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
        postWantedItem: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                wastelandId: string;
                title: string;
                description: string;
                priority?: "critical" | "high" | "low" | "medium" | undefined;
                type?: "bug" | "docs" | "feature" | "other" | undefined;
                direct?: boolean | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        markWantedItemDone: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                wastelandId: string;
                itemId: string;
                evidence: string;
                direct?: boolean | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        acceptWantedItem: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                wastelandId: string;
                itemId: string;
                quality: "excellent" | "fair" | "good" | "poor";
                message?: string | undefined;
                direct?: boolean | undefined;
            };
            output: {
                success: boolean;
            };
            meta: object;
        }>;
        rejectWantedItem: import("@trpc/server").TRPCMutationProcedure<{
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
        closeWantedItem: import("@trpc/server").TRPCMutationProcedure<{
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
        mergeUpstreamPR: import("@trpc/server").TRPCMutationProcedure<{
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
        closeUpstreamPR: import("@trpc/server").TRPCMutationProcedure<{
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
        verifyUpstreamAdmin: import("@trpc/server").TRPCMutationProcedure<{
            input: {
                wastelandId: string;
            };
            output: {
                hasWriteAccess: boolean;
                error: string | null;
            };
            meta: object;
        }>;
        listInboxItems: import("@trpc/server").TRPCQueryProcedure<{
            input: {
                wastelandId: string;
            };
            output: {
                items: ({
                    pull_id: string;
                    title: string;
                    state: string;
                    from_branch: string | null;
                    submitter: string | null;
                    creator_name: string | null;
                    created_at: string | null;
                    updated_at: string | null;
                    kind: "rig-registration";
                    handle: string;
                    display_name: string | null;
                    dolthub_org: string | null;
                    owner_email: string | null;
                    hop_uri: string | null;
                    gt_version: string | null;
                } | {
                    pull_id: string;
                    title: string;
                    state: string;
                    from_branch: string | null;
                    submitter: string | null;
                    creator_name: string | null;
                    created_at: string | null;
                    updated_at: string | null;
                    kind: "wanted-post";
                    item_id: string;
                    item_title: string;
                    description: string | null;
                    type: string | null;
                    priority: string | null;
                    effort_level: string | null;
                    tags: string | null;
                    posted_by: string | null;
                } | {
                    pull_id: string;
                    title: string;
                    state: string;
                    from_branch: string | null;
                    submitter: string | null;
                    creator_name: string | null;
                    created_at: string | null;
                    updated_at: string | null;
                    kind: "wanted-edit";
                    subkind: "delete" | "unclaim" | "update";
                    item_id: string;
                    item_title: string;
                    submitter_is_poster: boolean | null;
                    posted_by: string | null;
                    status_transition: string | null;
                } | {
                    pull_id: string;
                    title: string;
                    state: string;
                    from_branch: string | null;
                    submitter: string | null;
                    creator_name: string | null;
                    created_at: string | null;
                    updated_at: string | null;
                    kind: "work-submission";
                    item_id: string;
                    item_title: string;
                    claimer: string;
                    has_done: boolean;
                    evidence_url: string | null;
                    completion_id: string | null;
                } | {
                    pull_id: string;
                    title: string;
                    state: string;
                    from_branch: string | null;
                    submitter: string | null;
                    creator_name: string | null;
                    created_at: string | null;
                    updated_at: string | null;
                    kind: "admin-action";
                    subkind: "accept" | "accept-upstream" | "close" | "close-upstream" | "reject";
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
                } | {
                    pull_id: string;
                    title: string;
                    state: string;
                    from_branch: string | null;
                    submitter: string | null;
                    creator_name: string | null;
                    created_at: string | null;
                    updated_at: string | null;
                    kind: "unknown";
                    commit_subjects: string[];
                })[];
            };
            meta: object;
        }>;
        commentOnUpstreamPR: import("@trpc/server").TRPCMutationProcedure<{
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
        listUpstreamRigs: import("@trpc/server").TRPCQueryProcedure<{
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
        setUpstreamRigTrust: import("@trpc/server").TRPCMutationProcedure<{
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
    }>>;
}>>;
export type WrappedWastelandRouter = typeof wrappedWastelandRouter;
