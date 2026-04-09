/**
 * Reconciler action types and application.
 *
 * Actions are the reconciler's outputs — they describe mutations to apply
 * and side effects to execute. Nothing mutates bead/agent/convoy state
 * directly; all mutations flow through applyAction().
 *
 * See reconciliation-spec.md §4.
 */

import { z } from 'zod';
import { beads } from '../../db/tables/beads.table';
import { agent_metadata } from '../../db/tables/agent-metadata.table';
import { convoy_metadata } from '../../db/tables/convoy-metadata.table';
import { bead_dependencies } from '../../db/tables/bead-dependencies.table';
import { agent_nudges } from '../../db/tables/agent-nudges.table';
import { review_metadata } from '../../db/tables/review-metadata.table';
import { query } from '../../util/query.util';
import * as beadOps from './beads';
import * as agentOps from './agents';
import * as reviewQueue from './review-queue';
import * as patrol from './patrol';
import { getRig } from './rigs';
import { parseGitUrl } from '../../util/platform-pr.util';

// ── Bead mutations ──────────────────────────────────────────────────

const TransitionBead = z.object({
  type: z.literal('transition_bead'),
  bead_id: z.string(),
  from: z.string().nullable(),
  to: z.string(),
  reason: z.string(),
  actor: z.string(),
});

const AssignBead = z.object({
  type: z.literal('assign_bead'),
  bead_id: z.string(),
  agent_id: z.string(),
});

const ClearBeadAssignee = z.object({
  type: z.literal('clear_bead_assignee'),
  bead_id: z.string(),
});

const CreateMrBead = z.object({
  type: z.literal('create_mr_bead'),
  source_bead_id: z.string(),
  agent_id: z.string(),
  rig_id: z.string(),
  branch: z.string(),
  target_branch: z.string(),
  pr_url: z.string().optional(),
  summary: z.string().optional(),
});

const CreateLandingMr = z.object({
  type: z.literal('create_landing_mr'),
  convoy_id: z.string(),
  rig_id: z.string(),
  feature_branch: z.string(),
  target_branch: z.string(),
});

const CloseSiblingMrs = z.object({
  type: z.literal('close_sibling_mrs'),
  source_bead_id: z.string(),
  exclude_mr_id: z.string(),
});

const SetReviewPrUrl = z.object({
  type: z.literal('set_review_pr_url'),
  bead_id: z.string(),
  pr_url: z.string(),
});

// ── Agent mutations ─────────────────────────────────────────────────

const TransitionAgent = z.object({
  type: z.literal('transition_agent'),
  agent_id: z.string(),
  from: z.string().nullable(),
  to: z.string(),
  reason: z.string(),
});

const HookAgent = z.object({
  type: z.literal('hook_agent'),
  agent_id: z.string(),
  bead_id: z.string(),
});

const UnhookAgent = z.object({
  type: z.literal('unhook_agent'),
  agent_id: z.string(),
  reason: z.string(),
});

const ClearAgentCheckpoint = z.object({
  type: z.literal('clear_agent_checkpoint'),
  agent_id: z.string(),
});

const ResetAgentDispatchAttempts = z.object({
  type: z.literal('reset_agent_dispatch_attempts'),
  agent_id: z.string(),
});

const DeleteAgent = z.object({
  type: z.literal('delete_agent'),
  agent_id: z.string(),
  reason: z.string(),
});

// ── Convoy mutations ────────────────────────────────────────────────

const UpdateConvoyProgress = z.object({
  type: z.literal('update_convoy_progress'),
  convoy_id: z.string(),
  closed_beads: z.number(),
});

const SetConvoyReadyToLand = z.object({
  type: z.literal('set_convoy_ready_to_land'),
  convoy_id: z.string(),
});

const CloseConvoy = z.object({
  type: z.literal('close_convoy'),
  convoy_id: z.string(),
});

// ── Side effects (deferred) ─────────────────────────────────────────

const DispatchAgent = z.object({
  type: z.literal('dispatch_agent'),
  agent_id: z.string(),
  bead_id: z.string(),
  rig_id: z.string(),
});

const StopAgent = z.object({
  type: z.literal('stop_agent'),
  agent_id: z.string(),
  reason: z.string(),
});

const PollPr = z.object({
  type: z.literal('poll_pr'),
  bead_id: z.string(),
  pr_url: z.string(),
});

const SendNudge = z.object({
  type: z.literal('send_nudge'),
  agent_id: z.string(),
  message: z.string(),
  tier: z.enum(['warn', 'escalate', 'force_stop']),
});

const CreateTriageRequest = z.object({
  type: z.literal('create_triage_request'),
  agent_id: z.string(),
  triage_type: z.string(),
  reason: z.string(),
});

const NotifyMayor = z.object({
  type: z.literal('notify_mayor'),
  message: z.string(),
});

