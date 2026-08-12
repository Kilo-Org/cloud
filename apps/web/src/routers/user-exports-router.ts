import 'server-only';

import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import * as z from 'zod';
import { DOWNLOAD_CODE_LENGTH } from '@/app/(app)/data-exports/data-export-contract';
import { isDataExportDownloadCodeRateLimited } from '@/lib/auth/data-export-download-code-rate-limit';
import {
  consumeDataExportDownloadCode,
  createDataExportDownloadCode,
  deleteDataExportDownloadCode,
  DOWNLOAD_CODE_EXPIRY_MINUTES,
  releaseDataExportDownloadCode,
  reserveDataExportDownloadCode,
  type ReserveDownloadCodeResult,
} from '@/lib/auth/data-export-download-codes';
import { db } from '@/lib/drizzle';
import { sendDataExportDownloadCodeEmail } from '@/lib/email';
import { adminProcedure, createTRPCRouter, type TRPCContext } from '@/lib/trpc/init';
import {
  ORGANIZATION_EXPORT_ROLES,
  organizationExportAccess,
} from '@kilocode/db/organization-export-access';
import {
  dispatchUserDataExport,
  requestUserDataExportDownload,
} from '@/lib/user-data-export-worker-client';

const ExportIdSchema = z.object({ exportId: z.string().uuid() });
const OrganizationExportSchema = z.object({ organizationId: z.string().uuid() });
const DownloadInputSchema = z.object({
  exportId: z.string().uuid(),
  code: z.string().regex(new RegExp(`^\\d{${DOWNLOAD_CODE_LENGTH}}$`)),
  challengeId: z.string().uuid(),
});
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
const EXPORT_ROLES = ORGANIZATION_EXPORT_ROLES;

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
 * Membership is not only direct: an owner or admin of a parent organization inherits
 * access to its children. Listing only direct memberships would let someone request a
 * child organization's export successfully and then never see it, because the request
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
  // Driven from the caller's own memberships, which are indexed on kilo_user_id, rather
  // than from `organizations` with correlated subqueries per row. This runs on every
  // list() call including each pagination page, so its cost has to scale with how many
  // organizations the caller belongs to, not with how many exist.
  //
  // UNION rather than a single join with an OR: an OR across two different join columns
  // cannot use an index for both sides, so the planner falls back to scanning. Split,
  // each branch is a plain indexed lookup, and UNION already removes the duplicates a
  // DISTINCT would have had to sort for.
  const { rows } = await db.execute<{ id: string; name: string }>(sql`
    WITH exportable AS (
      SELECT orgs.id, orgs.name
      FROM organization_memberships memberships
      JOIN organizations orgs ON orgs.id = memberships.organization_id
      WHERE memberships.kilo_user_id = ${userId}
        AND memberships.role IN (${EXPORT_ROLES_SQL})
        AND orgs.deleted_at IS NULL
      UNION
      -- The inherited route: a role held in a parent organization reaches its children.
      SELECT orgs.id, orgs.name
      FROM organization_memberships memberships
      JOIN organizations orgs ON orgs.parent_organization_id = memberships.organization_id
      WHERE memberships.kilo_user_id = ${userId}
        AND memberships.role IN (${EXPORT_ROLES_SQL})
        AND orgs.deleted_at IS NULL
    )
    SELECT id, name FROM exportable ORDER BY name, id
  `);
  return rows;
}

/**
 * The organization is real, not soft-deleted, and the caller genuinely holds an export
 * role on it.
 *
 * The shared predicate, not `ensureOrganizationAccess`, which every other organization
 * router uses. That helper grants `owner` to any `is_admin` caller, so on this router —
 * where every procedure is `adminProcedure` — it would authorise on staff status rather
 * than on membership, and nobody may export another person's or another organization's
 * data.
 *
 * Shared with the Worker, which re-checks independently, because the two must reach the
 * same verdict. They once did not, and an export generated, showed as ready, and then
 * failed its download every time.
 */
async function requireExportableOrganization(
  ctx: TRPCContext,
  organizationId: string
): Promise<void> {
  const { rows } = await db.execute<{ allowed: number }>(sql`
    SELECT 1 AS allowed
    WHERE ${organizationExportAccess({
      kiloUserId: ctx.user.id,
      organizationId: sql`${organizationId}::uuid`,
    })}
  `);
  if (!rows[0]) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You do not have permission to export this organization',
    });
  }
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

/**
 * Ownership and freshness gate shared by both download steps. A miss is reported
 * as NOT_FOUND so another user's export is indistinguishable from a missing one.
 *
 * Ownership of a personal export is part of the lookup rather than a follow-up check,
 * so there is no window between deciding the row is the caller's and acting on it.
 *
 * An organization's export is admitted by that lookup and authorised on live role
 * below. It belongs to the organization rather than to whoever pressed the button, so
 * any current owner or admin may download it — and an admin whose role was revoked
 * while it generated may not. Placing this on the shared gate covers both the code
 * request and the redemption, so neither step can be reached on stale authority.
 */
