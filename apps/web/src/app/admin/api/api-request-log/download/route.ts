import { connection, type NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { api_request_log } from '@kilocode/db/schema';
import { and, gte, lte, eq, asc, gt, count } from 'drizzle-orm';
import archiver from 'archiver';
import { Readable } from 'node:stream';

// Downloading all logs for a heavy user can take a while. Without a raised
// maxDuration the Vercel function was killed mid-stream, producing a ZIP
// without a central directory record. macOS Archive Utility then refused to
// extract it ("Error 79 - Inappropriate file type or format").
export const maxDuration = 300;

const BATCH_SIZE = 100;

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

function buildFilter(userId: string, parsedStart: Date, parsedEnd: Date, model: string | null) {
  const conditions = [
    eq(api_request_log.kilo_user_id, userId),
    gte(api_request_log.created_at, parsedStart.toISOString()),
    lte(api_request_log.created_at, parsedEnd.toISOString()),
  ];
  if (model) {
    conditions.push(eq(api_request_log.model, model));
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

  if (!userId || !startDate || !endDate) {
    return jsonError('userId, startDate, and endDate are required', 400);
  }

  const parsedStart = parseDate(startDate);
  const parsedEnd = parseDate(endDate + 'T23:59:59.999Z');
  if (!parsedStart || !parsedEnd) {
    return jsonError('Invalid date format. Use YYYY-MM-DD.', 400);
  }

  const filter = buildFilter(userId, parsedStart, parsedEnd, model);

  const [result] = await db.select({ total: count() }).from(api_request_log).where(filter);
  if (result.total === 0) {
    return jsonError('No records found for the given criteria', 404);
  }

  const archive = archiver('zip', { zlib: { level: 6 } });

  // Fetch and archive rows in batches using cursor-based pagination to
  // avoid loading the entire result set into memory at once.
  const appendRows = async () => {
    let cursor: bigint | null = null;
    for (;;) {
      const rows = await db
        .select()
        .from(api_request_log)
        .where(cursor ? and(filter, gt(api_request_log.id, cursor)) : filter)
        .orderBy(asc(api_request_log.id))
        .limit(BATCH_SIZE);

      if (rows.length === 0) break;

      for (const row of rows) {
        const ts = formatTimestamp(row.created_at);
        const id = String(row.id);

        const requestExt = isJson(row.request) ? 'json' : 'txt';
        const requestContent = tryFormatJson(row.request);
        if (requestContent) {
          archive.append(requestContent, { name: `${ts}_${id}_request.${requestExt}` });
        }

        const responseExt = isJson(row.response) ? 'json' : 'txt';
        const responseContent = tryFormatJson(row.response);
        if (responseContent) {
          archive.append(responseContent, { name: `${ts}_${id}_response.${responseExt}` });
        }
      }

      cursor = rows[rows.length - 1].id;

      // Yield between batches while the archive's readable buffer is above
      // its high-water mark, so we don't buffer unbounded data in memory.
      // Polling via setImmediate rather than waiting on a single 'drain'
      // event: archiver's internal queue pauses once it's out of entries, so
      // after we stop appending its writable side may never go back above
      // HWM and 'drain' would never fire again - listening for it would
      // deadlock the stream.
      const hwm = archive.readableHighWaterMark ?? 16 * 1024;
      while (archive.readableLength > hwm) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
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

  const sanitize = (s: string) => s.replaceAll('/', '-').replaceAll(':', '-');
  const safeUserId = sanitize(userId);
  const safeModel = model ? `_${sanitize(model)}` : '';
  const filename = `api-request-log_${safeUserId}_${startDate}_${endDate}${safeModel}.zip`;

  return new Response(webStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
