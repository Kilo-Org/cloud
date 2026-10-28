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
} as const;

/** The session entity leaves only through cloud deletion, never through a batch removal. */
export const REMOVABLE_KINDS = [
  'message',
  'inbox',
  'instruction-entry',
  'instruction-state',
  'instruction-blob',
  'asset',
] as const;

export const ENTITY_KINDS = ['session', ...REMOVABLE_KINDS] as const;

export const REMOVE_CAUSES = ['revert', 'cancel', 'instruction-removed', 'consumed'] as const;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isBoundedJson(value: unknown, depth: number): value is Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth >= LIMITS.jsonDepth || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.every(item => isBoundedJson(item, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(item => isBoundedJson(item, depth + 1));
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export const jsonSchema = z.custom<Json>(value => isBoundedJson(value, 0), {
  message: `Expected JSON nested at most ${LIMITS.jsonDepth} levels`,
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

export const changeSchema = z.union([
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
]);
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
  storage_budget_exceeded: 413,
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

export type Result<T> = { ok: true; value: T } | { ok: false; error: SyncError };

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
  return { error: { code: error.code, message: error.message, ...error.details } };
}
