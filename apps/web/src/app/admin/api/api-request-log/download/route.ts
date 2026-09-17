import { connection, type NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { db, pool } from '@/lib/drizzle';
import { api_request_log } from '@kilocode/db/schema';
import { and, gte, lte, eq, asc, gt, count, or, isNotNull, sql, type SQL } from 'drizzle-orm';
import archiver from 'archiver';
import { Readable } from 'node:stream';

// Downloading all logs for a heavy user can take a while. Without a raised
// maxDuration the Vercel function was killed mid-stream, producing a ZIP
// without a central directory record. macOS Archive Utility then refused to
// extract it ("Error 79 - Inappropriate file type or format").
export const maxDuration = 800;

// Fluid compute functions are 2 GB. A batch of parsed jsonb rows, plus a
// pretty-printed copy, exceeds that for heavy users. Pretty-print only small
// payloads, copy medium ones as text, and stream anything larger in chunks.
const ID_PAGE_SIZE = 25;
const PRETTY_PRINT_MAX_BYTES = 256 * 1024;
const IN_MEMORY_MAX_BYTES = 1024 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;

const PAYLOAD_COLUMNS = ['request', 'response', 'error'] as const;
type PayloadColumn = (typeof PAYLOAD_COLUMNS)[number];

// Constants only. These are interpolated into SQL, so they must stay fixed.
const PAYLOAD_TEXT_SQL: Record<PayloadColumn, string> = {
  request: 'request::text',
  response: 'response',
  error: 'error::text',
};

async function readPayloadText(id: bigint, column: PayloadColumn): Promise<string | null> {
  const result = await pool.query(
    `SELECT ${PAYLOAD_TEXT_SQL[column]} AS payload
     FROM api_request_log
     WHERE id = $1::bigint`,
    [id.toString()]
  );
  const payload = result.rows[0]?.payload;
  if (typeof payload !== 'string' || payload.length === 0) return null;
  return payload;
}

async function readPayloadChunk(
  id: bigint,
  column: PayloadColumn,
  offset: number,
  length: number
): Promise<Buffer | null> {
  // Each chunk is its own query so a pooled connection is not held for the
  // whole payload, and a session temp table is not required.
  const result = await pool.query(
    `SELECT substring(convert_to(${PAYLOAD_TEXT_SQL[column]}, 'UTF8') from $2::int for $3::int) AS chunk
     FROM api_request_log
     WHERE id = $1::bigint`,
    [id.toString(), offset, length]
  );
  return toChunk(result.rows[0]?.chunk);
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

function extensionForResponsePrefix(prefix: string | null): 'json' | 'txt' {
  const start = prefix?.at(0);
  if (!start) return 'txt';
  if ('{["-0123456789tfn'.includes(start)) return 'json';
  return 'txt';
}

function readByteLength(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toChunk(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value.length > 0 ? value : null;
  if (value instanceof Uint8Array) {
    return value.byteLength > 0 ? Buffer.from(value) : null;
  }
  return null;
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

function smallPayloadLimit(column: PayloadColumn) {
  const expression =
    column === 'response'
      ? sql`coalesce(octet_length(${api_request_log.response}), 0) <= ${PRETTY_PRINT_MAX_BYTES}`
      : column === 'request'
        ? sql`coalesce(octet_length(${api_request_log.request}::text), 0) <= ${PRETTY_PRINT_MAX_BYTES}`
        : sql`coalesce(octet_length(${api_request_log.error}::text), 0) <= ${PRETTY_PRINT_MAX_BYTES}`;
  return expression;
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

  const appendEntry = async (name: string, source: string | Readable) => {
    totalAppendedEntries += 1;
    archive.append(source, { name });
    await waitForEntries(totalAppendedEntries);
  };

  const appendFormattedPayloads = async (
    createdAt: string,
    id: bigint,
    row: { request: unknown; response: string | null; error: unknown }
  ) => {
    const ts = formatTimestamp(createdAt);
    const idText = String(id);

    const requestContent = tryFormatJson(row.request);
    if (requestContent) {
      const requestExt = isJson(row.request) ? 'json' : 'txt';
      await appendEntry(`${ts}_${idText}_request.${requestExt}`, requestContent);
    }

    const responseContent = tryFormatJson(row.response);
    if (responseContent) {
      const responseExt = isJson(row.response) ? 'json' : 'txt';
      await appendEntry(`${ts}_${idText}_response.${responseExt}`, responseContent);
    }

    if (row.error !== null && row.error !== undefined) {
      const errorContent = tryFormatJson(row.error);
      if (errorContent) {
        await appendEntry(`${ts}_${idText}_error.json`, errorContent);
      }
    }
  };

  const appendStreamedPayload = async (id: bigint, column: PayloadColumn, name: string) => {
    let offset = 1;
    let finished = false;
    let reading = false;

    const pump = async (readable: Readable) => {
      try {
        while (!finished) {
          const chunk = await readPayloadChunk(id, column, offset, STREAM_CHUNK_BYTES);
          if (!chunk) {
            finished = true;
            readable.push(null);
            return;
          }
          offset += chunk.length;
          const last = chunk.length < STREAM_CHUNK_BYTES;
          const more = readable.push(chunk);
          if (last) {
            finished = true;
            readable.push(null);
            return;
          }
          if (!more) return;
        }
      } catch (error) {
        finished = true;
        readable.destroy(
          error instanceof Error ? error : new Error('Failed to read API request log payload')
        );
      } finally {
        reading = false;
      }
    };

    const stream = new Readable({
      highWaterMark: STREAM_CHUNK_BYTES,
      read() {
        if (finished || reading) return;
        reading = true;
        void pump(this);
      },
    });
    stream.on('error', () => undefined);
    await appendEntry(name, stream);
  };

  const appendOversizedRow = async (createdAt: string, id: bigint) => {
    const [meta] = await db
      .select({
        requestBytes: sql<string | null>`octet_length(${api_request_log.request}::text)`,
        responseBytes: sql<string | null>`octet_length(${api_request_log.response})`,
        errorBytes: sql<string | null>`octet_length(${api_request_log.error}::text)`,
        responsePrefix: sql<string | null>`left(ltrim(${api_request_log.response}), 1)`,
      })
      .from(api_request_log)
      .where(eq(api_request_log.id, id))
      .limit(1);
    if (!meta) return;

    const ts = formatTimestamp(createdAt);
    const idText = String(id);
    const bytesByColumn = {
      request: readByteLength(meta.requestBytes),
      response: readByteLength(meta.responseBytes),
      error: readByteLength(meta.errorBytes),
    };
    const extensionByColumn = {
      request: 'json',
      response: extensionForResponsePrefix(meta.responsePrefix),
      error: 'json',
    } as const;

    for (const column of PAYLOAD_COLUMNS) {
      const bytes = bytesByColumn[column];
      if (bytes <= 0) continue;
      const name = `${ts}_${idText}_${column}.${extensionByColumn[column]}`;
      if (bytes <= IN_MEMORY_MAX_BYTES) {
        const text = await readPayloadText(id, column);
        if (text) await appendEntry(name, text);
        continue;
      }
      await appendStreamedPayload(id, column, name);
    }
  };

  const appendRows = async () => {
    let cursor: bigint | null = null;
    for (;;) {
      const rows = await db
        .select({
          id: api_request_log.id,
          created_at: api_request_log.created_at,
        })
        .from(api_request_log)
        .where(cursor ? and(filter, gt(api_request_log.id, cursor)) : filter)
        .orderBy(asc(api_request_log.id))
        .limit(ID_PAGE_SIZE);

      if (rows.length === 0) break;

      for (const row of rows) {
        const [small] = await db
          .select({
            request: api_request_log.request,
            response: api_request_log.response,
            error: api_request_log.error,
          })
          .from(api_request_log)
          .where(
            and(
              eq(api_request_log.id, row.id),
              smallPayloadLimit('request'),
              smallPayloadLimit('response'),
              smallPayloadLimit('error')
            )
          )
          .limit(1);

        if (small) {
          await appendFormattedPayloads(row.created_at, row.id, small);
        } else {
          await appendOversizedRow(row.created_at, row.id);
        }
      }

      cursor = rows[rows.length - 1].id;
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
      'Cache-Control': 'no-store, no-transform',
    },
  });
}
