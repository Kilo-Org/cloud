declare const WL_VERBS: readonly ["post", "claim", "unclaim", "done", "update", "delete", "accept", "accept-upstream", "reject", "close", "close-upstream"];
type WlVerb = (typeof WL_VERBS)[number];
type ParsedCommit = {
    kind: 'wl';
    verb: WlVerb;
    itemId: string;
    reason?: string;
} | {
    kind: 'register';
    handle: string;
} | {
    kind: 'unknown';
    subject: string;
};
/**
 * Parse a commit subject against the closed grammar produced by the `wl` CLI:
 *   - `wl {verb}: {wanted-id}[ — {reason}]`  (reason only on `reject`)
 *   - `Register rig: {handle}`               (no leading `wl`, capital R)
 * Anything else returns `{ kind: 'unknown' }` so the card renders as foreign.
 */
export declare function parseCommitSubject(subject: string): ParsedCommit;
type InboxCardBase = {
    pull_id: string;
    title: string;
    state: string;
    from_branch: string | null;
    submitter: string | null;
    creator_name: string | null;
    created_at: string | null;
    updated_at: string | null;
};
export type InboxItem = InboxCardBase & ({
    kind: 'rig-registration';
    handle: string;
    display_name: string | null;
    dolthub_org: string | null;
    owner_email: string | null;
    hop_uri: string | null;
    gt_version: string | null;
} | {
    kind: 'wanted-post';
    item_id: string;
    item_title: string;
    description: string | null;
    type: string | null;
    priority: string | null;
    effort_level: string | null;
    tags: string | null;
    posted_by: string | null;
} | {
    kind: 'wanted-edit';
    subkind: 'update' | 'delete' | 'unclaim';
    item_id: string;
    item_title: string;
    submitter_is_poster: boolean | null;
    posted_by: string | null;
    status_transition: string | null;
} | {
    kind: 'work-submission';
    item_id: string;
    item_title: string;
    claimer: string;
    has_done: boolean;
    evidence_url: string | null;
    completion_id: string | null;
} | {
    kind: 'admin-action';
    subkind: 'accept' | 'accept-upstream' | 'reject' | 'close' | 'close-upstream';
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
    kind: 'unknown';
    commit_subjects: string[];
});
export declare function listInboxItems(upstream: string, token: string): Promise<InboxItem[]>;
export {};
