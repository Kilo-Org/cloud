import { connection, type NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { db } from '@/lib/drizzle';
import { api_request_log } from '@kilocode/db/schema';
import { and, gte, lte, eq, asc, desc, gt, or, isNotNull, type SQL } from 'drizzle-orm';
import archiver from 'archiver';
import { Readable } from 'node:stream';

// Downloading all logs for a heavy user can take a while. Without a raised
// maxDuration the Vercel function was killed mid-stream, producing a ZIP
// without a central directory record. macOS Archive Utility then refused to
// extract it ("Error 79 - Inappropriate file type or format").
export const maxDuration = 300;

const BATCH_SIZE = 25;

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

function parseDate(value: string): Date | null {
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d;
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
  await connection();

  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  const searchParams = request.nextUrl.searchParams;
  const userId = searchParams.get('userId');
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const model = searchParams.get('model');
  const sessionId = searchParams.get('sessionId') || searchParams.get('session_id');
  const errorsOnly = searchParams.get('errorsOnly') === 'true';

  const parsedStart = startDate ? parseDate(startDate) : null;
  const parsedEnd = endDate ? parseDate(endDate + 'T23:59:59.999Z') : null;
  if ((startDate && !parsedStart) || (endDate && !parsedEnd)) {
    return jsonError('Invalid date format. Use YYYY-MM-DD.', 400);
  }

  const filter = buildFilter(userId, parsedStart, parsedEnd, model, sessionId, errorsOnly);

  // Bound pagination before streaming starts so newly inserted logs cannot
  // keep extending a busy export toward the function timeout.
  const [ceiling] = await db
    .select({ lastId: api_request_log.id })
    .from(api_request_log)
    .where(filter)
    .orderBy(desc(api_request_log.id))
    .limit(1);
  if (!ceiling) {
    return jsonError('No records found for the given criteria', 404);
  }

  // Request logs are large and text-heavy. Level 1 retains useful compression
  // while reducing the chance that CPU time prevents the ZIP from finalizing.
  const archive = archiver('zip', { zlib: { level: 1 } });
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
    let cursor: bigint | null = null;
    for (;;) {
      const rows = await db
        .select()
        .from(api_request_log)
        .where(
          and(
            filter,
            lte(api_request_log.id, ceiling.lastId),
            cursor ? gt(api_request_log.id, cursor) : undefined
          )
        )
        .orderBy(asc(api_request_log.id))
        .limit(BATCH_SIZE);

      if (rows.length === 0) break;

      for (const row of rows) {
        const ts = formatTimestamp(row.created_at);
        const id = String(row.id);

        const requestExt = isJson(row.request) ? 'json' : 'txt';
        const requestContent = tryFormatJson(row.request);
        if (requestContent) {
          totalAppendedEntries += 1;
          archive.append(requestContent, { name: `${ts}_${id}_request.${requestExt}` });
        }

        const responseExt = isJson(row.response) ? 'json' : 'txt';
        const responseContent = tryFormatJson(row.response);
        if (responseContent) {
          totalAppendedEntries += 1;
          archive.append(responseContent, { name: `${ts}_${id}_response.${responseExt}` });
        }

        if (row.error !== null && row.error !== undefined) {
          const errorContent = tryFormatJson(row.error);
          if (errorContent) {
            totalAppendedEntries += 1;
            archive.append(errorContent, { name: `${ts}_${id}_error.json` });
          }
        }
      }

      cursor = rows[rows.length - 1].id;

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
  const filename = `api-request-log_${safeUserId}_${startDate ?? 'any-start'}_${endDate ?? 'any-end'}${safeModel}${safeSessionId}${safeErrorsOnly}.zip`;

  return new Response(webStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
