import { connection, type NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { api_request_log } from '@kilocode/db/schema';
import { and, gte, lte, eq, asc } from 'drizzle-orm';
import archiver from 'archiver';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';

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

function generateProviderSpecificHash(payload: string, provider: string): string {
  const salt = 'd20250815';
  const pepper =
    provider === 'vercel' ? 'vercel' : provider === 'openrouter' ? 'henk is a boss' : provider;
  return createHash('sha256')
    .update(salt + pepper + payload)
    .digest('base64');
}

function hashTaskId(userId: string, taskId: string, provider: string): string {
  return generateProviderSpecificHash(userId + '-' + taskId, provider);
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

  // Optional filters
  const modelFilter = searchParams.get('model');
  const sessionIdFilter = searchParams.get('sessionId');

  if (!userId || !startDate || !endDate) {
    return jsonError('userId, startDate, and endDate are required', 400);
  }

  const parsedStart = parseDate(startDate);
  const parsedEnd = parseDate(endDate + 'T23:59:59.999Z');
  if (!parsedStart || !parsedEnd) {
    return jsonError('Invalid date format. Use YYYY-MM-DD.', 400);
  }

  let rows = await db
    .select()
    .from(api_request_log)
    .where(
      and(
        eq(api_request_log.kilo_user_id, userId),
        gte(api_request_log.created_at, parsedStart.toISOString()),
        lte(api_request_log.created_at, parsedEnd.toISOString())
      )
    )
    .orderBy(asc(api_request_log.created_at));

  // Apply optional filters
  if (modelFilter) {
    rows = rows.filter(row => row.model === modelFilter);
  }

  if (sessionIdFilter) {
    rows = rows.filter(row => {
      if (!row.prompt_cache_key || !row.provider || !row.kilo_user_id) {
        return false;
      }
      const expectedHash = hashTaskId(row.kilo_user_id, sessionIdFilter, row.provider);
      return expectedHash === row.prompt_cache_key;
    });
  }

  if (rows.length === 0) {
    return jsonError('No records found for the given criteria', 404);
  }

  const passthrough = new PassThrough();
  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.pipe(passthrough);

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
      archive.append(responseContent, { name: `${ts}_${id}_response.${responseExt}` );
    }
  }

  void archive.finalize();

  const webStream = new ReadableStream({
    start(controller) {
      passthrough.on('data', (chunk: Buffer) => controller.enqueue(chunk));
      passthrough.on('end', () => controller.close());
      passthrough.on('error', err => controller.error(err));
    },
  });

  const safeUserId = userId.replaceAll('/', '-').replaceAll(':', '-');
  const filename = `api-request-log_${safeUserId}_${startDate}_${endDate}.zip`;

  return new Response(webStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
