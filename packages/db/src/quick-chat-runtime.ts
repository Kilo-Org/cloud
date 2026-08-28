import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import type * as schema from './schema';
import {
  agent_harness_conversation_registry,
  agent_harness_retirements,
  kilocode_users,
  organizations,
  quick_chat_messages,
  quick_chat_threads,
} from './schema';

const UUID = z.uuid().transform(value => value.toLowerCase());
export const QuickChatAuthoritySchema = z.object({
  threadId: UUID,
  userId: z.string(),
  organizationId: UUID.nullable(),
  generation: z.int().nonnegative(),
});
export type QuickChatAuthority = z.infer<typeof QuickChatAuthoritySchema>;
const ClaimSchema = QuickChatAuthoritySchema.extend({
  id: UUID,
  role: z.string(),
  content: z.string(),
  clientId: z.string().nullable(),
  createdAt: z.string(),
  leaseToken: UUID,
});
export type QuickChatClaim = z.infer<typeof ClaimSchema>;
const ProjectionSchema = z.strictObject({
  id: UUID,
  key: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  clientId: z.string().nullable().default(null),
  createdAt: z.iso.datetime(),
});
export type QuickChatProjection = z.input<typeof ProjectionSchema>;
type Database = NodePgDatabase<typeof schema>;

export class QuickChatAuthorityError extends Error {
  constructor() {
    super('Quick Chat primary authority is missing, mismatched, or retired');
    this.name = 'QuickChatAuthorityError';
  }
}

function activeThreads(authority?: QuickChatAuthority) {
  return sql`
    SELECT thread.id AS "threadId", thread.user_id AS "userId",
      thread.organization_id AS "organizationId", registry.generation
    FROM ${quick_chat_threads} AS thread
    JOIN ${kilocode_users} AS owner ON owner.id = thread.user_id
    JOIN ${agent_harness_conversation_registry} AS registry
      ON registry.thread_id = thread.id AND registry.user_id = thread.user_id
      AND registry.organization_id IS NOT DISTINCT FROM thread.organization_id
    WHERE owner.blocked_reason IS NULL
      AND (thread.organization_id IS NULL OR EXISTS (
        SELECT 1 FROM ${organizations} AS context
        WHERE context.id = thread.organization_id AND context.deleted_at IS NULL
      ))
      AND NOT EXISTS (
        SELECT 1 FROM ${agent_harness_retirements} AS retirement
        WHERE retirement.thread_id = thread.id
      )
      ${
        authority
          ? sql`AND thread.id = ${authority.threadId}
        AND thread.user_id = ${authority.userId}
        AND thread.organization_id IS NOT DISTINCT FROM ${authority.organizationId}::uuid
        AND registry.generation = ${authority.generation}`
          : sql``
      }
  `;
}

async function lockAuthority(database: Database, authority: QuickChatAuthority) {
  const { rows } = await database.execute<QuickChatAuthority>(sql`
    ${activeThreads(authority)} FOR SHARE OF thread, owner, registry
  `);
  if (!rows.length) throw new QuickChatAuthorityError();
  if (authority.organizationId !== null) {
    // Lock the context too; the authority query only checks its existence.
    const context = await database.execute(sql`
      SELECT id FROM ${organizations}
      WHERE id = ${authority.organizationId} AND deleted_at IS NULL FOR SHARE
    `);
    if (!context.rows.length) throw new QuickChatAuthorityError();
  }
}

function leaseFence(claim: QuickChatClaim) {
  return sql`${quick_chat_messages.id} = ${claim.id}
    AND ${quick_chat_messages.thread_id} = ${claim.threadId}
    AND ${quick_chat_messages.provenance} = 'legacy'
    AND ${quick_chat_messages.ingress_acknowledged_at} IS NULL
    AND ${quick_chat_messages.ingress_lease_token} = ${claim.leaseToken}
    AND ${quick_chat_messages.ingress_lease_expires_at} > clock_timestamp()`;
}

