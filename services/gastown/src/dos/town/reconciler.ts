/**
 * Town Reconciler — read-only state reconciliation engine.
 *
 * Each reconcile function examines current state and returns Action[]
 * describing what mutations are needed to bring the system toward its
 * desired state. Rules are checked on every alarm tick.
 *
 * In Phase 2 (shadow mode), actions are logged but not applied.
 * In Phase 3+, actions are applied via applyAction().
 *
 * See reconciliation-spec.md §5.3.
 */

import { z } from 'zod';
import { beads, BeadRecord } from '../../db/tables/beads.table';
import { agent_metadata, AgentMetadataRecord } from '../../db/tables/agent-metadata.table';
import { review_metadata, ReviewMetadataRecord } from '../../db/tables/review-metadata.table';
import { convoy_metadata, ConvoyMetadataRecord } from '../../db/tables/convoy-metadata.table';
import { bead_dependencies } from '../../db/tables/bead-dependencies.table';
import { agent_nudges } from '../../db/tables/agent-nudges.table';
import { escalation_metadata } from '../../db/tables/escalation-metadata.table';
import { query } from '../../util/query.util';
import {
  GUPP_ESCALATE_MS,
  GUPP_FORCE_STOP_MS,
  AGENT_GC_RETENTION_MS,
  TRIAGE_LABEL_LIKE,
  createTriageRequest,
} from './patrol';
import { MAX_DISPATCH_ATTEMPTS } from './scheduling';
import * as reviewQueue from './review-queue';
import * as agents from './agents';
import * as beadOps from './beads';
import { getRig } from './rigs';
import { resolveRigConfig } from './config';
import { PR_POLL_INTERVAL_MS } from './actions';
import type { Action } from './actions';
import type { TownEventRecord } from '../../db/tables/town-events.table';
import type { TownConfig } from '../../types';

const LOG = '[reconciler]';

// ── Circuit breaker ─────────────────────────────────────────────────

/** Number of dispatch failures in a 30-min window to trip the town-level breaker. */
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 20;
/** Window in minutes for counting dispatch failures. */
const CIRCUIT_BREAKER_WINDOW_MINUTES = 30;

/** Max landing MR creation attempts before failing the convoy (#2260). */
const MAX_LANDING_MR_ATTEMPTS = 5;

/** Base cooldown for landing MR retry: min(2^attempts * BASE, MAX) (#2260). */
const LANDING_MR_COOLDOWN_BASE_MS = 30_000; // 30s

/** Max cooldown for landing MR retry (#2260). */
const LANDING_MR_COOLDOWN_MAX_MS = 30 * 60_000; // 30 min

/**
 * Town-level dispatch circuit breaker. Counts beads with at least one
 * dispatch attempt in the recent window that have not yet closed
 * successfully. This captures beads in active retry loops (in_progress
 * after a failed container start), beads that have been explicitly
 * failed, and beads that exhausted all attempts — while excluding
 * beads that eventually succeeded (status = 'closed').
 */
