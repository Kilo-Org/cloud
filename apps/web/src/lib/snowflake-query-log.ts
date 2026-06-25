import { snowflake_query_log } from '@kilocode/db/schema';

import { db } from '@/lib/drizzle';

export type SnowflakeQueryLogRecord = {
  createdAt: string;
  source: string;
  queryLabel: string;
  requestId: string;
  statementHandle: string | null;
  succeeded: boolean;
  statusCode: number | null;
  durationMs: number;
  submitRequestCount: number;
  pollRequestCount: number;
  partitionRequestCount: number;
  http202Count: number;
  http429Count: number;
  retryCount: number;
  partitionCount: number;
  rowCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export async function recordSnowflakeQuery(record: SnowflakeQueryLogRecord): Promise<void> {
  try {
    await db.insert(snowflake_query_log).values({
      created_at: record.createdAt,
      source: record.source,
      query_label: record.queryLabel,
      request_id: record.requestId,
      statement_handle: record.statementHandle,
      succeeded: record.succeeded,
      status_code: record.statusCode,
      duration_ms: record.durationMs,
      submit_request_count: record.submitRequestCount,
      poll_request_count: record.pollRequestCount,
      partition_request_count: record.partitionRequestCount,
      http_202_count: record.http202Count,
      http_429_count: record.http429Count,
      retry_count: record.retryCount,
      partition_count: record.partitionCount,
      row_count: record.rowCount,
      error_code: record.errorCode?.slice(0, 100) ?? null,
      error_message: record.errorMessage?.slice(0, 200) ?? null,
    });
  } catch (error) {
    console.error('Failed to record Snowflake query metrics', {
      source: record.source,
      queryLabel: record.queryLabel,
      requestId: record.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