/** Supply the primary database, never a replica. This adapter never creates threads or registry rows. */
export function createQuickChatRuntime(primary: Database) {
  async function lookupThread(input: QuickChatAuthority) {
    const authority = QuickChatAuthoritySchema.parse(input);
    const { rows } = await primary.execute<QuickChatAuthority>(activeThreads(authority));
    return rows[0] ?? null;
  }

  async function claimPending(options: { authority?: QuickChatAuthority; limit?: number } = {}) {
    const limit = z
      .int()
      .min(1)
      .max(50)
      .parse(options.limit ?? 50);
    const authority = options.authority && QuickChatAuthoritySchema.parse(options.authority);
    if (authority && !(await lookupThread(authority))) throw new QuickChatAuthorityError();
    // Old appends omit ingress fields. Keep scanning pending rows until old writers and records are gone.
    // A lease is not delivery, and created_at orders a batch, never an ingestion watermark.
    const { rows } = await primary.execute<QuickChatClaim>(sql`
      WITH candidates AS (
        SELECT message.id, authority.*
        FROM ${quick_chat_messages} AS message
        JOIN (${activeThreads(authority)}) AS authority ON authority."threadId" = message.thread_id
        WHERE message.provenance = 'legacy' AND message.ingress_acknowledged_at IS NULL
          AND (message.ingress_lease_expires_at IS NULL
            OR message.ingress_lease_expires_at <= clock_timestamp())
        ORDER BY message.created_at, message.id LIMIT ${limit}
        FOR UPDATE OF message SKIP LOCKED
      ), claimed AS (
        UPDATE ${quick_chat_messages} AS message
        SET ingress_lease_token = gen_random_uuid(),
          ingress_lease_expires_at = clock_timestamp() + interval '60 seconds'
        FROM candidates
        WHERE message.id = candidates.id
        RETURNING message.id, message.thread_id AS "threadId", candidates."userId",
          candidates."organizationId", candidates.generation, message.role, message.content,
          message.client_id AS "clientId", message.created_at,
          message.ingress_lease_token AS "leaseToken"
      )
      SELECT id, "threadId", "userId", "organizationId", generation, role, content, "clientId",
        created_at::text AS "createdAt", "leaseToken"
      FROM claimed ORDER BY created_at, id
    `);
    return rows.map(row => ClaimSchema.parse(row));
  }

  async function withClaim(
    input: QuickChatClaim,
    importAndAcknowledge: (acknowledge: () => Promise<boolean>) => Promise<boolean>
  ) {
    const claim = ClaimSchema.parse(input);
    return primary.transaction(async tx => {
      // Keep account, context, registry, and thread deletion behind this import transaction.
      await lockAuthority(tx, claim);
      const leased = await tx
        .select({ id: quick_chat_messages.id })
        .from(quick_chat_messages)
        .where(leaseFence(claim));
      if (!leased.length) return false;
      return importAndAcknowledge(async () => {
        // Recheck permanent fences after the importer commits, even if retirement delivery finished.
        await lockAuthority(tx, claim);
        const acknowledged = await tx
          .update(quick_chat_messages)
          .set({
            ingress_acknowledged_at: sql`clock_timestamp()`,
            ingress_lease_token: null,
            ingress_lease_expires_at: null,
          })
          .where(sql`${leaseFence(claim)} AND EXISTS (${activeThreads(claim)})`)
          .returning({ id: quick_chat_messages.id });
        return acknowledged.length === 1;
      });
    });
  }

  async function projectText(input: QuickChatAuthority, text: QuickChatProjection) {
    const authority = QuickChatAuthoritySchema.parse(input);
    const projection = ProjectionSchema.parse(text);
    return primary.transaction(async tx => {
      await lockAuthority(tx, authority);
      const [inserted] = await tx
        .insert(quick_chat_messages)
        .values({
          id: projection.id,
          thread_id: authority.threadId,
          role: projection.role,
          content: projection.content,
          client_id: projection.clientId,
          created_at: projection.createdAt,
          provenance: 'harness',
          server_projection_key: projection.key,
          ingress_acknowledged_at: sql`clock_timestamp()`,
        })
        // Both the UUID and projection key can conflict before either delivery commits.
        .onConflictDoNothing()
        .returning();
      const row =
        inserted ??
        (
          await tx
            .select()
            .from(quick_chat_messages)
            .where(eq(quick_chat_messages.server_projection_key, projection.key))
        )[0];
      await lockAuthority(tx, authority);
      if (
        !row ||
        row.thread_id !== authority.threadId ||
        row.id !== projection.id ||
        row.role !== projection.role ||
        row.content !== projection.content ||
        row.client_id !== projection.clientId ||
        row.provenance !== 'harness' ||
        row.ingress_acknowledged_at === null ||
        new Date(row.created_at).toISOString() !== new Date(projection.createdAt).toISOString()
      ) {
        throw new Error('Conflicting Quick Chat projection');
      }
      return row.id;
    });
  }

  return { lookupThread, claimPending, withClaim, projectText };
}
