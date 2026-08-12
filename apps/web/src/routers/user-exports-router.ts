import 'server-only';

import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import * as z from 'zod';
import { db } from '@/lib/drizzle';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { ORGANIZATION_MANAGE_ROLES } from '@kilocode/app-shared/organizations';
import {
  dispatchUserDataExport,
  requestUserDataExportDownload,
} from '@/lib/user-data-export-worker-client';

const ExportIdSchema = z.object({ exportId: z.string().uuid() });
const OrganizationExportSchema = z.object({ organizationId: z.string().uuid() });
const ListInputSchema = z.object({ cursor: z.string().uuid().optional() }).optional();
const PAGE_SIZE = 20;
const EXPORT_DATA_CUTOFF = '2026-08-02T08:40:00.000Z';

/**
 * Roles that may request an organization's export. Owners and admins only —
 * `member` and `billing_manager` are deliberately excluded, matching the routing
 * rule settled for the warehouse.
 *
 * The shared constant rather than a local copy, because the export Worker authorises
 * the same request again on its own and the two verdicts have to agree. Export
 * authority is defined as organization-management authority; if it ever needs to
 * diverge, that is a new constant here, not an edit to the shared one.
 */
const EXPORT_ROLES = ORGANIZATION_MANAGE_ROLES;

/**
 * The same role list for the discovery query below, derived rather than repeated: a
 * hardcoded SQL copy would keep admitting a role that had been removed from the
 * constant, or hide an organization the request path would still accept.
 */
const EXPORT_ROLES_SQL = sql.join(
  EXPORT_ROLES.map(role => sql`${role}`),
  sql`, `
);

type UserExportRow = {
  id: string;
  subject_type: 'user' | 'organization';
  organization_id: string | null;
  organization_name: string | null;
  status: 'queued' | 'processing' | 'finalizing' | 'ready' | 'failed' | 'expired';
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  size_bytes: number | string | null;
  row_count: number | string | null;
  failure_message: string | null;
  dispatch_generation: number;
};

function toIso(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function requiredIso(value: string): string {
  return new Date(value).toISOString();
}

function serialize(row: UserExportRow) {
  return {
    id: row.id,
    subjectType: row.subject_type,
    organizationId: row.organization_id,
    // Named so the list can distinguish two organizations' exports without the client
    // resolving ids. Nullable because a personal export has no organization.
    organizationName: row.organization_name,
    status: row.status,
    requestedAt: requiredIso(row.requested_at),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    expiresAt: toIso(row.expires_at),
    sizeBytes: toNumber(row.size_bytes),
    rowCount: toNumber(row.row_count),
    failureMessage: row.failure_message,
  };
}

const EXPORT_COLUMNS = sql`exports.id, exports.subject_type, exports.organization_id, orgs.name AS organization_name,
  exports.status, exports.requested_at, exports.started_at, exports.completed_at, exports.expires_at,
  exports.size_bytes, exports.row_count, exports.last_error_redacted AS failure_message,
  exports.dispatch_generation`;

/**
 * Organizations the caller may export.
 *
 * Mirrors what `ensureOrganizationAccess` will actually admit, which is not the same as
 * direct membership: an owner or admin of a parent organization inherits access to its
 * children. Listing only direct memberships would let someone request a child
 * organization's export successfully and then never see it, because the request
 * succeeded on inherited access that the list did not know about.
 *
 * `billing_manager` inherits access to a child in general but is not an export role, so
 * it is excluded on both branches here, matching the role list passed at the call sites.
 *
 * Resolved from live membership on every call rather than from anything stored on the
 * export row: a person who has lost the role must stop seeing the organization's
 * exports immediately, including ones they requested themselves while they still held it.
 */
async function exportableOrganizations(userId: string): Promise<{ id: string; name: string }[]> {
  const { rows } = await db.execute<{ id: string; name: string }>(sql`
    SELECT orgs.id, orgs.name
    FROM organizations orgs
    WHERE orgs.deleted_at IS NULL
      AND (
        EXISTS (
          SELECT 1 FROM organization_memberships memberships
          WHERE memberships.organization_id = orgs.id
            AND memberships.kilo_user_id = ${userId}
            AND memberships.role IN (${EXPORT_ROLES_SQL})
        )
        OR EXISTS (
          SELECT 1 FROM organization_memberships memberships
          WHERE memberships.organization_id = orgs.parent_organization_id
            AND memberships.kilo_user_id = ${userId}
            AND memberships.role IN (${EXPORT_ROLES_SQL})
        )
      )
    ORDER BY orgs.name, orgs.id
  `);
  return rows;
}

function requireWebSession(authViaToken: boolean | undefined): void {
  if (authViaToken) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'A web session is required for data exports',
    });
  }
}