async function requireDownloadableExport(ctx: TRPCContext, exportId: string): Promise<void> {
  const notFound = new TRPCError({ code: 'NOT_FOUND', message: 'Export not found' });
  const { rows } = await db.execute<{
    subject_type: 'user' | 'organization';
    organization_id: string | null;
  }>(sql`
    SELECT subject_type, organization_id FROM user_data_exports
    WHERE id = ${exportId}
      AND status = 'ready' AND expires_at > now()
      AND (subject_type = 'organization' OR kilo_user_id = ${ctx.user.id})
    LIMIT 1
  `);
  const record = rows[0];
  if (!record) throw notFound;
  if (record.subject_type !== 'organization') return;
  if (!record.organization_id) throw notFound;

  // Collapsed to the same NOT_FOUND as a miss, deliberately. `requireExportableOrganization`
  // distinguishes "no such organization" from "you lack the role", which is right where the
  // caller named the organization themselves — but here they named an export id, and letting
  // UNAUTHORIZED through would confirm that id exists. That is the enumeration this
  // function's uniform NOT_FOUND exists to prevent.
  try {
    await requireExportableOrganization(ctx, record.organization_id);
  } catch {
    throw notFound;
  }
}

/**
 * The download code is emailed to the account address, so an account without one
 * cannot complete the step-up.
 */
function requireDownloadCodeRecipient(email: string | null): string {
  if (!email) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Your account has no email address to send a download code to',
    });
  }
  return email;
}

/**
 * Email a freshly minted code, dropping the code row unless it was delivered.
 *
 * The mail path reports a refused address as `{ sent: false }` but throws on an
 * API or network failure, and both mean the same thing here: nothing reached the
 * inbox. A code left behind can only ever fail verification, and its `created_at`
 * still trips the resend cooldown, so the immediate retry would claim a code was
 * just sent when none was.
 */
async function emailDownloadCodeOrDrop(
  email: string,
  created: { code: string; challengeId: string }
): Promise<void> {
  let delivered = false;
  try {
    const sent = await sendDataExportDownloadCodeEmail(email, {
      code: created.code,
      expiresInMinutes: DOWNLOAD_CODE_EXPIRY_MINUTES,
    });
    delivered = sent.sent;
  } catch (error) {
    captureException(error);
  }
  if (delivered) return;

  try {
    await deleteDataExportDownloadCode(created.challengeId);
  } catch (error) {
    // Losing the cleanup only costs the user the cooldown, so report it and
    // still tell the caller the truth about the email.
    captureException(error);
  }
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'The download code could not be emailed. Try again shortly.',
  });
}

function downloadCodeError(result: Exclude<ReserveDownloadCodeResult, 'ok'>): TRPCError {
  switch (result) {
    case 'too_many_attempts':
      return new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many incorrect codes. Request a new code to try again.',
      });
    case 'in_progress':
      return new TRPCError({
        code: 'CONFLICT',
        message: 'This code is already being used. Try again in a moment.',
      });
    case 'invalid':
      return new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'That code is incorrect or has expired.',
      });
  }
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
      // Throws UNAUTHORIZED for members and billing managers, NOT_FOUND for an
      // organization that has been soft-deleted. Re-checked at download, because a role
      // can be revoked, or the organization deleted, while an export is generating.
      await requireExportableOrganization(ctx, input.organizationId);
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

  /**
   * Step 1 of the download: email a single-use code to the account address. A
   * held web session alone cannot reach the artifact without also reaching the
   * inbox.
   */
  requestDownloadCode: adminProcedure.input(ExportIdSchema).mutation(async ({ ctx, input }) => {
    requireWebSession(ctx.authViaToken);
    await requireDownloadableExport(ctx, input.exportId);
    const email = requireDownloadCodeRecipient(ctx.user.google_user_email);

    // Bounds total issuance for the account: the cooldown below only spaces
    // consecutive codes, and each new code carries a fresh attempt budget.
    if (await isDataExportDownloadCodeRateLimited(ctx.user.id)) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many download codes requested. Try again later.',
      });
    }

    const created = await createDataExportDownloadCode(email, input.exportId);
    if (created.status === 'cooldown') {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'A code was just sent. Check your email, or wait a minute to request another.',
      });
    }

    await emailDownloadCodeOrDrop(email, created);

    return {
      challengeId: created.challengeId,
      expiresInMinutes: DOWNLOAD_CODE_EXPIRY_MINUTES,
    };
  }),

  /** Step 2 of the download: redeem the emailed code for one signed URL. */
  createDownload: adminProcedure.input(DownloadInputSchema).mutation(async ({ ctx, input }) => {
    requireWebSession(ctx.authViaToken);
    await requireDownloadableExport(ctx, input.exportId);
    const email = requireDownloadCodeRecipient(ctx.user.google_user_email);

    const reservation = await reserveDataExportDownloadCode(
      email,
      input.exportId,
      input.code,
      input.challengeId
    );
    if (reservation !== 'ok') throw downloadCodeError(reservation);

    const result = await requestUserDataExportDownload({
      exportId: input.exportId,
      kiloUserId: ctx.user.id,
    });
    if (result.kind === 'unavailable') {
      // Signing failed, so no capability was handed out and the code stays usable.
      await releaseDataExportDownloadCode(input.challengeId);
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Downloads are not available yet',
      });
    }

    // The signed URL is a bearer capability from here on, so the code must not
    // survive to mint a second one.
    await consumeDataExportDownloadCode(input.challengeId);
    return { downloadUrl: result.downloadUrl, expiresAt: result.expiresAt };
  }),
});

export const __test__ = { requireWebSession, serialize, downloadCodeError };