const MergePr = z.object({
  type: z.literal('merge_pr'),
  bead_id: z.string(),
  pr_url: z.string(),
});

const EmitEvent = z.object({
  type: z.literal('emit_event'),
  event_name: z.string(),
  data: z.record(z.string(), z.unknown()),
});

// ── Union ───────────────────────────────────────────────────────────

export const Action = z.discriminatedUnion('type', [
  // Bead mutations
  TransitionBead,
  AssignBead,
  ClearBeadAssignee,
  CreateMrBead,
  CreateLandingMr,
  CloseSiblingMrs,
  SetReviewPrUrl,
  // Agent mutations
  TransitionAgent,
  ResetAgentDispatchAttempts,
  HookAgent,
  UnhookAgent,
  ClearAgentCheckpoint,
  DeleteAgent,
  // Convoy mutations
  UpdateConvoyProgress,
  SetConvoyReadyToLand,
  CloseConvoy,
  // Side effects
  DispatchAgent,
  StopAgent,
  PollPr,
  MergePr,
  SendNudge,
  CreateTriageRequest,
  NotifyMayor,
  EmitEvent,
]);

export type Action = z.infer<typeof Action>;

// ── Per-type exports for construction ───────────────────────────────
// These aren't validated at construction time (they're built by the
// reconciler itself), so we export plain type aliases for convenience.

export type TransitionBead = z.infer<typeof TransitionBead>;
export type AssignBead = z.infer<typeof AssignBead>;
export type ClearBeadAssignee = z.infer<typeof ClearBeadAssignee>;
export type CreateMrBead = z.infer<typeof CreateMrBead>;
export type CreateLandingMr = z.infer<typeof CreateLandingMr>;
export type CloseSiblingMrs = z.infer<typeof CloseSiblingMrs>;
export type SetReviewPrUrl = z.infer<typeof SetReviewPrUrl>;
export type TransitionAgent = z.infer<typeof TransitionAgent>;
export type ResetAgentDispatchAttempts = z.infer<typeof ResetAgentDispatchAttempts>;
export type HookAgent = z.infer<typeof HookAgent>;
export type UnhookAgent = z.infer<typeof UnhookAgent>;
export type ClearAgentCheckpoint = z.infer<typeof ClearAgentCheckpoint>;
export type DeleteAgent = z.infer<typeof DeleteAgent>;
export type UpdateConvoyProgress = z.infer<typeof UpdateConvoyProgress>;
export type SetConvoyReadyToLand = z.infer<typeof SetConvoyReadyToLand>;
export type CloseConvoy = z.infer<typeof CloseConvoy>;
export type DispatchAgent = z.infer<typeof DispatchAgent>;
export type StopAgent = z.infer<typeof StopAgent>;
export type PollPr = z.infer<typeof PollPr>;
export type MergePr = z.infer<typeof MergePr>;
export type SendNudge = z.infer<typeof SendNudge>;
export type CreateTriageRequest = z.infer<typeof CreateTriageRequest>;
export type NotifyMayor = z.infer<typeof NotifyMayor>;
export type EmitEvent = z.infer<typeof EmitEvent>;

// ── Action application context ──────────────────────────────────────
// applyAction needs access to TownDO-level resources for side effects.
// The SQL handle is for synchronous mutations; the rest are for async
// side effects (dispatch, stop, poll, nudge).

/** Result of checking PR feedback (unresolved comments + failing CI checks). */
export type PRFeedbackCheckResult = {
  hasUnresolvedComments: boolean;
  hasFailingChecks: boolean;
  allChecksPass: boolean;
  /** True when the check-runs response was paginated and not all runs were
   *  inspected. allChecksPass is already false in this case, but
   *  hasFailingChecks only reflects the runs we actually saw. */
  hasUncheckedRuns: boolean;
};

export type ApplyActionContext = {
  sql: SqlStorage;
  townId: string;
  /** Dispatch an agent to its container. Returns true if container accepted. */
  dispatchAgent: (agentId: string, beadId: string, rigId: string) => Promise<boolean>;
  /** Stop an agent's container process. */
  stopAgent: (agentId: string) => Promise<void>;
  /** Check a PR's status via GitHub/GitLab API. Returns 'open'|'merged'|'closed'|null. */
  checkPRStatus: (prUrl: string) => Promise<'open' | 'merged' | 'closed' | null>;
  /** Check PR for unresolved review comments and failing CI checks. */
  checkPRFeedback: (prUrl: string) => Promise<PRFeedbackCheckResult | null>;
  /** Merge a PR via GitHub/GitLab API. */
  mergePR: (prUrl: string) => Promise<boolean>;
  /** Queue a nudge message for an agent. */
  queueNudge: (agentId: string, message: string, tier: string) => Promise<void>;
  /** Insert a town_event for deferred processing (e.g. pr_status_changed). */
  insertEvent: (
    eventType: string,
    params: { agent_id?: string | null; bead_id?: string | null; payload?: Record<string, unknown> }
  ) => void;
  /** Emit an analytics/WebSocket event. */
  emitEvent: (data: Record<string, unknown>) => void;
  /** Get the current town config (read lazily). */
  getTownConfig: () => Promise<{
    refinery?: {
      auto_merge?: boolean;
      auto_resolve_pr_feedback?: boolean;
      auto_merge_delay_minutes?: number | null;
    };
  }>;
};

