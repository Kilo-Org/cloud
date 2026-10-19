import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  security_findings,
  security_analysis_owner_state,
  security_analysis_queue,
} from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import type { SecurityReviewOwner } from '../core/types';
import {
  releaseAnalysisStartReservation,
  tryReserveAnalysisRestartSlot,
  tryReserveAnalysisStartSlot,
} from './security-analysis';
import { SECURITY_ANALYSIS_OWNER_CAP } from '../core/constants';
let owner: SecurityReviewOwner;
let userId: string;
const findingIds: string[] = [];

async function insertFinding(overrides: {
  analysisStatus?: 'pending' | 'running' | 'completed' | 'failed' | null;
  status?: 'open' | 'fixed' | 'ignored';
  organizationId?: string;
}): Promise<string> {
  const [row] = await db
    .insert(security_findings)
    .values({
      owned_by_user_id: overrides.organizationId ? null : userId,
      owned_by_organization_id: overrides.organizationId ?? null,
      repo_full_name: 'test-org/reservation-repo',
      source: 'dependabot',
      source_id: randomUUID(),
      severity: 'high',
      package_name: 'lodash',
      package_ecosystem: 'npm',
      title: 'Prototype Pollution in lodash',
      status: overrides.status ?? 'open',
      analysis_status: overrides.analysisStatus ?? null,
    })
    .returning({ id: security_findings.id });
  if (!row) throw new Error('Finding insert returned no row');
  findingIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const user = await insertTestUser();
  userId = user.id;
  owner = { userId: user.id };
});

afterEach(async () => {
  if (findingIds.length > 0) {
    const ids = findingIds.splice(0, findingIds.length);
    await db
      .delete(security_analysis_queue)
      .where(inArray(security_analysis_queue.finding_id, ids));
    await db.delete(security_findings).where(inArray(security_findings.id, ids));
  }
  await db
    .delete(security_analysis_owner_state)
    .where(eq(security_analysis_owner_state.owned_by_user_id, userId));
});

afterAll(async () => {
  // The shared workerSetup afterAll closes connections via
  // closeAllDrizzleConnections(); no per-file pool.end here.
});

describe('tryReserveAnalysisStartSlot', () => {
  it('reserves a slot and flips the finding to pending', async () => {
    const findingId = await insertFinding({});

    const reservation = await tryReserveAnalysisStartSlot(owner, findingId);

    expect(reservation).toEqual({ reserved: true });
    const [row] = await db
      .select({ analysisStatus: security_findings.analysis_status })
      .from(security_findings)
      .where(eq(security_findings.id, findingId));
    expect(row.analysisStatus).toBe('pending');
  });

  it('rejects with cap when the owner is at the concurrent limit and leaves the finding untouched', async () => {
    for (let i = 0; i < SECURITY_ANALYSIS_OWNER_CAP; i += 1) {
      await insertFinding({ analysisStatus: 'running' });
    }
    const findingId = await insertFinding({});

    const reservation = await tryReserveAnalysisStartSlot(owner, findingId);

    expect(reservation).toMatchObject({ reserved: false, reason: 'cap' });
    if (!reservation.reserved && reservation.reason === 'cap') {
      expect(reservation.currentCount).toBe(SECURITY_ANALYSIS_OWNER_CAP);
      expect(reservation.limit).toBe(SECURITY_ANALYSIS_OWNER_CAP);
    }
    const [row] = await db
      .select({ analysisStatus: security_findings.analysis_status })
      .from(security_findings)
      .where(eq(security_findings.id, findingId));
    expect(row.analysisStatus).toBeNull();
  });

  it('serializes parallel reservations so the owner count never exceeds the cap', async () => {
    // One slot in use; cap 3 → exactly two more reservations can win.
    await insertFinding({ analysisStatus: 'running' });
    const first = await insertFinding({});
    const second = await insertFinding({});
    const third = await insertFinding({});

    const results = await Promise.all([
      tryReserveAnalysisStartSlot(owner, first),
      tryReserveAnalysisStartSlot(owner, second),
      tryReserveAnalysisStartSlot(owner, third),
    ]);

    const reserved = results.filter(result => result.reserved);
    const rejected = results.filter(result => !result.reserved);
    expect(reserved).toHaveLength(SECURITY_ANALYSIS_OWNER_CAP - 1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reserved: false, reason: 'cap' });

    const inflight = await db
      .select({ id: security_findings.id })
      .from(security_findings)
      .where(
        and(
          eq(security_findings.owned_by_user_id, userId),
          inArray(security_findings.analysis_status, ['pending', 'running'])
        )
      );
    // 1 pre-seeded running + the reservations that won.
    expect(inflight).toHaveLength(SECURITY_ANALYSIS_OWNER_CAP);
  });

  it('rejects a same-finding concurrent reservation exactly once', async () => {
    const findingId = await insertFinding({});

    const results = await Promise.all([
      tryReserveAnalysisStartSlot(owner, findingId),
      tryReserveAnalysisStartSlot(owner, findingId),
    ]);

    const reserved = results.filter(result => result.reserved);
    const lost = results.filter(result => !result.reserved);
    expect(reserved).toHaveLength(1);
    expect(lost).toEqual([{ reserved: false, reason: 'in_progress' }]);
  });

  it('rejects with in_progress when the finding already has a live analysis', async () => {
    const findingId = await insertFinding({ analysisStatus: 'running' });

    const reservation = await tryReserveAnalysisStartSlot(owner, findingId);

    expect(reservation).toEqual({ reserved: false, reason: 'in_progress' });
  });

  it('takes the lease from a failed previous analysis', async () => {
    const findingId = await insertFinding({ analysisStatus: 'failed' });

    const reservation = await tryReserveAnalysisStartSlot(owner, findingId);

    expect(reservation).toEqual({ reserved: true });
  });
});