function checkDispatchCircuitBreaker(sql: SqlStorage): Action[] {
  const rows = z
    .object({ failure_count: z.number() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
          SELECT count(*) as failure_count
          FROM ${beads}
          WHERE ${beads.last_dispatch_attempt_at} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${CIRCUIT_BREAKER_WINDOW_MINUTES} minutes')
            AND ${beads.dispatch_attempts} > 0
            AND ${beads.status} != 'closed'
        `,
        []
      ),
    ]);

  const failureCount = rows[0]?.failure_count ?? 0;
  if (failureCount >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    console.warn(
      `${LOG} circuit breaker OPEN: ${failureCount} dispatch failures in last ${CIRCUIT_BREAKER_WINDOW_MINUTES}min (threshold=${CIRCUIT_BREAKER_FAILURE_THRESHOLD})`
    );
    return [
      {
        type: 'notify_mayor',
        message: `Dispatch circuit breaker is OPEN: ${failureCount} dispatch failures in the last ${CIRCUIT_BREAKER_WINDOW_MINUTES} minutes. All dispatch actions are paused until failures clear.`,
      },
    ];
  }
  return [];
}

// ── Timeouts (from spec §7) ─────────────────────────────────────────

/** Reset non-PR MR beads stuck in_progress with no working agent */
const STUCK_REVIEW_TIMEOUT_MS = 30 * 60_000; // 30 min

/** Reset unhooked MR beads to open */
const ABANDONED_MR_TIMEOUT_MS = 2 * 60_000; // 2 min

/** Reset in_review beads with all-terminal MRs */
const ORPHANED_SOURCE_TIMEOUT_MS = 5 * 60_000; // 5 min

/** Fail PR-strategy beads with dead agents */
const ORPHANED_PR_REVIEW_TIMEOUT_MS = 30 * 60_000; // 30 min

/** In-progress issue bead with no working agent considered stale.
 * Must be longer than AGENT_IDLE_TIMEOUT_MS (2 min) + one alarm tick (5s)
 * to avoid racing with the idle-timer → agentCompleted → reconciler flow. */
const STALE_IN_PROGRESS_TIMEOUT_MS = 5 * 60_000; // 5 min

// ── Helper: staleness check ─────────────────────────────────────────

function staleMs(timestamp: string | null, thresholdMs: number): boolean {
  if (!timestamp) return true;
  return Date.now() - new Date(timestamp).getTime() > thresholdMs;
}

/**
 * Compute the dispatch cooldown for a bead based on its attempt count.
 * Implements exponential backoff:
 *   attempts 1-2: 2 min (DISPATCH_COOLDOWN_MS)
 *   attempt 3:    5 min
 *   attempt 4:   10 min
 *   attempt 5+:  30 min
 */
function getDispatchCooldownMs(dispatchAttempts: number): number {
  if (dispatchAttempts <= 1) return 30_000; // 30 sec
  if (dispatchAttempts === 2) return 60_000; // 1 min
  if (dispatchAttempts === 3) return 2 * 60_000; // 2 min
  if (dispatchAttempts === 4) return 5 * 60_000; // 5 min
  return 10 * 60_000; // 10 min
}

// ── Row schemas for queries ─────────────────────────────────────────
// Derived from table record schemas for traceability back to table defs.

const AgentRow = AgentMetadataRecord.pick({
  bead_id: true,
  role: true,
  status: true,
  current_hook_bead_id: true,
  dispatch_attempts: true,
  last_activity_at: true,
  last_event_type: true,
  last_event_at: true,
  active_tools: true,
}).extend({
  // Joined from beads table
  rig_id: BeadRecord.shape.rig_id,
});
type AgentRow = z.infer<typeof AgentRow>;

const BeadRow = BeadRecord.pick({
  bead_id: true,
  type: true,
  status: true,
  rig_id: true,
  assignee_agent_bead_id: true,
  updated_at: true,
  labels: true,
  created_by: true,
  dispatch_attempts: true,
  last_dispatch_attempt_at: true,
});
type BeadRow = z.infer<typeof BeadRow>;

const MrBeadRow = BeadRecord.pick({
  bead_id: true,
  status: true,
  rig_id: true,
  updated_at: true,
  assignee_agent_bead_id: true,
  metadata: true,
}).extend({
  // Joined from review_metadata
  pr_url: ReviewMetadataRecord.shape.pr_url,
});
type MrBeadRow = z.infer<typeof MrBeadRow>;

const ConvoyRow = BeadRecord.pick({
  bead_id: true,
  status: true,
}).extend({
  // Joined from convoy_metadata
  total_beads: ConvoyMetadataRecord.shape.total_beads,
  closed_beads: ConvoyMetadataRecord.shape.closed_beads,
  feature_branch: ConvoyMetadataRecord.shape.feature_branch,
  merge_mode: ConvoyMetadataRecord.shape.merge_mode,
  staged: ConvoyMetadataRecord.shape.staged,
  // Raw JSON string from beads.metadata
  metadata: z.string(),
});
type ConvoyRow = z.infer<typeof ConvoyRow>;

// ════════════════════════════════════════════════════════════════════
// Event application — translates facts into state transitions
// ════════════════════════════════════════════════════════════════════

/**
 * Apply a single event to the database. Events represent facts that
 * have occurred; applying them updates state to reflect those facts.
 *
 * Delegates to existing module functions to ensure identical behavior
 * to the pre-reconciler system.
 *
 * See reconciliation-spec.md §5.2.
 */
export function applyEvent(
  sql: SqlStorage,
  event: TownEventRecord,
  opts?: { townConfig?: TownConfig }
): void {
  const payload = event.payload;

  switch (event.event_type) {
    case 'agent_done': {
      if (!event.agent_id) {
        console.warn(`${LOG} applyEvent: agent_done missing agent_id`);
        return;
      }
      const branch = typeof payload.branch === 'string' ? payload.branch : '';
      const pr_url = typeof payload.pr_url === 'string' ? payload.pr_url : undefined;
      const summary = typeof payload.summary === 'string' ? payload.summary : undefined;

      reviewQueue.agentDone(sql, event.agent_id, { branch, pr_url, summary });
      return;
    }

    case 'agent_completed': {
      if (!event.agent_id) {
        console.warn(`${LOG} applyEvent: agent_completed missing agent_id`);
        return;
      }
      const status =
        payload.status === 'completed' || payload.status === 'failed' ? payload.status : 'failed';
      const reason = typeof payload.reason === 'string' ? payload.reason : undefined;

      reviewQueue.agentCompleted(sql, event.agent_id, { status, reason });
      return;
    }

    case 'pr_status_changed': {
      if (!event.bead_id) {
        console.warn(`${LOG} applyEvent: pr_status_changed missing bead_id`);
        return;
      }
      const pr_state = payload.pr_state;
      if (pr_state === 'merged') {
        reviewQueue.completeReviewWithResult(sql, {
          entry_id: event.bead_id,
          status: 'merged',
          message: 'PR merged (detected by polling)',
        });
      } else if (pr_state === 'closed') {
        reviewQueue.completeReviewWithResult(sql, {
          entry_id: event.bead_id,
          status: 'failed',
          message: 'PR closed without merge',
        });
      }
      return;
    }

    case 'bead_created': {
      // No state change needed — bead already exists in DB.
      // Reconciler will pick it up as unassigned on next pass.
      return;
    }

    case 'bead_cancelled': {
      if (!event.bead_id) {
        console.warn(`${LOG} applyEvent: bead_cancelled missing bead_id`);
        return;
      }
      const cancelStatus =
        payload.cancel_status === 'closed' || payload.cancel_status === 'failed'
          ? payload.cancel_status
          : 'failed';

      beadOps.updateBeadStatus(sql, event.bead_id, cancelStatus, 'system');

      // Unhook any agent hooked to this bead
      const hookedAgentRows = z
        .object({ bead_id: z.string() })
        .array()
        .parse([
          ...query(
            sql,
            /* sql */ `
            SELECT ${agent_metadata.bead_id}
            FROM ${agent_metadata}
            WHERE ${agent_metadata.current_hook_bead_id} = ?
          `,
            [event.bead_id]
          ),
        ]);
      for (const row of hookedAgentRows) {
        agents.unhookBead(sql, row.bead_id);
      }
      return;
    }

    case 'convoy_started': {
      const convoyId = typeof payload.convoy_id === 'string' ? payload.convoy_id : null;
      if (!convoyId) {
        console.warn(`${LOG} applyEvent: convoy_started missing convoy_id`);
        return;
      }
      query(
        sql,
        /* sql */ `
          UPDATE ${convoy_metadata}
          SET ${convoy_metadata.columns.staged} = 0
          WHERE ${convoy_metadata.columns.bead_id} = ?
        `,
        [convoyId]
      );
      return;
    }

    case 'container_status': {
      if (!event.agent_id) return;

      const containerStatus = payload.status as string;
      const agent = agents.getAgent(sql, event.agent_id);
      if (!agent) return;

      // Only act on working/stalled agents whose container has stopped.
      // For 'not_found': skip if the agent was dispatched recently (#1358).
      // During a cold start the container may 404 on /agents/:id/status
      // because the agent hasn't registered in the process manager yet.
      // The 3-minute grace period covers the 60s HTTP timeout plus
      // typical cold start time (git clone + worktree). Truly dead
      // agents are caught by reconcileAgents after 90s of no heartbeats.
      if (containerStatus === 'not_found' && agent.last_activity_at) {
        const ageSec = (Date.now() - new Date(agent.last_activity_at).getTime()) / 1000;
        if (ageSec < 180) return; // 3-minute grace for cold starts
      }

      if (
        (agent.status === 'working' || agent.status === 'stalled') &&
        (containerStatus === 'exited' || containerStatus === 'not_found')
      ) {
        if (agent.role === 'refinery') {
          // Check if gt_done already completed the MR
          if (agent.current_hook_bead_id) {
            const mr = beadOps.getBead(sql, agent.current_hook_bead_id);
            if (mr && (mr.status === 'closed' || mr.status === 'failed')) {
              // MR already terminal — clean up the refinery
              agents.unhookBead(sql, event.agent_id);
              agents.updateAgentStatus(sql, event.agent_id, 'idle');
              agents.writeCheckpoint(sql, event.agent_id, null);
            } else {
              // Refinery died without completing — set idle, keep hook.
              // reconcileReviewQueue Rule 6 will retry dispatch.
              agents.updateAgentStatus(sql, event.agent_id, 'idle');
            }
          } else {
            agents.updateAgentStatus(sql, event.agent_id, 'idle');
          }
        } else {
          // Non-refinery died — set idle. Bead stays in_progress.
          // reconcileBeads Rule 3 will reset it to open after 5 min.
          agents.updateAgentStatus(sql, event.agent_id, 'idle');
        }
      }
      return;
    }

    case 'container_eviction': {
      // Draining flag is managed by the TownDO via KV storage.
      // The reconciler reads it from there; no SQL state change needed here.
      // The event is recorded for audit trail.
      return;
    }

    case 'nudge_timeout': {
      // GUPP violations are handled by reconcileGUPP on the next pass.
      // The event just records the fact for audit trail.
      return;
    }

    case 'pr_feedback_detected': {
      const mrBeadId = typeof payload.mr_bead_id === 'string' ? payload.mr_bead_id : null;
      if (!mrBeadId) {
        console.warn(`${LOG} applyEvent: pr_feedback_detected missing mr_bead_id`);
        return;
      }

      const mrBead = beadOps.getBead(sql, mrBeadId);
      if (!mrBead || mrBead.status === 'closed' || mrBead.status === 'failed') return;

      // Check for existing non-terminal feedback bead to prevent duplicates
      if (hasExistingPrFeedbackBead(sql, mrBeadId)) return;

      const prUrl = typeof payload.pr_url === 'string' ? payload.pr_url : '';
      const prNumber = typeof payload.pr_number === 'number' ? payload.pr_number : 0;
      const repo = typeof payload.repo === 'string' ? payload.repo : '';
      const branch = typeof payload.branch === 'string' ? payload.branch : '';
      const hasUnresolvedComments = payload.has_unresolved_comments === true;
      const hasFailingChecks = payload.has_failing_checks === true;
      const hasUncheckedRuns = payload.has_unchecked_runs === true;

      // Consolidation: if there's already an open gt:pr-conflict bead for this MR,
      // add has_feedback: true to it instead of creating a separate feedback bead.
      // The agent resolving conflicts will then also address review feedback afterward.
      const existingConflictBeadId = getExistingPrConflictBeadId(sql, mrBeadId);
      if (existingConflictBeadId) {
        query(
          sql,
          /* sql */ `
            UPDATE ${beads}
            SET ${beads.columns.metadata} = json_set(COALESCE(${beads.metadata}, '{}'), '$.has_feedback', 1),
                ${beads.columns.updated_at} = ?
            WHERE ${beads.bead_id} = ?
          `,
          [new Date().toISOString(), existingConflictBeadId]
        );
        console.log(
          `${LOG} pr_feedback_detected: merged into existing conflict bead ${existingConflictBeadId} (mrBeadId=${mrBeadId})`
        );
        return;
      }

      const feedbackBead = beadOps.createBead(sql, {
        type: 'issue',
        title: buildFeedbackBeadTitle(
          prNumber,
          repo,
          hasUnresolvedComments,
          hasFailingChecks,
          hasUncheckedRuns
        ),
        body: buildFeedbackPrompt(
          prNumber,
          repo,
          branch,
          hasUnresolvedComments,
          hasFailingChecks,
          hasUncheckedRuns
        ),
        rig_id: mrBead.rig_id ?? undefined,
        parent_bead_id: mrBeadId,
        labels: ['gt:pr-feedback'],
        metadata: {
          pr_feedback_for: mrBeadId,
          pr_url: prUrl,
          branch,
        },
      });

      // Feedback bead blocks the MR bead (same pattern as rework beads)
      beadOps.insertDependency(sql, mrBeadId, feedbackBead.bead_id, 'blocks');
      return;
    }

    case 'pr_conflict_detected': {
      const mrBeadId = typeof payload.mr_bead_id === 'string' ? payload.mr_bead_id : null;
      if (!mrBeadId) {
        console.warn(`${LOG} applyEvent: pr_conflict_detected missing mr_bead_id`);
        return;
      }

      const mrBead = beadOps.getBead(sql, mrBeadId);
      if (!mrBead || mrBead.status === 'closed' || mrBead.status === 'failed') return;

      // Idempotent: check for an existing open gt:pr-conflict bead for this pr_url
      if (hasExistingPrConflictBead(sql, mrBeadId)) return;

      const prUrl = typeof payload.pr_url === 'string' ? payload.pr_url : '';
      const branch = typeof payload.branch === 'string' ? payload.branch : '';
      const sourceBead = typeof payload.source_bead_id === 'string' ? payload.source_bead_id : null;

      // Read the target_branch from review_metadata
      const rmRows = z
        .object({ target_branch: z.string() })
        .array()
        .parse([
          ...query(
            sql,
            /* sql */ `
              SELECT ${review_metadata.columns.target_branch}
              FROM ${review_metadata}
              WHERE ${review_metadata.bead_id} = ?
            `,
            [mrBeadId]
          ),
        ]);
      const targetBranch = rmRows[0]?.target_branch ?? '';

      // Read auto_resolve_merge_conflicts using the same fallback chain as
      // auto_resolve_pr_feedback: rig override → town config → default (true).
      const rig = mrBead.rig_id ? getRig(sql, mrBead.rig_id) : null;
      const effectiveConfig = opts?.townConfig
        ? resolveRigConfig(opts.townConfig, rig?.config ?? null)
        : { auto_resolve_merge_conflicts: rig?.config?.auto_resolve_merge_conflicts !== false };
      const autoResolveConflicts = effectiveConfig.auto_resolve_merge_conflicts !== false;

      if (autoResolveConflicts) {
        // Consolidation: if there's already an open gt:pr-feedback bead for this MR,
        // add has_conflicts: true to it instead of creating a separate conflict bead.
        // The agent handling the feedback bead will resolve conflicts first, then
        // address review comments.
        const existingFeedbackBeadId = getExistingPrFeedbackBeadId(sql, mrBeadId);
        if (existingFeedbackBeadId) {
          query(
            sql,
            /* sql */ `
              UPDATE ${beads}
              SET ${beads.columns.metadata} = json_set(COALESCE(${beads.metadata}, '{}'), '$.has_conflicts', 1, '$.conflict_target_branch', ?),
                  ${beads.columns.updated_at} = ?
              WHERE ${beads.bead_id} = ?
            `,
            [targetBranch, new Date().toISOString(), existingFeedbackBeadId]
          );
          console.log(
            `${LOG} pr_conflict_detected: merged into existing feedback bead ${existingFeedbackBeadId} (mrBeadId=${mrBeadId})`
          );
          return;
        }

        const conflictBead = beadOps.createBead(sql, {
          type: 'issue',
          title: `Resolve merge conflicts on PR: ${branch}`,
          body: buildConflictResolutionPrompt(prUrl, branch, targetBranch),
          rig_id: mrBead.rig_id ?? undefined,
          parent_bead_id: mrBeadId,
          labels: ['gt:pr-conflict'],
          metadata: {
            pr_url: prUrl,
            branch,
            target_branch: targetBranch,
            mr_bead_id: mrBeadId,
            source_bead_id: sourceBead,
          },
        });

        // Conflict bead blocks the MR bead (same pattern as feedback beads)
        beadOps.insertDependency(sql, mrBeadId, conflictBead.bead_id, 'blocks');
      } else {
        // auto_resolve_merge_conflicts disabled — route through the full
        // escalation pipeline so escalation_metadata, triage request, and
        // mayor notification are all created (same path as routeEscalation()).
        const escalationBead = beadOps.createBead(sql, {
          type: 'escalation',
          title: `Merge conflict detected: ${branch}`,
          body: `PR ${prUrl} (branch ${branch}) has merge conflicts that require manual resolution.`,
          priority: 'high',
          rig_id: mrBead.rig_id ?? undefined,
          labels: ['gt:escalation', 'severity:high'],
          metadata: {
            pr_url: prUrl,
            branch,
            target_branch: targetBranch,
            mr_bead_id: mrBeadId,
            source_bead_id: sourceBead,
            conflict: true,
          },
        });
        query(
          sql,
          /* sql */ `
            INSERT INTO ${escalation_metadata} (
              ${escalation_metadata.columns.bead_id},
              ${escalation_metadata.columns.severity},
              ${escalation_metadata.columns.category},
              ${escalation_metadata.columns.acknowledged},
              ${escalation_metadata.columns.re_escalation_count},
              ${escalation_metadata.columns.acknowledged_at}
            ) VALUES (?, ?, ?, ?, ?, ?)
          `,
          [escalationBead.bead_id, 'high', 'merge_conflict', 0, 0, null]
        );
        createTriageRequest(sql, {
          triageType: 'escalation',
          agentBeadId: null,
          title: `Escalation (high): Merge conflict on ${branch}`,
          context: {
            escalation_bead_id: escalationBead.bead_id,
            severity: 'high',
            rig_id: mrBead.rig_id,
            category: 'merge_conflict',
            pr_url: prUrl,
            branch,
            mr_bead_id: mrBeadId,
          },
          options: ['ESCALATE_TO_MAYOR', 'RESTART', 'CLOSE_BEAD', 'REASSIGN_BEAD'],
          rigId: mrBead.rig_id ?? undefined,
        });
      }
      return;
    }

    case 'pr_auto_merge': {
      const mrBeadId = typeof payload.mr_bead_id === 'string' ? payload.mr_bead_id : null;
      if (!mrBeadId) {
        console.warn(`${LOG} applyEvent: pr_auto_merge missing mr_bead_id`);
        return;
      }

      const mrBead = beadOps.getBead(sql, mrBeadId);
      if (!mrBead || mrBead.status === 'closed' || mrBead.status === 'failed') return;

      // The actual merge is handled by the merge_pr side effect generated by
      // the reconciler on the next tick when it sees this event has been processed.
      // We just mark the intent here via metadata.
      query(
        sql,
        /* sql */ `
          UPDATE ${beads}
          SET ${beads.columns.metadata} = json_set(COALESCE(${beads.metadata}, '{}'), '$.auto_merge_pending', 1),
              ${beads.columns.updated_at} = ?
          WHERE ${beads.bead_id} = ?
        `,
        [new Date().toISOString(), mrBeadId]
      );
      return;
    }

    default: {
      console.warn(`${LOG} applyEvent: unknown event type: ${event.event_type}`);
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// Top-level reconcile
// ════════════════════════════════════════════════════════════════════

export function reconcile(
  sql: SqlStorage,
  opts?: { draining?: boolean; townConfig?: TownConfig }
): Action[] {
  const draining = opts?.draining ?? false;
  const actions: Action[] = [];
  actions.push(...reconcileAgents(sql, { draining }));
  actions.push(...reconcileBeads(sql, { draining, townConfig: opts?.townConfig }));
  actions.push(...reconcileReviewQueue(sql, { draining, townConfig: opts?.townConfig }));
  actions.push(...reconcileConvoys(sql));
  actions.push(...reconcileGUPP(sql, { draining }));
  actions.push(...reconcileGC(sql));
  return actions;
}

// ════════════════════════════════════════════════════════════════════
// reconcileAgents — detect working agents with dead containers,
// idle agents with stale hooks to terminal beads
// ════════════════════════════════════════════════════════════════════

export function reconcileAgents(sql: SqlStorage, opts?: { draining?: boolean }): Action[] {
  const actions: Action[] = [];

  // Working agents with stale or missing heartbeat — container probably dead.
  // This is a safety net: the container status observation pre-phase
  // emits container_status events which are applied in Phase 0, but
  // if that fails (e.g. container DO unreachable), this catches agents
  // whose heartbeat stopped. 3 missed heartbeats (90s) = container dead.
  // Agents with NULL last_activity_at never received a heartbeat at all
  // (container may have failed to start).
  const workingAgents = AgentRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${agent_metadata.bead_id}, ${agent_metadata.role},
               ${agent_metadata.status}, ${agent_metadata.current_hook_bead_id},
               ${agent_metadata.dispatch_attempts},
               ${agent_metadata.last_activity_at},
               b.${beads.columns.rig_id}
        FROM ${agent_metadata}
        LEFT JOIN ${beads} b ON b.${beads.columns.bead_id} = ${agent_metadata.bead_id}
        WHERE ${agent_metadata.status} = 'working'
      `,
      []
    ),
  ]);

  for (const agent of workingAgents) {
    // Mayors are always working with no hook — skip them
    if (agent.role === 'mayor') continue;

    // During container drain the heartbeat reporter is stopped, so
    // last_activity_at freezes. Skip stale-heartbeat checks to avoid
    // false-positive idle transitions while agents are still working.
    if (opts?.draining) continue;

    if (!agent.last_activity_at) {
      // No heartbeat ever received — container may have failed to start
      actions.push({
        type: 'transition_agent',
        agent_id: agent.bead_id,
        from: 'working',
        to: 'idle',
        reason: 'no heartbeat received since dispatch',
      });
    } else if (staleMs(agent.last_activity_at, 90_000)) {
      actions.push({
        type: 'transition_agent',
        agent_id: agent.bead_id,
        from: 'working',
        to: 'idle',
        reason: 'heartbeat lost (3 missed cycles)',
      });
    } else if (!agent.current_hook_bead_id) {
      // Agent is working with fresh heartbeat but no hook — it's running
      // in the container but has no bead to work on (gt_done already ran,
      // or the hook was cleared by another code path). Set to idle so
      // the reconciler can dispatch it to new work.
      actions.push({
        type: 'transition_agent',
        agent_id: agent.bead_id,
        from: 'working',
        to: 'idle',
        reason: 'working agent has no hook (gt_done already completed)',
      });
    }
  }

  // Auto-reset dispatch_attempts after 30-minute cooldown
  const staleAgents = AgentRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${agent_metadata.bead_id}, ${agent_metadata.role},
               ${agent_metadata.status}, ${agent_metadata.current_hook_bead_id},
               ${agent_metadata.dispatch_attempts},
               ${agent_metadata.last_activity_at},
               b.${beads.columns.rig_id}
        FROM ${agent_metadata}
        LEFT JOIN ${beads} b ON b.${beads.columns.bead_id} = ${agent_metadata.bead_id}
        WHERE ${agent_metadata.dispatch_attempts} >= ?
          AND ${agent_metadata.last_activity_at} < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes')
      `,
      [MAX_DISPATCH_ATTEMPTS]
    ),
  ]);

  for (const agent of staleAgents) {
    actions.push({
      type: 'reset_agent_dispatch_attempts',
      agent_id: agent.bead_id,
    });
  }

  // Idle agents hooked to terminal beads — clean up stale hooks
  const idleHooked = AgentRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${agent_metadata.bead_id}, ${agent_metadata.role},
               ${agent_metadata.status}, ${agent_metadata.current_hook_bead_id},
               ${agent_metadata.dispatch_attempts},
               ${agent_metadata.last_activity_at},
               b.${beads.columns.rig_id}
        FROM ${agent_metadata}
        LEFT JOIN ${beads} b ON b.${beads.columns.bead_id} = ${agent_metadata.bead_id}
        WHERE ${agent_metadata.status} = 'idle'
          AND ${agent_metadata.current_hook_bead_id} IS NOT NULL
      `,
      []
    ),
  ]);

  for (const agent of idleHooked) {
    if (!agent.current_hook_bead_id) continue;

    const hookedRows = z
      .object({ status: z.string() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
          SELECT ${beads.status}
          FROM ${beads}
          WHERE ${beads.bead_id} = ?
        `,
          [agent.current_hook_bead_id]
        ),
      ]);

    if (hookedRows.length === 0) {
      // Hooked bead doesn't exist — stale reference
      actions.push({
        type: 'unhook_agent',
        agent_id: agent.bead_id,
        reason: 'hooked bead does not exist',
      });
      actions.push({
        type: 'clear_agent_checkpoint',
        agent_id: agent.bead_id,
      });
      continue;
    }

    const hookedStatus = hookedRows[0].status;
    if (hookedStatus === 'closed' || hookedStatus === 'failed') {
      actions.push({
        type: 'unhook_agent',
        agent_id: agent.bead_id,
        reason: 'hooked bead is terminal',
      });
      actions.push({
        type: 'clear_agent_checkpoint',
        agent_id: agent.bead_id,
      });
    } else if (hookedStatus === 'in_progress' || hookedStatus === 'open') {
      // Idle agent hooked to a live bead — the dispatch started but the
      // agent died (container failed to start, OOM, etc.) and agentCompleted
      // set it to idle without unhooking. Reset the bead to open and unhook
      // so the scheduling rules can re-dispatch.
      actions.push({
        type: 'unhook_agent',
        agent_id: agent.bead_id,
        reason: 'idle agent hooked to live bead (dispatch failed)',
      });
      actions.push({
        type: 'transition_bead',
        bead_id: agent.current_hook_bead_id,
        from: hookedStatus,
        to: 'open',
        reason: 'agent went idle without completing work — reset for re-dispatch',
        actor: 'system',
      });
    }
  }

  return actions;
}

// ════════════════════════════════════════════════════════════════════
// reconcileBeads — handle unassigned beads, lost agents, stale reviews
// ════════════════════════════════════════════════════════════════════

export function reconcileBeads(
  sql: SqlStorage,
  opts?: { draining?: boolean; townConfig?: TownConfig }
): Action[] {
  const draining = opts?.draining ?? false;
  const actions: Action[] = [];

  // Resolve per-rig max_dispatch_attempts, falling back to the module default.
  const rigMaxDispatchAttempts = (rigId: string | null): number => {
    if (!rigId || !opts?.townConfig) return MAX_DISPATCH_ATTEMPTS;
    const rig = getRig(sql, rigId);
    return (
      resolveRigConfig(opts.townConfig, rig?.config ?? null).max_dispatch_attempts ??
      MAX_DISPATCH_ATTEMPTS
    );
  };

  // Town-level circuit breaker: if too many dispatch failures in the
  // window, skip all dispatch_agent actions and escalate to mayor.
  const circuitBreakerActions = checkDispatchCircuitBreaker(sql);
  const circuitBreakerOpen = circuitBreakerActions.length > 0;

  // Rule 1: Open issue beads with no assignee, no blockers, not staged, not triage
  const unassigned = BeadRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT b.${beads.columns.bead_id}, b.${beads.columns.type},
               b.${beads.columns.status}, b.${beads.columns.rig_id},
               b.${beads.columns.assignee_agent_bead_id},
               b.${beads.columns.updated_at},
               b.${beads.columns.labels},
               b.${beads.columns.created_by},
               b.${beads.columns.dispatch_attempts},
               b.${beads.columns.last_dispatch_attempt_at}
        FROM ${beads} b
        WHERE b.${beads.columns.type} = 'issue'
          AND b.${beads.columns.status} = 'open'
          AND b.${beads.columns.assignee_agent_bead_id} IS NULL
          AND b.${beads.columns.rig_id} IS NOT NULL
          AND b.${beads.columns.labels} NOT LIKE ?
          AND NOT EXISTS (
            SELECT 1 FROM ${bead_dependencies} bd
            INNER JOIN ${beads} blocker ON blocker.${beads.columns.bead_id} = bd.${bead_dependencies.columns.depends_on_bead_id}
            WHERE bd.${bead_dependencies.columns.bead_id} = b.${beads.columns.bead_id}
              AND bd.${bead_dependencies.columns.dependency_type} = 'blocks'
              AND blocker.${beads.columns.status} NOT IN ('closed', 'failed')
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${bead_dependencies} bd2
            INNER JOIN ${convoy_metadata} cm ON cm.${convoy_metadata.columns.bead_id} = bd2.${bead_dependencies.columns.depends_on_bead_id}
            WHERE bd2.${bead_dependencies.columns.bead_id} = b.${beads.columns.bead_id}
              AND bd2.${bead_dependencies.columns.dependency_type} = 'tracks'
              AND cm.${convoy_metadata.columns.staged} = 1
          )
      `,
      [TRIAGE_LABEL_LIKE]
    ),
  ]);

  for (const bead of unassigned) {
    if (!bead.rig_id) continue;
    if (draining) {
      console.log(`${LOG} Town is draining, skipping dispatch for bead ${bead.bead_id}`);
      continue;
    }

    // Per-bead dispatch cap: fail the bead if it exhausted all attempts
    if (bead.dispatch_attempts >= rigMaxDispatchAttempts(bead.rig_id)) {
      actions.push({
        type: 'transition_bead',
        bead_id: bead.bead_id,
        from: 'open',
        to: 'failed',
        reason: `max dispatch attempts exceeded (${bead.dispatch_attempts})`,
        actor: 'system',
      });
      continue;
    }

    // Exponential backoff: skip if last dispatch attempt was too recent
    const cooldownMs = getDispatchCooldownMs(bead.dispatch_attempts);
    if (!staleMs(bead.last_dispatch_attempt_at, cooldownMs)) continue;

    // Town-level circuit breaker suppresses dispatch
    if (circuitBreakerOpen) continue;

    actions.push({
      type: 'dispatch_agent',
      agent_id: '', // resolved at apply time
      bead_id: bead.bead_id,
      rig_id: bead.rig_id,
    });
  }

  // Rule 1b: Open issue beads with a stale assignee (agent exists but is not
  // hooked to this bead). This happens when a container restart causes the
  // agent to be unhooked while the bead is reset to open (e.g. by the mayor).
  // Clear the assignee so Rule 1 can pick it up on the next reconciler tick.
  const staleAssigned = BeadRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${beads.bead_id}, ${beads.type},
               ${beads.status}, ${beads.rig_id},
               ${beads.assignee_agent_bead_id},
               ${beads.updated_at},
               ${beads.labels},
               ${beads.created_by},
               ${beads.dispatch_attempts},
               ${beads.last_dispatch_attempt_at}
        FROM ${beads}
        WHERE ${beads.type} = 'issue'
          AND ${beads.status} = 'open'
          AND ${beads.assignee_agent_bead_id} IS NOT NULL
          AND ${beads.rig_id} IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${agent_metadata}
            WHERE ${agent_metadata.bead_id} = ${beads.assignee_agent_bead_id}
              AND ${agent_metadata.current_hook_bead_id} = ${beads.bead_id}
          )
      `,
      []
    ),
  ]);

  for (const bead of staleAssigned) {
    // Skip system-assigned beads (escalations, rework requests) — those
    // are handled by other subsystems and don't need dispatch.
    if (bead.assignee_agent_bead_id === 'system') continue;

    // Skip triage-request beads — patrol.createTriageRequest() sets
    // assignee_agent_bead_id to route the request to a specific agent,
    // but hookBead() intentionally refuses to hook triage-request beads.
    // Without this skip, the reconciler would clear the assignee on
    // every tick because the hook will never exist.
    if (bead.labels.includes('gt:triage-request')) continue;

    actions.push({
      type: 'clear_bead_assignee',
      bead_id: bead.bead_id,
    });
  }

  // Rule 2: Idle agents with hooks need dispatch
  const idleHooked = AgentRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${agent_metadata.bead_id}, ${agent_metadata.role},
               ${agent_metadata.status}, ${agent_metadata.current_hook_bead_id},
               ${agent_metadata.dispatch_attempts},
               ${agent_metadata.last_activity_at},
               b.${beads.columns.rig_id}
        FROM ${agent_metadata}
        LEFT JOIN ${beads} b ON b.${beads.columns.bead_id} = ${agent_metadata.bead_id}
        WHERE ${agent_metadata.status} = 'idle'
          AND ${agent_metadata.current_hook_bead_id} IS NOT NULL
          AND ${agent_metadata.columns.role} != 'refinery'
      `,
      []
    ),
  ]);

  for (const agent of idleHooked) {
    if (!agent.current_hook_bead_id) continue;

    // Check if the hooked bead is open and unblocked, and read its
    // dispatch_attempts for the per-bead circuit breaker.
    const hookedRows = z
      .object({
        status: z.string(),
        rig_id: z.string().nullable(),
        dispatch_attempts: z.number(),
        last_dispatch_attempt_at: z.string().nullable(),
      })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
          SELECT ${beads.status}, ${beads.rig_id},
                 ${beads.dispatch_attempts}, ${beads.last_dispatch_attempt_at}
          FROM ${beads}
          WHERE ${beads.bead_id} = ?
        `,
          [agent.current_hook_bead_id]
        ),
      ]);

    if (hookedRows.length === 0) continue;
    const hooked = hookedRows[0];
    if (hooked.status !== 'open') continue;

    // Per-bead dispatch cap (uses bead counter, not agent counter)
    if (hooked.dispatch_attempts >= MAX_DISPATCH_ATTEMPTS) {
      actions.push({
        type: 'transition_bead',
        bead_id: agent.current_hook_bead_id,
        from: null,
        to: 'failed',
        reason: `max dispatch attempts exceeded (${hooked.dispatch_attempts})`,
        actor: 'system',
      });
      actions.push({
        type: 'unhook_agent',
        agent_id: agent.bead_id,
        reason: 'max dispatch attempts',
      });
      continue;
    }

    // Exponential backoff using bead's last_dispatch_attempt_at
    const cooldownMs = getDispatchCooldownMs(hooked.dispatch_attempts);
    if (!staleMs(hooked.last_dispatch_attempt_at, cooldownMs)) continue;

    // Check blockers
    const blockerCount = z
      .object({ cnt: z.number() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
          SELECT count(*) as cnt
          FROM ${bead_dependencies} bd
          INNER JOIN ${beads} blocker ON blocker.${beads.columns.bead_id} = bd.${bead_dependencies.columns.depends_on_bead_id}
          WHERE bd.${bead_dependencies.columns.bead_id} = ?
            AND bd.${bead_dependencies.columns.dependency_type} = 'blocks'
            AND blocker.${beads.columns.status} NOT IN ('closed', 'failed')
        `,
          [agent.current_hook_bead_id]
        ),
      ]);

    if (blockerCount[0]?.cnt > 0) continue;

    if (draining) {
      console.log(
        `${LOG} Town is draining, skipping dispatch for bead ${agent.current_hook_bead_id}`
      );
      continue;
    }

    // Town-level circuit breaker suppresses dispatch
    if (circuitBreakerOpen) continue;

    actions.push({
      type: 'dispatch_agent',
      agent_id: agent.bead_id,
      bead_id: agent.current_hook_bead_id,
      rig_id: hooked.rig_id ?? agent.rig_id ?? '',
    });
  }

  // Rule 3: In-progress issue beads with no working/stalled agent
  const staleInProgress = BeadRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT b.${beads.columns.bead_id}, b.${beads.columns.type},
               b.${beads.columns.status}, b.${beads.columns.rig_id},
               b.${beads.columns.assignee_agent_bead_id},
               b.${beads.columns.updated_at},
               b.${beads.columns.labels},
               b.${beads.columns.created_by},
               b.${beads.columns.dispatch_attempts},
               b.${beads.columns.last_dispatch_attempt_at}
        FROM ${beads} b
        WHERE b.${beads.columns.type} = 'issue'
          AND b.${beads.columns.status} = 'in_progress'
      `,
      []
    ),
  ]);

  for (const bead of staleInProgress) {
    if (!staleMs(bead.updated_at, STALE_IN_PROGRESS_TIMEOUT_MS)) continue;

    // Check if any agent is hooked AND (working/stalled OR has a recent
    // heartbeat). The heartbeat check is defense-in-depth for #1358: if
    // the agent's status is wrong (e.g. stuck on 'idle' due to a dispatch
    // timeout race), a fresh heartbeat proves the agent is alive.
    const hookedAgent = z
      .object({ status: z.string(), last_activity_at: z.string().nullable() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
          SELECT ${agent_metadata.status}, ${agent_metadata.last_activity_at}
          FROM ${agent_metadata}
          WHERE ${agent_metadata.current_hook_bead_id} = ?
            AND (
              ${agent_metadata.status} IN ('working', 'stalled')
              OR ${agent_metadata.last_activity_at} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 seconds')
            )
        `,
          [bead.bead_id]
        ),
      ]);

    if (hookedAgent.length > 0) continue;

    // If the bead has exhausted its dispatch attempts, fail it instead
    // of resetting to open (which would cause an infinite retry loop).
    if (bead.dispatch_attempts >= MAX_DISPATCH_ATTEMPTS) {
      actions.push({
        type: 'transition_bead',
        bead_id: bead.bead_id,
        from: 'in_progress',
        to: 'failed',
        reason: `agent lost, max dispatch attempts exhausted (${bead.dispatch_attempts})`,
        actor: 'system',
      });
      actions.push({
        type: 'clear_bead_assignee',
        bead_id: bead.bead_id,
      });
      continue;
    }

    actions.push({
      type: 'transition_bead',
      bead_id: bead.bead_id,
      from: 'in_progress',
      to: 'open',
      reason: 'agent lost',
      actor: 'system',
    });
    actions.push({
      type: 'clear_bead_assignee',
      bead_id: bead.bead_id,
    });
  }

  // Rule 4: In-review issue beads where all MR beads are terminal
  const inReview = BeadRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT b.${beads.columns.bead_id}, b.${beads.columns.type},
               b.${beads.columns.status}, b.${beads.columns.rig_id},
               b.${beads.columns.assignee_agent_bead_id},
               b.${beads.columns.updated_at},
               b.${beads.columns.labels},
               b.${beads.columns.created_by}
        FROM ${beads} b
        WHERE b.${beads.columns.type} = 'issue'
          AND b.${beads.columns.status} = 'in_review'
      `,
      []
    ),
  ]);

  for (const bead of inReview) {
    if (!staleMs(bead.updated_at, ORPHANED_SOURCE_TIMEOUT_MS)) continue;

    // Get all MR beads tracking this source
    const mrBeads = z
      .object({ status: z.string() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
          SELECT mr.${beads.columns.status}
          FROM ${bead_dependencies} bd
          INNER JOIN ${beads} mr ON mr.${beads.columns.bead_id} = bd.${bead_dependencies.columns.bead_id}
          WHERE bd.${bead_dependencies.columns.depends_on_bead_id} = ?
            AND bd.${bead_dependencies.columns.dependency_type} = 'tracks'
            AND mr.${beads.columns.type} = 'merge_request'
        `,
          [bead.bead_id]
        ),
      ]);

    if (mrBeads.length === 0) continue;
    const allTerminal = mrBeads.every(mr => mr.status === 'closed' || mr.status === 'failed');
    if (!allTerminal) continue;

    const anyMerged = mrBeads.some(mr => mr.status === 'closed');

    if (anyMerged) {
      actions.push({
        type: 'transition_bead',
        bead_id: bead.bead_id,
        from: 'in_review',
        to: 'closed',
        reason: 'MR merged (reconciler safety net)',
        actor: 'system',
      });
    } else {
      actions.push({
        type: 'transition_bead',
        bead_id: bead.bead_id,
        from: 'in_review',
        to: 'open',
        reason: 'all reviews failed',
        actor: 'system',
      });
      actions.push({
        type: 'clear_bead_assignee',
        bead_id: bead.bead_id,
      });
    }
  }

  // Emit circuit breaker notification (once per reconcile pass)
  if (circuitBreakerOpen) {
    actions.push(...circuitBreakerActions);
  }

  return actions;
}

