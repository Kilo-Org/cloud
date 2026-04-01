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
export const RpcWantedItemOutput = rpcSafe(WantedItemOutput);
