import { base64urlToBytes, bytesToBase64url } from '@kilocode/worker-utils/base64url';
import { z } from 'zod';

/** Request and storage bounds. Oversized data fails explicitly; nothing is skipped. */
export const LIMITS = {
  /** Bytes of one batch request body. */
  batchBytes: 512 * 1024,
  /** Bytes of one registration or exchange request body. */
  controlBytes: 4 * 1024,
  /** Changes in one batch. */
  changes: 64,
  /** UTF-8 bytes of one serialized inline value. */
  inlineBytes: 64 * 1024,
  /** Nesting depth of one inline value. */
  jsonDepth: 64,
  /** JSON values plus object keys in one inline value. */
  jsonValueNodes: 8_192,
  /** JSON values plus object keys in the complete batch, including its envelope. */
  jsonBatchNodes: 32_768,
  /** Batch object, changes array, and change object above an inline value. */
  jsonBatchDepth: 67,
  /** Active and queued batch request strings, conservatively charged as UTF-16. */
  batchQueueBytes: 4 * 1024 * 1024,
  /** Active and queued batch calls, including tiny/empty bodies. */
  batchQueueRequests: 8,
  /** Bytes of one blob. */
  blobBytes: 8 * 1024 * 1024,
  /** Reserved and stored blob bytes for one session. */
  sessionBlobBytes: 256 * 1024 * 1024,
  /** Stored and reserved blob entries for one session. */
  sessionBlobs: 10_000,
  /** Stored inline value bytes for one session. */
  sessionInlineBytes: 64 * 1024 * 1024,
  /** Current entities for one session. */
  sessionEntities: 100_000,
  /** Characters of an entity ID or principal ID. */
  idChars: 256,
  /** Default and maximum entities in one page. */
  pageDefault: 50,
  pageItems: 100,
  /** Inline value bytes in one page; a page always holds at least one entity. */
  pageBytes: 2 * 1024 * 1024,
  /** Characters of an encoded page cursor. */
  cursorChars: 4096,
  /** Retained batch receipts per session. */
  receipts: 256,
  /** Time an upload has to store its object after it starts. */
  uploadMs: 5 * 60_000,
  /** Grace period for verified blobs without a current entity reference. */
  unreferencedMs: 15 * 60_000,
  tenantInitialLeaseBytes: 1024 * 1024,
  tenantLeaseBytes: 32 * 1024 * 1024,
  userTenantSessions: 10_000,
  userTenantBytes: 100 * 1024 * 1024 * 1024,
  organizationTenantSessions: 200_000,
  organizationTenantBytes: 2 * 1024 * 1024 * 1024 * 1024,
} as const;

/** The session entity leaves only through cloud deletion, never through a batch removal. */
export const REMOVABLE_KINDS = [
  'message',
  'message-part',
  'inbox',
  'instruction-entry',
  'instruction-state',
  'instruction-blob',
  'asset',
] as const;

export const ENTITY_KINDS = ['session', ...REMOVABLE_KINDS] as const;

export const REMOVE_CAUSES = [
  'revert',
  'cancel',
  'instruction-removed',
  'consumed',
  'part-removed',
] as const;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Counts keys as well as values, without allocating an array for object properties. */
export function isBoundedJson(
  value: unknown,
  depth = 0,
  budget: { nodes: number; exceeded?: boolean } = { nodes: 0 }
): value is Json {
  if (++budget.nodes > LIMITS.jsonValueNodes) {
    budget.exceeded = true;
    return false;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (depth >= LIMITS.jsonDepth) {
    budget.exceeded = true;
    return false;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isBoundedJson(item, depth + 1, budget)) return false;
    }
    return true;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const record = value as Record<string, unknown>;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (++budget.nodes > LIMITS.jsonValueNodes) {
      budget.exceeded = true;
      return false;
    }
    if (!isBoundedJson(record[key], depth + 1, budget)) return false;
  }
  return true;
}

/**
 * Lexical preflight BEFORE JSON.parse: adversarial small-token/deep bodies cannot
 * allocate an unbounded object graph. JSON.parse still owns syntax validation.
 * Strings (including object keys), containers, and primitives each cost a node.
 */