/**
 * Creates an export for one subject, or returns the in-flight one.
 *
 * Personal and organization requests share this so the deduplication, throttle and
 * outbox dispatch cannot drift apart between them. Only the scope differs: a personal
 * export is unique per requester, an organization's is unique per organization, so two
 * admins pressing the button do not each generate a copy of the same data.
 *
 * `kilo_user_id` is the requester in both cases. For an organization export it records
 * who asked, not whose data it holds.
 */
async function createExportRequest(subject: {
  kiloUserId: string;
  organizationId: string | null;
}): Promise<UserExportRow> {
  const isOrg = subject.organizationId !== null;
  // Serialises concurrent requests for the same subject. Keyed on the organization for
  // an org export so two different admins contend on the same lock.
  const lockKey = subject.organizationId ?? subject.kiloUserId;
  const scopeFilter = isOrg
    ? sql`exports.subject_type = 'organization' AND exports.organization_id = ${subject.organizationId}::uuid`
    : sql`exports.subject_type = 'user' AND exports.kilo_user_id = ${subject.kiloUserId}`;

  const { rows } = await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const existing = await tx.execute<UserExportRow>(sql`
      SELECT ${EXPORT_COLUMNS}
      FROM user_data_exports exports
      LEFT JOIN organizations orgs ON orgs.id = exports.organization_id
      WHERE ${scopeFilter}
        -- Only short-circuit on an in-progress export (return it instead of starting a
        -- duplicate generation). A completed/ready export must not block requesting a
        -- fresh one; that is governed solely by the re-request throttle below.
        AND exports.status IN ('queued', 'processing', 'finalizing')
      ORDER BY exports.created_at DESC, exports.id DESC
      LIMIT 1
    `);
    if (existing.rows[0]) return existing;

    const recent = await tx.execute<{ requested_at: string }>(sql`
      SELECT exports.requested_at
      FROM user_data_exports exports
      WHERE ${scopeFilter}
        AND exports.status <> 'failed'
        -- TEMPORARY: throttle lowered to 5 minutes for pre-launch testing; restore to 24 hours before going live.
        AND exports.requested_at > now() - interval '5 minutes'
      ORDER BY exports.requested_at DESC
      LIMIT 1
    `);
    if (recent.rows[0]) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: isOrg
          ? 'This organization can have one data export every 24 hours'
          : 'You can request one data export every 24 hours',
      });
    }

    return tx.execute<UserExportRow>(sql`
      WITH created AS (
        INSERT INTO user_data_exports (kilo_user_id, subject_type, organization_id, snapshot_at)
        VALUES (
          ${subject.kiloUserId},
          ${isOrg ? 'organization' : 'user'},
          ${subject.organizationId}::uuid,
          ${EXPORT_DATA_CUTOFF}::timestamptz
        )
        RETURNING id, subject_type, organization_id, status, requested_at, started_at, completed_at,
          expires_at, size_bytes, row_count, last_error_redacted AS failure_message, dispatch_generation
      ), outbox AS (
        INSERT INTO user_data_export_outbox (export_id, generation, operation, available_at)
        SELECT id, dispatch_generation, 'generate', now() FROM created
        ON CONFLICT (export_id, generation, operation) DO NOTHING
      )
      SELECT created.*, orgs.name AS organization_name
      FROM created
      LEFT JOIN organizations orgs ON orgs.id = created.organization_id
    `);
  });

  const row = rows[0];
  if (!row)
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Export request failed' });

  // The outbox remains authoritative if the Worker is unavailable after commit.
  if (row.status === 'queued')
    await dispatchUserDataExport({
      exportId: row.id,
      generation: row.dispatch_generation,
      kiloUserId: subject.kiloUserId,
    });
  return row;
}

