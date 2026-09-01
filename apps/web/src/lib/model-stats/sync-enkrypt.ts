import 'server-only';

import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { ENKRYPT_API_KEY, ENKRYPT_SYNC_ENABLED } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { enkrypt_sync_state, modelStats } from '@kilocode/db/schema';
import { EnkryptSyncCountsSchema } from '@kilocode/db/schema-types';
import type {
  EnkryptBenchmark,
  EnkryptFailureCategory,
  EnkryptSyncCounts,
} from '@kilocode/db/schema-types';
import { and, eq, sql } from 'drizzle-orm';
import { EnkryptSyncError } from './enkrypt-errors';
import { matchEnkryptScores, parseEnkryptScores } from './enkrypt-identity';

export { matchEnkryptScores, parseEnkryptScores } from './enkrypt-identity';

export type SyncEnkryptResult =
  | { status: 'disabled' }
  | ({ status: 'succeeded'; ingestedAt: string } & EnkryptSyncCounts);

async function fetchScores(apiKey: string): Promise<unknown> {
  const signal = AbortSignal.timeout(30_000);
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch('https://api.enkryptai.com/leaderboard/v2/scores', {
        method: 'GET',
        headers: { apikey: apiKey },
        signal,
        redirect: 'error',
        cache: 'no-store',
      });
    } catch {
      throw new EnkryptSyncError(signal.aborted ? 'timeout' : 'network');
    }

    if (response.ok) {
      let body: string;
      try {
        body = await response.text();
      } catch {
        throw new EnkryptSyncError(signal.aborted ? 'timeout' : 'network');
      }
      try {
        return JSON.parse(body);
      } catch {
        throw new EnkryptSyncError('response_validation');
      }
    }

    const httpStatus = response.status;
    await response.body?.cancel().catch(() => undefined);
    if ((httpStatus === 429 || httpStatus >= 500) && attempt < 2) {
      try {
        await setTimeout(1_000 * 2 ** attempt, undefined, { signal });
      } catch {
        throw new EnkryptSyncError('timeout', { httpStatus });
      }
      continue;
    }
    throw new EnkryptSyncError(
      httpStatus === 401 || httpStatus === 403
        ? 'authentication'
        : httpStatus === 429
          ? 'rate_limited'
          : 'upstream',
      { httpStatus }
    );
  }
  throw new EnkryptSyncError('unexpected');
}

