import { z } from 'zod';
export declare const WastelandOutput: z.ZodObject<{
    wasteland_id: z.ZodString;
    name: z.ZodString;
    owner_type: z.ZodEnum<{
        org: "org";
        user: "user";
    }>;
    owner_user_id: z.ZodNullable<z.ZodString>;
    organization_id: z.ZodNullable<z.ZodString>;
    dolthub_upstream: z.ZodNullable<z.ZodString>;
    visibility: z.ZodEnum<{
        private: "private";
        public: "public";
    }>;
    status: z.ZodEnum<{
        active: "active";
        deleted: "deleted";
    }>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
}, z.core.$strip>;
export declare const WastelandMemberOutput: z.ZodObject<{
    member_id: z.ZodString;
    user_id: z.ZodString;
    trust_level: z.ZodNumber;
    role: z.ZodEnum<{
        contributor: "contributor";
        maintainer: "maintainer";
        owner: "owner";
    }>;
    joined_at: z.ZodString;
}, z.core.$strip>;
export declare const WastelandCredentialStatusOutput: z.ZodObject<{
    user_id: z.ZodString;
    dolthub_org: z.ZodString;
    rig_handle: z.ZodNullable<z.ZodString>;
    is_upstream_admin: z.ZodBoolean;
    connected_at: z.ZodString;
}, z.core.$strip>;
export declare const WastelandConfigOutput: z.ZodObject<{
    wasteland_id: z.ZodString;
    name: z.ZodString;
    owner_type: z.ZodEnum<{
        org: "org";
        user: "user";
    }>;
    owner_user_id: z.ZodNullable<z.ZodString>;
    organization_id: z.ZodNullable<z.ZodString>;
    dolthub_upstream: z.ZodNullable<z.ZodString>;
    visibility: z.ZodEnum<{
        private: "private";
        public: "public";
    }>;
    status: z.ZodEnum<{
        active: "active";
        deleted: "deleted";
    }>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
}, z.core.$strip>;
export declare const ConnectedTownOutput: z.ZodObject<{
    town_id: z.ZodString;
    wasteland_id: z.ZodString;
    connected_by: z.ZodString;
    connected_at: z.ZodString;
}, z.core.$strip>;
export declare const WantedItemOutput: z.ZodObject<{
    item_id: z.ZodString;
    title: z.ZodString;
    description: z.ZodString;
    status: z.ZodEnum<{
        claimed: "claimed";
        done: "done";
        open: "open";
    }>;
    priority: z.ZodEnum<{
        critical: "critical";
        high: "high";
        low: "low";
        medium: "medium";
    }>;
    type: z.ZodEnum<{
        bug: "bug";
        docs: "docs";
        feature: "feature";
        other: "other";
    }>;
    claimed_by: z.ZodNullable<z.ZodString>;
    evidence: z.ZodNullable<z.ZodString>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
}, z.core.$strip>;
export declare const WantedBoardRowOutput: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    description: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    project: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    type: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    priority: z.ZodDefault<z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    tags: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    posted_by: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    claimed_by: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    status: z.ZodString;
    effort_level: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    evidence_url: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    sandbox_required: z.ZodDefault<z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    sandbox_scope: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    sandbox_min_tier: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    created_at: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    updated_at: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
