import { connection, type NextRequest } from 'next/server';
import { and, asc, eq, gt, gte, inArray, lte, or, type SQL } from 'drizzle-orm';
import * as z from 'zod';
import { microdollar_usage, microdollar_usage_metadata } from '@kilocode/db/schema';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  getAiProviderMetadataBucket,
  readAiProviderMetadata,
} from '@kilocode/web-shared/lib/r2/ai-provider-metadata-bucket';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
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
import { microdollarUsageModelStartsWith } from '@/lib/request-logs/model-prefix';

// Without a raised maxDuration, Vercel kills large exports mid-stream and the
// ZIP lacks its central directory, so it cannot be extracted.
export const maxDuration = 800;

const LOG_SOURCE = 'admin-provider-metadata-export';
const BATCH_SIZE = 50;
const MISSING_NOTICE_NAME = 'MISSING_METADATA_README.txt';

type Row = { id: string; created_at: string };

function buildFilter(
  { userId, organizationId, start, end, modelPrefix, sessionId }: LogExportFilters,
  usageId: string | null
) {
  const conditions: SQL[] = [];
  if (usageId !== null) {
    conditions.push(eq(microdollar_usage.id, usageId));
  }
  if (userId) {
    conditions.push(eq(microdollar_usage.kilo_user_id, userId));
  }
  if (organizationId) {
    conditions.push(eq(microdollar_usage.organization_id, organizationId));
  }
  if (start) {
    conditions.push(gte(microdollar_usage.created_at, start.toISOString()));
  }
  if (end) {
    conditions.push(lte(microdollar_usage.created_at, end.toISOString()));
  }
  if (modelPrefix) {
    conditions.push(microdollarUsageModelStartsWith(modelPrefix));
  }
  // The session ID lives only in microdollar_usage_metadata, so read that table only for this filter.
  if (sessionId) {
    conditions.push(
      inArray(
        microdollar_usage.id,
        readDb
          .select({ id: microdollar_usage_metadata.id })
          .from(microdollar_usage_metadata)
          .where(eq(microdollar_usage_metadata.session_id, sessionId))
      )
    );
  }
  return and(...conditions);
}

/** Keyset condition for rows after `row` in (created_at, id) order. */
function after(row: Row) {
  return and(
    gte(microdollar_usage.created_at, row.created_at),
    or(gt(microdollar_usage.created_at, row.created_at), gt(microdollar_usage.id, row.id))
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
  const usageId = searchParams.get('id') || null;
  if (usageId !== null && !z.uuid().safeParse(usageId).success) {
    return jsonError('Invalid usage ID. Use a UUID.', 400);
  }
  const organizationId = searchParams.get('organizationId') || null;
  if (organizationId !== null && !z.uuid().safeParse(organizationId).success) {
    return jsonError('Invalid organization ID. Use a UUID.', 400);
  }

  if (!getAiProviderMetadataBucket(LOG_SOURCE)) {
    return jsonError('The AI provider metadata bucket is not configured', 503);
  }

  const parsedFilters = await parseLogExportFilters(searchParams);
  if (!parsedFilters.ok) {
    return parsedFilters.response;
  }
  const { filters } = parsedFilters;
  const filter = buildFilter(filters, usageId);

  const fetchBatch = (lastRow: Row | null): Promise<Row[]> =>
    readDb
      .select({ id: microdollar_usage.id, created_at: microdollar_usage.created_at })
      .from(microdollar_usage)
      .where(lastRow ? and(filter, after(lastRow)) : filter)
      .orderBy(asc(microdollar_usage.created_at), asc(microdollar_usage.id))
      .limit(BATCH_SIZE);

  // microdollar_usage is too large to count matches, so an empty first batch is the 404 check.
  const firstBatch = await fetchBatch(null);
  if (firstBatch.length === 0) {
    return jsonError('No records found for the given criteria', 404);
  }

  const audit = logExportAuditDetails(filters);
  await recordAdminAction(
    {
      ...adminActionContextFromHeaders(user, request.headers),
      trpcPath: '/admin/api/provider-metadata/download',
    },
    {
      action: 'provider_metadata.download',
      target: audit.target,
      message: 'Started provider metadata ZIP export',
      metadata: { usageId, ...audit.metadata },
    }
  );

  let exportedRows = 0;
  let missingRows = 0;
  const stream = streamBatchedZipExport<Row>({
    startedAt,
    maxDurationSeconds: maxDuration,
    order: 'creation time',
    firstBatch,
    fetchBatch,
    remainingRows: async lastRow => {
      const [next] = await readDb
        .select({ id: microdollar_usage.id })
        .from(microdollar_usage)
        .where(and(filter, after(lastRow)))
        .limit(1);
      return next ? 'some' : 0;
    },
    writeRows: async (rows, append) => {
      const objects = await Promise.all(
        rows.map(async row => {
          try {
            return await readAiProviderMetadata(row.id, LOG_SOURCE);
          } catch (error) {
            return { status: 'load-error' as const, error };
          }
        })
      );
      for (const [index, row] of rows.entries()) {
        const object = objects[index];
        const prefix = `${formatTimestamp(row.created_at)}_${row.id}`;
        if (object.status === 'found') {
          append(tryFormatJson(object.body), `${prefix}.${isJson(object.body) ? 'json' : 'txt'}`);
        } else if (object.status === 'load-error') {
          append(
            `Failed to load ${row.id}.json from R2: ${String(object.error)}`,
            `${prefix}_load-error.txt`
          );
        } else {
          missingRows += 1;
        }
      }
      exportedRows += rows.length;
    },
    writeSummary: append => {
      if (missingRows > 0) {
        append(
          `${missingRows} of the ${exportedRows} exported usage records have no provider metadata object in R2.\n`,
          MISSING_NOTICE_NAME
        );
      }
    },
  });

  const suffix = usageId !== null ? `_id-${usageId}` : '';
  return zipDownloadResponse(stream, logExportFilename('provider-metadata', filters, suffix));
}
