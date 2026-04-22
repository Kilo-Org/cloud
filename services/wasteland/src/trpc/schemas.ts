import { z } from 'zod';

/**
 * Wraps a Zod schema in z.any().pipe(schema) so the TS input type is `any`
 * (avoiding "excessively deep" instantiation with Rpc.Promisified DO stubs)
 * while still performing full runtime validation via the piped schema.
 */
function rpcSafe<T extends z.ZodTypeAny>(schema: T): z.ZodPipe<z.ZodAny, T> {
  return z.any().pipe(schema);
}

// ── Wasteland (config output for API consumers) ─────────────────────────

export const WastelandOutput = z.object({
  wasteland_id: z.string(),
  name: z.string(),
  owner_type: z.enum(['user', 'org']),
  owner_user_id: z.string().nullable(),
  organization_id: z.string().nullable(),
  dolthub_upstream: z.string().nullable(),
  visibility: z.enum(['public', 'private']),
  status: z.enum(['active', 'deleted']),
  created_at: z.string(),
  updated_at: z.string(),
});

// ── Wasteland Member ────────────────────────────────────────────────────

export const WastelandMemberOutput = z.object({
  member_id: z.string(),
  user_id: z.string(),
  trust_level: z.number(),
  role: z.enum(['contributor', 'maintainer', 'owner']),
  joined_at: z.string(),
});

// ── Credential Status (never expose encrypted_token) ────────────────────

export const WastelandCredentialStatusOutput = z.object({
  user_id: z.string(),
  dolthub_org: z.string(),
  rig_handle: z.string().nullable(),
  is_upstream_admin: z.boolean(),
  connected_at: z.string(),
});

// ── Full Config (same shape as WastelandOutput for now) ─────────────────

export const WastelandConfigOutput = z.object({
  wasteland_id: z.string(),
  name: z.string(),
  owner_type: z.enum(['user', 'org']),
  owner_user_id: z.string().nullable(),
  organization_id: z.string().nullable(),
  dolthub_upstream: z.string().nullable(),
  visibility: z.enum(['public', 'private']),
  status: z.enum(['active', 'deleted']),
  created_at: z.string(),
  updated_at: z.string(),
});

// ── Connected Town ──────────────────────────────────────────────────────

export const ConnectedTownOutput = z.object({
  town_id: z.string(),
  wasteland_id: z.string(),
  connected_by: z.string(),
  connected_at: z.string(),
});

// ── Wanted Board Item ───────────────────────────────────────────────────

export const WantedItemOutput = z.object({
  item_id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(['open', 'claimed', 'done']),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  type: z.enum(['feature', 'bug', 'docs', 'other']),
  claimed_by: z.string().nullable(),
  evidence: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

// The row shape returned by DoltHub's SQL REST API for the `wanted` table.
// Values are strings (MySQL DATETIME as 'YYYY-MM-DD HH:MM:SS', priority as
// stringified integer, etc.). Nulls come through as `null`. All optional
// fields default to `null` when missing so consumers have a stable shape.
export const WantedBoardRowOutput = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().default(null),
  project: z.string().nullable().default(null),
  type: z.string().nullable().default(null),
  priority: z.union([z.string(), z.number()]).nullable().default(null),
  tags: z.string().nullable().default(null),
  posted_by: z.string().nullable().default(null),
  claimed_by: z.string().nullable().default(null),
  status: z.string(),
  effort_level: z.string().nullable().default(null),
  evidence_url: z.string().nullable().default(null),
  sandbox_required: z.union([z.string(), z.number()]).nullable().default(null),
  sandbox_scope: z.string().nullable().default(null),
  sandbox_min_tier: z.string().nullable().default(null),
  created_at: z.string().nullable().default(null),
  updated_at: z.string().nullable().default(null),
});

// ── Admin: mergeUpstreamPR result ───────────────────────────────────────

export const MergePullOutput = z.object({
  pull_id: z.string(),
  state: z.string(),
});

// ── Admin: verifyUpstreamAdmin ─────────────────────────────────────────

export const UpstreamAdminVerifyOutput = z.object({
  hasWriteAccess: z.boolean(),
  error: z.string().nullable(),
});