export function batchJsonWithinBudget(body: string): boolean {
  let nodes = 0;
  let depth = 0;
  let primitive = false;
  for (let index = 0; index < body.length; index++) {
    const code = body.charCodeAt(index);
    if (code === 0x22) {
      if (++nodes > LIMITS.jsonBatchNodes) return false;
      for (index++; index < body.length; index++) {
        const next = body.charCodeAt(index);
        if (next === 0x5c) index++;
        else if (next === 0x22) break;
      }
      primitive = false;
    } else if (code === 0x7b || code === 0x5b) {
      if (++nodes > LIMITS.jsonBatchNodes || ++depth > LIMITS.jsonBatchDepth) return false;
      primitive = false;
    } else if (code === 0x7d || code === 0x5d) {
      depth--;
      primitive = false;
    } else if (code === 0x2c || code === 0x3a || code <= 0x20) {
      primitive = false;
    } else if (!primitive) {
      if (++nodes > LIMITS.jsonBatchNodes) return false;
      primitive = true;
    }
  }
  return true;
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export const jsonSchema = z.custom<Json>(value => isBoundedJson(value), {
  message: `Expected JSON with at most ${LIMITS.jsonDepth} levels and ${LIMITS.jsonValueNodes} nodes`,
});

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Native session IDs start with `ses`; the rest is producer-defined. */
export const sessionIDSchema = z
  .string()
  .min(3)
  .max(LIMITS.idChars)
  .startsWith('ses')
  .refine(value => !hasControlCharacter(value), 'Session IDs cannot contain control characters');
export const uuidSchema = z.uuid();
export const entityIDSchema = z
  .string()
  .min(1)
  .max(LIMITS.idChars)
  .refine(value => !hasControlCharacter(value), 'Entity IDs cannot contain control characters');
export const kindSchema = z.enum(ENTITY_KINDS);
export const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const positionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const revisionSchema = positionSchema;

export const userIDSchema = z.string().min(1).max(LIMITS.idChars);

export const tenantSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('user'), id: userIDSchema }),
  z.strictObject({ type: z.literal('organization'), id: z.uuid() }),
]);
export type Tenant = z.infer<typeof tenantSchema>;

/** A personal tenant is always the authenticated user. */
export const principalSchema = z
  .strictObject({ userID: userIDSchema, tenant: tenantSchema })
  .refine(p => p.tenant.type === 'organization' || p.tenant.id === p.userID, {
    message: 'A personal tenant must match its user',
  });
export type Principal = z.infer<typeof principalSchema>;

export const exchangeRequestSchema = z.strictObject({
  version: z.literal(1),
  organizationID: z
    .uuid()
    .transform(id => id.toLowerCase())
    .optional(),
});

export const exchangeResponseSchema = z.strictObject({
  version: z.literal(1),
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
  tenant: tenantSchema,
  userID: userIDSchema,
});

export const blobRefSchema = z.strictObject({
  hash: hashSchema,
  bytes: z.number().int().min(0).max(LIMITS.blobBytes),
});
export type BlobRef = z.infer<typeof blobRefSchema>;

export const changeSchema = z
  .union([
    z.strictObject({
      op: z.literal('put'),
      kind: kindSchema,
      id: entityIDSchema,
      value: jsonSchema,
    }),
    z.strictObject({
      op: z.literal('put'),
      kind: kindSchema,
      id: entityIDSchema,
      blob: blobRefSchema,
    }),
    z.strictObject({
      op: z.literal('remove'),
      kind: z.enum(REMOVABLE_KINDS),
      id: entityIDSchema,
      cause: z.enum(REMOVE_CAUSES),
    }),
  ])
  .refine(
    change =>
      change.op !== 'remove' ||
      change.cause !== 'part-removed' ||
      change.kind === 'message-part' ||
      change.kind === 'asset',
    { message: '`part-removed` only removes message-part or asset entities' }
  );
export type Change = z.infer<typeof changeSchema>;

export const registerRequestSchema = z.strictObject({
  version: z.literal(1),
  sourceID: uuidSchema,
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const batchRequestSchema = z
  .strictObject({
    version: z.literal(1),
    sourceID: uuidSchema,
    batchID: uuidSchema,
    after: positionSchema,
    through: positionSchema,
    changes: z.array(changeSchema).max(LIMITS.changes),
  })
  .refine(batch => batch.through > batch.after, {
    message: '`through` must be greater than `after`',
    path: ['through'],
  })
  .superRefine((batch, ctx) => {
    let total = 0;
    batch.changes.forEach((change, index) => {
      if (!('value' in change)) return;
      const bytes = utf8Bytes(JSON.stringify(change.value));
      total += bytes;
      if (bytes <= LIMITS.inlineBytes) return;
      ctx.addIssue({
        code: 'custom',
        message: `Inline value exceeds ${LIMITS.inlineBytes} bytes; upload a blob instead`,
        path: ['changes', index, 'value'],
      });
    });
    if (total <= LIMITS.batchBytes) return;
    ctx.addIssue({
      code: 'custom',
      message: `Inline values exceed ${LIMITS.batchBytes} bytes in one batch`,
      path: ['changes'],
    });
  });
export type BatchRequest = z.infer<typeof batchRequestSchema>;

export const cursorSchema = z.strictObject({ kind: kindSchema, id: entityIDSchema });
export type Cursor = z.infer<typeof cursorSchema>;

const cursorTupleSchema = z.tuple([kindSchema, entityIDSchema]);

/** Encodes the last returned entity key as an opaque page cursor. */
export function encodeCursor(cursor: Cursor): string {
  return bytesToBase64url(new TextEncoder().encode(JSON.stringify([cursor.kind, cursor.id])));
}

export function decodeCursor(encoded: string): Cursor | undefined {
  try {
    const decoded: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(base64urlToBytes(encoded))
    );
    const parsed = cursorTupleSchema.safeParse(decoded);
    return parsed.success ? { kind: parsed.data[0], id: parsed.data[1] } : undefined;
  } catch {
    return undefined;
  }
}

export const pageQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(LIMITS.cursorChars).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.pageItems).optional(),
  revision: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