// ════════════════════════════════════════════════════════════════════
// reconcileReviewQueue — PR polling, stuck/abandoned MR recovery,
// refinery dispatch
// ════════════════════════════════════════════════════════════════════

export function reconcileReviewQueue(
  sql: SqlStorage,
  opts?: { draining?: boolean; townConfig?: TownConfig }
): Action[] {
  const draining = opts?.draining ?? false;
  const actions: Action[] = [];

  // Town-level circuit breaker
  const circuitBreakerOpen = checkDispatchCircuitBreaker(sql).length > 0;

  // Resolve per-rig code_review setting. Falls back to town default when
  // townConfig is not provided (e.g. in tests or debug replay).
  const rigCodeReview = (rigId: string): boolean => {
    if (!opts?.townConfig) return true;
    const rig = getRig(sql, rigId);
    return resolveRigConfig(opts.townConfig, rig?.config ?? null).code_review;
  };

  // Resolve per-rig max_dispatch_attempts, falling back to the module default.
  const rigMaxDispatchAttempts = (rigId: string | null): number => {
    if (!rigId || !opts?.townConfig) return MAX_DISPATCH_ATTEMPTS;
    const rig = getRig(sql, rigId);
    return (
      resolveRigConfig(opts.townConfig, rig?.config ?? null).max_dispatch_attempts ??
      MAX_DISPATCH_ATTEMPTS
    );
  };

  // Get all MR beads that need attention
  const mrBeads = MrBeadRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT b.${beads.columns.bead_id}, b.${beads.columns.status},
               b.${beads.columns.rig_id}, b.${beads.columns.updated_at},
               b.${beads.columns.metadata},
               rm.${review_metadata.columns.pr_url},
               b.${beads.columns.assignee_agent_bead_id}
        FROM ${beads} b
        INNER JOIN ${review_metadata} rm ON rm.${review_metadata.columns.bead_id} = b.${beads.columns.bead_id}
        WHERE b.${beads.columns.type} = 'merge_request'
          AND b.${beads.columns.status} IN ('open', 'in_progress')
      `,
      []
    ),
  ]);

  for (const mr of mrBeads) {
    // Rule 1: PR-strategy MR beads in_progress need polling.
    // Rate-limit: skip if polled less than PR_POLL_INTERVAL_MS ago (#1632).
    if (mr.status === 'in_progress' && mr.pr_url) {
      const lastPollAt: unknown = mr.metadata?.last_poll_at;
      const msSinceLastPoll =
        typeof lastPollAt === 'string' ? Date.now() - new Date(lastPollAt).getTime() : Infinity;

      if (msSinceLastPoll >= PR_POLL_INTERVAL_MS) {
        actions.push({
          type: 'poll_pr',
          bead_id: mr.bead_id,
          pr_url: mr.pr_url,
        });
      }
      // If auto-merge is pending, also attempt the merge
      if (mr.metadata?.auto_merge_pending) {
        actions.push({
          type: 'merge_pr',
          bead_id: mr.bead_id,
          pr_url: mr.pr_url,
        });
      }
    }

    // Rule 2: Stuck MR beads in_progress with no PR, no working agent, stale >30min
    // Skip MR beads with unresolved rework blockers — they're waiting for
    // a polecat to finish rework, which is a normal in-flight state.
    if (
      mr.status === 'in_progress' &&
      !mr.pr_url &&
      staleMs(mr.updated_at, STUCK_REVIEW_TIMEOUT_MS)
    ) {
      if (hasUnresolvedReworkBlockers(sql, mr.bead_id)) continue;
      const workingAgent = hasWorkingAgentHooked(sql, mr.bead_id);
      if (!workingAgent) {
        actions.push({
          type: 'transition_bead',
          bead_id: mr.bead_id,
          from: 'in_progress',
          to: 'open',
          reason: 'stuck review, no working agent',
          actor: 'system',
        });
        // Unhook any idle agent still pointing at this MR
        const idleAgent = getIdleAgentHookedTo(sql, mr.bead_id);
        if (idleAgent) {
          actions.push({
            type: 'unhook_agent',
            agent_id: idleAgent,
            reason: 'stuck review cleanup',
          });
        }
      }
    }

    // Rule 3: Abandoned MR beads in_progress, no PR, no agent hooked, stale >2min
    // Skip MR beads with rework blockers (same reasoning as Rule 2).
    if (
      mr.status === 'in_progress' &&
      !mr.pr_url &&
      staleMs(mr.updated_at, ABANDONED_MR_TIMEOUT_MS)
    ) {
      if (hasUnresolvedReworkBlockers(sql, mr.bead_id)) continue;
      const anyAgent = hasAnyAgentHooked(sql, mr.bead_id);
      if (!anyAgent) {
        actions.push({
          type: 'transition_bead',
          bead_id: mr.bead_id,
          from: 'in_progress',
          to: 'open',
          reason: 'abandoned, no agent hooked',
          actor: 'system',
        });
      }
    }

    // Rule 4: PR-strategy MR beads orphaned (refinery dispatched then died, stale >30min)
    // Only in_progress — open beads are just waiting for the refinery to pop them.
    // Skip when refinery code review is disabled for this rig: poll_pr keeps the
    // bead alive via updated_at touches, and no refinery is expected to be working.
    if (
      mr.rig_id &&
      rigCodeReview(mr.rig_id) &&
      mr.status === 'in_progress' &&
      mr.pr_url &&
      staleMs(mr.updated_at, ORPHANED_PR_REVIEW_TIMEOUT_MS)
    ) {
      const workingAgent = hasWorkingAgentHooked(sql, mr.bead_id);
      if (!workingAgent) {
        actions.push({
          type: 'transition_bead',
          bead_id: mr.bead_id,
          from: mr.status,
          to: 'failed',
          reason: 'PR review orphaned',
          actor: 'system',
        });
      }
    }
  }

  // Per-rig: when refinery code review is disabled for a rig:
  //  - MR beads for that rig WITH pr_url → fast-track to in_progress for poll_pr
  //  - MR beads for that rig WITHOUT pr_url → fail them and reopen the source bead
  //    (the polecat was supposed to create the PR via merge_strategy=pr
  //    but didn't provide one — retry the source bead)
  // Collect all rigs that have open MR beads so we can apply per-rig logic.
  const rigsWithAnyOpenMrs = z
    .object({ rig_id: z.string() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
          SELECT DISTINCT b.${beads.columns.rig_id}
          FROM ${beads} b
          WHERE b.${beads.columns.type} = 'merge_request'
            AND b.${beads.columns.status} = 'open'
            AND b.${beads.columns.rig_id} IS NOT NULL
        `,
        []
      ),
    ]);

  for (const { rig_id } of rigsWithAnyOpenMrs) {
    if (rigCodeReview(rig_id)) continue;

    // Fast-track: open MR beads with pr_url → in_progress (skip refinery review)
    const openMrsWithPr = z
      .object({ bead_id: z.string() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
            SELECT b.${beads.columns.bead_id}
            FROM ${beads} b
            JOIN ${review_metadata} rm
              ON rm.${review_metadata.columns.bead_id} = b.${beads.columns.bead_id}
            WHERE b.${beads.columns.type} = 'merge_request'
              AND b.${beads.columns.status} = 'open'
              AND b.${beads.columns.rig_id} = ?
              AND rm.${review_metadata.columns.pr_url} IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM ${beads} parent
                JOIN ${convoy_metadata} cm
                  ON cm.${convoy_metadata.columns.bead_id} = parent.${beads.columns.bead_id}
                WHERE parent.${beads.columns.bead_id} = b.${beads.columns.parent_bead_id}
                  AND cm.${convoy_metadata.columns.merge_mode} = 'review-and-merge'
              )
          `,
          [rig_id]
        ),
      ]);
    for (const { bead_id } of openMrsWithPr) {
      actions.push({
        type: 'transition_bead',
        bead_id,
        from: 'open',
        to: 'in_progress',
        reason: 'refinery code review disabled — skip to poll_pr',
        actor: 'system',
      });
    }

    // Orphan cleanup: open MR beads without pr_url that aren't convoy
    // review-and-merge beads or system-created landing MR beads.
    // The polecat should have created the PR (merge_strategy=pr) but
    // didn't — fail the MR and reopen the source bead so another
    // polecat can retry.
    // Landing MR beads (created_by='system') are excluded because they
    // are created by reconcileConvoys for review-then-land convoys and
    // intentionally have no pr_url at creation — the refinery creates
    // the PR when it picks up the landing MR.
    const orphanedMrs = z
      .object({ bead_id: z.string(), source_bead_id: z.string().nullable() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
            SELECT b.${beads.columns.bead_id},
                   bd.${bead_dependencies.columns.depends_on_bead_id} AS source_bead_id
            FROM ${beads} b
            JOIN ${review_metadata} rm
              ON rm.${review_metadata.columns.bead_id} = b.${beads.columns.bead_id}
            LEFT JOIN ${bead_dependencies} bd
              ON bd.${bead_dependencies.columns.bead_id} = b.${beads.columns.bead_id}
              AND bd.${bead_dependencies.columns.dependency_type} = 'tracks'
            WHERE b.${beads.columns.type} = 'merge_request'
              AND b.${beads.columns.status} = 'open'
              AND b.${beads.columns.rig_id} = ?
              AND rm.${review_metadata.columns.pr_url} IS NULL
              AND b.${beads.columns.created_by} != 'system'
              AND NOT EXISTS (
                SELECT 1
                FROM ${beads} parent
                JOIN ${convoy_metadata} cm
                  ON cm.${convoy_metadata.columns.bead_id} = parent.${beads.columns.bead_id}
                WHERE parent.${beads.columns.bead_id} = b.${beads.columns.parent_bead_id}
                  AND cm.${convoy_metadata.columns.merge_mode} = 'review-and-merge'
              )
          `,
          [rig_id]
        ),
      ]);
    for (const { bead_id, source_bead_id } of orphanedMrs) {
      actions.push({
        type: 'transition_bead',
        bead_id,
        from: 'open',
        to: 'failed',
        reason: 'MR bead has no pr_url and code review is disabled — polecat failed to create PR',
        actor: 'system',
      });
      if (source_bead_id) {
        actions.push({
          type: 'transition_bead',
          bead_id: source_bead_id,
          from: 'in_review',
          to: 'open',
          reason: 'MR failed (no PR created) — reopening for retry',
          actor: 'system',
        });
      }
    }
  }

  // Rules 5-6: Refinery dispatch for open MR beads.
  // When code_review=true for a rig: dispatches for all open MR beads in that rig.
  // When code_review=false for a rig: only dispatches for convoy review-and-merge
  // MR beads (the fast-track above already moved ordinary MR beads to
  // in_progress as actions, but those haven't been applied to SQL yet —
  // so we must filter here to avoid re-dispatching them).
  {
    // Rule 5: Pop open MR bead for idle refinery
    // Get all rigs that have open MR beads needing the refinery.
    // All rigs with open MRs are candidates; per-rig code_review is checked inside the loop.
    const rigsWithOpenMrs = z
      .object({ rig_id: z.string() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
        SELECT DISTINCT b.${beads.columns.rig_id}
        FROM ${beads} b
        WHERE b.${beads.columns.type} = 'merge_request'
          AND b.${beads.columns.status} = 'open'
          AND b.${beads.columns.rig_id} IS NOT NULL
      `,
          []
        ),
      ]);

    for (const { rig_id } of rigsWithOpenMrs) {
      // When code_review=false, only dispatch the refinery for:
      //  1. Convoy review-and-merge MR beads (refinery does combined review+merge)
      //  2. System-created landing MR beads (review-then-land convoy finalization)
      // MR beads WITH a pr_url are handled by the fast-track → poll_pr.
      // MR beads WITHOUT a pr_url when merge_strategy=pr are orphaned
      // (polecat should have created the PR) — orphan cleanup handles them.
      const refineryNeededFilter = rigCodeReview(rig_id)
        ? ''
        : /* sql */ `
            AND (
              EXISTS (
                SELECT 1
                FROM ${beads} outer_parent
                JOIN ${convoy_metadata} cm
                  ON cm.${convoy_metadata.columns.bead_id} = outer_parent.${beads.columns.bead_id}
                WHERE outer_parent.${beads.columns.bead_id} = ${beads.parent_bead_id}
                  AND cm.${convoy_metadata.columns.merge_mode} = 'review-and-merge'
              )
              OR ${beads.created_by} = 'system'
            )`;

      // Check if rig already has an in_progress MR that needs the refinery.
      // PR-strategy MR beads (pr_url IS NOT NULL) don't need the refinery —
      // the merge is handled by the user/CI via the PR. Only direct-strategy
      // MRs (no pr_url, refinery merges to main itself) block the queue.
      const inProgressCount = z
        .object({ cnt: z.number() })
        .array()
        .parse([
          ...query(
            sql,
            /* sql */ `
          SELECT count(*) as cnt FROM ${beads} b
          INNER JOIN ${review_metadata} rm
            ON rm.${review_metadata.columns.bead_id} = b.${beads.columns.bead_id}
          WHERE b.${beads.columns.type} = 'merge_request'
            AND b.${beads.columns.status} = 'in_progress'
            AND b.${beads.columns.rig_id} = ?
            AND rm.${review_metadata.columns.pr_url} IS NULL
        `,
            [rig_id]
          ),
        ]);
      if ((inProgressCount[0]?.cnt ?? 0) > 0) continue;

      // Check if the refinery for this rig is idle and unhooked
      const refinery = AgentRow.array().parse([
        ...query(
          sql,
          /* sql */ `
          SELECT ${agent_metadata.bead_id}, ${agent_metadata.role},
                 ${agent_metadata.status}, ${agent_metadata.current_hook_bead_id},
                 ${agent_metadata.dispatch_attempts},
                 ${agent_metadata.last_activity_at},
                 b.${beads.columns.rig_id}
          FROM ${agent_metadata}
          LEFT JOIN ${beads} b ON b.${beads.columns.bead_id} = ${agent_metadata.bead_id}
          WHERE ${agent_metadata.columns.role} = 'refinery'
            AND b.${beads.columns.rig_id} = ?
          LIMIT 1
        `,
          [rig_id]
        ),
      ]);

      // Get oldest open MR for this rig (filtered by convoy when code_review=false)
      const oldestMr = z
        .object({ bead_id: z.string() })
        .array()
        .parse([
          ...query(
            sql,
            /* sql */ `
          SELECT ${beads.bead_id}
          FROM ${beads}
          WHERE ${beads.type} = 'merge_request'
            AND ${beads.status} = 'open'
            AND ${beads.rig_id} = ?
            ${refineryNeededFilter}
          ORDER BY ${beads.created_at} ASC
          LIMIT 1
        `,
            [rig_id]
          ),
        ]);

      if (oldestMr.length === 0) continue;

      // Skip dispatch if the town is draining (container eviction in progress)
      if (draining) {
        console.log(`${LOG} Town is draining, skipping dispatch for bead ${oldestMr[0].bead_id}`);
        continue;
      }

      // Town-level circuit breaker suppresses dispatch
      if (circuitBreakerOpen) continue;

      // If no refinery exists or it's busy, emit a dispatch_agent with empty
      // agent_id — applyAction will create the refinery via getOrCreateAgent.
      if (refinery.length === 0) {
        actions.push({
          type: 'transition_bead',
          bead_id: oldestMr[0].bead_id,
          from: 'open',
          to: 'in_progress',
          reason: 'popped for review (creating refinery)',
          actor: 'system',
        });
        actions.push({
          type: 'dispatch_agent',
          agent_id: '',
          bead_id: oldestMr[0].bead_id,
          rig_id,
        });
        continue;
      }

      const ref = refinery[0];
      if (ref.status !== 'idle' || ref.current_hook_bead_id) continue;

      actions.push({
        type: 'transition_bead',
        bead_id: oldestMr[0].bead_id,
        from: 'open',
        to: 'in_progress',
        reason: 'popped for review',
        actor: 'system',
      });
      actions.push({
        type: 'hook_agent',
        agent_id: ref.bead_id,
        bead_id: oldestMr[0].bead_id,
      });
      actions.push({
        type: 'dispatch_agent',
        agent_id: ref.bead_id,
        bead_id: oldestMr[0].bead_id,
        rig_id,
      });
    }

    // Rule 6: Idle refinery hooked to in_progress MR — needs re-dispatch
    const idleRefineries = AgentRow.array().parse([
      ...query(
        sql,
        /* sql */ `
        SELECT ${agent_metadata.bead_id}, ${agent_metadata.role},
               ${agent_metadata.status}, ${agent_metadata.current_hook_bead_id},
               ${agent_metadata.dispatch_attempts},
               ${agent_metadata.last_activity_at},
               b.${beads.columns.rig_id}
        FROM ${agent_metadata}
        LEFT JOIN ${beads} b ON b.${beads.columns.bead_id} = ${agent_metadata.bead_id}
        WHERE ${agent_metadata.columns.role} = 'refinery'
          AND ${agent_metadata.status} = 'idle'
          AND ${agent_metadata.current_hook_bead_id} IS NOT NULL
      `,
        []
      ),
    ]);

    for (const ref of idleRefineries) {
      if (!ref.current_hook_bead_id) continue;

      // Read the bead's dispatch_attempts for the per-bead circuit breaker
      const mrRows = z
        .object({
          status: z.string(),
          type: z.string(),
          rig_id: z.string().nullable(),
          dispatch_attempts: z.number(),
          last_dispatch_attempt_at: z.string().nullable(),
        })
        .array()
        .parse([
          ...query(
            sql,
            /* sql */ `
          SELECT ${beads.status}, ${beads.type}, ${beads.rig_id},
                 ${beads.dispatch_attempts}, ${beads.last_dispatch_attempt_at}
          FROM ${beads}
          WHERE ${beads.bead_id} = ?
        `,
            [ref.current_hook_bead_id]
          ),
        ]);

      if (mrRows.length === 0) continue;
      const mr = mrRows[0];
      if (mr.type !== 'merge_request' || mr.status !== 'in_progress') continue;

      if (draining) {
        console.log(
          `${LOG} Town is draining, skipping dispatch for bead ${ref.current_hook_bead_id}`
        );
        continue;
      }

      const rigId = mr.rig_id ?? ref.rig_id ?? null;

      // Per-bead dispatch cap — check before cooldown so max-attempt MR
      // beads are failed immediately rather than waiting for the cooldown.
      if (mr.dispatch_attempts >= rigMaxDispatchAttempts(rigId)) {
        actions.push({
          type: 'transition_bead',
          bead_id: ref.current_hook_bead_id,
          from: null,
          to: 'failed',
          reason: `refinery max dispatch attempts exceeded (${mr.dispatch_attempts})`,
          actor: 'system',
        });
        actions.push({
          type: 'unhook_agent',
          agent_id: ref.bead_id,
          reason: 'max dispatch attempts',
        });
        continue;
      }

      // Exponential backoff using bead's last_dispatch_attempt_at
      const cooldownMs = getDispatchCooldownMs(mr.dispatch_attempts);
      if (!staleMs(mr.last_dispatch_attempt_at, cooldownMs)) continue;

      // Town-level circuit breaker suppresses dispatch
      if (circuitBreakerOpen) continue;

      // Container status is checked at apply time (async). In shadow mode,
      // we just note that a dispatch is needed.
      actions.push({
        type: 'dispatch_agent',
        agent_id: ref.bead_id,
        bead_id: ref.current_hook_bead_id,
        rig_id: rigId ?? '',
      });
    }
  } // end Rules 5–6 block

  // Rule 7: Working refinery hooked to a terminal MR bead — stop it.
  // This catches the race where auto-merge closes the MR bead while the
  // refinery is still running in the container. Without this, the refinery
  // can post review comments on an already-merged PR.
  const workingRefineries = AgentRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${agent_metadata.bead_id}, ${agent_metadata.role},
               ${agent_metadata.status}, ${agent_metadata.current_hook_bead_id},
               ${agent_metadata.dispatch_attempts},
               ${agent_metadata.last_activity_at},
               b.${beads.columns.rig_id}
        FROM ${agent_metadata}
        LEFT JOIN ${beads} b ON b.${beads.columns.bead_id} = ${agent_metadata.bead_id}
        WHERE ${agent_metadata.columns.role} = 'refinery'
          AND ${agent_metadata.status} IN ('working', 'stalled')
          AND ${agent_metadata.current_hook_bead_id} IS NOT NULL
      `,
      []
    ),
  ]);

  for (const ref of workingRefineries) {
    if (!ref.current_hook_bead_id) continue;
    const mr = beadOps.getBead(sql, ref.current_hook_bead_id);
    if (!mr || (mr.status !== 'closed' && mr.status !== 'failed')) continue;

    actions.push({
      type: 'stop_agent',
      agent_id: ref.bead_id,
      reason: `MR bead ${ref.current_hook_bead_id} is ${mr.status}`,
    });
    actions.push({
      type: 'unhook_agent',
      agent_id: ref.bead_id,
      reason: `MR bead ${mr.status} — cleanup`,
    });
    // Transition to idle immediately so the agent doesn't spend a tick
    // in an inconsistent working+unhooked state.
    actions.push({
      type: 'transition_agent',
      agent_id: ref.bead_id,
      from: ref.status,
      to: 'idle',
      reason: `MR bead ${mr.status} — cleanup`,
    });
  }

  return actions;
}

