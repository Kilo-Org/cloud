import type { NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { api_request_log } from '@kilocode/db/schema';
import { and, gte, lte, eq, asc } from 'drizzle-orm';
import archiver from 'archiver';
import { PassThrough } from 'node:stream';

export const dynamic = 'force-dynamic';

function formatTimestamp(isoString: string): string {
  return isoString.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
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

export async function GET(request: NextRequest) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  const searchParams = request.nextUrl.searchParams;
  const userId = searchParams.get('userId');
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');

  if (!userId || !startDate || !endDate) {
    return new Response(JSON.stringify({ error: 'userId, startDate, and endDate are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const conditions = [
    eq(api_request_log.kilo_user_id, userId),
    gte(api_request_log.created_at, new Date(startDate).toISOString()),
    lte(api_request_log.created_at, new Date(endDate + 'T23:59:59.999Z').toISOString()),
  ];

  const rows = await db
    .select()
    .from(api_request_log)
    .where(and(...conditions))
    .orderBy(asc(api_request_log.created_at));

  if (rows.length === 0) {
    return new Response(JSON.stringify({ error: 'No records found for the given criteria' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
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
      archive.append(responseContent, { name: `${ts}_${id}_response.${responseExt}` });
    }
  }

  archive.finalize();

  const webStream = new ReadableStream({
    start(controller) {
      passthrough.on('data', (chunk: Buffer) => controller.enqueue(chunk));
      passthrough.on('end', () => controller.close());
      passthrough.on('error', (err) => controller.error(err));
    },
  });

  const filename = `api-request-log_${userId}_${startDate}_${endDate}.zip`;

  return new Response(webStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