export const receiptSchema = z.strictObject({
  version: z.literal(1),
  sessionID: sessionIDSchema,
  batchID: uuidSchema,
  after: positionSchema,
  through: positionSchema,
  revision: revisionSchema,
  changes: z.number().int().min(0),
  /** SHA-256 of the exact request body bytes; a retry must repeat them verbatim. */
  digest: hashSchema,
  committedAt: z.number().int(),
});
export type Receipt = z.infer<typeof receiptSchema>;

export const liveStateSchema = z.strictObject({
  version: z.literal(1),
  sessionID: sessionIDSchema,
  tenant: tenantSchema,
  deleted: z.literal(false),
  creatorID: z.string(),
  sourceID: uuidSchema,
  position: positionSchema,
  revision: revisionSchema,
  batches: z.number().int().min(0),
  /** Receipt of the batch that set `position`; null before the first batch. */
  lastReceipt: receiptSchema.nullable(),
  usage: z.strictObject({
    entities: z.number().int().min(0),
    inlineBytes: z.number().int().min(0),
    blobBytes: z.number().int().min(0),
  }),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const deletedStateSchema = z.strictObject({
  version: z.literal(1),
  sessionID: sessionIDSchema,
  tenant: tenantSchema,
  deleted: z.literal(true),
  deletedAt: z.number().int(),
});

export const sessionStateSchema = z.discriminatedUnion('deleted', [
  liveStateSchema,
  deletedStateSchema,
]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const entitySchema = z.union([
  z.strictObject({
    kind: kindSchema,
    id: entityIDSchema,
    revision: revisionSchema,
    value: jsonSchema,
  }),
  z.strictObject({
    kind: kindSchema,
    id: entityIDSchema,
    revision: revisionSchema,
    blob: blobRefSchema,
  }),
]);
export type Entity = z.infer<typeof entitySchema>;

export const pageSchema = z.strictObject({
  version: z.literal(1),
  sessionID: sessionIDSchema,
  revision: revisionSchema,
  position: positionSchema,
  entities: z.array(entitySchema),
  next: z.string().nullable(),
});
export type Page = z.infer<typeof pageSchema>;

export const blobAckSchema = z.strictObject({
  version: z.literal(1),
  hash: hashSchema,
  bytes: z.number().int().min(0),
  created: z.boolean(),
});
export type BlobAck = z.infer<typeof blobAckSchema>;

export const ERROR_STATUS = {
  invalid_request: 400,
  blob_hash_mismatch: 400,
  creator_mismatch: 403,
  not_found: 404,
  session_not_found: 404,
  blob_not_found: 404,
  source_conflict: 409,
  batch_conflict: 409,
  batch_superseded: 409,
  position_conflict: 409,
  blob_missing: 409,
  revision_changed: 409,
  upload_timeout: 408,
  upload_in_progress: 409,
  session_deleted: 410,
  length_required: 411,
  request_too_large: 413,
  json_budget_exceeded: 413,
  storage_budget_exceeded: 413,
  tenant_budget_exceeded: 413,
  rate_limited: 429,
  tenant_unavailable: 503,
  service_overloaded: 503,
  internal_error: 500,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;

export type SyncError = {
  code: ErrorCode;
  message: string;
  /** Machine-readable context, such as the committed position after a conflict. */
  details?: Record<string, string | number>;
};

export const errorBodySchema = z.strictObject({
  error: z.looseObject({ code: z.string(), message: z.string() }),
});

export type Result<T> = ({ ok: true; value: T } | { ok: false; error: SyncError }) & {
  r2Ms?: number;
};

export function fail(
  code: ErrorCode,
  message: string,
  details?: SyncError['details']
): { ok: false; error: SyncError } {
  return { ok: false, error: details ? { code, message, details } : { code, message } };
}

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function errorBody(error: SyncError) {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...error.details,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}