// ════════════════════════════════════════════════════════════════════
// reconcileConvoys — track convoy progress, trigger landing
// ════════════════════════════════════════════════════════════════════

export function reconcileConvoys(sql: SqlStorage): Action[] {
  const actions: Action[] = [];

  const convoys = ConvoyRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT b.${beads.columns.bead_id}, b.${beads.columns.status},
               cm.${convoy_metadata.columns.total_beads} as total_beads,
               cm.${convoy_metadata.columns.closed_beads} as closed_beads,
               cm.${convoy_metadata.columns.feature_branch} as feature_branch,
               cm.${convoy_metadata.columns.merge_mode} as merge_mode,
               cm.${convoy_metadata.columns.staged} as staged,
               b.${beads.columns.metadata} as metadata
        FROM ${beads} b
        INNER JOIN ${convoy_metadata} cm ON cm.${convoy_metadata.columns.bead_id} = b.${beads.columns.bead_id}
        WHERE b.${beads.columns.type} = 'convoy'
          AND b.${beads.columns.status} = 'open'
      `,
      []
    ),
  ]);

  for (const convoy of convoys) {
    // Count actually closed tracked beads
    const progressRows = z
      .object({ closed_count: z.number(), total_count: z.number() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
          SELECT
            count(CASE WHEN tracked.${beads.columns.status} IN ('closed', 'failed') THEN 1 END) as closed_count,
            count(*) as total_count
          FROM ${bead_dependencies} bd
          INNER JOIN ${beads} tracked ON tracked.${beads.columns.bead_id} = bd.${bead_dependencies.columns.bead_id}
          WHERE bd.${bead_dependencies.columns.depends_on_bead_id} = ?
            AND bd.${bead_dependencies.columns.dependency_type} = 'tracks'
            AND tracked.${beads.columns.type} = 'issue'
        `,
          [convoy.bead_id]
        ),
      ]);

    if (progressRows.length === 0) continue;
    const { closed_count, total_count } = progressRows[0];

    // Parse convoy metadata for landing MR tracking fields (#2260)
    let parsedMeta: Record<string, unknown> = {};
    try {
      parsedMeta = JSON.parse(convoy.metadata) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    const landingMrAttempts =
      typeof parsedMeta.landing_mr_attempts === 'number' ? parsedMeta.landing_mr_attempts : 0;
    const lastLandingMrAttemptAt =
      typeof parsedMeta.last_landing_mr_attempt_at === 'string'
        ? parsedMeta.last_landing_mr_attempt_at
        : null;

    // Check for in-flight MR beads (open or in_progress) for tracked issue beads
    const inFlightMrCount = z
      .object({ cnt: z.number() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
          SELECT count(*) as cnt
          FROM ${bead_dependencies} track_dep
          INNER JOIN ${bead_dependencies} mr_dep
            ON mr_dep.${bead_dependencies.columns.depends_on_bead_id} = track_dep.${bead_dependencies.columns.bead_id}
          INNER JOIN ${beads} mr
            ON mr.${beads.columns.bead_id} = mr_dep.${bead_dependencies.columns.bead_id}
          WHERE track_dep.${bead_dependencies.columns.depends_on_bead_id} = ?
            AND track_dep.${bead_dependencies.columns.dependency_type} = 'tracks'
            AND mr_dep.${bead_dependencies.columns.dependency_type} = 'tracks'
            AND mr.${beads.columns.type} = 'merge_request'
            AND mr.${beads.columns.status} IN ('open', 'in_progress')
        `,
          [convoy.bead_id]
        ),
      ]);

    const hasInFlightReviews = (inFlightMrCount[0]?.cnt ?? 0) > 0;

    // Check if all beads done
    const allBeadsDone = closed_count >= total_count && total_count > 0 && !hasInFlightReviews;

    // Update progress if stale (skip if we're failing/closing the convoy this tick)
    if (closed_count !== convoy.closed_beads) {
      actions.push({
        type: 'update_convoy_progress',
        convoy_id: convoy.bead_id,
        closed_beads: closed_count,
      });
    }

    if (!allBeadsDone) continue;

    if (convoy.merge_mode === 'review-then-land' && convoy.feature_branch) {
      if (!parsedMeta.ready_to_land) {
        actions.push({
          type: 'set_convoy_ready_to_land',
          convoy_id: convoy.bead_id,
        });
      }

      if (parsedMeta.ready_to_land) {
        // Check if a landing MR already exists (any status)
        const landingMrs = z
          .object({ status: z.string() })
          .array()
          .parse([
            ...query(
              sql,
              /* sql */ `
                SELECT mr.${beads.columns.status}
                FROM ${bead_dependencies} bd
                INNER JOIN ${beads} mr ON mr.${beads.columns.bead_id} = bd.${bead_dependencies.columns.bead_id}
                WHERE bd.${bead_dependencies.columns.depends_on_bead_id} = ?
                  AND bd.${bead_dependencies.columns.dependency_type} = 'tracks'
                  AND mr.${beads.columns.type} = 'merge_request'
              `,
              [convoy.bead_id]
            ),
          ]);

        // If a landing MR was already merged (closed), close the convoy
        const hasMergedLanding = landingMrs.some(mr => mr.status === 'closed');
        if (hasMergedLanding) {
          actions.push({
            type: 'close_convoy',
            convoy_id: convoy.bead_id,
          });
          continue;
        }

        // Fix 1 (#2260): If a landing MR is active (open or in_progress), wait — don't create another
        const hasActiveLanding = landingMrs.some(
          mr => mr.status === 'open' || mr.status === 'in_progress'
        );
        if (hasActiveLanding) continue;

        // Fix 2 (#2260): If max landing MR attempts exceeded and no landing MR is
        // active or merged, fail the convoy. Checked after landing MR status lookup
        // so the final allowed attempt can still succeed.
        if (landingMrAttempts >= MAX_LANDING_MR_ATTEMPTS) {
          actions.push({
            type: 'fail_convoy',
            convoy_id: convoy.bead_id,
            reason: `Landing MR creation failed after ${MAX_LANDING_MR_ATTEMPTS} attempts`,
          });
          continue;
        }

        // Fix 2 (#2260): Apply exponential cooldown between landing MR attempts
        if (landingMrAttempts > 0 && lastLandingMrAttemptAt) {
          const elapsed = Date.now() - new Date(lastLandingMrAttemptAt).getTime();
          const cooldownMs = Math.min(
            Math.pow(2, landingMrAttempts) * LANDING_MR_COOLDOWN_BASE_MS,
            LANDING_MR_COOLDOWN_MAX_MS
          );
          if (elapsed < cooldownMs) continue;
        }

        // Fix 3 (#2260): Check that tracked beads have at least one MR with a PR URL.
        // For review-then-land convoys using direct merge strategy, intermediate bead
        // merges go straight into the feature branch without persisting a pr_url —
        // skip this guard and always create the landing MR when all beads are closed.
        const needsPrUrl = convoy.merge_mode !== 'review-then-land';
        if (needsPrUrl) {
          const convoyBeadsWithPr = z
            .object({ cnt: z.number() })
            .array()
            .parse([
              ...query(
                sql,
                /* sql */ `
                  SELECT count(*) as cnt
                  FROM ${bead_dependencies} track_dep
                  INNER JOIN ${bead_dependencies} mr_dep
                    ON mr_dep.${bead_dependencies.columns.depends_on_bead_id} = track_dep.${bead_dependencies.columns.bead_id}
                  INNER JOIN ${review_metadata} rm
                    ON rm.${review_metadata.columns.bead_id} = mr_dep.${bead_dependencies.columns.bead_id}
                  WHERE track_dep.${bead_dependencies.columns.depends_on_bead_id} = ?
                    AND track_dep.${bead_dependencies.columns.dependency_type} = 'tracks'
                    AND mr_dep.${bead_dependencies.columns.dependency_type} = 'tracks'
                    AND rm.${review_metadata.columns.pr_url} IS NOT NULL
                `,
                [convoy.bead_id]
              ),
            ]);

          if ((convoyBeadsWithPr[0]?.cnt ?? 0) === 0) {
            console.warn(
              `${LOG} convoy ${convoy.bead_id} has no beads with pr_url — skipping create_landing_mr`
            );
            continue;
          }
        }

        // No landing MR exists yet and cooldown has passed — create one
        {
          const rigRows = z
            .object({ rig_id: z.string() })
            .array()
            .parse([
              ...query(
                sql,
                /* sql */ `
                  SELECT DISTINCT tracked.${beads.columns.rig_id} as rig_id
                  FROM ${bead_dependencies} bd
                  INNER JOIN ${beads} tracked ON tracked.${beads.columns.bead_id} = bd.${bead_dependencies.columns.bead_id}
                  WHERE bd.${bead_dependencies.columns.depends_on_bead_id} = ?
                    AND bd.${bead_dependencies.columns.dependency_type} = 'tracks'
                    AND tracked.${beads.columns.rig_id} IS NOT NULL
                  LIMIT 1
                `,
                [convoy.bead_id]
              ),
            ]);

          if (rigRows.length > 0) {
            const rig = getRig(sql, rigRows[0].rig_id);
            actions.push({
              type: 'create_landing_mr',
              convoy_id: convoy.bead_id,
              rig_id: rigRows[0].rig_id,
              feature_branch: convoy.feature_branch,
              target_branch: rig?.default_branch ?? 'main',
            });
          }
        }
      }
    } else {
      // review-and-merge or no feature branch — auto-close
      actions.push({
        type: 'close_convoy',
        convoy_id: convoy.bead_id,
      });
    }
  }

  return actions;
}

// ════════════════════════════════════════════════════════════════════
// reconcileGUPP — detect agents exceeding activity thresholds
// ════════════════════════════════════════════════════════════════════

export function reconcileGUPP(sql: SqlStorage, opts?: { draining?: boolean }): Action[] {
  // During container drain the heartbeat reporter is stopped, so
  // last_event_at freezes. Skip GUPP checks entirely to avoid
  // false-positive "idle for 15 minutes" nudges while agents are
  // still actively working in the draining container.
  if (opts?.draining) return [];
  const actions: Action[] = [];

  const workingAgents = AgentRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${agent_metadata.bead_id}, ${agent_metadata.role},
               ${agent_metadata.status}, ${agent_metadata.current_hook_bead_id},
               ${agent_metadata.dispatch_attempts},
               ${agent_metadata.last_activity_at},
               ${agent_metadata.last_event_type},
               ${agent_metadata.last_event_at},
               ${agent_metadata.active_tools},
               b.${beads.columns.rig_id}
        FROM ${agent_metadata}
        LEFT JOIN ${beads} b ON b.${beads.columns.bead_id} = ${agent_metadata.bead_id}
        WHERE ${agent_metadata.status} IN ('working', 'stalled')
          AND ${agent_metadata.role} != 'mayor'
      `,
      []
    ),
  ]);

  for (const agent of workingAgents) {
    // Use last_event_at (SDK activity) as primary signal, fall back to
    // last_activity_at (heartbeat). Agents with no heartbeat at all are
    // handled by reconcileAgents (NULL-heartbeat check), so skip them here.
    const activityTimestamp = agent.last_event_at ?? agent.last_activity_at;
    if (!activityTimestamp) continue;

    const elapsed = Date.now() - new Date(activityTimestamp).getTime();
    if (Number.isNaN(elapsed) || elapsed < 0) continue;

    if (elapsed > GUPP_FORCE_STOP_MS) {
      actions.push({
        type: 'transition_agent',
        agent_id: agent.bead_id,
        from: agent.status,
        to: 'stalled',
        reason: 'GUPP force stop — no SDK activity for 2h',
      });
      actions.push({
        type: 'stop_agent',
        agent_id: agent.bead_id,
        reason: 'exceeded 2h GUPP limit',
      });
      actions.push({
        type: 'create_triage_request',
        agent_id: agent.bead_id,
        triage_type: 'stuck_agent',
        reason: 'GUPP force stop',
      });
    } else if (elapsed > GUPP_ESCALATE_MS) {
      if (!hasRecentNudge(sql, agent.bead_id, 'escalate')) {
        actions.push({
          type: 'send_nudge',
          agent_id: agent.bead_id,
          message:
            'You have been working for over 1 hour without completing your task. Please wrap up or report if you are stuck.',
          tier: 'escalate',
        });
        actions.push({
          type: 'create_triage_request',
          agent_id: agent.bead_id,
          triage_type: 'stuck_agent',
          reason: 'GUPP escalation',
        });
      }
    } else if (elapsed > 15 * 60_000) {
      // Tighter warn threshold (15min vs old 30min) using SDK activity.
      // Skip if agent is mid-tool-call — long-running tools like git clone are normal.
      let tools: string[] = [];
      try {
        tools = JSON.parse(agent.active_tools ?? '[]') as string[];
      } catch {
        /* ignore */
      }

      if (tools.length === 0 && !hasRecentNudge(sql, agent.bead_id, 'warn')) {
        actions.push({
          type: 'send_nudge',
          agent_id: agent.bead_id,
          message:
            'You have been idle for 15 minutes with no tool activity. Please check your progress.',
          tier: 'warn',
        });
      }
    }
  }

  return actions;
}

