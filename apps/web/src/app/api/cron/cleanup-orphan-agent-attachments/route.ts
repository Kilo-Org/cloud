import { NextResponse } from 'next/server';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { and, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { cloud_agent_attachment_uploads } from '@kilocode/db/schema';
import { r2Client, r2CloudAgentAttachmentsBucketName } from '@/lib/r2/client';
import { CRON_SECRET } from '@/lib/config.server';

const BATCH_SIZE = 500;

/**
 * Reap unconsumed Cloud Agent attachment uploads past the TTL.
 *
 * A presign writes a ledger row (`cloud_agent_attachment_uploads`); a sent
 * message marks it consumed. Rows still unconsumed after 24 hours are orphaned
 * uploads: delete the R2 object, then the row. Select on `r2_key` only — never
 * `user_id` — so the batch is keyed by the object identity and never leaks PII.
 */
export async function GET(request: Request) {
  if (!CRON_SECRET || request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const cutoff = sql`now() - interval '24 hours'`;

  const rows = await db
    .select({ r2_key: cloud_agent_attachment_uploads.r2_key })
    .from(cloud_agent_attachment_uploads)
    .where(
      and(
        isNull(cloud_agent_attachment_uploads.consumed_at),
        lt(cloud_agent_attachment_uploads.created_at, cutoff)
      )
    )
    .limit(BATCH_SIZE);

  let deletedObjects = 0;
  for (const row of rows) {
    await r2Client.send(
      new DeleteObjectCommand({
        Bucket: r2CloudAgentAttachmentsBucketName,
        Key: row.r2_key,
      })
    );
    deletedObjects += 1;
  }

  let deletedRows = 0;
  if (rows.length > 0) {
    const keys = rows.map(row => row.r2_key);
    const result = await db
      .delete(cloud_agent_attachment_uploads)
      .where(inArray(cloud_agent_attachment_uploads.r2_key, keys));
    deletedRows = result.rowCount ?? 0;
  }

  return NextResponse.json({
    success: true,
    scannedCount: rows.length,
    deletedObjects,
    deletedRows,
    timestamp: new Date().toISOString(),
  });
}