export declare const MergePullOutput: z.ZodObject<{
    pull_id: z.ZodString;
    state: z.ZodString;
}, z.core.$strip>;
export declare const UpstreamAdminVerifyOutput: z.ZodObject<{
    hasWriteAccess: z.ZodBoolean;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const UpstreamRigOutput: z.ZodObject<{
    rig_handle: z.ZodString;
    display_name: z.ZodNullable<z.ZodString>;
    trust_level: z.ZodNumber;
    registered_at: z.ZodNullable<z.ZodString>;
    last_seen_at: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export declare const InboxItemOutput: z.ZodDiscriminatedUnion<[z.ZodObject<{
    pull_id: z.ZodString;
    title: z.ZodString;
    state: z.ZodString;
    from_branch: z.ZodNullable<z.ZodString>;
    submitter: z.ZodNullable<z.ZodString>;
    creator_name: z.ZodNullable<z.ZodString>;
    created_at: z.ZodNullable<z.ZodString>;
    updated_at: z.ZodNullable<z.ZodString>;
    kind: z.ZodLiteral<"rig-registration">;
    handle: z.ZodString;
    display_name: z.ZodNullable<z.ZodString>;
    dolthub_org: z.ZodNullable<z.ZodString>;
    owner_email: z.ZodNullable<z.ZodString>;
    hop_uri: z.ZodNullable<z.ZodString>;
    gt_version: z.ZodNullable<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    pull_id: z.ZodString;
    title: z.ZodString;
    state: z.ZodString;
    from_branch: z.ZodNullable<z.ZodString>;
    submitter: z.ZodNullable<z.ZodString>;
    creator_name: z.ZodNullable<z.ZodString>;
    created_at: z.ZodNullable<z.ZodString>;
    updated_at: z.ZodNullable<z.ZodString>;
    kind: z.ZodLiteral<"wanted-post">;
    item_id: z.ZodString;
    item_title: z.ZodString;
    description: z.ZodNullable<z.ZodString>;
    type: z.ZodNullable<z.ZodString>;
    priority: z.ZodNullable<z.ZodString>;
    effort_level: z.ZodNullable<z.ZodString>;
    tags: z.ZodNullable<z.ZodString>;
    posted_by: z.ZodNullable<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    pull_id: z.ZodString;
    title: z.ZodString;
    state: z.ZodString;
    from_branch: z.ZodNullable<z.ZodString>;
    submitter: z.ZodNullable<z.ZodString>;
    creator_name: z.ZodNullable<z.ZodString>;
    created_at: z.ZodNullable<z.ZodString>;
    updated_at: z.ZodNullable<z.ZodString>;
    kind: z.ZodLiteral<"wanted-edit">;
    subkind: z.ZodEnum<{
        delete: "delete";
        unclaim: "unclaim";
        update: "update";
    }>;
    item_id: z.ZodString;
    item_title: z.ZodString;
    submitter_is_poster: z.ZodNullable<z.ZodBoolean>;
    posted_by: z.ZodNullable<z.ZodString>;
    status_transition: z.ZodNullable<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    pull_id: z.ZodString;
    title: z.ZodString;
    state: z.ZodString;
    from_branch: z.ZodNullable<z.ZodString>;
    submitter: z.ZodNullable<z.ZodString>;
    creator_name: z.ZodNullable<z.ZodString>;
    created_at: z.ZodNullable<z.ZodString>;
    updated_at: z.ZodNullable<z.ZodString>;
    kind: z.ZodLiteral<"work-submission">;
    item_id: z.ZodString;
    item_title: z.ZodString;
    claimer: z.ZodString;
    has_done: z.ZodBoolean;
    evidence_url: z.ZodNullable<z.ZodString>;
    completion_id: z.ZodNullable<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    pull_id: z.ZodString;
    title: z.ZodString;
    state: z.ZodString;
    from_branch: z.ZodNullable<z.ZodString>;
    submitter: z.ZodNullable<z.ZodString>;
    creator_name: z.ZodNullable<z.ZodString>;
    created_at: z.ZodNullable<z.ZodString>;
    updated_at: z.ZodNullable<z.ZodString>;
    kind: z.ZodLiteral<"admin-action">;
    subkind: z.ZodEnum<{
        accept: "accept";
        "accept-upstream": "accept-upstream";
        close: "close";
        "close-upstream": "close-upstream";
        reject: "reject";
    }>;
    item_id: z.ZodString;
    item_title: z.ZodString;
    worker: z.ZodNullable<z.ZodString>;
    acceptor: z.ZodNullable<z.ZodString>;
    reject_reason: z.ZodNullable<z.ZodString>;
    stamp: z.ZodNullable<z.ZodObject<{
        quality: z.ZodNullable<z.ZodString>;
        severity: z.ZodNullable<z.ZodString>;
        skill_tags: z.ZodNullable<z.ZodString>;
        message: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    pull_id: z.ZodString;
    title: z.ZodString;
    state: z.ZodString;
    from_branch: z.ZodNullable<z.ZodString>;
    submitter: z.ZodNullable<z.ZodString>;
    creator_name: z.ZodNullable<z.ZodString>;
    created_at: z.ZodNullable<z.ZodString>;
    updated_at: z.ZodNullable<z.ZodString>;
    kind: z.ZodLiteral<"unknown">;
    commit_subjects: z.ZodArray<z.ZodString>;
}, z.core.$strip>], "kind">;
export declare const RpcWastelandOutput: z.ZodPipe<z.ZodAny, z.ZodObject<{
    wasteland_id: z.ZodString;
    name: z.ZodString;
    owner_type: z.ZodEnum<{
        org: "org";
        user: "user";
    }>;
    owner_user_id: z.ZodNullable<z.ZodString>;
    organization_id: z.ZodNullable<z.ZodString>;
    dolthub_upstream: z.ZodNullable<z.ZodString>;
    visibility: z.ZodEnum<{
        private: "private";
        public: "public";
    }>;
    status: z.ZodEnum<{
        active: "active";
        deleted: "deleted";
    }>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
}, z.core.$strip>>;
export declare const RpcWastelandMemberOutput: z.ZodPipe<z.ZodAny, z.ZodObject<{
    member_id: z.ZodString;
    user_id: z.ZodString;
    trust_level: z.ZodNumber;
    role: z.ZodEnum<{
        contributor: "contributor";
        maintainer: "maintainer";
        owner: "owner";
    }>;
    joined_at: z.ZodString;
}, z.core.$strip>>;
export declare const RpcWastelandCredentialStatusOutput: z.ZodPipe<z.ZodAny, z.ZodObject<{
    user_id: z.ZodString;
    dolthub_org: z.ZodString;
    rig_handle: z.ZodNullable<z.ZodString>;
    is_upstream_admin: z.ZodBoolean;
    connected_at: z.ZodString;
}, z.core.$strip>>;
export declare const RpcWastelandConfigOutput: z.ZodPipe<z.ZodAny, z.ZodObject<{
    wasteland_id: z.ZodString;
    name: z.ZodString;
    owner_type: z.ZodEnum<{
        org: "org";
        user: "user";
    }>;
    owner_user_id: z.ZodNullable<z.ZodString>;
    organization_id: z.ZodNullable<z.ZodString>;
    dolthub_upstream: z.ZodNullable<z.ZodString>;
    visibility: z.ZodEnum<{
        private: "private";
        public: "public";
    }>;
    status: z.ZodEnum<{
        active: "active";
        deleted: "deleted";
    }>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
}, z.core.$strip>>;
export declare const RpcConnectedTownOutput: z.ZodPipe<z.ZodAny, z.ZodObject<{
    town_id: z.ZodString;
    wasteland_id: z.ZodString;
    connected_by: z.ZodString;
    connected_at: z.ZodString;
}, z.core.$strip>>;
export declare const RpcWantedItemOutput: z.ZodPipe<z.ZodAny, z.ZodObject<{
    item_id: z.ZodString;
    title: z.ZodString;
    description: z.ZodString;
    status: z.ZodEnum<{
        claimed: "claimed";
        done: "done";
        open: "open";
    }>;
    priority: z.ZodEnum<{
        critical: "critical";
        high: "high";
        low: "low";
        medium: "medium";
    }>;
    type: z.ZodEnum<{
        bug: "bug";
        docs: "docs";
        feature: "feature";
        other: "other";
    }>;
    claimed_by: z.ZodNullable<z.ZodString>;
    evidence: z.ZodNullable<z.ZodString>;
    created_at: z.ZodString;
    updated_at: z.ZodString;
}, z.core.$strip>>;
export declare const RpcWantedBoardRowOutput: z.ZodPipe<z.ZodAny, z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    description: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    project: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    type: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    priority: z.ZodDefault<z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    tags: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    posted_by: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    claimed_by: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    status: z.ZodString;
    effort_level: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    evidence_url: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    sandbox_required: z.ZodDefault<z.ZodNullable<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    sandbox_scope: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    sandbox_min_tier: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    created_at: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    updated_at: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>>;
export declare const RpcMergePullOutput: z.ZodPipe<z.ZodAny, z.ZodObject<{
    pull_id: z.ZodString;
    state: z.ZodString;
}, z.core.$strip>>;
export declare const RpcUpstreamAdminVerifyOutput: z.ZodPipe<z.ZodAny, z.ZodObject<{
    hasWriteAccess: z.ZodBoolean;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strip>>;
export declare const RpcUpstreamRigOutput: z.ZodPipe<z.ZodAny, z.ZodObject<{
    rig_handle: z.ZodString;
    display_name: z.ZodNullable<z.ZodString>;
    trust_level: z.ZodNumber;
    registered_at: z.ZodNullable<z.ZodString>;
    last_seen_at: z.ZodNullable<z.ZodString>;
}, z.core.$strip>>;
export declare const RpcInboxItemOutput: z.ZodPipe<z.ZodAny, z.ZodDiscriminatedUnion<[z.ZodObject<{
    pull_id: z.ZodString;
    title: z.ZodString;
    state: z.ZodString;
    from_branch: z.ZodNullable<z.ZodString>;
    submitter: z.ZodNullable<z.ZodString>;
    creator_name: z.ZodNullable<z.ZodString>;
    created_at: z.ZodNullable<z.ZodString>;
    updated_at: z.ZodNullable<z.ZodString>;
    kind: z.ZodLiteral<"rig-registration">;
    handle: z.ZodString;
    display_name: z.ZodNullable<z.ZodString>;
    dolthub_org: z.ZodNullable<z.ZodString>;
    owner_email: z.ZodNullable<z.ZodString>;
    hop_uri: z.ZodNullable<z.ZodString>;
    gt_version: z.ZodNullable<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    pull_id: z.ZodString;
    title: z.ZodString;
    state: z.ZodString;
    from_branch: z.ZodNullable<z.ZodString>;
    submitter: z.ZodNullable<z.ZodString>;
    creator_name: z.ZodNullable<z.ZodString>;
    created_at: z.ZodNullable<z.ZodString>;
    updated_at: z.ZodNullable<z.ZodString>;
    kind: z.ZodLiteral<"wanted-post">;
    item_id: z.ZodString;
    item_title: z.ZodString;
    description: z.ZodNullable<z.ZodString>;
    type: z.ZodNullable<z.ZodString>;
    priority: z.ZodNullable<z.ZodString>;
    effort_level: z.ZodNullable<z.ZodString>;
    tags: z.ZodNullable<z.ZodString>;
    posted_by: z.ZodNullable<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    pull_id: z.ZodString;
    title: z.ZodString;
    state: z.ZodString;
    from_branch: z.ZodNullable<z.ZodString>;
    submitter: z.ZodNullable<z.ZodString>;
    creator_name: z.ZodNullable<z.ZodString>;
    created_at: z.ZodNullable<z.ZodString>;
    updated_at: z.ZodNullable<z.ZodString>;
    kind: z.ZodLiteral<"wanted-edit">;
    subkind: z.ZodEnum<{
        delete: "delete";
        unclaim: "unclaim";
        update: "update";
    }>;
    item_id: z.ZodString;
    item_title: z.ZodString;
    submitter_is_poster: z.ZodNullable<z.ZodBoolean>;
    posted_by: z.ZodNullable<z.ZodString>;
    status_transition: z.ZodNullable<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    pull_id: z.ZodString;
    title: z.ZodString;
    state: z.ZodString;
    from_branch: z.ZodNullable<z.ZodString>;
    submitter: z.ZodNullable<z.ZodString>;
    creator_name: z.ZodNullable<z.ZodString>;
    created_at: z.ZodNullable<z.ZodString>;
    updated_at: z.ZodNullable<z.ZodString>;
    kind: z.ZodLiteral<"work-submission">;
    item_id: z.ZodString;
    item_title: z.ZodString;
    claimer: z.ZodString;
    has_done: z.ZodBoolean;
    evidence_url: z.ZodNullable<z.ZodString>;
    completion_id: z.ZodNullable<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    pull_id: z.ZodString;
    title: z.ZodString;
    state: z.ZodString;
    from_branch: z.ZodNullable<z.ZodString>;
    submitter: z.ZodNullable<z.ZodString>;
    creator_name: z.ZodNullable<z.ZodString>;
    created_at: z.ZodNullable<z.ZodString>;
    updated_at: z.ZodNullable<z.ZodString>;
    kind: z.ZodLiteral<"admin-action">;
    subkind: z.ZodEnum<{
        accept: "accept";
        "accept-upstream": "accept-upstream";
        close: "close";
        "close-upstream": "close-upstream";
        reject: "reject";
    }>;
    item_id: z.ZodString;
    item_title: z.ZodString;
    worker: z.ZodNullable<z.ZodString>;
    acceptor: z.ZodNullable<z.ZodString>;
    reject_reason: z.ZodNullable<z.ZodString>;
    stamp: z.ZodNullable<z.ZodObject<{
        quality: z.ZodNullable<z.ZodString>;
        severity: z.ZodNullable<z.ZodString>;
        skill_tags: z.ZodNullable<z.ZodString>;
        message: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    pull_id: z.ZodString;
    title: z.ZodString;
    state: z.ZodString;
    from_branch: z.ZodNullable<z.ZodString>;
    submitter: z.ZodNullable<z.ZodString>;
    creator_name: z.ZodNullable<z.ZodString>;
    created_at: z.ZodNullable<z.ZodString>;
    updated_at: z.ZodNullable<z.ZodString>;
    kind: z.ZodLiteral<"unknown">;
    commit_subjects: z.ZodArray<z.ZodString>;
}, z.core.$strip>], "kind">>;