// ════════════════════════════════════════════════════════════════════
// reconcileGC — garbage-collect idle agents with no hook
// ════════════════════════════════════════════════════════════════════

export function reconcileGC(sql: SqlStorage): Action[] {
  const actions: Action[] = [];

  const gcCandidates = AgentRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${agent_metadata.bead_id}, ${agent_metadata.role},
               ${agent_metadata.status}, ${agent_metadata.current_hook_bead_id},
               ${agent_metadata.dispatch_attempts},
               ${agent_metadata.last_activity_at},
               b.${beads.columns.rig_id}
        FROM ${agent_metadata}
        LEFT JOIN ${beads} b ON b.${beads.columns.bead_id} = ${agent_metadata.bead_id}
        WHERE ${agent_metadata.status} IN ('idle', 'dead')
          AND ${agent_metadata.columns.role} IN ('polecat', 'refinery')
          AND ${agent_metadata.current_hook_bead_id} IS NULL
      `,
      []
    ),
  ]);

  for (const agent of gcCandidates) {
    if (staleMs(agent.last_activity_at, AGENT_GC_RETENTION_MS)) {
      actions.push({
        type: 'delete_agent',
        agent_id: agent.bead_id,
        reason: 'GC: idle > 24h',
      });
    }
  }

  return actions;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Check if an MR bead has open rework beads blocking it. */
function hasUnresolvedReworkBlockers(sql: SqlStorage, mrBeadId: string): boolean {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT 1 FROM ${bead_dependencies} bd
        INNER JOIN ${beads} rework ON rework.${beads.columns.bead_id} = bd.${bead_dependencies.columns.depends_on_bead_id}
        WHERE bd.${bead_dependencies.columns.bead_id} = ?
          AND bd.${bead_dependencies.columns.dependency_type} = 'blocks'
          AND rework.${beads.columns.status} NOT IN ('closed', 'failed')
        LIMIT 1
      `,
      [mrBeadId]
    ),
  ];
  return rows.length > 0;
}

