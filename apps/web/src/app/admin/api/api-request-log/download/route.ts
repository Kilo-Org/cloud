import { connection, type NextRequest } from 'next/server';
import * as z from 'zod';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { api_request_log_2 } from '@kilocode/db/schema';
import { and, gte, lte, eq, asc, gt, count, inArray, like, or, type SQL } from 'drizzle-orm';
import {
  apiRequestLogBlobKey,
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
import { MAX_LOG_EXPORT_IDS, splitIdList } from '@/lib/admin/log-export-ids';

// Downloading all logs for a heavy user can take a while. Without a raised
// maxDuration the Vercel function was killed mid-stream, producing a ZIP
// without a central directory record. macOS Archive Utility then refused to
// extract it ("Error 79 - Inappropriate file type or format").
export const maxDuration = 800;

const BATCH_SIZE = 10;

type Row = { id: string; created_at: string };

type LoadedBlob = { files: { kind: string; value: string | null }[] } | { loadError: string };

async function loadBlob(row: Row): Promise<LoadedBlob> {
  let key: string;
  try {
    key = apiRequestLogBlobKey(row);
  } catch (error) {
    return { loadError: `Failed to derive the R2 key of ${row.id}: ${String(error)}` };
  }
  let body: string | null;
  try {
    body = await getApiRequestLogBlob(key);
  } catch (error) {
    return { loadError: `Failed to load ${key} from R2: ${String(error)}` };
  }
  if (body === null) {
    return { loadError: `Failed to load ${key} from R2: Object not found` };
  }
  try {
    const blob = apiRequestLogBlobSchema.parse(JSON.parse(body));
    return {
      files: [
        { kind: 'request', value: JSON.stringify(blob.request) },
        { kind: 'response', value: blob.response },
        ...(blob.enkrypt?.length ? [{ kind: 'enkrypt', value: JSON.stringify(blob.enkrypt) }] : []),
        ...(blob.error ? [{ kind: 'error', value: JSON.stringify(blob.error) }] : []),
      ],
    };
  } catch {
    return { loadError: `Failed to decode ${key} from R2: Invalid API request log envelope` };
  }
}

function buildFilter(
  { userId, organizationId, start, end, modelPrefix, sessionId }: LogExportFilters,
  ids: string[],
  generationIds: string[]
) {
  const conditions: SQL[] = [];
  if (ids.length > 0) {
    conditions.push(inArray(api_request_log_2.id, ids));
  }
  if (generationIds.length > 0) {
    conditions.push(inArray(api_request_log_2.generation_id, generationIds));
  }
  if (userId) {
    conditions.push(eq(api_request_log_2.kilo_user_id, userId));
  }
  if (organizationId) {
    conditions.push(eq(api_request_log_2.organization_id, organizationId));
  }
  if (start) {
    conditions.push(gte(api_request_log_2.created_at, start.toISOString()));
  }
  if (end) {
    conditions.push(lte(api_request_log_2.created_at, end.toISOString()));
  }
  if (modelPrefix) {
    conditions.push(like(api_request_log_2.requested_model, `${escapeLikePattern(modelPrefix)}%`));
  }
  if (sessionId) {
    conditions.push(eq(api_request_log_2.session_id, sessionId));
  }
  return and(...conditions);
}

/** Keyset condition for rows after `row` in (created_at, id) order. */
function after(row: Row) {
  return and(
    gte(api_request_log_2.created_at, row.created_at),
    or(gt(api_request_log_2.created_at, row.created_at), gt(api_request_log_2.id, row.id))
  );
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
  const ids = splitIdList(...searchParams.getAll('id'));
  const generationIds = splitIdList(...searchParams.getAll('generationId'));
  if (ids.length > MAX_LOG_EXPORT_IDS || generationIds.length > MAX_LOG_EXPORT_IDS) {
    return jsonError(
      `Too many IDs. Use at most ${MAX_LOG_EXPORT_IDS} log IDs and ${MAX_LOG_EXPORT_IDS} generation IDs.`,
      400
    );
  }
  const invalidId = ids.find(id => !z.uuid().safeParse(id).success);
  if (invalidId !== undefined) {
    return jsonError(`Invalid log ID ${JSON.stringify(invalidId)}. Use the usage UUID.`, 400);
  }

  const parsedFilters = await parseLogExportFilters(searchParams);
  if (!parsedFilters.ok) {
    return parsedFilters.response;
  }
  const { filters } = parsedFilters;
  const filter = buildFilter(filters, ids, generationIds);

  const [result] = await db.select({ total: count() }).from(api_request_log_2).where(filter);
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
        logIds: ids.length > 0 ? ids : null,
        generationIdCount: generationIds.length,
        ...audit.metadata,
        matchingRows: result.total,
      },
    }
  );

  const stream = streamBatchedZipExport<Row>({
    startedAt,
    maxDurationSeconds: maxDuration,
    order: 'creation time',
    fetchBatch: lastRow =>
      db
        .select({ id: api_request_log_2.id, created_at: api_request_log_2.created_at })
        .from(api_request_log_2)
        .where(lastRow ? and(filter, after(lastRow)) : filter)
        .orderBy(asc(api_request_log_2.created_at), asc(api_request_log_2.id))
        .limit(BATCH_SIZE),
    remainingRows: async lastRow => {
      const [remaining] = await db
        .select({ total: count() })
        .from(api_request_log_2)
        .where(and(filter, after(lastRow)));
      return remaining.total;
    },
    writeRows: async (rows, append) => {
      const blobs = await Promise.all(rows.map(loadBlob));
      for (const [index, row] of rows.entries()) {
        const prefix = `${formatTimestamp(row.created_at)}_${row.id}`;
        const blob = blobs[index];
        if ('loadError' in blob) {
          append(blob.loadError, `${prefix}_load-error.txt`);
          continue;
        }
        for (const { kind, value } of blob.files) {
          const content = tryFormatJson(value);
          if (content) {
            append(content, `${prefix}_${kind}.${isJson(value) ? 'json' : 'txt'}`);
          }
        }
      }
    },
  });

  const suffix = ids.length === 1 ? `_id-${ids[0]}` : ids.length > 1 ? `_${ids.length}-ids` : '';
  return zipDownloadResponse(stream, logExportFilename('api-request-log', filters, suffix));
}