const LOG = '[actions]';

/** Fail MR bead after this many consecutive null poll results (#1632). */
const PR_POLL_NULL_THRESHOLD = 10;

/** Minimum interval between PR polls per MR bead (ms) (#1632). */
export const PR_POLL_INTERVAL_MS = 60_000; // 1 minute

function now(): string {
  return new Date().toISOString();
}

// ── applyAction ─────────────────────────────────────────────────────

/**
 * Apply a single action. Synchronous SQL mutations happen inline.
 * Async side effects (container dispatch, PR polling, etc.) are returned
 * as a deferred function to be executed after all SQL is committed.
 *
 * See reconciliation-spec.md §5.4.
 */
export function applyAction(ctx: ApplyActionContext, action: Action): (() => Promise<void>) | null {
  const { sql, townId } = ctx;

  switch (action.type) {
    // ── Bead mutations ──────────────────────────────────────────

    case 'transition_bead': {
      try {
        const failureReason =
          action.to === 'failed'
            ? { code: 'reconciler', message: action.reason, source: 'scheduler' }
            : undefined;
        beadOps.updateBeadStatus(sql, action.bead_id, action.to, action.actor, failureReason);
      } catch (err) {
        console.warn(`${LOG} transition_bead failed: bead=${action.bead_id} to=${action.to}`, err);
      }
      return null;
    }

    case 'assign_bead': {
      query(
        sql,
        /* sql */ `
          UPDATE ${beads}
          SET ${beads.columns.assignee_agent_bead_id} = ?,
              ${beads.columns.updated_at} = ?
          WHERE ${beads.bead_id} = ?
        `,
        [action.agent_id, now(), action.bead_id]
      );
      return null;
    }

    case 'clear_bead_assignee': {
      // Clear the assignee on the bead
      query(
        sql,
        /* sql */ `
          UPDATE ${beads}
          SET ${beads.columns.assignee_agent_bead_id} = NULL,
              ${beads.columns.updated_at} = ?
          WHERE ${beads.bead_id} = ?
        `,
        [now(), action.bead_id]
      );
      // Also unhook any agents still pointing at this bead, to prevent
      // split-brain where the bead looks unassigned but agents still hold hooks.
      const hookedAgents = z
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
            [action.bead_id]
          ),
        ]);
      for (const row of hookedAgents) {
        agentOps.unhookBead(sql, row.bead_id);
      }
      return null;
    }

    case 'create_mr_bead': {
      reviewQueue.submitToReviewQueue(sql, {
        agent_id: action.agent_id,
        bead_id: action.source_bead_id,
        rig_id: action.rig_id,
        branch: action.branch,
        pr_url: action.pr_url,
        summary: action.summary,
      });
      return null;
    }

    case 'create_landing_mr': {
      // Create an MR bead for the landing merge (feature branch → main)
      reviewQueue.submitToReviewQueue(sql, {
        agent_id: 'system',
        bead_id: action.convoy_id,
        rig_id: action.rig_id,
        branch: action.feature_branch,
        default_branch: action.target_branch,
      });
      return null;
    }

    case 'close_sibling_mrs': {
      // Find sibling MR beads, then close each via updateBeadStatus for
      // proper terminal guard + bead event logging.
      const siblingRows = z
        .object({ bead_id: z.string() })
        .array()
        .parse([
          ...query(
            sql,
            /* sql */ `
            SELECT ${beads.bead_id}
            FROM ${beads}
            WHERE ${beads.type} = 'merge_request'
              AND ${beads.bead_id} != ?
              AND ${beads.status} NOT IN ('closed', 'failed')
              AND ${beads.bead_id} IN (
                SELECT dep.${bead_dependencies.columns.bead_id}
                FROM ${bead_dependencies} AS dep
                WHERE dep.${bead_dependencies.columns.depends_on_bead_id} = ?
                  AND dep.${bead_dependencies.columns.dependency_type} = 'tracks'
              )
          `,
            [action.exclude_mr_id, action.source_bead_id]
          ),
        ]);
      for (const row of siblingRows) {
        beadOps.updateBeadStatus(sql, row.bead_id, 'closed', 'system');
      }
      return null;
    }

    case 'set_review_pr_url': {
      reviewQueue.setReviewPrUrl(sql, action.bead_id, action.pr_url);
      return null;
    }

    // ── Agent mutations ─────────────────────────────────────────

    case 'transition_agent': {
      try {
        agentOps.updateAgentStatus(sql, action.agent_id, action.to);
      } catch (err) {
        console.warn(
          `${LOG} transition_agent failed: agent=${action.agent_id} to=${action.to}`,
          err
        );
      }
      return null;
    }

    case 'reset_agent_dispatch_attempts': {
      const agentRows = z
        .object({ current_hook_bead_id: z.string().nullable() })
        .array()
        .parse([
          ...query(
            sql,
            /* sql */ `
              SELECT ${agent_metadata.columns.current_hook_bead_id}
              FROM ${agent_metadata}
              WHERE ${agent_metadata.columns.bead_id} = ?
            `,
            [action.agent_id]
          ),
        ]);
      const hookedBeadId = agentRows[0]?.current_hook_bead_id;

      query(
        sql,
        /* sql */ `
          UPDATE ${agent_metadata}
          SET ${agent_metadata.columns.dispatch_attempts} = 0
          WHERE ${agent_metadata.bead_id} = ?
        `,
        [action.agent_id]
      );

      if (hookedBeadId) {
        const beadRows = [
          ...query(
            sql,
            /* sql */ `
              SELECT ${beads.columns.status}, ${beads.columns.type}
              FROM ${beads}
              WHERE ${beads.bead_id} = ?
            `,
            [hookedBeadId]
          ),
        ];
        const status = beadRows[0]?.status;
        const type = beadRows[0]?.type;

        query(
          sql,
          /* sql */ `
            UPDATE ${beads}
            SET ${beads.columns.dispatch_attempts} = 0,
                ${beads.columns.last_dispatch_attempt_at} = NULL
            WHERE ${beads.bead_id} = ?
          `,
          [hookedBeadId]
        );

        if (status === 'failed') {
          beadOps.updateBeadStatus(sql, hookedBeadId, 'open', 'system');
        }

        if (type === 'merge_request') {
          query(
            sql,
            /* sql */ `
              UPDATE ${review_metadata}
              SET ${review_metadata.columns.retry_count} = 0
              WHERE ${review_metadata.bead_id} = ?
            `,
            [hookedBeadId]
          );
        }
      }
      return null;
    }

    case 'hook_agent': {
      try {
        agentOps.hookBead(sql, action.agent_id, action.bead_id);
      } catch (err) {
        console.warn(
          `${LOG} hook_agent failed: agent=${action.agent_id} bead=${action.bead_id}`,
          err
        );
      }
      return null;
    }

    case 'unhook_agent': {
      agentOps.unhookBead(sql, action.agent_id);
      return null;
    }

    case 'clear_agent_checkpoint': {
      agentOps.writeCheckpoint(sql, action.agent_id, null);
      return null;
    }

    case 'delete_agent': {
      try {
        agentOps.deleteAgent(sql, action.agent_id);
      } catch (err) {
        console.warn(`${LOG} delete_agent failed: agent=${action.agent_id}`, err);
      }
      return null;
    }

    // ── Convoy mutations ────────────────────────────────────────

    case 'update_convoy_progress': {
      query(
        sql,
        /* sql */ `
          UPDATE ${convoy_metadata}
          SET ${convoy_metadata.columns.closed_beads} = ?
          WHERE ${convoy_metadata.columns.bead_id} = ?
        `,
        [action.closed_beads, action.convoy_id]
      );
      return null;
    }

    case 'set_convoy_ready_to_land': {
      const timestamp = now();
      query(
        sql,
        /* sql */ `
          UPDATE ${beads}
          SET ${beads.columns.metadata} = json_set(COALESCE(${beads.metadata}, '{}'), '$.ready_to_land', 1),
              ${beads.columns.updated_at} = ?
          WHERE ${beads.bead_id} = ?
        `,
        [timestamp, action.convoy_id]
      );
      return null;
    }

    case 'close_convoy': {
      // Use updateBeadStatus for terminal state guard + bead event logging
      beadOps.updateBeadStatus(sql, action.convoy_id, 'closed', 'system');
      query(
        sql,
        /* sql */ `
          UPDATE ${convoy_metadata}
          SET ${convoy_metadata.columns.landed_at} = ?
          WHERE ${convoy_metadata.columns.bead_id} = ?
        `,
        [now(), action.convoy_id]
      );
      return null;
    }

    // ── Side effects (deferred) ─────────────────────────────────

    case 'dispatch_agent': {
      // Resolve agent if not yet assigned (agent_id is '' for Rule 1 dispatches)
      let agentId = action.agent_id;
      const beadId = action.bead_id;
      const rigId = action.rig_id;

      if (!agentId) {
        // Need to get-or-create an agent for this bead.
        // Infer role from bead type: MR beads need refineries, issue beads need polecats.
        const targetBead = beadOps.getBead(sql, beadId);
        const role = targetBead?.type === 'merge_request' ? 'refinery' : 'polecat';
        try {
          const agent = agentOps.getOrCreateAgent(sql, role, rigId, townId);
          agentOps.hookBead(sql, agent.id, beadId);
          agentId = agent.id;
        } catch (err) {
          console.warn(`${LOG} dispatch_agent: failed to hook agent for bead=${beadId}`, err);
          return null;
        }
      }

      // Set agent to working and bead to in_progress synchronously.
      // dispatch_attempts are NOT incremented here — scheduling.dispatchAgent()
      // is the single source of truth for both agent_metadata and bead counters.
      agentOps.updateAgentStatus(sql, agentId, 'working');
      beadOps.updateBeadStatus(sql, beadId, 'in_progress', agentId);

      const capturedAgentId = agentId;
      return async () => {
        // Best-effort dispatch. If it fails, the agent stays 'working'
        // and the bead stays 'in_progress'. The reconciler detects the
        // mismatch on the next tick (idle agent hooked to in_progress
        // bead) and retries dispatch.
        await ctx.dispatchAgent(capturedAgentId, beadId, rigId).catch(err => {
          console.warn(
            `${LOG} dispatch_agent: container start failed for agent=${capturedAgentId} bead=${beadId}`,
            err
          );
        });
      };
    }

    case 'stop_agent': {
      return async () => {
        try {
          await ctx.stopAgent(action.agent_id);
        } catch (err) {
          console.warn(`${LOG} stop_agent failed: agent=${action.agent_id}`, err);
        }
      };
    }

    case 'poll_pr': {
      // Touch updated_at and record last_poll_at synchronously so the bead
      // doesn't look stale to Rule 4 (orphaned PR review, 30 min timeout).
      // Without this, active polling keeps the PR alive but updated_at was
      // set once at PR creation and never refreshed, causing a false
      // "orphaned" failure after 30 minutes.
      const timestamp = now();
      query(
        sql,
        /* sql */ `
          UPDATE ${beads}
          SET ${beads.columns.updated_at} = ?,
              ${beads.columns.metadata} = json_set(
                COALESCE(${beads.columns.metadata}, '{}'),
                '$.last_poll_at', ?
              )
          WHERE ${beads.bead_id} = ?
        `,
        [timestamp, timestamp, action.bead_id]
      );

      return async () => {
        try {
          const status = await ctx.checkPRStatus(action.pr_url);
          if (status !== null) {
            // Any non-null result resets the consecutive null counter
            query(
              sql,
              /* sql */ `
                UPDATE ${beads}
                SET ${beads.columns.metadata} = json_set(
                  COALESCE(${beads.columns.metadata}, '{}'),
                  '$.poll_null_count', 0
                )
                WHERE ${beads.bead_id} = ?
              `,
              [action.bead_id]
            );
            if (status !== 'open') {
              ctx.insertEvent('pr_status_changed', {
                bead_id: action.bead_id,
                payload: { pr_url: action.pr_url, pr_state: status },
              });
              return;
            }

            // PR is open — check for feedback and auto-merge if configured
            const townConfig = await ctx.getTownConfig();
            const refineryConfig = townConfig.refinery;
            if (!refineryConfig) return;

            const wantsAutoResolve = refineryConfig.auto_resolve_pr_feedback === true;
            const wantsAutoMerge =
              refineryConfig.auto_merge !== false &&
              refineryConfig.auto_merge_delay_minutes !== null &&
              refineryConfig.auto_merge_delay_minutes !== undefined;

            // Fetch feedback once and reuse for both auto-resolve and auto-merge.
            // Each checkPRFeedback call makes 3+ GitHub API requests (GraphQL +
            // check-runs + commit status), so deduplicating halves our API usage.
            const feedback =
              wantsAutoResolve || wantsAutoMerge ? await ctx.checkPRFeedback(action.pr_url) : null;

            // Auto-resolve PR feedback: detect unresolved comments and failing CI
            if (
              wantsAutoResolve &&
              feedback &&
              (feedback.hasUnresolvedComments ||
                feedback.hasFailingChecks ||
                feedback.hasUncheckedRuns)
            ) {
              // Re-verify the PR is still open before creating a feedback bead.
              // The checkPRFeedback call above takes ~2s (3+ GitHub API calls).
              // If the PR was merged externally during that window, inserting
              // pr_feedback_detected would create a feedback bead for a merged
              // PR — leading to a duplicate PR on an already-merged branch.
              const freshStatus = await ctx.checkPRStatus(action.pr_url);
              if (freshStatus !== 'open') {
                console.log(
                  `${LOG} poll_pr: PR status changed to '${freshStatus}' during feedback check, skipping feedback for bead=${action.bead_id}`
                );
              } else {
                const existingFeedback = hasExistingFeedbackBead(sql, action.bead_id);
                if (!existingFeedback) {
                  const prMeta = parsePrUrl(action.pr_url);
                  const rmRows = z
                    .object({ branch: z.string() })
                    .array()
                    .parse([
                      ...query(
                        sql,
                        /* sql */ `
                          SELECT ${review_metadata.columns.branch}
                          FROM ${review_metadata}
                          WHERE ${review_metadata.bead_id} = ?
                        `,
                        [action.bead_id]
                      ),
                    ]);
                  const branch = rmRows[0]?.branch ?? '';

                  ctx.insertEvent('pr_feedback_detected', {
                    bead_id: action.bead_id,
                    payload: {
                      mr_bead_id: action.bead_id,
                      pr_url: action.pr_url,
                      pr_number: prMeta?.prNumber ?? 0,
                      repo: prMeta?.repo ?? '',
                      branch,
                      has_unresolved_comments: feedback.hasUnresolvedComments,
                      has_failing_checks: feedback.hasFailingChecks,
                      has_unchecked_runs: feedback.hasUncheckedRuns,
                    },
                  });
                }

                query(
                  sql,
                  /* sql */ `
                    UPDATE ${review_metadata}
                    SET ${review_metadata.columns.last_feedback_check_at} = ?
                    WHERE ${review_metadata.bead_id} = ?
                  `,
                  [now(), action.bead_id]
                );
              }
            }

            // Auto-merge timer: track grace period when everything is green
            if (wantsAutoMerge) {
              if (!feedback) return;

              const allGreen =
                !feedback.hasUnresolvedComments &&
                !feedback.hasFailingChecks &&
                feedback.allChecksPass;

              console.log(
                `${LOG} poll_pr: bead=${action.bead_id} allGreen=${allGreen} unresolved=${feedback.hasUnresolvedComments} failing=${feedback.hasFailingChecks} allPass=${feedback.allChecksPass} unchecked=${feedback.hasUncheckedRuns}`
              );

              if (allGreen) {
                const readySinceRows = z
                  .object({ auto_merge_ready_since: z.string().nullable() })
                  .array()
                  .parse([
                    ...query(
                      sql,
                      /* sql */ `
                        SELECT ${review_metadata.columns.auto_merge_ready_since}
                        FROM ${review_metadata}
                        WHERE ${review_metadata.bead_id} = ?
                      `,
                      [action.bead_id]
                    ),
                  ]);

                const readySince = readySinceRows[0]?.auto_merge_ready_since;

                console.log(
                  `${LOG} poll_pr: bead=${action.bead_id} readySince=${readySince ?? 'null'} rows=${readySinceRows.length}`
                );

                if (!readySince) {
                  query(
                    sql,
                    /* sql */ `
                      UPDATE ${review_metadata}
                      SET ${review_metadata.columns.auto_merge_ready_since} = ?
                      WHERE ${review_metadata.bead_id} = ?
                    `,
                    [now(), action.bead_id]
                  );
                } else {
                  const elapsed = Date.now() - new Date(readySince).getTime();
                  const delayMs = (refineryConfig.auto_merge_delay_minutes ?? 0) * 60_000;
                  console.log(
                    `${LOG} poll_pr: bead=${action.bead_id} elapsed=${elapsed}ms delay=${delayMs}ms shouldMerge=${elapsed >= delayMs}`
                  );
                  if (elapsed >= delayMs) {
                    console.log(
                      `${LOG} poll_pr: inserting pr_auto_merge event for bead=${action.bead_id}`
                    );
                    ctx.insertEvent('pr_auto_merge', {
                      bead_id: action.bead_id,
                      payload: {
                        mr_bead_id: action.bead_id,
                        pr_url: action.pr_url,
                      },
                    });
                  }
                }
              } else {
                query(
                  sql,
                  /* sql */ `
                    UPDATE ${review_metadata}
                    SET ${review_metadata.columns.auto_merge_ready_since} = NULL
                    WHERE ${review_metadata.bead_id} = ?
                  `,
                  [action.bead_id]
                );
              }
            }
          } else {
            // Null result — GitHub API unreachable (token missing, expired, rate-limited, or 5xx).
            // Increment consecutive null counter; fail the bead after PR_POLL_NULL_THRESHOLD.
            query(
              sql,
              /* sql */ `
                UPDATE ${beads}
                SET ${beads.columns.metadata} = json_set(
                  COALESCE(${beads.columns.metadata}, '{}'),
                  '$.poll_null_count',
                  COALESCE(
                    json_extract(${beads.columns.metadata}, '$.poll_null_count'),
                    0
                  ) + 1
                )
                WHERE ${beads.bead_id} = ?
              `,
              [action.bead_id]
            );
            const rows = [
              ...query(
                sql,
                /* sql */ `
                  SELECT json_extract(${beads.columns.metadata}, '$.poll_null_count') AS null_count
                  FROM ${beads}
                  WHERE ${beads.bead_id} = ?
                `,
                [action.bead_id]
              ),
            ];
            const nullCount = Number(rows[0]?.null_count ?? 0);
            if (nullCount >= PR_POLL_NULL_THRESHOLD) {
              console.warn(
                `${LOG} poll_pr: ${nullCount} consecutive null results for bead=${action.bead_id}, failing`
              );
              beadOps.updateBeadStatus(sql, action.bead_id, 'failed', 'system');
              query(
                sql,
                /* sql */ `
                  UPDATE ${beads}
                  SET ${beads.columns.metadata} = json_set(
                    COALESCE(${beads.columns.metadata}, '{}'),
                    '$.failureReason', 'pr_poll_failed',
                    '$.failureMessage', ?
                  )
                  WHERE ${beads.bead_id} = ?
                `,
                [
                  `Cannot poll PR status — GitHub API returned null ${nullCount} consecutive times. Check that a valid GitHub token is configured in town settings and that the GitHub API is reachable.`,
                  action.bead_id,
                ]
              );
            }
          }
          // status === 'open' — no action needed, poll again next tick
        } catch (err) {
          console.warn(`${LOG} poll_pr failed: bead=${action.bead_id} url=${action.pr_url}`, err);
        }
      };
    }

    case 'merge_pr': {
      // Validate the PR URL matches the rig's repository before merging.
      // Prevents merging an unrelated repo if a buggy refinery stores a wrong URL.
      const mrBead = beadOps.getBead(sql, action.bead_id);
      if (mrBead?.rig_id) {
        const rig = getRig(sql, mrBead.rig_id);
        if (rig?.git_url) {
          const rigCoords = parseGitUrl(rig.git_url);
          const prMeta = parsePrUrl(action.pr_url);
          if (rigCoords && prMeta) {
            const rigRepo = `${rigCoords.owner}/${rigCoords.repo}`;
            if (rigRepo !== prMeta.repo) {
              console.warn(
                `${LOG} merge_pr: PR repo "${prMeta.repo}" does not match rig repo "${rigRepo}" — refusing to merge`
              );
              // Clear the pending flag to avoid retry loops
              query(
                sql,
                /* sql */ `
                  UPDATE ${beads}
                  SET ${beads.columns.metadata} = json_remove(COALESCE(${beads.metadata}, '{}'), '$.auto_merge_pending'),
                      ${beads.columns.updated_at} = ?
                  WHERE ${beads.bead_id} = ?
                `,
                [now(), action.bead_id]
              );
              return null;
            }
          }
        }
      }

      return async () => {
        try {
          // Re-check feedback immediately before merging to avoid acting on
          // stale state. If a reviewer posted new comments or CI regressed
          // since the last poll, abort and reset the timer.
          const freshFeedback = await ctx.checkPRFeedback(action.pr_url);
          if (
            freshFeedback &&
            (freshFeedback.hasUnresolvedComments ||
              freshFeedback.hasFailingChecks ||
              !freshFeedback.allChecksPass)
          ) {
            console.log(
              `${LOG} merge_pr: fresh feedback check found issues, aborting merge for bead=${action.bead_id}`
            );
            query(
              sql,
              /* sql */ `
                UPDATE ${beads}
                SET ${beads.columns.metadata} = json_remove(COALESCE(${beads.metadata}, '{}'), '$.auto_merge_pending'),
                    ${beads.columns.updated_at} = ?
                WHERE ${beads.bead_id} = ?
              `,
              [now(), action.bead_id]
            );
            query(
              sql,
              /* sql */ `
                UPDATE ${review_metadata}
                SET ${review_metadata.columns.auto_merge_ready_since} = NULL
                WHERE ${review_metadata.bead_id} = ?
              `,
              [action.bead_id]
            );
            return;
          }

          const merged = await ctx.mergePR(action.pr_url);
          if (merged) {
            ctx.insertEvent('pr_status_changed', {
              bead_id: action.bead_id,
              payload: { pr_url: action.pr_url, pr_state: 'merged' },
            });
          } else {
            // Merge failed (405/409: branch protection, merge conflict, stale head, etc.)
            // Clear auto_merge_pending so we resume normal polling on the next tick.
            // Also reset the auto_merge_ready_since timer so it re-evaluates freshness.
            query(
              sql,
              /* sql */ `
                UPDATE ${beads}
                SET ${beads.columns.metadata} = json_remove(COALESCE(${beads.metadata}, '{}'), '$.auto_merge_pending'),
                    ${beads.columns.updated_at} = ?
                WHERE ${beads.bead_id} = ?
              `,
              [now(), action.bead_id]
            );
            query(
              sql,
              /* sql */ `
                UPDATE ${review_metadata}
                SET ${review_metadata.columns.auto_merge_ready_since} = NULL
                WHERE ${review_metadata.bead_id} = ?
              `,
              [action.bead_id]
            );
            console.warn(
              `${LOG} merge_pr: merge failed, cleared auto_merge_pending for bead=${action.bead_id}`
            );
          }
        } catch (err) {
          console.warn(`${LOG} merge_pr failed: bead=${action.bead_id} url=${action.pr_url}`, err);
          // Clear pending flag on unexpected errors too
          query(
            sql,
            /* sql */ `
              UPDATE ${beads}
              SET ${beads.columns.metadata} = json_remove(COALESCE(${beads.metadata}, '{}'), '$.auto_merge_pending'),
                  ${beads.columns.updated_at} = ?
              WHERE ${beads.bead_id} = ?
            `,
            [now(), action.bead_id]
          );
          query(
            sql,
            /* sql */ `
              UPDATE ${review_metadata}
              SET ${review_metadata.columns.auto_merge_ready_since} = NULL
              WHERE ${review_metadata.bead_id} = ?
            `,
            [action.bead_id]
          );
        }
      };
    }

    case 'send_nudge': {
      // Insert nudge record synchronously.
      // Explicitly set created_at to ISO 8601 so it matches the format used
      // by hasRecentNudge's cutoff comparison (#1412). SQLite's default
      // datetime('now') produces 'YYYY-MM-DD HH:MM:SS' (space separator)
      // which compares incorrectly against JS toISOString().
      const nudgeId = crypto.randomUUID();
      query(
        sql,
        /* sql */ `
          INSERT INTO ${agent_nudges} (
            ${agent_nudges.columns.nudge_id},
            ${agent_nudges.columns.agent_bead_id},
            ${agent_nudges.columns.message},
            ${agent_nudges.columns.mode},
            ${agent_nudges.columns.priority},
            ${agent_nudges.columns.source},
            ${agent_nudges.columns.created_at},
            ${agent_nudges.columns.expires_at}
          ) VALUES (?, ?, ?, 'immediate', 'urgent', ?, ?, ?)
        `,
        [
          nudgeId,
          action.agent_id,
          action.message,
          `reconciler:${action.tier}`,
          new Date().toISOString(),
          null,
        ]
      );

      return async () => {
        try {
          await ctx.queueNudge(action.agent_id, action.message, action.tier);
        } catch (err) {
          console.warn(`${LOG} send_nudge failed: agent=${action.agent_id}`, err);
        }
      };
    }

    case 'create_triage_request': {
      try {
        patrol.createTriageRequest(sql, {
          triageType: action.triage_type as patrol.TriageType,
          agentBeadId: action.agent_id,
          title: `Triage: ${action.reason}`,
          context: { reason: action.reason },
          options: ['RESTART', 'CLOSE', 'ESCALATE'],
        });
      } catch (err) {
        console.warn(`${LOG} create_triage_request failed: agent=${action.agent_id}`, err);
      }
      return null;
    }

    case 'notify_mayor': {
      // Mayor notifications are informational — log for now
      console.log(`${LOG} notify_mayor: town=${townId} msg=${action.message}`);
      return null;
    }

    case 'emit_event': {
      ctx.emitEvent({ event: action.event_name, townId, ...action.data });
      return null;
    }

    default: {
      // Exhaustiveness check via never
      const _exhaustive: never = action;
      console.warn(`${LOG} applyAction: unknown action type`, _exhaustive);
      return null;
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Check if an MR bead already has a non-terminal feedback bead blocking it. */
function hasExistingFeedbackBead(sql: SqlStorage, mrBeadId: string): boolean {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT 1 FROM ${bead_dependencies} bd
        INNER JOIN ${beads} fb ON fb.${beads.columns.bead_id} = bd.${bead_dependencies.columns.depends_on_bead_id}
        WHERE bd.${bead_dependencies.columns.bead_id} = ?
          AND bd.${bead_dependencies.columns.dependency_type} = 'blocks'
          AND fb.${beads.columns.labels} LIKE '%gt:pr-feedback%'
          AND fb.${beads.columns.status} NOT IN ('closed', 'failed')
        LIMIT 1
      `,
      [mrBeadId]
    ),
  ];
  return rows.length > 0;
}

/** Parse a GitHub/GitLab PR URL to extract repo and PR number. */
function parsePrUrl(prUrl: string): { repo: string; prNumber: number } | null {
  // GitHub: https://github.com/{owner}/{repo}/pull/{number}
  const ghMatch = prUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (ghMatch) {
    return { repo: ghMatch[1], prNumber: parseInt(ghMatch[2], 10) };
  }
  // GitLab: https://{host}/{path}/-/merge_requests/{iid}
  const glMatch = prUrl.match(/^https:\/\/[^/]+\/(.+)\/-\/merge_requests\/(\d+)/);
  if (glMatch) {
    return { repo: glMatch[1], prNumber: parseInt(glMatch[2], 10) };
  }
  return null;
}

// Exported for testing
export { hasExistingFeedbackBead as _hasExistingFeedbackBead, parsePrUrl as _parsePrUrl };
