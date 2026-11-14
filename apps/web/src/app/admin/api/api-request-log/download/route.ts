import { connection, type NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { api_request_log } from '@kilocode/db/schema';
import {
  and,
  gte,
  lte,
  eq,
  asc,
  gt,
  count,
  inArray,
  or,
  isNotNull,
  like,
  type SQL,
} from 'drizzle-orm';
import {
  apiRequestLogBlobSchema,
  getApiRequestLogBlob,
} from '@kilocode/web-shared/lib/r2/api-request-log';
import { canCurrentUserExportApiRequestLogs } from '@/lib/admin/admin-permissions';
import { adminActionContextFromHeaders, recordAdminAction } from '@/lib/admin/admin-action-audit';
import {
  formatTimestamp,
  isJson,
  jsonError,
  logExportAuditDetails,
  logExportFilename,
  parseLogExportFilters,
  streamBatchedZipExport,
  tryFormatJson,
  zipDownloadResponse,
  type LogExportFilters,
} from '@/lib/admin/log-export';
import { escapeLikePattern } from '@/lib/sql-like';

// Downloading all logs for a heavy user can take a while. Without a raised
// maxDuration the Vercel function was killed mid-stream, producing a ZIP
// without a central directory record. macOS Archive Utility then refused to
// extract it ("Error 79 - Inappropriate file type or format").
export const maxDuration = 800;

const BATCH_SIZE = 10;

type LoadedBody = { value: string | null } | { loadError: string };
type LoadedBodies = { request: LoadedBody; response: LoadedBody; enkrypt?: LoadedBody };

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

async function loadBodies(row: {
  request_r2_key: string | null;
  response_r2_key: string | null;
}): Promise<LoadedBodies> {
  if (row.request_r2_key !== null && row.request_r2_key === row.response_r2_key) {
    const body = await loadBody(row.request_r2_key);
    if ('loadError' in body) {
      return { request: body, response: body };
    }
    if (body.value === null) {
      const failure = {
        loadError: `Failed to load ${row.request_r2_key} from R2: Object not found`,
      };
      return { request: failure, response: failure };
    }
    try {
      const blob = apiRequestLogBlobSchema.parse(JSON.parse(body.value));
      return {
        request: { value: JSON.stringify(blob.request) },
        response: { value: blob.response },
        ...(blob.enkrypt?.length ? { enkrypt: { value: JSON.stringify(blob.enkrypt) } } : {}),
      };
    } catch {
      const failure = {
        loadError: `Failed to decode ${row.request_r2_key} from R2: Invalid API request log envelope`,
      };
      return { request: failure, response: failure };
    }
  }
  const [request, response] = await Promise.all([
    loadBody(row.request_r2_key),
    loadBody(row.response_r2_key),
  ]);
  return { request, response };
}

function buildFilter(
  { userId, organizationId, start, end, modelPrefix, sessionId }: LogExportFilters,
  ids: bigint[] | null,
  errorsOnly: boolean
) {
  const conditions: SQL[] = [];
  if (ids !== null) {
    conditions.push(inArray(api_request_log.id, ids));
  }
  if (userId) {
    conditions.push(eq(api_request_log.kilo_user_id, userId));
  }
  if (organizationId) {
    conditions.push(eq(api_request_log.organization_id, organizationId));
  }
  if (start) {
    conditions.push(gte(api_request_log.created_at, start.toISOString()));
  }
  if (end) {
    conditions.push(lte(api_request_log.created_at, end.toISOString()));
  }
  if (modelPrefix) {
    conditions.push(like(api_request_log.model, `${escapeLikePattern(modelPrefix)}%`));
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

  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    return authFailedResponse;
  }
  if (!user || !(await canCurrentUserExportApiRequestLogs(user.id))) {
    return jsonError('API request log export access required', 403);
  }

  const searchParams = request.nextUrl.searchParams;
  const id = searchParams.get('id');
  const idTokens = id === null ? null : id.split(',').map(token => token.trim());
  const errorsOnly = searchParams.get('errorsOnly') === 'true';

  if (
    idTokens?.some(
      token => !/^[1-9]\d{0,18}$/.test(token) || BigInt(token) > BigInt('9223372036854775807')
    )
  ) {
    return jsonError('Invalid log ID. Use an integer between 1 and 9223372036854775807.', 400);
  }
  const parsedIds = idTokens === null ? null : [...new Set(idTokens.map(token => BigInt(token)))];

  const parsedFilters = await parseLogExportFilters(searchParams);
  if (!parsedFilters.ok) {
    return parsedFilters.response;
  }
  const { filters } = parsedFilters;
  const filter = buildFilter(filters, parsedIds, errorsOnly);

  const [result] = await db.select({ total: count() }).from(api_request_log).where(filter);
  if (result.total === 0) {
    return jsonError('No records found for the given criteria', 404);
  }

  const audit = logExportAuditDetails(filters);
  await recordAdminAction(
    {
      ...adminActionContextFromHeaders(user, request.headers),
      trpcPath: '/admin/api/api-request-log/download',
    },
    {
      action: 'api_request_log.download',
      target: audit.target,
      message: 'Started API request log ZIP export',
      metadata: {
        logId: parsedIds?.length === 1 ? parsedIds[0].toString() : null,
        ...(parsedIds && parsedIds.length > 1
          ? { logIds: parsedIds.map(id => id.toString()) }
          : {}),
        ...audit.metadata,
        errorsOnly,
        matchingRows: result.total,
      },
    }
  );

  type Row = {
    id: bigint;
    created_at: string;
    error: unknown;
    request_r2_key: string | null;
    response_r2_key: string | null;
  };
  const after = (row: Row | null) => (row ? and(filter, gt(api_request_log.id, row.id)) : filter);

  const stream = streamBatchedZipExport<Row>({
    startedAt,
    maxDurationSeconds: maxDuration,
    order: 'id',
    fetchBatch: lastRow =>
      db
        .select({
          id: api_request_log.id,
          created_at: api_request_log.created_at,
          error: api_request_log.error,
          request_r2_key: api_request_log.request_r2_key,
          response_r2_key: api_request_log.response_r2_key,
        })
        .from(api_request_log)
        .where(after(lastRow))
        .orderBy(asc(api_request_log.id))
        .limit(BATCH_SIZE),
    remainingRows: async lastRow => {
      const [remaining] = await db
        .select({ total: count() })
        .from(api_request_log)
        .where(after(lastRow));
      return remaining.total;
    },
    writeRows: async (rows, append) => {
      const bodies = await Promise.all(rows.map(loadBodies));
      for (const [index, row] of rows.entries()) {
        const prefix = `${formatTimestamp(row.created_at)}_${row.id}`;

        for (const [kind, body] of Object.entries(bodies[index])) {
          if ('loadError' in body) {
            append(body.loadError, `${prefix}_${kind}_load-error.txt`);
            continue;
          }
          const content = tryFormatJson(body.value);
          if (content) {
            append(content, `${prefix}_${kind}.${isJson(body.value) ? 'json' : 'txt'}`);
          }
        }

        if (row.error !== null && row.error !== undefined) {
          const errorContent = tryFormatJson(row.error);
          if (errorContent) {
            append(errorContent, `${prefix}_error.json`);
          }
        }
      }
    },
  });

  const idSuffix =
    parsedIds === null
      ? ''
      : parsedIds.length === 1
        ? `_id-${parsedIds[0]}`
        : `_ids-${parsedIds.length}`;
  const suffix = `${errorsOnly ? '_errors-only' : ''}${idSuffix}`;
  return zipDownloadResponse(stream, logExportFilename('api-request-log', filters, suffix));
}
