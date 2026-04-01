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
import { query } from '../../util/query.util';
import * as beadOps from './beads';
import * as agentOps from './agents';
import * as reviewQueue from './review-queue';
import * as patrol from './patrol';

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
export type SendNudge = z.infer<typeof SendNudge>;
export type CreateTriageRequest = z.infer<typeof CreateTriageRequest>;
export type NotifyMayor = z.infer<typeof NotifyMayor>;
export type EmitEvent = z.infer<typeof EmitEvent>;

// ── Action application context ──────────────────────────────────────
// applyAction needs access to TownDO-level resources for side effects.
// The SQL handle is for synchronous mutations; the rest are for async
// side effects (dispatch, stop, poll, nudge).

export type ApplyActionContext = {
  sql: SqlStorage;
  townId: string;
  /** Dispatch an agent to its container. Returns true if container accepted. */
  dispatchAgent: (agentId: string, beadId: string, rigId: string) => Promise<boolean>;
  /** Stop an agent's container process. */
  stopAgent: (agentId: string) => Promise<void>;
  /** Check a PR's status via GitHub/GitLab API. Returns 'open'|'merged'|'closed'|null. */
  checkPRStatus: (prUrl: string) => Promise<'open' | 'merged' | 'closed' | null>;
  /** Queue a nudge message for an agent. */
  queueNudge: (agentId: string, message: string, tier: string) => Promise<void>;
  /** Insert a town_event for deferred processing (e.g. pr_status_changed). */
  insertEvent: (
    eventType: string,
    params: { agent_id?: string | null; bead_id?: string | null; payload?: Record<string, unknown> }
  ) => void;
  /** Emit an analytics/WebSocket event. */
  emitEvent: (data: Record<string, unknown>) => void;
};

const LOG = '[actions]';

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
      // Touch updated_at synchronously so the bead doesn't look stale
      // to Rule 4 (orphaned PR review, 30 min timeout). Without this,
      // active polling keeps the PR alive but updated_at was set once
      // at PR creation and never refreshed, causing a false "orphaned"
      // failure after 30 minutes.
      query(
        sql,
        /* sql */ `
          UPDATE ${beads}
          SET ${beads.columns.updated_at} = ?
          WHERE ${beads.bead_id} = ?
        `,
        [now(), action.bead_id]
      );

      return async () => {
        try {
          const status = await ctx.checkPRStatus(action.pr_url);
          if (status && status !== 'open') {
            ctx.insertEvent('pr_status_changed', {
              bead_id: action.bead_id,
              payload: { pr_url: action.pr_url, pr_state: status },
            });
          }
        } catch (err) {
          console.warn(`${LOG} poll_pr failed: bead=${action.bead_id} url=${action.pr_url}`, err);
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