function hasWorkingAgentHooked(sql: SqlStorage, beadId: string): boolean {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT 1 FROM ${agent_metadata}
        WHERE ${agent_metadata.current_hook_bead_id} = ?
          AND ${agent_metadata.status} IN ('working', 'stalled')
        LIMIT 1
      `,
      [beadId]
    ),
  ];
  return rows.length > 0;
}

function hasAnyAgentHooked(sql: SqlStorage, beadId: string): boolean {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT 1 FROM ${agent_metadata}
        WHERE ${agent_metadata.current_hook_bead_id} = ?
        LIMIT 1
      `,
      [beadId]
    ),
  ];
  return rows.length > 0;
}

function getIdleAgentHookedTo(sql: SqlStorage, beadId: string): string | null {
  const rows = z
    .object({ bead_id: z.string() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
        SELECT ${agent_metadata.bead_id}
        FROM ${agent_metadata}
        WHERE ${agent_metadata.current_hook_bead_id} = ?
          AND ${agent_metadata.status} = 'idle'
        LIMIT 1
      `,
        [beadId]
      ),
    ]);
  return rows.length > 0 ? rows[0].bead_id : null;
}

function hasRecentNudge(sql: SqlStorage, agentId: string, tier: string): boolean {
  // Check if a nudge with this exact tier source was created in the last 60 min.
  // The source is set to `reconciler:${tier}` by applyAction('send_nudge').
  // Use SQLite's datetime() for the cutoff so the comparison works regardless
  // of whether created_at was stored in SQLite's native 'YYYY-MM-DD HH:MM:SS'
  // format (old rows) or ISO 8601 'YYYY-MM-DDTHH:MM:SS.000Z' (new rows).
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT 1 FROM ${agent_nudges}
        WHERE ${agent_nudges.agent_bead_id} = ?
          AND ${agent_nudges.source} = ?
          AND datetime(${agent_nudges.created_at}) > datetime('now', '-60 minutes')
        LIMIT 1
      `,
      [agentId, `reconciler:${tier}`]
    ),
  ];
  return rows.length > 0;
}

