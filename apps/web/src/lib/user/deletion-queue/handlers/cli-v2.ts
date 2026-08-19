import { and, eq, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { generateInternalServiceToken } from '@/lib/tokens';
import {
  USER_DELETION_RESOURCE_BATCH_SIZE,
  USER_DELETION_SESSION_INGEST_AUDIENCE,
} from '@/lib/user/deletion-queue/deletion-constants';
import { userIdKeyedAbsenceOutcome } from '@/lib/user/deletion-queue/deletion-subject';
import {
  classifyResponse,
  configurationMissing,
  continueIfLowTime,
  deletionFetch,
  incrementProcessed,
  isRecord,
  readJsonUnknown,
  resourceHmac,
  type DeletionHandler,
} from '@/lib/user/deletion-queue/handlers/common';

const childSessions = alias(cli_sessions_v2, 'cli_sessions_v2_child');

async function loadLeafSessions(userId: string) {
  return db
    .select({ session_id: cli_sessions_v2.session_id })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, userId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(childSessions)
            .where(
              and(
                eq(childSessions.parent_session_id, cli_sessions_v2.session_id),
                eq(childSessions.kilo_user_id, userId)
              )
            )
        )
      )
    )
    .orderBy(cli_sessions_v2.session_id)
    .limit(USER_DELETION_RESOURCE_BATCH_SIZE);
}

async function sessionExists(userId: string, sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ session_id: cli_sessions_v2.session_id })
    .from(cli_sessions_v2)
    .where(and(eq(cli_sessions_v2.kilo_user_id, userId), eq(cli_sessions_v2.session_id, sessionId)))
    .limit(1);
  return Boolean(row);
}

async function anySessionExists(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ session_id: cli_sessions_v2.session_id })
    .from(cli_sessions_v2)
    .where(eq(cli_sessions_v2.kilo_user_id, userId))
    .limit(1);
  return Boolean(row);
}

export const handleCliV2Sessions: DeletionHandler = async ({ request, step, context }) => {
  const absence = userIdKeyedAbsenceOutcome(request);
  if (absence) return absence;
  const userId = request.user_id;
  if (!userId) return { kind: 'needs_attention', errorCode: 'legacy_identity_unresolved' };

  if (!SESSION_INGEST_WORKER_URL) return configurationMissing();

  const stop = continueIfLowTime(context, step.progress_json);
  if (stop) return stop;

  const leaves = await loadLeafSessions(userId);
  if (leaves.length === 0) {
    if (await anySessionExists(userId)) {
      return { kind: 'needs_attention', errorCode: 'cyclic_session_graph' };
    }
    return (step.progress_json.processed_count ?? 0) === 0
      ? { kind: 'not_applicable' }
      : { kind: 'succeeded', progress: step.progress_json };
  }

  const token = generateInternalServiceToken(userId, {
    expiresIn: 5 * 60,
    audience: USER_DELETION_SESSION_INGEST_AUDIENCE,
  });
  let progress = step.progress_json;

  for (const leaf of leaves) {
    const reserve = continueIfLowTime(context, progress);
    if (reserve) return reserve;

    const url = `${SESSION_INGEST_WORKER_URL}/api/session/${encodeURIComponent(leaf.session_id)}`;
    const result = await deletionFetch(context, url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if ('outcome' in result) return result.outcome;

    if (result.response.status === 409) {
      return { kind: 'continue', progress };
    }
    if (!result.response.ok && result.response.status !== 404) {
      return classifyResponse(result.response);
    }

    const stillPresent = await sessionExists(userId, leaf.session_id);
    if (stillPresent) {
      return {
        kind: 'needs_attention',
        errorCode: 'session_identity_mismatch',
        resourceHmac: resourceHmac(leaf.session_id),
      };
    }
    if (result.response.status === 404) {
      const body = await readJsonUnknown(result.response);
      if (!isRecord(body) || body.cleanup !== 'done') {
        return {
          kind: 'needs_attention',
          errorCode: 'session_cleanup_unconfirmed',
          resourceHmac: resourceHmac(leaf.session_id),
        };
      }
    }
    progress = incrementProcessed(progress);
  }

  if (await anySessionExists(userId)) {
    return { kind: 'continue', progress };
  }
  return { kind: 'succeeded', progress };
};