export async function syncEnkryptBenchmarks(): Promise<SyncEnkryptResult> {
  if (!ENKRYPT_SYNC_ENABLED) return { status: 'disabled' };
  if (!ENKRYPT_API_KEY?.trim()) throw new EnkryptSyncError('configuration');

  const attemptAt = new Date().toISOString();
  const attemptId = randomUUID();
  let stage: EnkryptFailureCategory = 'database';
  let counts: EnkryptSyncCounts | undefined;

  try {
    const [started] = await db
      .insert(enkrypt_sync_state)
      .values({
        job_name: 'enkrypt',
        attempt_id: attemptId,
        last_attempt_at: attemptAt,
        last_outcome: 'running',
      })
      .onConflictDoUpdate({
        target: enkrypt_sync_state.job_name,
        set: {
          attempt_id: attemptId,
          last_attempt_at: attemptAt,
          last_completed_at: null,
          last_outcome: 'running',
          last_failure_category: null,
          last_counts: null,
        },
        setWhere: sql`${enkrypt_sync_state.last_attempt_at} IS NULL OR ${enkrypt_sync_state.last_attempt_at} <= ${attemptAt}::timestamptz`,
      })
      .returning({ attemptId: enkrypt_sync_state.attempt_id });
    if (!started) throw new EnkryptSyncError('superseded');

    stage = 'unexpected';
    const value = await fetchScores(ENKRYPT_API_KEY);
    stage = 'response_validation';
    const parsed = parseEnkryptScores(value);
    counts = {
      fetchedCount: parsed.fetchedCount,
      rejectedCount: parsed.rejectedCount,
      matchedCount: 0,
      unmatchedCount: 0,
      ambiguousCount: 0,
      updatedCount: 0,
    };
    if (parsed.scores.length === 0) throw new EnkryptSyncError('coverage', { counts });

    stage = 'database';
    const models = await db
      .select({
        id: modelStats.id,
        openrouterId: modelStats.openrouterId,
        isActive: modelStats.isActive,
        isStealth: modelStats.isStealth,
      })
      .from(modelStats)
      .where(and(eq(modelStats.isActive, true), eq(modelStats.isStealth, false)));
    stage = 'unexpected';
    const matched = matchEnkryptScores(parsed.scores, models);
    counts.matchedCount = matched.matches.length;
    counts.unmatchedCount = matched.unmatchedRecords.length;
    counts.ambiguousCount = matched.ambiguousCount;
    if (matched.matches.length === 0 || matched.missingRequiredModelIds.length > 0) {
      throw new EnkryptSyncError('coverage', { counts });
    }

    stage = 'database';
    const acceptedCounts = counts;
    return await db.transaction(async tx => {
      const [state] = await tx
        .select()
        .from(enkrypt_sync_state)
        .where(eq(enkrypt_sync_state.job_name, 'enkrypt'))
        .for('update');
      if (!state || state.attempt_id !== attemptId) {
        throw new EnkryptSyncError('superseded', { counts: acceptedCounts });
      }
      if (
        state.baseline_matched_count !== null &&
        acceptedCounts.matchedCount < state.baseline_matched_count * 0.8
      ) {
        throw new EnkryptSyncError('coverage', { counts: acceptedCounts });
      }

      const ingestedAt = new Date().toISOString();
      let updatedCount = 0;
      for (const { model, score } of matched.matches) {
        const snapshot: EnkryptBenchmark = { ...score, ingestedAt, evaluatedAt: null };
        const updated = await tx
          .update(modelStats)
          .set({
            benchmarks: sql`COALESCE(${modelStats.benchmarks}, '{}'::jsonb) || ${JSON.stringify({ enkrypt: snapshot })}::jsonb`,
          })
          .where(
            and(
              eq(modelStats.id, model.id),
              eq(modelStats.openrouterId, model.openrouterId),
              eq(modelStats.isActive, true),
              eq(modelStats.isStealth, false)
            )
          )
          .returning({ id: modelStats.id });
        updatedCount += updated.length;
      }
      if (updatedCount !== acceptedCounts.matchedCount) {
        throw new EnkryptSyncError('coverage', { counts: acceptedCounts });
      }
      const successCounts: EnkryptSyncCounts = { ...acceptedCounts, updatedCount };
      await tx
        .update(enkrypt_sync_state)
        .set({
          last_outcome: 'succeeded',
          last_completed_at: ingestedAt,
          last_success_at: ingestedAt,
          last_failure_category: null,
          last_counts: successCounts,
          last_success_counts: successCounts,
          baseline_matched_count: Math.max(
            state.baseline_matched_count ?? 0,
            acceptedCounts.matchedCount
          ),
          last_alert_at: null,
          last_alert_reason: null,
        })
        .where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
      return { status: 'succeeded', ...successCounts, ingestedAt };
    });
  } catch (error) {
    const failure =
      error instanceof EnkryptSyncError
        ? new EnkryptSyncError(error.category, {
            counts: error.counts ?? counts,
            httpStatus: error.httpStatus,
          })
        : new EnkryptSyncError(stage, { counts });
    try {
      const failed = await db
        .update(enkrypt_sync_state)
        .set({
          last_outcome: 'failed',
          last_completed_at: new Date().toISOString(),
          last_failure_category: failure.category,
          last_counts: failure.counts ?? null,
        })
        .where(
          and(
            eq(enkrypt_sync_state.job_name, 'enkrypt'),
            eq(enkrypt_sync_state.attempt_id, attemptId),
            eq(enkrypt_sync_state.last_outcome, 'running')
          )
        )
        .returning({ attemptId: enkrypt_sync_state.attempt_id });
      if (failed.length === 0) {
        const [completed] = await db
          .select({
            counts: enkrypt_sync_state.last_success_counts,
            ingestedAt: enkrypt_sync_state.last_success_at,
          })
          .from(enkrypt_sync_state)
          .where(
            and(
              eq(enkrypt_sync_state.job_name, 'enkrypt'),
              eq(enkrypt_sync_state.attempt_id, attemptId),
              eq(enkrypt_sync_state.last_outcome, 'succeeded')
            )
          );
        const committedCounts = EnkryptSyncCountsSchema.safeParse(completed?.counts);
        if (
          committedCounts.success &&
          committedCounts.data.updatedCount > 0 &&
          committedCounts.data.updatedCount === committedCounts.data.matchedCount &&
          completed?.ingestedAt &&
          Number.isFinite(Date.parse(completed.ingestedAt))
        ) {
          return {
            status: 'succeeded',
            ...committedCounts.data,
            ingestedAt: new Date(completed.ingestedAt).toISOString(),
          };
        }
      }
    } catch {
      throw new EnkryptSyncError('database', { counts: failure.counts });
    }
    throw failure;
  }
}