/** Check if an MR bead has a non-terminal conflict bead (gt:pr-conflict) blocking it. */
function hasExistingPrConflictBead(sql: SqlStorage, mrBeadId: string): boolean {
  return getExistingPrConflictBeadId(sql, mrBeadId) !== null;
}

/** Return the bead_id of a non-terminal conflict bead (gt:pr-conflict) blocking the MR, or null. */
function getExistingPrConflictBeadId(sql: SqlStorage, mrBeadId: string): string | null {
  const rows = z
    .object({ bead_id: z.string() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
          SELECT fb.${beads.columns.bead_id}
          FROM ${bead_dependencies} bd
          INNER JOIN ${beads} fb ON fb.${beads.columns.bead_id} = bd.${bead_dependencies.columns.depends_on_bead_id}
          WHERE bd.${bead_dependencies.columns.bead_id} = ?
            AND bd.${bead_dependencies.columns.dependency_type} = 'blocks'
            AND fb.${beads.columns.labels} LIKE '%gt:pr-conflict%'
            AND fb.${beads.columns.status} NOT IN ('closed', 'failed')
          LIMIT 1
        `,
        [mrBeadId]
      ),
    ]);
  return rows.length > 0 ? rows[0].bead_id : null;
}

/** Check if an MR bead has a non-terminal feedback bead (gt:pr-feedback) blocking it. */
function hasExistingPrFeedbackBead(sql: SqlStorage, mrBeadId: string): boolean {
  return getExistingPrFeedbackBeadId(sql, mrBeadId) !== null;
}

/** Return the bead_id of a non-terminal feedback bead (gt:pr-feedback) blocking the MR, or null. */
function getExistingPrFeedbackBeadId(sql: SqlStorage, mrBeadId: string): string | null {
  const rows = z
    .object({ bead_id: z.string() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
          SELECT fb.${beads.columns.bead_id}
          FROM ${bead_dependencies} bd
          INNER JOIN ${beads} fb ON fb.${beads.columns.bead_id} = bd.${bead_dependencies.columns.depends_on_bead_id}
          WHERE bd.${bead_dependencies.columns.bead_id} = ?
            AND bd.${bead_dependencies.columns.dependency_type} = 'blocks'
            AND fb.${beads.columns.labels} LIKE '%gt:pr-feedback%'
            AND fb.${beads.columns.status} NOT IN ('closed', 'failed')
          LIMIT 1
        `,
        [mrBeadId]
      ),
    ]);
  return rows.length > 0 ? rows[0].bead_id : null;
}