// ── Admin: upstream rigs row ────────────────────────────────────────────

export const UpstreamRigOutput = z.object({
  rig_handle: z.string(),
  display_name: z.string().nullable(),
  trust_level: z.number(),
  registered_at: z.string().nullable(),
  last_seen_at: z.string().nullable(),
});

// ── Admin: Review inbox items ──────────────────────────────────────────
// Discriminated union matching the `InboxItem` type from
// `../inbox/inbox-classifier`. Each kind renders as a distinct card in
// the Review page UI.

const InboxBase = {
  pull_id: z.string(),
  title: z.string(),
  state: z.string(),
  from_branch: z.string().nullable(),
  submitter: z.string().nullable(),
  creator_name: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
};

export const InboxItemOutput = z.discriminatedUnion('kind', [
  z.object({
    ...InboxBase,
    kind: z.literal('rig-registration'),
    handle: z.string(),
    display_name: z.string().nullable(),
    dolthub_org: z.string().nullable(),
    owner_email: z.string().nullable(),
    hop_uri: z.string().nullable(),
    gt_version: z.string().nullable(),
  }),
  z.object({
    ...InboxBase,
    kind: z.literal('wanted-post'),
    item_id: z.string(),
    item_title: z.string(),
    description: z.string().nullable(),
    type: z.string().nullable(),
    priority: z.string().nullable(),
    effort_level: z.string().nullable(),
    tags: z.string().nullable(),
    posted_by: z.string().nullable(),
  }),
  z.object({
    ...InboxBase,
    kind: z.literal('wanted-edit'),
    subkind: z.enum(['update', 'delete', 'unclaim']),
    item_id: z.string(),
    item_title: z.string(),
    submitter_is_poster: z.boolean().nullable(),
    posted_by: z.string().nullable(),
    status_transition: z.string().nullable(),
  }),
  z.object({
    ...InboxBase,
    kind: z.literal('work-submission'),
    item_id: z.string(),
    item_title: z.string(),
    claimer: z.string(),
    has_done: z.boolean(),
    evidence_url: z.string().nullable(),
    completion_id: z.string().nullable(),
  }),
  z.object({
    ...InboxBase,
    kind: z.literal('admin-action'),
    subkind: z.enum(['accept', 'accept-upstream', 'reject', 'close', 'close-upstream']),
    item_id: z.string(),
    item_title: z.string(),
    worker: z.string().nullable(),
    acceptor: z.string().nullable(),
    reject_reason: z.string().nullable(),
    stamp: z
      .object({
        quality: z.string().nullable(),
        severity: z.string().nullable(),
        skill_tags: z.string().nullable(),
        message: z.string().nullable(),
      })
      .nullable(),
  }),
  z.object({
    ...InboxBase,
    kind: z.literal('unknown'),
    commit_subjects: z.array(z.string()),
  }),
]);

// ── rpcSafe wrappers ────────────────────────────────────────────────────
// tRPC's .output() forces TypeScript to check that the handler return type
// is assignable to the schema's input type. When handlers return values from
// Cloudflare Rpc.Promisified DO stubs, the deeply recursive proxy types
// exceed TS's instantiation depth limit. Wrapping with rpcSafe() (z.any().pipe)
// short-circuits the type check while preserving identical runtime validation.

export const RpcWastelandOutput = rpcSafe(WastelandOutput);
export const RpcWastelandMemberOutput = rpcSafe(WastelandMemberOutput);
export const RpcWastelandCredentialStatusOutput = rpcSafe(WastelandCredentialStatusOutput);
export const RpcWastelandConfigOutput = rpcSafe(WastelandConfigOutput);
export const RpcConnectedTownOutput = rpcSafe(ConnectedTownOutput);
export const RpcWantedItemOutput = rpcSafe(WantedItemOutput);
export const RpcWantedBoardRowOutput = rpcSafe(WantedBoardRowOutput);
export const RpcMergePullOutput = rpcSafe(MergePullOutput);
export const RpcUpstreamAdminVerifyOutput = rpcSafe(UpstreamAdminVerifyOutput);
export const RpcUpstreamRigOutput = rpcSafe(UpstreamRigOutput);
export const RpcInboxItemOutput = rpcSafe(InboxItemOutput);