describe('tryReserveAnalysisRestartSlot', () => {
  it('allows a restart below the cap and writes no state', async () => {
    const restarted = await insertFinding({ analysisStatus: 'running' });
    for (let i = 0; i < SECURITY_ANALYSIS_OWNER_CAP - 1; i += 1) {
      await insertFinding({ analysisStatus: 'running' });
    }

    const reservation = await tryReserveAnalysisRestartSlot(owner, restarted);

    expect(reservation).toEqual({ reserved: true });
    const [row] = await db
      .select({ analysisStatus: security_findings.analysis_status })
      .from(security_findings)
      .where(eq(security_findings.id, restarted));
    expect(row.analysisStatus).toBe('running');
  });

  it('rejects a restart when the other inflight findings fill the cap', async () => {
    const restarted = await insertFinding({ analysisStatus: 'running' });
    for (let i = 0; i < SECURITY_ANALYSIS_OWNER_CAP; i += 1) {
      await insertFinding({ analysisStatus: 'running' });
    }

    const reservation = await tryReserveAnalysisRestartSlot(owner, restarted);

    expect(reservation).toMatchObject({ reserved: false, reason: 'cap' });
    if (!reservation.reserved && reservation.reason === 'cap') {
      expect(reservation.currentCount).toBe(SECURITY_ANALYSIS_OWNER_CAP);
    }
  });

  it('serializes restart validation against parallel slot reservations', async () => {
    // Cap 3: one running + one pending reservation leaves no room; a restart
    // started concurrently with the reservation must observe one of the two
    // outcomes, never both passing with four inflight.
    await insertFinding({ analysisStatus: 'running' });
    const restarted = await insertFinding({ analysisStatus: 'running' });
    const starting = await insertFinding({});

    const [restartResult, startResult] = await Promise.all([
      tryReserveAnalysisRestartSlot(owner, restarted),
      tryReserveAnalysisStartSlot(owner, starting),
    ]);

    // Both reserve at most one slot each on top of the two running rows, so
    // the total stays at or below the cap.
    const [inflightRow] = await db
      .select({ analysisStatus: security_findings.analysis_status })
      .from(security_findings)
      .where(eq(security_findings.id, starting));
    if (startResult.reserved) {
      expect(inflightRow.analysisStatus).toBe('pending');
    } else {
      expect(startResult).toMatchObject({ reserved: false });
    }
    expect(restartResult.reserved).toBe(true);
  });

  it('admits every sequential restart of the same running finding without consuming extra slots', async () => {
    const restarted = await insertFinding({ analysisStatus: 'running' });

    for (let i = 0; i < 5; i += 1) {
      await expect(tryReserveAnalysisRestartSlot(owner, restarted)).resolves.toEqual({
        reserved: true,
      });
    }

    const [row] = await db
      .select({ analysisStatus: security_findings.analysis_status })
      .from(security_findings)
      .where(eq(security_findings.id, restarted));
    expect(row.analysisStatus).toBe('running');

    const inflight = await db
      .select({ id: security_findings.id })
      .from(security_findings)
      .where(
        and(
          eq(security_findings.owned_by_user_id, userId),
          inArray(security_findings.analysis_status, ['pending', 'running'])
        )
      );
    expect(inflight).toHaveLength(1);
  });
});

describe('releaseAnalysisStartReservation', () => {
  it('clears a pending reservation and restores the finding to startable state', async () => {
    const findingId = await insertFinding({});

    await tryReserveAnalysisStartSlot(owner, findingId);
    await releaseAnalysisStartReservation(findingId);

    const [row] = await db
      .select({ analysisStatus: security_findings.analysis_status })
      .from(security_findings)
      .where(eq(security_findings.id, findingId));
    expect(row.analysisStatus).toBeNull();
  });

  it('leaves the finding alone when a queue row owns it', async () => {
    const findingId = await insertFinding({});
    await tryReserveAnalysisStartSlot(owner, findingId);
    await db.insert(security_analysis_queue).values({
      finding_id: findingId,
      owned_by_user_id: userId,
      queue_status: 'pending',
      severity_rank: 1,
      claim_token: randomUUID(),
      queued_at: new Date().toISOString(),
      claimed_at: new Date().toISOString(),
      claimed_by_job_id: 'test-job',
    });

    await releaseAnalysisStartReservation(findingId);

    const [row] = await db
      .select({ analysisStatus: security_findings.analysis_status })
      .from(security_findings)
      .where(eq(security_findings.id, findingId));
    expect(row.analysisStatus).toBe('pending');
  });

  it('does not clear a running analysis', async () => {
    const findingId = await insertFinding({ analysisStatus: 'running' });

    await releaseAnalysisStartReservation(findingId);

    const [row] = await db
      .select({ analysisStatus: security_findings.analysis_status })
      .from(security_findings)
      .where(eq(security_findings.id, findingId));
    expect(row.analysisStatus).toBe('running');
  });
});
