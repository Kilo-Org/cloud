/**
 * Agent scheduling and dispatch for the Town DO alarm loop.
 *
 * Owns the core dispatch/retry logic that was previously inline in
 * Town.do.ts. The Town DO delegates to these pure(ish) functions,
 * passing its SQL handle and env bindings.
 */

import * as Sentry from '@sentry/cloudflare';
import { beads } from '../../db/tables/beads.table';
import { agent_metadata } from '../../db/tables/agent-metadata.table';
import { query } from '../../util/query.util';
import * as beadOps from './beads';
import * as agents from './agents';
import * as rigs from './rigs';
import * as dispatch from './container-dispatch';
import * as patrol from './patrol';
import type { Agent, Bead, TownConfig } from '../../types';
import type { GastownEventData } from '../../util/analytics.util';

const LOG = '[scheduling]';

// ── Constants ──────────────────────────────────────────────────────────

export const DISPATCH_COOLDOWN_MS = 30_000; // 30 sec
export const MAX_DISPATCH_ATTEMPTS = 5;

// ── Context passed by the Town DO ──────────────────────────────────────

type SchedulingContext = {
  sql: SqlStorage;
  env: Env;
  storage: DurableObjectStorage;
  townId: string;
  getTownConfig: () => Promise<TownConfig>;
  getRigConfig: (rigId: string) => Promise<RigConfig | null>;
  resolveKilocodeToken: () => Promise<string | undefined>;
  emitEvent: (data: Omit<GastownEventData, 'userId' | 'delivery'>) => void;
};

type RigConfig = {
  townId: string;
  rigId: string;
  gitUrl: string;
  defaultBranch: string;
  userId: string;
  kilocodeToken?: string;
  platformIntegrationId?: string;
  merge_strategy?: string;
};

function now(): string {
  return new Date().toISOString();
}

// ── dispatchAgent ──────────────────────────────────────────────────────

/**
 * Dispatch a single agent to the container. Transitions the bead to
 * in_progress and the agent to working BEFORE the async network call
 * (I/O gate safety for fire-and-forget callers). Returns true if the
 * container accepted the agent.
 */