/** Build a human-readable title for the feedback bead. */
function buildFeedbackBeadTitle(
  prNumber: number,
  repo: string,
  hasComments: boolean,
  hasFailingChecks: boolean,
  hasUncheckedRuns = false
): string {
  const parts: string[] = [];
  if (hasComments) parts.push('review comments');
  if (hasFailingChecks) parts.push('failing CI');
  if (hasUncheckedRuns && !hasFailingChecks) parts.push('unchecked CI runs');
  const shortRepo = repo.includes('/') ? repo.split('/').pop() : repo;
  return `Address ${parts.join(' & ')} on PR #${prNumber}${shortRepo ? ` (${shortRepo})` : ''}`;
}

/** Build the polecat prompt body for addressing PR feedback. */
function buildFeedbackPrompt(
  prNumber: number,
  repo: string,
  branch: string,
  hasComments: boolean,
  hasFailingChecks: boolean,
  hasUncheckedRuns = false
): string {
  const lines: string[] = [];
  lines.push(`You are addressing feedback on PR #${prNumber} on ${repo}, branch ${branch}.`);
  lines.push('');

  if (hasComments && hasFailingChecks) {
    lines.push('This PR has both unresolved review comments and failing CI checks.');
    lines.push(
      'Address the review comments first, then fix the CI failures, as comment fixes may also resolve some CI issues.'
    );
  } else if (hasComments && hasUncheckedRuns) {
    lines.push(
      'This PR has unresolved review comments and more than 100 CI check-runs (not all could be inspected). Address the review comments and verify CI status.'
    );
  } else if (hasComments) {
    lines.push('This PR has unresolved review comments.');
  } else if (hasFailingChecks) {
    lines.push('This PR has failing CI checks.');
  } else if (hasUncheckedRuns) {
    lines.push(
      'This PR has more than 100 CI check-runs. Not all could be inspected by the system. Check `gh pr checks` for the full status and fix any failures.'
    );
  }

  lines.push('');
  lines.push('## Review Comments');
  lines.push('');
  lines.push(`Run \`gh pr view ${prNumber} --comments\` to see all review comments.`);
  lines.push('');
  lines.push('For each unresolved comment thread:');
  lines.push(
    "- If it's a relevant code fix: make the change, push, reply explaining what you did, and resolve the thread"
  );
  lines.push("- If it's not relevant: reply explaining why, and resolve the thread");
  lines.push('');
  lines.push("It's important to resolve the full thread rather than just the base comment.");
  lines.push('');
  lines.push('## CI Checks');
  lines.push('');
  lines.push(`Run \`gh pr checks ${prNumber}\` to see the status of all CI checks.`);
  lines.push('');
  lines.push('For each failing check:');
  lines.push('- Read the failure logs via `gh run view <run_id> --log-failed`');
  lines.push('- Fix the underlying issue (test failure, lint error, type error, etc.)');
  lines.push('- Push the fix');
  lines.push('- Verify the check passes by reviewing the new run');
  lines.push('');
  lines.push(
    'After addressing everything, push all changes in a single commit (or minimal commits) and call gt_done.'
  );

  return lines.join('\n');
}

/** Build the polecat prompt body for resolving merge conflicts on a PR branch. */
function buildConflictResolutionPrompt(
  prUrl: string,
  branch: string,
  targetBranch: string
): string {
  const lines: string[] = [];
  lines.push(`You are resolving merge conflicts on branch \`${branch}\`.`);
  lines.push(`The PR is: ${prUrl}`);
  lines.push(`The target branch is: \`${targetBranch}\``);
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  lines.push('1. Fetch the latest state of the remote:');
  lines.push('   ```');
  lines.push('   git fetch origin');
  lines.push('   ```');
  lines.push('');
  lines.push(`2. Rebase your branch onto the target branch to incorporate its latest changes:`);
  lines.push('   ```');
  lines.push(`   git rebase origin/${targetBranch}`);
  lines.push('   ```');
  lines.push('');
  lines.push('3. If there are conflicts during rebase, resolve them:');
  lines.push(
    '   - Edit the conflicting files to resolve the conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)'
  );
  lines.push('   - Stage the resolved files: `git add <file>`');
  lines.push('   - Continue the rebase: `git rebase --continue`');
  lines.push('   - Repeat until the rebase completes');
  lines.push('');
  lines.push('4. Push the rebased branch:');
  lines.push('   ```');
  lines.push(`   git push --force-with-lease origin ${branch}`);
  lines.push('   ```');
  lines.push('');
  lines.push('5. Call `gt_done` once the push succeeds, passing both required arguments:');
  lines.push(`   - \`pr_url\`: \`${prUrl}\``);
  lines.push(`   - \`branch\`: \`${branch}\``);

  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════
// Invariant checker — runs after action application to detect
// violations of the system invariants from spec §6.
// ════════════════════════════════════════════════════════════════════

export type Violation = {
  invariant: number;
  message: string;
};

/**
 * Check all system invariants. Returns violations found.
 * Should run at the end of each alarm tick after actions are applied.
 * See reconciliation-spec.md §6.
 */
export function checkInvariants(sql: SqlStorage): Violation[] {
  const violations: Violation[] = [];

  // Invariant 7: Working agents must have hooks
  // Mayors are always 'working' and intentionally have no hook — exclude them.
  const unhookedWorkers = z
    .object({ bead_id: z.string() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
        SELECT ${agent_metadata.bead_id}
        FROM ${agent_metadata}
        WHERE ${agent_metadata.status} = 'working'
          AND ${agent_metadata.current_hook_bead_id} IS NULL
          AND ${agent_metadata.role} != 'mayor'
      `,
        []
      ),
    ]);
  for (const a of unhookedWorkers) {
    violations.push({
      invariant: 7,
      message: `Working agent ${a.bead_id} has no hook`,
    });
  }

  // Invariant 5: Convoy beads should not be in unexpected states.
  // Valid states: open, in_progress, in_review, closed, failed.
  // 'failed' is a terminal state set by FailConvoy when landing MR
  // creation is exhausted.
  const badStateConvoys = z
    .object({ bead_id: z.string(), status: z.string() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
        SELECT ${beads.bead_id}, ${beads.status}
        FROM ${beads}
        WHERE ${beads.type} = 'convoy'
          AND ${beads.status} NOT IN ('open', 'in_progress', 'in_review', 'closed', 'failed')
      `,
        []
      ),
    ]);
  for (const c of badStateConvoys) {
    violations.push({
      invariant: 5,
      message: `Convoy bead ${c.bead_id} is in unexpected state '${c.status}'`,
    });
  }

  // Invariant 3: Only one MR bead in_progress per rig (refinery is serial)
  const duplicateMrPerRig = z
    .object({ rig_id: z.string(), cnt: z.number() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
        SELECT ${beads.rig_id} as rig_id, count(*) as cnt
        FROM ${beads}
        WHERE ${beads.type} = 'merge_request'
          AND ${beads.status} = 'in_progress'
          AND ${beads.rig_id} IS NOT NULL
        GROUP BY ${beads.rig_id}
        HAVING count(*) > 1
      `,
        []
      ),
    ]);
  for (const r of duplicateMrPerRig) {
    violations.push({
      invariant: 3,
      message: `Rig ${r.rig_id} has ${r.cnt} in_progress MR beads (should be at most 1)`,
    });
  }

  // Invariant 6: At most one agent hooked per bead
  const multiHooked = z
    .object({ hook: z.string(), cnt: z.number() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
        SELECT ${agent_metadata.current_hook_bead_id} as hook, count(*) as cnt
        FROM ${agent_metadata}
        WHERE ${agent_metadata.current_hook_bead_id} IS NOT NULL
        GROUP BY ${agent_metadata.current_hook_bead_id}
        HAVING count(*) > 1
      `,
        []
      ),
    ]);
  for (const m of multiHooked) {
    violations.push({
      invariant: 6,
      message: `Bead ${m.hook} has ${m.cnt} agents hooked (should be at most 1)`,
    });
  }

  // Invariant 4: in_review beads must have at least one open/in_progress MR
  const orphanedInReview = z
    .object({ bead_id: z.string() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
        SELECT b.${beads.columns.bead_id}
        FROM ${beads} b
        WHERE b.${beads.columns.type} = 'issue'
          AND b.${beads.columns.status} = 'in_review'
          AND NOT EXISTS (
            SELECT 1
            FROM ${bead_dependencies} bd
            INNER JOIN ${beads} mr ON mr.${beads.columns.bead_id} = bd.${bead_dependencies.columns.bead_id}
            WHERE bd.${bead_dependencies.columns.depends_on_bead_id} = b.${beads.columns.bead_id}
              AND bd.${bead_dependencies.columns.dependency_type} = 'tracks'
              AND mr.${beads.columns.type} = 'merge_request'
              AND mr.${beads.columns.status} IN ('open', 'in_progress')
          )
      `,
        []
      ),
    ]);
  for (const b of orphanedInReview) {
    violations.push({
      invariant: 4,
      message: `Issue bead ${b.bead_id} is in_review but has no open/in_progress MR bead`,
    });
  }

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// Reconciler metrics — collected per alarm tick
// ════════════════════════════════════════════════════════════════════

export type ReconcilerMetrics = {
  eventsDrained: number;
  actionsEmitted: number;
  actionsByType: Record<string, number>;
  sideEffectsAttempted: number;
  sideEffectsSucceeded: number;
  sideEffectsFailed: number;
  invariantViolations: number;
  wallClockMs: number;
  pendingEventCount: number;
};