export const userExportsRouter = createTRPCRouter({
  request: adminProcedure.mutation(async ({ ctx }) => {
    requireWebSession(ctx.authViaToken);
    const row = await createExportRequest({ kiloUserId: ctx.user.id, organizationId: null });
    return serialize(row);
  }),

  requestOrganization: adminProcedure
    .input(OrganizationExportSchema)
    .mutation(async ({ ctx, input }) => {
      requireWebSession(ctx.authViaToken);
      // Throws UNAUTHORIZED for members and billing managers. Re-checked at download,
      // because a role can be revoked while an export is generating.
      await ensureOrganizationAccess(ctx, input.organizationId, [...EXPORT_ROLES]);
      const row = await createExportRequest({
        kiloUserId: ctx.user.id,
        organizationId: input.organizationId,
      });
      return serialize(row);
    }),

  /** Organizations the caller may export, for rendering the organization buttons. */
  exportableOrganizations: adminProcedure.query(async ({ ctx }) => {
    requireWebSession(ctx.authViaToken);
    return { organizations: await exportableOrganizations(ctx.user.id) };
  }),

  list: adminProcedure.input(ListInputSchema).query(async ({ ctx, input }) => {
    requireWebSession(ctx.authViaToken);
    // Two independent reasons an export is visible.
    //
    // Anything the caller requested, whatever its subject. Whoever pressed the button
    // always sees the result, even if the access that admitted the request is not
    // access this query can reproduce — a Kilo staff elevation, for instance.
    //
    // Plus every export belonging to an organization they may export, so a second
    // admin is not refused by the one-active-export-per-org constraint while being
    // shown nothing that explains why.
    const organizationIds = (await exportableOrganizations(ctx.user.id)).map(
      organization => organization.id
    );
    const ownRequests = sql`exports.kilo_user_id = ${ctx.user.id}`;
    const visibleFilter =
      organizationIds.length > 0
        ? sql`(
            ${ownRequests}
            OR (exports.subject_type = 'organization' AND exports.organization_id = ANY(${sql`ARRAY[${sql.join(
              organizationIds.map(id => sql`${id}::uuid`),
              sql`, `
            )}]`}))
          )`
        : sql`(${ownRequests})`;
    // The cursor is resolved under the same visibility predicate as the page itself.
    // Without it, any export id in the table resolves to a position, which pages the
    // caller's own rows relative to a row they cannot see — an ordering and existence
    // oracle over other people's exports. Unresolvable cursors yield NULL and match
    // nothing, so an id outside the caller's visibility returns an empty page rather
    // than the first one. The inner alias shadows the outer query's, so `visibleFilter`
    // applies to the row being resolved.
    const cursorFilter = input?.cursor
      ? sql`AND (exports.created_at, exports.id) < (
          SELECT exports.created_at, exports.id
          FROM user_data_exports exports
          WHERE exports.id = ${input.cursor} AND ${visibleFilter}
        )`
      : sql``;
    const { rows } = await db.execute<UserExportRow>(sql`
      SELECT ${EXPORT_COLUMNS}
      FROM user_data_exports exports
      LEFT JOIN organizations orgs ON orgs.id = exports.organization_id
      WHERE ${visibleFilter}
        ${cursorFilter}
      ORDER BY exports.created_at DESC, exports.id DESC
      LIMIT ${PAGE_SIZE + 1}
    `);
    const page = rows.slice(0, PAGE_SIZE);
    return {
      exports: page.map(serialize),
      nextCursor: rows.length > PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
    };
  }),

  createDownload: adminProcedure.input(ExportIdSchema).mutation(async ({ ctx, input }) => {
    requireWebSession(ctx.authViaToken);
    const { rows } = await db.execute<{
      id: string;
      subject_type: 'user' | 'organization';
      organization_id: string | null;
    }>(sql`
      SELECT id, subject_type, organization_id FROM user_data_exports
      WHERE id = ${input.exportId}
        AND status = 'ready' AND expires_at > now()
        -- Ownership of a personal export is part of the lookup rather than a
        -- follow-up check, so there is no window between deciding the row is the
        -- caller's and acting on it. An organization export is admitted here and
        -- authorised on live role below.
        AND (subject_type = 'organization' OR kilo_user_id = ${ctx.user.id})
      LIMIT 1
    `);
    const record = rows[0];
    if (!record) throw new TRPCError({ code: 'NOT_FOUND', message: 'Export not found' });

    if (record.subject_type === 'organization') {
      if (!record.organization_id) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Export not found' });
      }
      // Authorised again here rather than trusting the check made at request time.
      // Roles change while an export generates, and a revoked admin must not be able
      // to download data they could no longer ask for.
      await ensureOrganizationAccess(ctx, record.organization_id, [...EXPORT_ROLES]);
    }

    const result = await requestUserDataExportDownload({
      exportId: input.exportId,
      kiloUserId: ctx.user.id,
    });
    if (result.kind === 'unavailable') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Downloads are not available yet',
      });
    }
    return { downloadUrl: result.downloadUrl, expiresAt: result.expiresAt };
  }),
});

export const __test__ = { requireWebSession, serialize };