export async function dispatchAgent(
  ctx: SchedulingContext,
  agent: Agent,
  bead: Bead,
  options?: { systemPromptOverride?: string }
): Promise<boolean> {
  try {
    const rigId = agent.rig_id ?? rigs.listRigs(ctx.sql)[0]?.id ?? '';
    const rigConfig = rigId ? await ctx.getRigConfig(rigId) : null;
    if (!rigConfig) {
      console.warn(`${LOG} dispatchAgent: no rig config for agent=${agent.id} rig=${rigId}`);
      return false;
    }

    const townConfig = await ctx.getTownConfig();
    const kilocodeToken = await ctx.resolveKilocodeToken();

    const convoyId = beadOps.getConvoyForBead(ctx.sql, bead.bead_id);
    const convoyFeatureBranch = convoyId ? beadOps.getConvoyFeatureBranch(ctx.sql, convoyId) : null;

    // Transition bead to in_progress BEFORE the async container start.
    // Must happen synchronously within the I/O gate — fire-and-forget
    // callers (slingBead, slingConvoy) close the gate before the
    // network call completes.
    const currentBead = beadOps.getBead(ctx.sql, bead.bead_id);
    if (
      currentBead &&
      currentBead.status !== 'in_progress' &&
      currentBead.status !== 'closed' &&
      currentBead.status !== 'failed'
    ) {
      beadOps.updateBeadStatus(ctx.sql, bead.bead_id, 'in_progress', agent.id);
    }

    // Set agent to 'working' BEFORE the async container start (same
    // I/O gate rationale).
    const timestamp = now();
    query(
      ctx.sql,
      /* sql */ `
        UPDATE ${agent_metadata}
        SET ${agent_metadata.columns.status} = 'working',
            ${agent_metadata.columns.dispatch_attempts} = ${agent_metadata.columns.dispatch_attempts} + 1,
            ${agent_metadata.columns.last_activity_at} = ?,
            ${agent_metadata.columns.last_event_at} = NULL,
            ${agent_metadata.columns.last_event_type} = NULL
        WHERE ${agent_metadata.bead_id} = ?
      `,
      [timestamp, agent.id]
    );
    // Track dispatch attempts on the bead itself so the counter
    // survives agent re-creation and hookBead cycles.
    query(
      ctx.sql,
      /* sql */ `
        UPDATE ${beads}
        SET ${beads.columns.dispatch_attempts} = ${beads.columns.dispatch_attempts} + 1,
            ${beads.columns.last_dispatch_attempt_at} = ?
        WHERE ${beads.bead_id} = ?
      `,
      [timestamp, bead.bead_id]
    );

    const rigRecord = rigs.getRig(ctx.sql, rigId);

    const { started, containerFetchMs } = await dispatch.startAgentInContainer(
      ctx.env,
      ctx.storage,
      {
        townId: ctx.townId,
        rigId,
        userId: rigConfig.userId,
        agentId: agent.id,
        agentName: agent.name,
        role: agent.role,
        identity: agent.identity,
        beadId: bead.bead_id,
        beadTitle: bead.title,
        beadBody: bead.body ?? '',
        checkpoint: agent.checkpoint,
        gitUrl: rigConfig.gitUrl,
        defaultBranch: rigConfig.defaultBranch,
        kilocodeToken,
        townConfig,
        rigOverride: rigRecord?.config ?? null,
        platformIntegrationId: rigConfig.platformIntegrationId,
        convoyFeatureBranch: convoyFeatureBranch ?? undefined,
        systemPromptOverride: options?.systemPromptOverride,
      }
    );

    if (started) {
      // Reset dispatch_attempts on successful start — but NOT for refineries.
      // Refineries can loop (idle-timeout → re-dispatch) many times on the
      // same MR bead, so we keep the counter monotonically increasing until
      // the bead is closed or the agent hooks a new bead (#1342).
      if (agent.role !== 'refinery') {
        query(
          ctx.sql,
          /* sql */ `
            UPDATE ${agent_metadata}
            SET ${agent_metadata.columns.dispatch_attempts} = 0
            WHERE ${agent_metadata.bead_id} = ?
          `,
          [agent.id]
        );
      }
      console.log(`${LOG} dispatchAgent: started agent=${agent.name}(${agent.id})`);
      ctx.emitEvent({
        event: 'agent.spawned',
        townId: ctx.townId,
        rigId,
        agentId: agent.id,
        beadId: bead.bead_id,
        role: agent.role,
        durationMs: containerFetchMs,
      });
    } else {
      // Container start returned false — but the container may have
      // actually started the agent (timeout race). Leave the agent
      // as 'working' so the reconciler doesn't treat it as lost.
      // If the agent truly didn't start: reconcileAgents catches it
      // after 90s of missing heartbeats and transitions to 'idle'.
      // If the agent actually started: heartbeats keep it alive. (#1358)
      ctx.emitEvent({
        event: 'agent.dispatch_failed',
        townId: ctx.townId,
        rigId,
        agentId: agent.id,
        beadId: bead.bead_id,
        role: agent.role,
        reason: 'container returned false',
      });
    }
    return started;
  } catch (err) {
    console.error(`${LOG} dispatchAgent: failed for agent=${agent.id}:`, err);
    Sentry.captureException(err, {
      extra: { agentId: agent.id, beadId: bead.bead_id },
    });
    try {
      query(
        ctx.sql,
        /* sql */ `
          UPDATE ${agent_metadata}
          SET ${agent_metadata.columns.status} = 'idle',
              ${agent_metadata.columns.last_activity_at} = ?
          WHERE ${agent_metadata.bead_id} = ?
        `,
        [now(), agent.id]
      );
      // Don't roll back bead to open — same timeout race rationale
    } catch (rollbackErr) {
      console.error(`${LOG} dispatchAgent: rollback also failed:`, rollbackErr);
    }
    ctx.emitEvent({
      event: 'agent.dispatch_failed',
      townId: ctx.townId,
      agentId: agent.id,
      beadId: bead.bead_id,
      role: agent.role,
      reason: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ── dispatchUnblockedBeads ─────────────────────────────────────────────

/**
 * When a bead closes, find beads that were blocked by it and are now
 * fully unblocked. Dispatch their assigned agents (fire-and-forget).
 */
export function dispatchUnblockedBeads(ctx: SchedulingContext, closedBeadId: string): void {
  const unblockedIds = beadOps.getNewlyUnblockedBeads(ctx.sql, closedBeadId);
  if (unblockedIds.length === 0) return;

  console.log(
    `${LOG} dispatchUnblockedBeads: ${unblockedIds.length} beads unblocked by ${closedBeadId}`
  );

  for (const beadId of unblockedIds) {
    const bead = beadOps.getBead(ctx.sql, beadId);
    if (!bead || bead.status === 'closed' || bead.status === 'failed') continue;

    if (!bead.assignee_agent_bead_id) continue;
    const agent = agents.getAgent(ctx.sql, bead.assignee_agent_bead_id);
    if (!agent || agent.status !== 'idle') continue;

    dispatchAgent(ctx, agent, bead).catch(err =>
      console.error(
        `${LOG} dispatchUnblockedBeads: fire-and-forget dispatch failed for bead=${beadId}`,
        err
      )
    );
  }
}

// ── hasActiveWork ──────────────────────────────────────────────────────

/**
 * Returns true if the town has work that requires the fast (5s) alarm
 * interval. Used to decide between active and idle alarm cadence.
 */
export function hasActiveWork(sql: SqlStorage): boolean {
  // Stalled agents older than 30min no longer count as active work: they
  // typically represent stuck rows (container crashed hard, /status keeps
  // returning running/unknown). Keeping them in the active set would pin
  // the alarm at its 5s fast cadence indefinitely. The stalled->idle
  // auto-transition in reconcileAgents cleans them up after 2h 30min.
  const activeAgentRows = [
    ...query(
      sql,
      /* sql */ `SELECT COUNT(*) as cnt FROM ${agent_metadata}
        WHERE ${agent_metadata.status} = 'working'
           OR (${agent_metadata.status} = 'stalled'
               AND ${agent_metadata.last_activity_at} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes'))`,
      []
    ),
  ];
  const pendingBeadRows = [
    ...query(
      sql,
      /* sql */ `SELECT COUNT(*) as cnt FROM ${agent_metadata} WHERE ${agent_metadata.status} = 'idle' AND ${agent_metadata.current_hook_bead_id} IS NOT NULL`,
      []
    ),
  ];
  const pendingReviewRows = [
    ...query(
      sql,
      /* sql */ `SELECT COUNT(*) as cnt FROM ${beads} WHERE ${beads.type} = 'merge_request' AND ${beads.status} IN ('open', 'in_progress')`,
      []
    ),
  ];
  const pendingTriageRows = [
    ...query(
      sql,
      /* sql */ `SELECT COUNT(*) as cnt FROM ${beads} WHERE ${beads.type} = 'issue' AND ${beads.labels} LIKE ? AND ${beads.status} = 'open'`,
      [patrol.TRIAGE_LABEL_LIKE]
    ),
  ];
  // Open issue beads with a rig (eligible for dispatch by reconcileBeads Rule 1)
  // but not yet assigned to any agent. Without this check, the alarm drops to
  // idle cadence after a container restart when agents lose their hooks and
  // beads revert to open+unassigned, delaying dispatch by up to 5 minutes.
  const unassignedIssueRows = [
    ...query(
      sql,
      /* sql */ `SELECT COUNT(*) as cnt FROM ${beads} WHERE ${beads.type} = 'issue' AND ${beads.status} = 'open' AND ${beads.rig_id} IS NOT NULL AND ${beads.assignee_agent_bead_id} IS NULL`,
      []
    ),
  ];
  return (
    Number(activeAgentRows[0]?.cnt ?? 0) > 0 ||
    Number(pendingBeadRows[0]?.cnt ?? 0) > 0 ||
    Number(pendingReviewRows[0]?.cnt ?? 0) > 0 ||
    Number(pendingTriageRows[0]?.cnt ?? 0) > 0 ||
    Number(unassignedIssueRows[0]?.cnt ?? 0) > 0
  );
}
