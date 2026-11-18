import 'server-only';

import archiver from 'archiver';
import { Readable } from 'node:stream';
import { eq, or } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { findUserByEmailCaseInsensitive } from '@/lib/user';
import { organizationActionTarget, userActionTarget } from '@/lib/admin/admin-action-audit';

export const INCOMPLETE_NOTICE_NAME = 'INCOMPLETE_EXPORT_README.txt';

export function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function tryFormatJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  if (value !== null && value !== undefined) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return '';
}

export function isJson(value: unknown): boolean {
  if (typeof value === 'object' && value !== null) return true;
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function formatTimestamp(isoString: string): string {
  return isoString.replaceAll(':', '-').replaceAll(' ', '_');
}

function sanitizeFilenamePart(value: string) {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '-');
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

type ParsedBoundary = { ok: true; value: Date | null } | { ok: false };

// Dates and times are UTC. The end boundary is inclusive through the last
// millisecond of the chosen minute (or day, when no time is given).
function parseBoundary(
  date: string | null,
  time: string | null,
  edge: 'start' | 'end'
): ParsedBoundary {
  if (!date) {
    return time ? { ok: false } : { ok: true, value: null };
  }
  if (!DATE_PATTERN.test(date) || (time && !TIME_PATTERN.test(time))) {
    return { ok: false };
  }
  const suffix = edge === 'start' ? `${time || '00:00'}:00.000Z` : `${time || '23:59'}:59.999Z`;
  const value = new Date(`${date}T${suffix}`);
  // Date rolls calendar-invalid days over (2026-02-30 becomes 2026-03-02).
  if (isNaN(value.getTime()) || value.toISOString().slice(0, 10) !== date) {
    return { ok: false };
  }
  return { ok: true, value };
}

function formatBoundaryForFilename(date: string | null, time: string | null, fallback: string) {
  if (!date) return fallback;
  return time ? `${date}T${time.replace(':', '-')}` : date;
}

type ResolvedUser = { ok: true; userId: string } | { ok: false; error: string; status: number };

async function resolveUserId(userIdOrEmail: string): Promise<ResolvedUser> {
  const users = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(
      or(eq(kilocode_users.id, userIdOrEmail), eq(kilocode_users.google_user_email, userIdOrEmail))
    )
    .limit(2);
  const user = users.find(({ id }) => id === userIdOrEmail) ?? users[0];
  if (user) return { ok: true, userId: user.id };
  // Logs can outlive their user row, so an unknown non-email value is still a valid user ID filter.
  if (!userIdOrEmail.includes('@')) return { ok: true, userId: userIdOrEmail };

  const caseInsensitiveMatches = await findUserByEmailCaseInsensitive(userIdOrEmail);
  if (caseInsensitiveMatches.length === 1) {
    return { ok: true, userId: caseInsensitiveMatches[0].id };
  }
  if (caseInsensitiveMatches.length > 1) {
    return {
      ok: false,
      error: `Multiple users match email ${userIdOrEmail} case-insensitively. Use the exact email or user ID.`,
      status: 400,
    };
  }
  return { ok: false, error: `No user found with email ${userIdOrEmail}`, status: 404 };
}

function auditIdentifier(value: string | null): string | null {
  return value && value.length <= 255 && /^[a-zA-Z0-9_.:|-]+(?:\/[a-zA-Z0-9_.:|-]+)*$/.test(value)
    ? value
    : null;
}

/** The filters shared by the admin log exports, with the user resolved to an ID. */
export type LogExportFilters = {
  userIdOrEmail: string | null;
  userId: string | null;
  organizationId: string | null;
  startDate: string | null;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
  start: Date | null;
  end: Date | null;
  modelPrefix: string | null;
  sessionId: string | null;
};

export async function parseLogExportFilters(
  searchParams: URLSearchParams
): Promise<{ ok: true; filters: LogExportFilters } | { ok: false; response: Response }> {
  const userIdOrEmail = searchParams.get('userId') || null;
  const startDate = searchParams.get('startDate') || null;
  const startTime = searchParams.get('startTime') || null;
  const endDate = searchParams.get('endDate') || null;
  const endTime = searchParams.get('endTime') || null;

  const start = parseBoundary(startDate, startTime, 'start');
  const end = parseBoundary(endDate, endTime, 'end');
  if (!start.ok || !end.ok) {
    return {
      ok: false,
      response: jsonError(
        'Invalid date or time. Use YYYY-MM-DD for dates and HH:MM (UTC) for times; a time requires a date.',
        400
      ),
    };
  }
  if (start.value && end.value && start.value > end.value) {
    return { ok: false, response: jsonError('Start must be before end.', 400) };
  }

  const resolvedUser = userIdOrEmail ? await resolveUserId(userIdOrEmail) : null;
  if (resolvedUser && !resolvedUser.ok) {
    return { ok: false, response: jsonError(resolvedUser.error, resolvedUser.status) };
  }

  return {
    ok: true,
    filters: {
      userIdOrEmail,
      userId: resolvedUser?.userId ?? null,
      organizationId: searchParams.get('organizationId') || null,
      startDate,
      startTime,
      endDate,
      endTime,
      start: start.value,
      end: end.value,
      modelPrefix: searchParams.get('model') || null,
      sessionId: searchParams.get('sessionId') || searchParams.get('session_id') || null,
    },
  };
}

/** Audit target and metadata for the filters, omitting free-form values that could hold PII. */
export function logExportAuditDetails(filters: LogExportFilters) {
  const userId = auditIdentifier(filters.userId);
  const organizationId = auditIdentifier(filters.organizationId);
  return {
    target: userId
      ? userActionTarget(userId)
      : organizationId
        ? organizationActionTarget(organizationId)
        : null,
    metadata: {
      userId,
      organizationId,
      startAt: filters.start?.toISOString() ?? null,
      endAt: filters.end?.toISOString() ?? null,
      hasUserFilter: Boolean(filters.userId),
      hasOrganizationFilter: Boolean(filters.organizationId),
      hasModelPrefixFilter: Boolean(filters.modelPrefix),
      hasSessionFilter: Boolean(filters.sessionId),
    },
  };
}

export function logExportFilename(prefix: string, filters: LogExportFilters, suffix: string) {
  const user = filters.userIdOrEmail ? sanitizeFilenamePart(filters.userIdOrEmail) : 'all-users';
  const organization = filters.organizationId
    ? `_org-${sanitizeFilenamePart(filters.organizationId)}`
    : '';
  const start = formatBoundaryForFilename(filters.startDate, filters.startTime, 'any-start');
  const end = formatBoundaryForFilename(filters.endDate, filters.endTime, 'any-end');
  const model = filters.modelPrefix ? `_${sanitizeFilenamePart(filters.modelPrefix)}` : '';
  const session = filters.sessionId ? `_${sanitizeFilenamePart(filters.sessionId)}` : '';
  return `${prefix}_${user}${organization}_${start}_${end}${model}${session}${suffix}.zip`;
}

export function zipDownloadResponse(stream: ReadableStream<Uint8Array>, filename: string) {
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

type ExportRow = { id: bigint | string; created_at: string };

export type ZipEntryWriter = (content: string, name: string) => void;

function formatIncompleteNotice({
  elapsedMs,
  maxDurationSeconds,
  exportedRows,
  remainingRows,
  order,
  lastRow,
}: {
  elapsedMs: number;
  maxDurationSeconds: number;
  exportedRows: number;
  remainingRows: number | 'some';
  order: string;
  lastRow: ExportRow;
}): string {
  const remaining =
    remainingRows === 'some'
      ? 'More matching records were not exported.'
      : `${remainingRows} more matching records were not exported.`;
  return [
    'This export is incomplete.',
    '',
    `The download stopped after ${Math.round(elapsedMs / 1000)} seconds so the ZIP could be finished before the ${maxDurationSeconds}-second server time limit.`,
    `It contains ${exportedRows} matching records. ${remaining}`,
    `Records are exported in ${order} order. The last exported record has id ${lastRow.id} and was created at ${lastRow.created_at} (UTC).`,
    '',
    'To download the remaining records, start a new download with a later start date and time, or narrow the filters.',
    '',
  ].join('\n');
}

/**
 * Streams a ZIP that is filled batch by batch with keyset pagination. The export stops early
 * enough to write an incomplete-export notice and the ZIP central directory before Vercel kills
 * the function at `maxDurationSeconds`; a ZIP without a central directory cannot be extracted.
 */
export function streamBatchedZipExport<Row extends ExportRow>({
  startedAt,
  maxDurationSeconds,
  order,
  firstBatch,
  fetchBatch,
  remainingRows,
  writeRows,
  writeSummary,
}: {
  startedAt: number;
  maxDurationSeconds: number;
  /** How rows are ordered, as in "exported in <order> order". */
  order: string;
  firstBatch?: Row[];
  fetchBatch: (after: Row | null) => Promise<Row[]>;
  /** Number of matching rows after `after`, or 'some' when only their existence is known. */
  remainingRows: (after: Row) => Promise<number | 'some'>;
  writeRows: (rows: Row[], append: ZipEntryWriter) => Promise<void>;
  writeSummary?: (append: ZipEntryWriter) => void;
}): ReadableStream<Uint8Array> {
  const timeBudgetMs = (maxDurationSeconds - 60) * 1000;
  const archive = archiver('zip', { zlib: { level: 6 } });
  let appendedEntries = 0;
  let processedEntries = 0;

  archive.on('entry', () => {
    processedEntries += 1;
  });

  const append: ZipEntryWriter = (content, name) => {
    appendedEntries += 1;
    archive.append(content, { name });
  };

  const waitForEntries = (target: number) => {
    if (processedEntries >= target) return Promise.resolve();
    if (archive.destroyed) {
      return Promise.reject(new Error('Archive closed before all entries were processed'));
    }

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        archive.off('entry', onEntry);
        archive.off('error', onError);
        archive.off('close', onClose);
      };
      const onEntry = () => {
        if (processedEntries >= target) {
          cleanup();
          resolve();
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Archive closed before all entries were processed'));
      };

      archive.on('entry', onEntry);
      archive.once('error', onError);
      archive.once('close', onClose);
    });
  };

  const appendRows = async () => {
    let exportedRows = 0;
    let rows = firstBatch ?? (await fetchBatch(null));
    while (rows.length > 0) {
      await writeRows(rows, append);
      const lastRow = rows[rows.length - 1];
      exportedRows += rows.length;

      // Archiver maintains its own input queue, which is not reflected by the
      // readable stream's high-water mark. Wait until this batch is emitted so
      // large exports remain bounded even when compression is slower than DB reads.
      await waitForEntries(appendedEntries);

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= timeBudgetMs) {
        const remaining = await remainingRows(lastRow);
        if (remaining !== 0) {
          append(
            formatIncompleteNotice({
              elapsedMs,
              maxDurationSeconds,
              exportedRows,
              remainingRows: remaining,
              order,
              lastRow,
            }),
            INCOMPLETE_NOTICE_NAME
          );
        }
        break;
      }
      rows = await fetchBatch(lastRow);
    }

    writeSummary?.(append);
    await archive.finalize();
  };

  void appendRows().catch(error => archive.destroy(error));

  // Readable.toWeb propagates end, errors and backpressure correctly, unlike
  // a hand-rolled PassThrough -> ReadableStream bridge which eagerly pushed
  // chunks into the controller with no pull() and could drop bytes on a slow
  // or cancelled consumer - causing truncated ZIPs that macOS Archive Utility
  // refuses to extract.
  // Readable.toWeb returns the node-types flavoured ReadableStream, which is
  // structurally identical to the DOM lib ReadableStream accepted by Response
  // but TypeScript treats them as distinct - hence the cast.
  return Readable.toWeb(archive) as unknown as ReadableStream<Uint8Array>;
}
