import { connection, type NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { api_request_log } from '@kilocode/db/schema';
import { and, gte, lte, eq, asc, gt, count, or, isNotNull, type SQL } from 'drizzle-orm';
import archiver from 'archiver';
import { Readable } from 'node:stream';
import { getApiRequestLogBlob } from '@kilocode/web-shared/lib/r2/api-request-log';

// Downloading all logs for a heavy user can take a while. Without a raised
// maxDuration the Vercel function was killed mid-stream, producing a ZIP
// without a central directory record. macOS Archive Utility then refused to
// extract it ("Error 79 - Inappropriate file type or format").
export const maxDuration = 800;

// Stop early enough to write the incomplete-export notice and the ZIP central
// directory before Vercel kills the function at maxDuration.
const EXPORT_TIME_BUDGET_MS = (maxDuration - 60) * 1000;
const INCOMPLETE_NOTICE_NAME = 'INCOMPLETE_EXPORT_README.txt';

const BATCH_SIZE = 10;

type IncompleteExport = {
  elapsedMs: number;
  exportedRows: number;
  remainingRows: number;
  lastRow: { id: bigint; created_at: string };
};

function formatIncompleteNotice({
  elapsedMs,
  exportedRows,
  remainingRows,
  lastRow,
}: IncompleteExport): string {
  return [
    'This export is incomplete.',
    '',
    `The download stopped after ${Math.round(elapsedMs / 1000)} seconds so the ZIP could be finished before the ${maxDuration}-second server time limit.`,
    `It contains ${exportedRows} matching records. ${remainingRows} more matching records were not exported.`,
    `Records are exported in id order. The last exported record has id ${lastRow.id} and was created at ${lastRow.created_at} (UTC).`,
    '',
    'To download the remaining records, start a new download with a later start date and time, or narrow the filters.',
    '',
  ].join('\n');
}

function formatTimestamp(isoString: string): string {
  return isoString.replaceAll(':', '-').replaceAll(' ', '_');
}

function tryFormatJson(value: unknown): string {
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

function isJson(value: unknown): boolean {
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

type LoadedBody = { value: string | null } | { loadError: string };

async function loadBody(key: string | null): Promise<LoadedBody> {
  if (key === null) {
    return { value: null };
  }
  try {
    return { value: await getApiRequestLogBlob(key) };
  } catch (error) {
    return { loadError: `Failed to load ${key} from R2: ${String(error)}` };
  }
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

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function buildFilter(
  userId: string | null,
  parsedStart: Date | null,
  parsedEnd: Date | null,
  model: string | null,
  sessionId: string | null,
  errorsOnly: boolean
) {
  const conditions: SQL[] = [];
  if (userId) {
    conditions.push(eq(api_request_log.kilo_user_id, userId));
  }
  if (parsedStart) {
    conditions.push(gte(api_request_log.created_at, parsedStart.toISOString()));
  }
  if (parsedEnd) {
    conditions.push(lte(api_request_log.created_at, parsedEnd.toISOString()));
  }
  if (model) {
    conditions.push(eq(api_request_log.model, model));
  }
  if (sessionId) {
    conditions.push(eq(api_request_log.session_id, sessionId));
  }
  if (errorsOnly) {
    const errorsCondition = or(
      gte(api_request_log.status_code, 400),
      isNotNull(api_request_log.error)
    );
    if (errorsCondition) {
      conditions.push(errorsCondition);
    }
  }
  return and(...conditions);
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  await connection();

  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  const searchParams = request.nextUrl.searchParams;
  const userId = searchParams.get('userId');
  const startDate = searchParams.get('startDate');
  const startTime = searchParams.get('startTime');
  const endDate = searchParams.get('endDate');
  const endTime = searchParams.get('endTime');
  const model = searchParams.get('model');
  const sessionId = searchParams.get('sessionId') || searchParams.get('session_id');
  const errorsOnly = searchParams.get('errorsOnly') === 'true';

  const parsedStart = parseBoundary(startDate, startTime, 'start');
  const parsedEnd = parseBoundary(endDate, endTime, 'end');
  if (!parsedStart.ok || !parsedEnd.ok) {
    return jsonError(
      'Invalid date or time. Use YYYY-MM-DD for dates and HH:MM (UTC) for times; a time requires a date.',
      400
    );
  }
  if (parsedStart.value && parsedEnd.value && parsedStart.value > parsedEnd.value) {
    return jsonError('Start must be before end.', 400);
  }

  const filter = buildFilter(
    userId,
    parsedStart.value,
    parsedEnd.value,
    model,
    sessionId,
    errorsOnly
  );

  const [result] = await db.select({ total: count() }).from(api_request_log).where(filter);
  if (result.total === 0) {
    return jsonError('No records found for the given criteria', 404);
  }

  const archive = archiver('zip', { zlib: { level: 6 } });
  let totalAppendedEntries = 0;
  let totalProcessedEntries = 0;

  archive.on('entry', () => {
    totalProcessedEntries += 1;
  });

  const waitForEntries = (target: number) => {
    if (totalProcessedEntries >= target) return Promise.resolve();
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
        if (totalProcessedEntries >= target) {
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

  // Fetch and archive rows in batches using cursor-based pagination to
  // avoid loading the entire result set into memory at once.
  const appendRows = async () => {
    let exportedRows = 0;
    let lastRow: IncompleteExport['lastRow'] | null = null;
    for (;;) {
      const afterCursor: SQL | undefined = lastRow
        ? and(filter, gt(api_request_log.id, lastRow.id))
        : filter;
      const elapsedMs = Date.now() - startedAt;
      if (lastRow && elapsedMs >= EXPORT_TIME_BUDGET_MS) {
        const [remaining] = await db
          .select({ total: count() })
          .from(api_request_log)
          .where(afterCursor);
        if (remaining.total > 0) {
          archive.append(
            formatIncompleteNotice({
              elapsedMs,
              exportedRows,
              remainingRows: remaining.total,
              lastRow,
            }),
            { name: INCOMPLETE_NOTICE_NAME }
          );
        }
        break;
      }

      const rows = await db
        .select({
          id: api_request_log.id,
          created_at: api_request_log.created_at,
          error: api_request_log.error,
          request_r2_key: api_request_log.request_r2_key,
          response_r2_key: api_request_log.response_r2_key,
        })
        .from(api_request_log)
        .where(afterCursor)
        .orderBy(asc(api_request_log.id))
        .limit(BATCH_SIZE);

      if (rows.length === 0) break;

      const bodies = await Promise.all(
        rows.map(async row => {
          const [request, response] = await Promise.all([
            loadBody(row.request_r2_key),
            loadBody(row.response_r2_key),
          ]);
          return { request, response };
        })
      );

      for (const [index, row] of rows.entries()) {
        const ts = formatTimestamp(row.created_at);
        const id = String(row.id);

        for (const [kind, body] of Object.entries(bodies[index])) {
          if ('loadError' in body) {
            totalAppendedEntries += 1;
            archive.append(body.loadError, { name: `${ts}_${id}_${kind}_load-error.txt` });
            continue;
          }
          const ext = isJson(body.value) ? 'json' : 'txt';
          const content = tryFormatJson(body.value);
          if (content) {
            totalAppendedEntries += 1;
            archive.append(content, { name: `${ts}_${id}_${kind}.${ext}` });
          }
        }

        if (row.error !== null && row.error !== undefined) {
          const errorContent = tryFormatJson(row.error);
          if (errorContent) {
            totalAppendedEntries += 1;
            archive.append(errorContent, { name: `${ts}_${id}_error.json` });
          }
        }
      }

      lastRow = rows[rows.length - 1];
      exportedRows += rows.length;

      // Archiver maintains its own input queue, which is not reflected by the
      // readable stream's high-water mark. Wait until this batch is emitted so
      // large exports remain bounded even when compression is slower than DB reads.
      await waitForEntries(totalAppendedEntries);
    }

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
  const webStream = Readable.toWeb(archive) as unknown as ReadableStream<Uint8Array>;

  const sanitize = (value: string) => value.replaceAll(/[^a-zA-Z0-9._-]/g, '-');
  const safeUserId = userId ? sanitize(userId) : 'all-users';
  const safeModel = model ? `_${sanitize(model)}` : '';
  const safeSessionId = sessionId ? `_${sanitize(sessionId)}` : '';
  const safeErrorsOnly = errorsOnly ? '_errors-only' : '';
  const safeStart = formatBoundaryForFilename(startDate, startTime, 'any-start');
  const safeEnd = formatBoundaryForFilename(endDate, endTime, 'any-end');
  const filename = `api-request-log_${safeUserId}_${safeStart}_${safeEnd}${safeModel}${safeSessionId}${safeErrorsOnly}.zip`;

  return new Response(webStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
