import { connection, type NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { api_request_log } from '@kilocode/db/schema';
import { and, gte, lte, eq, asc, gt, count } from 'drizzle-orm';
import archiver from 'archiver';
import { PassThrough } from 'node:stream';

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

  const passthrough = new PassThrough();
  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.pipe(passthrough);

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

      // Wait for the passthrough stream to drain before fetching the next
      // batch so we don't buffer unbounded data in memory.
      await new Promise<void>(resolve => {
        if (passthrough.writableNeedDrain) {
          passthrough.once('drain', resolve);
        } else {
          resolve();
        }
      });
    }

    await archive.finalize();
  };

  void appendRows().catch(error => passthrough.destroy(error));

  const webStream = new ReadableStream({
    start(controller) {
      passthrough.on('data', (chunk: Buffer) => controller.enqueue(chunk));
      passthrough.on('end', () => controller.close());
      passthrough.on('error', err => controller.error(err));
    },
  });

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
