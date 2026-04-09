/**
 * Review queue and molecule management for the Town DO.
 *
 * After the beads-centric refactor (#441):
 * - Review queue entries are beads with type='merge_request' + review_metadata satellite
 * - Molecules are parent beads with type='molecule' + child step beads
 */

import { z } from 'zod';
import { beads, BeadRecord, MergeRequestBeadRecord } from '../../db/tables/beads.table';
import { review_metadata } from '../../db/tables/review-metadata.table';
import { bead_dependencies } from '../../db/tables/bead-dependencies.table';
import { agent_metadata } from '../../db/tables/agent-metadata.table';
import { convoy_metadata } from '../../db/tables/convoy-metadata.table';
import { bead_events } from '../../db/tables/bead-events.table';
import { query } from '../../util/query.util';
import {
  logBeadEvent,
  getBead,
  closeBead,
  updateBeadStatus,
  updateConvoyProgress,
  createBead,
  getConvoyForBead,
  getConvoyFeatureBranch,
  getConvoyMergeMode,
} from './beads';
import { getAgent, unhookBead, updateAgentStatus } from './agents';
import { getRig } from './rigs';
import type { ReviewQueueInput, ReviewQueueEntry, AgentDoneInput, Molecule } from '../../types';

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Extract the human-readable failure message from a bead event's metadata.
 *
 * Two sources:
 *  - status_changed events store it at `metadata.failure_reason.message`
 *  - review_completed / pr_creation_failed events store it at `metadata.message`
 */
function extractFailureMessage(
  status: string,
  metadata: Record<string, unknown> | null | undefined
): string | null {
  if (status !== 'failed' || !metadata) return null;
  // Structured failure_reason (from status_changed events via updateBeadStatus)
  const fr = metadata.failure_reason;
  if (typeof fr === 'object' && fr !== null && 'message' in fr) {
    const msg = (fr as Record<string, unknown>).message;
    if (typeof msg === 'string') return msg;
  }
  // Top-level message (from review_completed / pr_creation_failed events)
  if (typeof metadata.message === 'string') return metadata.message;
  return null;
}

export function initReviewQueueTables(_sql: SqlStorage): void {
  // Review queue and molecule tables are now part of beads + satellite tables.
  // Initialization happens in beads.initBeadTables().
}

// ── Review Queue ────────────────────────────────────────────────────

const REVIEW_JOIN = /* sql */ `
  SELECT ${beads}.*,
         ${review_metadata.branch}, ${review_metadata.target_branch},
         ${review_metadata.merge_commit}, ${review_metadata.pr_url},
         ${review_metadata.retry_count},
         ${review_metadata.auto_merge_ready_since},
         ${review_metadata.last_feedback_check_at}
  FROM ${beads}
  INNER JOIN ${review_metadata} ON ${beads.bead_id} = ${review_metadata.bead_id}
`;

/** Map a parsed MergeRequestBeadRecord to the ReviewQueueEntry API type. */
function toReviewQueueEntry(row: MergeRequestBeadRecord): ReviewQueueEntry {
  return {
    id: row.bead_id,
    // The polecat that submitted the review — stored in metadata (not assignee,
    // which is set to the refinery when it claims the MR bead via hookBead).
    agent_id:
      typeof row.metadata?.source_agent_id === 'string'
        ? row.metadata.source_agent_id
        : (row.created_by ?? ''),
    bead_id:
      typeof row.metadata?.source_bead_id === 'string' ? row.metadata.source_bead_id : row.bead_id,
    rig_id: row.rig_id ?? '',
    branch: row.branch,
    pr_url: row.pr_url,
    status:
      row.status === 'open'
        ? 'pending'
        : row.status === 'in_progress'
          ? 'running'
          : row.status === 'closed'
            ? 'merged'
            : 'failed',
    summary: row.body,
    created_at: row.created_at,
    processed_at: row.updated_at === row.created_at ? null : row.updated_at,
  };
}

export function submitToReviewQueue(sql: SqlStorage, input: ReviewQueueInput): void {
  const id = generateId();
  const timestamp = now();

  // Build metadata — include pr_url if the agent already created a PR so
  // the link is visible via the standard bead list endpoint.
  const metadata: Record<string, unknown> = {
    source_bead_id: input.bead_id,
    source_agent_id: input.agent_id,
  };
  if (input.pr_url) {
    metadata.pr_url = input.pr_url;
  }

  // Resolve the target branch for this MR:
  // - For review-then-land convoy beads → convoy's feature branch
  // - For review-and-merge convoy beads → rig's default branch (land independently)
  // - For standalone beads → rig's default branch
  // We pass defaultBranch from the caller so we don't hardcode 'main'.
  const convoyId = getConvoyForBead(sql, input.bead_id);
  const convoyFeatureBranch = convoyId ? getConvoyFeatureBranch(sql, convoyId) : null;
  const convoyMergeMode = convoyId ? getConvoyMergeMode(sql, convoyId) : null;
  const targetBranch =
    convoyMergeMode === 'review-then-land' && convoyFeatureBranch
      ? convoyFeatureBranch
      : (input.default_branch ?? 'main');

  if (convoyId) {
    metadata.convoy_id = convoyId;
    if (convoyFeatureBranch) {
      metadata.convoy_feature_branch = convoyFeatureBranch;
    }
  }

  // Create the merge_request bead
  query(
    sql,
    /* sql */ `
      INSERT INTO ${beads} (
        ${beads.columns.bead_id}, ${beads.columns.type}, ${beads.columns.status},
        ${beads.columns.title}, ${beads.columns.body}, ${beads.columns.rig_id},
        ${beads.columns.parent_bead_id}, ${beads.columns.assignee_agent_bead_id},
        ${beads.columns.priority}, ${beads.columns.labels}, ${beads.columns.metadata},
        ${beads.columns.created_by}, ${beads.columns.created_at}, ${beads.columns.updated_at},
        ${beads.columns.closed_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      'merge_request',
      'open',
      `Review: ${input.branch}`,
      input.summary ?? null,
      input.rig_id,
      null,
      null, // assignee left null — refinery claims it via hookBead
      'medium',
      JSON.stringify(['gt:merge-request']),
      JSON.stringify(metadata),
      input.agent_id, // created_by records who submitted
      timestamp,
      timestamp,
      null,
    ]
  );

  // Link MR bead → source bead via bead_dependencies so the DAG is queryable
  query(
    sql,
    /* sql */ `
      INSERT INTO ${bead_dependencies} (
        ${bead_dependencies.columns.bead_id},
        ${bead_dependencies.columns.depends_on_bead_id},
        ${bead_dependencies.columns.dependency_type}
      ) VALUES (?, ?, 'tracks')
    `,
    [id, input.bead_id]
  );

  // Create the review_metadata satellite
  query(
    sql,
    /* sql */ `
      INSERT INTO ${review_metadata} (
        ${review_metadata.columns.bead_id}, ${review_metadata.columns.branch},
        ${review_metadata.columns.target_branch}, ${review_metadata.columns.merge_commit},
        ${review_metadata.columns.pr_url}, ${review_metadata.columns.retry_count}
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    [id, input.branch, targetBranch, null, input.pr_url ?? null, 0]
  );

  logBeadEvent(sql, {
    beadId: input.bead_id,
    agentId: input.agent_id,
    eventType: 'review_submitted',
    newValue: input.branch,
    metadata: { branch: input.branch, target_branch: targetBranch },
  });
}

export function popReviewQueue(sql: SqlStorage): ReviewQueueEntry | null {
  // Pop the oldest open MR bead, but skip any whose source bead already
  // has another MR in_progress (i.e. a refinery is already reviewing it).
  // This prevents popping stale MR beads and triggering failReviewWithRework
  // while an active review is in flight for the same source.
  //
  // The source bead is linked via bead_dependencies (dependency_type='tracks'):
  //   bead_dependencies.bead_id = MR bead
  //   bead_dependencies.depends_on_bead_id = source bead
  const rows = [
    ...query(
      sql,
      /* sql */ `
        ${REVIEW_JOIN}
        WHERE ${beads.status} = 'open'
          AND NOT EXISTS (
            SELECT 1 FROM ${beads} AS active_mr
            WHERE active_mr.${beads.columns.type} = 'merge_request'
              AND active_mr.${beads.columns.status} = 'in_progress'
              AND active_mr.${beads.columns.rig_id} = ${beads.rig_id}
          )
        ORDER BY ${beads.created_at} ASC
        LIMIT 1
      `,
      []
    ),
  ];

  if (rows.length === 0) return null;
  const parsed = MergeRequestBeadRecord.parse(rows[0]);
  const entry = toReviewQueueEntry(parsed);

  // Mark as running (in_progress)
  query(
    sql,
    /* sql */ `
      UPDATE ${beads}
      SET ${beads.columns.status} = 'in_progress',
          ${beads.columns.updated_at} = ?
      WHERE ${beads.bead_id} = ?
    `,
    [now(), entry.id]
  );

  return { ...entry, status: 'running', processed_at: now() };
}

export function completeReview(
  sql: SqlStorage,
  entryId: string,
  status: 'merged' | 'failed'
): void {
  const beadStatus = status === 'merged' ? 'closed' : 'failed';
  // Delegate to updateBeadStatus so a status_changed event is recorded
  // on the event timeline. It also handles terminal-state guards,
  // closed_at timestamps, and convoy progress updates.
  updateBeadStatus(sql, entryId, beadStatus, 'system');
}

/**
 * Complete a review with full result handling (close bead on merge, escalate on conflict).
 */
export function completeReviewWithResult(
  sql: SqlStorage,
  input: {
    entry_id: string;
    status: 'merged' | 'failed' | 'conflict';
    message?: string;
    commit_sha?: string;
  }
): void {
  // On conflict, mark the review entry as failed and create an escalation bead
  const resolvedStatus = input.status === 'conflict' ? 'failed' : input.status;
  completeReview(sql, input.entry_id, resolvedStatus);

  // Find the review entry to get agent IDs
  const entryRows = [
    ...query(sql, /* sql */ `${REVIEW_JOIN} WHERE ${beads.bead_id} = ?`, [input.entry_id]),
  ];
  if (entryRows.length === 0) return;
  const parsed = MergeRequestBeadRecord.parse(entryRows[0]);
  const entry = toReviewQueueEntry(parsed);

  logBeadEvent(sql, {
    beadId: entry.bead_id,
    agentId: entry.agent_id,
    eventType: 'review_completed',
    newValue: input.status,
    metadata: {
      message: input.message,
      commit_sha: input.commit_sha,
    },
  });

  if (input.status === 'merged') {
    const mergeTimestamp = now();
    console.log(
      `[review-queue] completeReviewWithResult MERGED: entry_id=${input.entry_id} ` +
        `entry.bead_id (source)=${entry.bead_id} entry.id (MR)=${entry.id} — ` +
        `calling closeBead on source`
    );
    closeBead(sql, entry.bead_id, entry.agent_id);

    // Close ALL other open/in_progress/failed MR beads for the same
    // source bead. During rework cycles, multiple MR beads accumulate.
    // Without this cleanup, stale MR beads trigger failReviewWithRework
    // on the next alarm tick, reopening the source bead that was just
    // closed by this merge.
    query(
      sql,
      /* sql */ `
        UPDATE ${beads}
        SET ${beads.columns.status} = 'closed',
            ${beads.columns.updated_at} = ?,
            ${beads.columns.closed_at} = ?
        WHERE ${beads.type} = 'merge_request'
          AND ${beads.bead_id} != ?
          AND ${beads.status} NOT IN ('closed')
          AND ${beads.bead_id} IN (
            SELECT dep.${bead_dependencies.columns.bead_id}
            FROM ${bead_dependencies} AS dep
            WHERE dep.${bead_dependencies.columns.depends_on_bead_id} = ?
              AND dep.${bead_dependencies.columns.dependency_type} = 'tracks'
          )
      `,
      [mergeTimestamp, mergeTimestamp, input.entry_id, entry.bead_id]
    );

    // closeBead → updateBeadStatus short-circuits when completeReview already
    // set the status to 'closed' via direct SQL, so updateConvoyProgress is
    // never reached transitively. Call it explicitly to ensure the convoy
    // recounts after the MR bead is closed.
    updateConvoyProgress(sql, entry.bead_id, mergeTimestamp);

    // If this was a convoy landing MR, also set landed_at on the convoy metadata
    const sourceBead = getBead(sql, entry.bead_id);
    if (sourceBead?.type === 'convoy') {
      query(
        sql,
        /* sql */ `
          UPDATE ${convoy_metadata}
          SET ${convoy_metadata.columns.landed_at} = ?
          WHERE ${convoy_metadata.bead_id} = ?
        `,
        [now(), entry.bead_id]
      );
    }
  } else if (input.status === 'conflict') {
    // Create an escalation bead so the conflict is visible and actionable
    createBead(sql, {
      type: 'escalation',
      title: `Merge conflict: ${input.message ?? entry.branch}`,
      body: input.message,
      priority: 'high',
      metadata: {
        source_bead_id: entry.bead_id,
        source_agent_id: entry.agent_id,
        branch: entry.branch,
        conflict: true,
      },
    });
    // Return source bead to open so the normal scheduling path handles
    // rework. Clear assignee so feedStrandedConvoys can match.
    const conflictSourceBead = getBead(sql, entry.bead_id);
    if (
      conflictSourceBead &&
      conflictSourceBead.status !== 'closed' &&
      conflictSourceBead.status !== 'failed'
    ) {
      updateBeadStatus(sql, entry.bead_id, 'open', entry.agent_id);
      query(
        sql,
        /* sql */ `
          UPDATE ${beads}
          SET ${beads.columns.assignee_agent_bead_id} = NULL
          WHERE ${beads.bead_id} = ?
        `,
        [entry.bead_id]
      );
    }
  } else if (input.status === 'failed') {
    // Review failed (rework requested): return source bead to open so
    // the normal scheduling path (feedStrandedConvoys → hookBead →
    // schedulePendingWork → dispatch) handles rework. Clear the stale
    // assignee so feedStrandedConvoys can match (requires assignee IS NULL).
    // This avoids the fire-and-forget rework dispatch race in TownDO
    // where the dispatch fails and rehookOrphanedBeads churn.
    const sourceBead = getBead(sql, entry.bead_id);
    if (sourceBead && sourceBead.status !== 'closed' && sourceBead.status !== 'failed') {
      updateBeadStatus(sql, entry.bead_id, 'open', entry.agent_id);
      query(
        sql,
        /* sql */ `
          UPDATE ${beads}
          SET ${beads.columns.assignee_agent_bead_id} = NULL
          WHERE ${beads.bead_id} = ?
        `,
        [entry.bead_id]
      );
    }
  }
}

/**
 * Set the platform PR/MR URL on an MR bead's review_metadata and bead metadata.
 * Called after a PR is created in the 'pr' merge strategy path.
 * Writes to both review_metadata.pr_url (for query) and beads.metadata.pr_url
 * (so the URL is available via the standard bead list endpoint).
 */
/** Get review_metadata for an MR bead. */
export function getReviewMetadata(
  sql: SqlStorage,
  mrBeadId: string
): { branch: string; target_branch: string; pr_url: string | null } | null {
  const rows = z
    .object({
      branch: z.string(),
      target_branch: z.string(),
      pr_url: z.string().nullable(),
    })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
        SELECT ${review_metadata.columns.branch} as branch,
               ${review_metadata.columns.target_branch} as target_branch,
               ${review_metadata.columns.pr_url} as pr_url
        FROM ${review_metadata}
        WHERE ${review_metadata.bead_id} = ?
      `,
        [mrBeadId]
      ),
    ]);
  return rows[0] ?? null;
}

export function setReviewPrUrl(sql: SqlStorage, entryId: string, prUrl: string): boolean {
  // Reject non-HTTPS URLs to prevent storing garbage from LLM output.
  // Invalid URLs would cause pollPendingPRs to poll indefinitely.
  if (!prUrl.startsWith('https://')) {
    console.warn(`[review-queue] setReviewPrUrl: rejecting non-HTTPS pr_url: ${prUrl}`);
    return false;
  }
  query(
    sql,
    /* sql */ `
      UPDATE ${review_metadata}
      SET ${review_metadata.columns.pr_url} = ?
      WHERE ${review_metadata.bead_id} = ?
    `,
    [prUrl, entryId]
  );

  // Also write to bead metadata so the PR URL is visible in the standard bead list
  query(
    sql,
    /* sql */ `
      UPDATE ${beads}
      SET ${beads.columns.metadata} = json_set(COALESCE(${beads.metadata}, '{}'), '$.pr_url', ?)
      WHERE ${beads.bead_id} = ?
    `,
    [prUrl, entryId]
  );
  return true;
}

/**
 * Set an MR bead status to 'in_review' (maps to bead status 'in_progress').
 * Used when the PR strategy creates a PR and waits for human review.
 */
export function markReviewInReview(sql: SqlStorage, entryId: string): void {
  query(
    sql,
    /* sql */ `
      UPDATE ${beads}
      SET ${beads.columns.status} = 'in_progress',
          ${beads.columns.updated_at} = ?
      WHERE ${beads.bead_id} = ?
    `,
    [new Date().toISOString(), entryId]
  );
}

// ── Agent Done ──────────────────────────────────────────────────────

export function agentDone(sql: SqlStorage, agentId: string, input: AgentDoneInput): void {
  const agent = getAgent(sql, agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  if (!agent.current_hook_bead_id) {
    // The agent was unhooked by a recovery path (witnessPatrol,
    // rehookOrphanedBeads) between when the agent finished work and
    // when it called gt_done.
    //
    // For refineries, this is critical: the refinery successfully merged
    // but the hook was cleared by zombie detection. We MUST still complete
    // the review — otherwise the source bead stays open forever. Find the
    // most recent non-closed MR bead assigned to this agent and complete it.
    if (agent.role === 'refinery') {
      const recentMrRows = [
        ...query(
          sql,
          /* sql */ `
            SELECT ${beads.bead_id}
            FROM ${beads}
            WHERE ${beads.type} = 'merge_request'
              AND ${beads.assignee_agent_bead_id} = ?
              AND ${beads.status} NOT IN ('closed', 'failed')
            ORDER BY ${beads.updated_at} DESC
            LIMIT 1
          `,
          [agentId]
        ),
      ];
      if (recentMrRows.length > 0) {
        const mrBeadId = z.object({ bead_id: z.string() }).parse(recentMrRows[0]).bead_id;
        console.log(
          `[review-queue] agentDone: unhooked refinery ${agentId} — recovering MR bead ${mrBeadId}`
        );
        if (input.pr_url) {
          const stored = setReviewPrUrl(sql, mrBeadId, input.pr_url);
          if (stored) {
            markReviewInReview(sql, mrBeadId);
          } else {
            completeReviewWithResult(sql, {
              entry_id: mrBeadId,
              status: 'failed',
              message: `Refinery provided invalid pr_url: ${input.pr_url}`,
            });
          }
        } else {
          completeReviewWithResult(sql, {
            entry_id: mrBeadId,
            status: 'merged',
            message: input.summary ?? 'Merged by refinery agent (recovered from unhook)',
          });
        }
        return;
      }
    }

    console.warn(
      `[review-queue] agentDone: agent ${agentId} (role=${agent.role}) has no hooked bead — ignoring`
    );
    return;
  }

  // Triage batch beads don't produce code — close and unhook without
  // submitting to the review queue. Only applies to system-created triage
  // beads (created_by = 'patrol'). User-created beads that happen to carry
  // the gt:triage label go through normal review flow.
  const hookedBead = getBead(sql, agent.current_hook_bead_id);
  if (hookedBead?.labels.includes('gt:triage') && hookedBead.created_by === 'patrol') {
    closeBead(sql, agent.current_hook_bead_id, agentId);
    unhookBead(sql, agentId);
    return;
  }

  // Rework beads skip the review queue entirely. The polecat pushed commits
  // to an existing branch (the one the refinery already reviewed). Closing
  // the rework bead unblocks the MR bead, and the reconciler re-dispatches
  // the refinery to re-review.
  if (hookedBead?.labels.includes('gt:rework')) {
    console.log(
      `[review-queue] agentDone: rework bead ${agent.current_hook_bead_id} — closing directly (skip review)`
    );
    closeBead(sql, agent.current_hook_bead_id, agentId);
    unhookBead(sql, agentId);
    return;
  }

  // PR-fixup beads skip the review queue. The polecat pushed fixup commits
  // to an existing PR branch — no separate review is needed.
  if (hookedBead?.labels.includes('gt:pr-fixup')) {
    console.log(
      `[review-queue] agentDone: pr-fixup bead ${agent.current_hook_bead_id} — closing directly (skip review)`
    );
    closeBead(sql, agent.current_hook_bead_id, agentId);
    unhookBead(sql, agentId);
    return;
  }

  // PR-feedback beads (address review comments, fix CI) skip the review
  // queue. The polecat pushed commits to the existing PR branch — closing
  // the feedback bead unblocks the parent MR bead so poll_pr can re-check
  // CI status or the reconciler can re-dispatch the refinery for re-review.
  if (hookedBead?.labels.includes('gt:pr-feedback')) {
    console.log(
      `[review-queue] agentDone: pr-feedback bead ${agent.current_hook_bead_id} — closing directly (skip review)`
    );
    closeBead(sql, agent.current_hook_bead_id, agentId);
    unhookBead(sql, agentId);
    return;
  }

  if (agent.role === 'refinery') {
    // The refinery handles merging (direct strategy) or PR creation (pr strategy)
    // itself. When it calls gt_done:
    //  - With pr_url: refinery created a PR → store URL, mark as in_review, poll it
    //  - Without pr_url: refinery merged directly → mark as merged
    const mrBeadId = agent.current_hook_bead_id;

    if (input.pr_url) {
      // PR strategy: refinery created a PR via gh/glab CLI.
      // Validate the URL — LLM output may contain garbage URLs.
      const stored = setReviewPrUrl(sql, mrBeadId, input.pr_url);
      if (stored) {
        markReviewInReview(sql, mrBeadId);
        logBeadEvent(sql, {
          beadId: mrBeadId,
          agentId,
          eventType: 'pr_created',
          newValue: input.pr_url,
          metadata: { pr_url: input.pr_url, created_by: 'refinery' },
        });
      } else {
        // Invalid URL — fail the review so it doesn't poll forever
        completeReviewWithResult(sql, {
          entry_id: mrBeadId,
          status: 'failed',
          message: `Refinery provided invalid pr_url: ${input.pr_url}`,
        });
        logBeadEvent(sql, {
          beadId: mrBeadId,
          agentId,
          eventType: 'pr_creation_failed',
          metadata: { pr_url: input.pr_url, reason: 'invalid_url' },
        });
      }
    } else {
      // Direct strategy: refinery already merged and pushed
      completeReviewWithResult(sql, {
        entry_id: mrBeadId,
        status: 'merged',
        message: input.summary ?? 'Merged by refinery agent',
      });
    }

    unhookBead(sql, agentId);
    // Set refinery to idle immediately — the review is done and the
    // refinery is available for new work. Without this, processReviewQueue
    // sees the refinery as 'working' and won't pop the next MR bead until
    // agentCompleted fires (when the container process eventually exits).
    updateAgentStatus(sql, agentId, 'idle');
    return;
  }

  const sourceBead = agent.current_hook_bead_id;

  if (!agent.rig_id) {
    console.warn(
      `[review-queue] agentDone: agent ${agentId} has null rig_id — review entry may fail in processReviewQueue`
    );
  }

  // Resolve the rig's default branch so submitToReviewQueue can use it
  // instead of hardcoding 'main' for standalone/review-and-merge beads.
  const rigId = agent.rig_id ?? '';
  const rig = rigId ? getRig(sql, rigId) : null;

  submitToReviewQueue(sql, {
    agent_id: agentId,
    bead_id: sourceBead,
    rig_id: rigId,
    branch: input.branch,
    pr_url: input.pr_url,
    summary: input.summary,
    default_branch: rig?.default_branch,
  });

  // Transition the source bead to in_review — the polecat's work is done
  // but the refinery hasn't reviewed it yet. The MR bead tracks the merge
  // lifecycle. The source bead retains its assignee so we know which agent
  // worked on it. It will be closed (or returned to in_progress) by the
  // refinery after review.
  unhookBead(sql, agentId);
  updateBeadStatus(sql, sourceBead, 'in_review', agentId);
}

/**
 * Result from agentCompleted indicating whether a rework was triggered.
 * When non-null, the TownDO caller should dispatch a polecat for the
 * source bead.
 */
export type AgentCompletedResult = {
  reworkSourceBeadId: string | null;
};

/**
 * Called by the container when an agent process completes (or fails).
 * Closes/fails the bead and unhooks the agent.
 *
 * For refineries that exit with 'completed' without having merged,
 * this triggers the rework flow: the MR bead is failed and the source
 * bead is returned to in_progress so a polecat can be re-dispatched.
 */
export function agentCompleted(
  sql: SqlStorage,
  agentId: string,
  input: { status: 'completed' | 'failed'; reason?: string }
): AgentCompletedResult {
  const result: AgentCompletedResult = { reworkSourceBeadId: null };
  const agent = getAgent(sql, agentId);
  if (!agent) return result;

  if (agent.current_hook_bead_id) {
    if (agent.role === 'refinery') {
      // NEVER fail or unhook a refinery from agentCompleted.
      // agentCompleted races with gt_done: the process exits, the
      // container sends /completed, but gt_done's HTTP request may
      // still be in flight. If we unhook here, recoverStuckReviews
      // can fire between agentCompleted and gt_done, resetting the
      // MR bead that's about to be closed by gt_done.
      //
      // Leave the hook intact. gt_done will close + unhook if the
      // merge succeeded. recoverStuckReviews (which checks for
      // status='working') handles the case where gt_done never arrives.
      //
      // No-op for the bead — just fall through to mark agent idle.
    } else {
      // For non-refineries: if the agent exited with 'failed', fail the bead.
      // If it exited with 'completed', check whether gt_done already ran:
      //  - If the bead is in_review/closed/failed → gt_done already handled it, no-op on bead
      //  - If the bead is still in_progress → agent was killed (idle timer, OOM, etc.)
      //    before calling gt_done. Don't close the bead — just unhook. The reconciler's
      //    Rule 3 will reset it to open after the staleness timeout.
      const hookedBead = getBead(sql, agent.current_hook_bead_id);
      if (input.status === 'failed') {
        updateBeadStatus(sql, agent.current_hook_bead_id, 'failed', agentId, {
          code: 'agent_failed',
          message: 'Agent exited with failed status',
          source: 'container',
        });
      } else if (hookedBead && hookedBead.status === 'in_progress') {
        if (input.reason === 'container eviction') {
          // Container eviction: WIP was force-pushed and eviction context
          // was written on the bead body. Reset to open and clear the
          // stale assignee so the reconciler can re-dispatch immediately.
          console.log(
            `[review-queue] agentCompleted: polecat ${agentId} evicted — ` +
              `resetting bead ${agent.current_hook_bead_id} to open`
          );
          updateBeadStatus(sql, agent.current_hook_bead_id, 'open', agentId);
          query(
            sql,
            /* sql */ `
              UPDATE ${beads}
              SET ${beads.columns.assignee_agent_bead_id} = NULL
              WHERE ${beads.bead_id} = ?
            `,
            [agent.current_hook_bead_id]
          );
        } else {
          // Agent exited 'completed' but bead is still in_progress — gt_done was never called.
          // Don't close the bead. Rule 3 will handle rework.
          console.log(
            `[review-queue] agentCompleted: polecat ${agentId} exited without gt_done — ` +
              `bead ${agent.current_hook_bead_id} stays in_progress (Rule 3 will recover)`
          );
        }
      } else if (hookedBead && hookedBead.status === 'open') {
        // Bead is open (wasn't dispatched yet or was already reset). No-op.
      } else {
        // Bead is in_review, closed, or failed — gt_done already ran. No-op on bead.
      }
      unhookBead(sql, agentId);
    }
  }

  // Mark agent idle — but ONLY if it hasn't been re-dispatched (status
  // still 'working' on new work) since gt_done ran. agentCompleted can
  // arrive after the agent has been re-hooked and dispatched for a new
  // bead. Without this guard, the stale completion event would clobber
  // the live dispatch.
  // For refineries, preserve dispatch_attempts so Rule 6's circuit-breaker
  // can track cumulative re-dispatch attempts across idle→dispatch cycles.
  // Resetting to 0 here was enabling infinite loops (#1342). Non-refineries
  // reset to 0 because they unhook above and get a fresh counter on hookBead.
  query(
    sql,
    /* sql */ `
      UPDATE ${agent_metadata}
      SET ${agent_metadata.columns.status} = 'idle',
          ${agent_metadata.columns.dispatch_attempts} = CASE
            WHEN ${agent_metadata.columns.role} = 'refinery' THEN ${agent_metadata.columns.dispatch_attempts}
            ELSE 0
          END
      WHERE ${agent_metadata.bead_id} = ?
        AND NOT (
          ${agent_metadata.columns.status} = 'working'
          AND ${agent_metadata.columns.current_hook_bead_id} IS NOT NULL
        )
    `,
    [agentId]
  );

  return result;
}

// ── Merge Queue Data ────────────────────────────────────────────────

/**
 * 24 hours in milliseconds — MR beads in_review longer than this are "stale".
 */
const STALE_PR_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Zod schema for a single enriched MR bead row from the needsAttention query. */
const MrBeadRow = z.object({
  bead_id: z.string(),
  status: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  rig_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  metadata: z.string().transform((v): Record<string, unknown> => {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return {};
    }
  }),
  // review_metadata columns
  branch: z.string(),
  target_branch: z.string(),
  merge_commit: z.string().nullable(),
  pr_url: z.string().nullable(),
  retry_count: z.number(),
  // source bead (via bead_dependencies tracks)
  source_bead_id: z.string().nullable(),
  source_bead_title: z.string().nullable(),
  source_bead_status: z.string().nullable(),
  source_bead_body: z.string().nullable(),
  // convoy info (via metadata.convoy_id → convoy_metadata)
  convoy_id: z.string().nullable(),
  convoy_title: z.string().nullable(),
  convoy_total_beads: z.number().nullable(),
  convoy_closed_beads: z.number().nullable(),
  convoy_feature_branch: z.string().nullable(),
  convoy_merge_mode: z.string().nullable(),
  // agent info (via metadata.source_agent_id → agent_metadata)
  agent_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  agent_role: z.string().nullable(),
  // rig name
  rig_name: z.string().nullable(),
  // failure event metadata (correlated subquery for failed MR beads)
  failure_event_metadata: z
    .string()
    .nullable()
    .transform((v): Record<string, unknown> | null => {
      if (!v) return null;
      try {
        return JSON.parse(v) as Record<string, unknown>;
      } catch {
        return null;
      }
    }),
});

/** Zod schema for an enriched activity log event row. */
const ActivityLogRow = z.object({
  bead_event_id: z.string(),
  bead_id: z.string(),
  agent_id: z.string().nullable(),
  event_type: z.string(),
  old_value: z.string().nullable(),
  new_value: z.string().nullable(),
  event_metadata: z.string().transform((v): Record<string, unknown> => {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return {};
    }
  }),
  event_created_at: z.string(),
  // associated bead info
  bead_title: z.string().nullable(),
  bead_type: z.string().nullable(),
  bead_status: z.string().nullable(),
  bead_rig_id: z.string().nullable(),
  bead_metadata: z
    .string()
    .nullable()
    .transform((v): Record<string, unknown> => {
      try {
        return v ? (JSON.parse(v) as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    }),
  // agent info
  agent_name: z.string().nullable(),
  agent_role: z.string().nullable(),
  // rig info
  rig_name: z.string().nullable(),
  // source bead (resolved via bead_dependencies tracks join)
  source_bead_id: z.string().nullable(),
  source_bead_title: z.string().nullable(),
  source_bead_status: z.string().nullable(),
  // review metadata
  rm_branch: z.string().nullable(),
  rm_target_branch: z.string().nullable(),
  rm_merge_commit: z.string().nullable(),
  rm_pr_url: z.string().nullable(),
  // convoy info
  convoy_id: z.string().nullable(),
  convoy_title: z.string().nullable(),
  convoy_total_beads: z.number().nullable(),
  convoy_closed_beads: z.number().nullable(),
  convoy_feature_branch: z.string().nullable(),
  convoy_merge_mode: z.string().nullable(),
});

export type MergeQueueParams = {
  rigId?: string;
  limit?: number;
  since?: string;
};

export type MergeQueueData = {
  needsAttention: {
    openPRs: MergeQueueItem[];
    failedReviews: MergeQueueItem[];
    stalePRs: MergeQueueItem[];
  };
  activityLog: ActivityLogEntry[];
};

export type MergeQueueItem = {
  mrBead: {
    bead_id: string;
    status: string;
    title: string;
    body: string | null;
    rig_id: string | null;
    created_at: string;
    updated_at: string;
    metadata: Record<string, unknown>;
  };
  reviewMetadata: {
    branch: string;
    target_branch: string;
    merge_commit: string | null;
    pr_url: string | null;
    retry_count: number;
  };
  sourceBead: {
    bead_id: string;
    title: string;
    status: string;
    body: string | null;
  } | null;
  convoy: {
    convoy_id: string;
    title: string;
    total_beads: number;
    closed_beads: number;
    feature_branch: string | null;
    merge_mode: string | null;
  } | null;
  agent: {
    agent_id: string;
    name: string;
    role: string;
  } | null;
  rigName: string | null;
  staleSince: string | null;
  failureReason: string | null;
};

export type ActivityLogEntry = {
  event: {
    bead_event_id: string;
    bead_id: string;
    agent_id: string | null;
    event_type: string;
    old_value: string | null;
    new_value: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
  };
  mrBead: {
    bead_id: string;
    title: string;
    type: string;
    status: string;
    rig_id: string | null;
    metadata: Record<string, unknown>;
  } | null;
  sourceBead: {
    bead_id: string;
    title: string;
    status: string;
  } | null;
  convoy: {
    convoy_id: string;
    title: string;
    total_beads: number;
    closed_beads: number;
    feature_branch: string | null;
    merge_mode: string | null;
  } | null;
  agent: {
    agent_id: string;
    name: string;
    role: string;
  } | null;
  rigName: string | null;
  reviewMetadata: {
    pr_url: string | null;
    branch: string | null;
    target_branch: string | null;
    merge_commit: string | null;
  } | null;
};

/**
 * Query all data the Merge Queue page needs: MR beads needing attention
 * (open PRs, failed reviews, stale PRs) and a recent activity log.
 */
export function getMergeQueueData(sql: SqlStorage, params: MergeQueueParams): MergeQueueData {
  const rigId = params.rigId ?? null;

  // ── 1. Query MR beads with full joins ───────────────────────────────
  // Statuses: in_progress = "in review" (PR created, awaiting merge),
  //           open = pending review, failed = review failed
  // We fetch all non-closed MR beads for the needs-attention section.
  const mrRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT
          ${beads.bead_id},
          ${beads.status},
          ${beads.title},
          ${beads.body},
          ${beads.rig_id},
          ${beads.created_at},
          ${beads.updated_at},
          ${beads.metadata},
          ${review_metadata.branch},
          ${review_metadata.target_branch},
          ${review_metadata.merge_commit},
          ${review_metadata.pr_url},
          ${review_metadata.retry_count},
          src.${beads.columns.bead_id} AS source_bead_id,
          src.${beads.columns.title} AS source_bead_title,
          src.${beads.columns.status} AS source_bead_status,
          src.${beads.columns.body} AS source_bead_body,
          cm.${convoy_metadata.columns.bead_id} AS convoy_id,
          convoy_bead.${beads.columns.title} AS convoy_title,
          cm.${convoy_metadata.columns.total_beads} AS convoy_total_beads,
          cm.${convoy_metadata.columns.closed_beads} AS convoy_closed_beads,
          cm.${convoy_metadata.columns.feature_branch} AS convoy_feature_branch,
          cm.${convoy_metadata.columns.merge_mode} AS convoy_merge_mode,
          am.${agent_metadata.columns.bead_id} AS agent_id,
          agent_bead.${beads.columns.title} AS agent_name,
          am.${agent_metadata.columns.role} AS agent_role,
          rig.name AS rig_name,
          (SELECT ${bead_events.metadata}
           FROM ${bead_events}
           WHERE ${bead_events.bead_id} = ${beads.bead_id}
             AND ${bead_events.event_type} IN ('review_completed', 'pr_creation_failed')
           ORDER BY ${bead_events.created_at} DESC
           LIMIT 1) AS failure_event_metadata
        FROM ${beads}
        INNER JOIN ${review_metadata}
          ON ${beads.bead_id} = ${review_metadata.bead_id}
        LEFT JOIN ${bead_dependencies} AS dep
          ON dep.${bead_dependencies.columns.bead_id} = ${beads.bead_id}
          AND dep.${bead_dependencies.columns.dependency_type} = 'tracks'
        LEFT JOIN ${beads} AS src
          ON src.${beads.columns.bead_id} = dep.${bead_dependencies.columns.depends_on_bead_id}
        LEFT JOIN ${convoy_metadata} AS cm
          ON cm.${convoy_metadata.columns.bead_id} = json_extract(${beads.metadata}, '$.convoy_id')
        LEFT JOIN ${beads} AS convoy_bead
          ON convoy_bead.${beads.columns.bead_id} = cm.${convoy_metadata.columns.bead_id}
        LEFT JOIN ${agent_metadata} AS am
          ON am.${agent_metadata.columns.bead_id} = json_extract(${beads.metadata}, '$.source_agent_id')
        LEFT JOIN ${beads} AS agent_bead
          ON agent_bead.${beads.columns.bead_id} = am.${agent_metadata.columns.bead_id}
        LEFT JOIN rigs AS rig
          ON rig.id = ${beads.rig_id}
        WHERE ${beads.type} = 'merge_request'
          AND ${beads.status} IN ('open', 'in_progress', 'in_review', 'failed')
          AND (? IS NULL OR ${beads.rig_id} = ?)
        ORDER BY ${beads.created_at} DESC
      `,
      [rigId, rigId]
    ),
  ];

  const parsedMrRows = MrBeadRow.array().parse(mrRows);
  const staleThreshold = new Date(Date.now() - STALE_PR_THRESHOLD_MS).toISOString();

  const openPRs: MergeQueueItem[] = [];
  const failedReviews: MergeQueueItem[] = [];
  const stalePRs: MergeQueueItem[] = [];

  for (const row of parsedMrRows) {
    const item = mrBeadRowToItem(row);

    if (row.status === 'failed') {
      failedReviews.push(item);
    } else if (row.pr_url && row.status === 'in_progress') {
      // in_progress with pr_url = PR created, awaiting human merge
      if (row.updated_at < staleThreshold) {
        item.staleSince = row.updated_at;
        stalePRs.push(item);
      } else {
        openPRs.push(item);
      }
    }
    // open/in_review without pr_url are pending queue items, not shown in needs-attention
  }

  // ── 2. Query activity log events ────────────────────────────────────
  const limit = params.limit ?? 50;
  const since = params.since ?? null;

  const eventRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT
          ${bead_events.bead_event_id},
          ${bead_events.bead_id},
          ${bead_events.agent_id},
          ${bead_events.event_type},
          ${bead_events.old_value},
          ${bead_events.new_value},
          ${bead_events.metadata} AS event_metadata,
          ${bead_events.created_at} AS event_created_at,
          b.${beads.columns.title} AS bead_title,
          b.${beads.columns.type} AS bead_type,
          b.${beads.columns.status} AS bead_status,
          b.${beads.columns.rig_id} AS bead_rig_id,
          b.${beads.columns.metadata} AS bead_metadata,
          agent_bead.${beads.columns.title} AS agent_name,
          am.${agent_metadata.columns.role} AS agent_role,
          rig.name AS rig_name,
          src.${beads.columns.bead_id} AS source_bead_id,
          src.${beads.columns.title} AS source_bead_title,
          src.${beads.columns.status} AS source_bead_status,
          rm.${review_metadata.columns.branch} AS rm_branch,
          rm.${review_metadata.columns.target_branch} AS rm_target_branch,
          rm.${review_metadata.columns.merge_commit} AS rm_merge_commit,
          rm.${review_metadata.columns.pr_url} AS rm_pr_url,
          cm.${convoy_metadata.columns.bead_id} AS convoy_id,
          convoy_bead.${beads.columns.title} AS convoy_title,
          cm.${convoy_metadata.columns.total_beads} AS convoy_total_beads,
          cm.${convoy_metadata.columns.closed_beads} AS convoy_closed_beads,
          cm.${convoy_metadata.columns.feature_branch} AS convoy_feature_branch,
          cm.${convoy_metadata.columns.merge_mode} AS convoy_merge_mode
        FROM ${bead_events}
        INNER JOIN ${beads} AS b
          ON b.${beads.columns.bead_id} = ${bead_events.bead_id}
        LEFT JOIN ${agent_metadata} AS am
          ON am.${agent_metadata.columns.bead_id} = ${bead_events.agent_id}
        LEFT JOIN ${beads} AS agent_bead
          ON agent_bead.${beads.columns.bead_id} = ${bead_events.agent_id}
        LEFT JOIN ${bead_dependencies} AS dep
          ON dep.${bead_dependencies.columns.bead_id} = b.${beads.columns.bead_id}
          AND dep.${bead_dependencies.columns.dependency_type} = 'tracks'
        LEFT JOIN ${beads} AS src
          ON src.${beads.columns.bead_id} = dep.${bead_dependencies.columns.depends_on_bead_id}
        LEFT JOIN ${review_metadata} AS rm
          ON rm.${review_metadata.columns.bead_id} = ${bead_events.bead_id}
        LEFT JOIN ${convoy_metadata} AS cm
          ON cm.${convoy_metadata.columns.bead_id} = json_extract(b.${beads.columns.metadata}, '$.convoy_id')
        LEFT JOIN ${beads} AS convoy_bead
          ON convoy_bead.${beads.columns.bead_id} = cm.${convoy_metadata.columns.bead_id}
        LEFT JOIN rigs AS rig
          ON rig.id = b.${beads.columns.rig_id}
        WHERE ${bead_events.event_type} IN (
          'review_submitted', 'review_completed', 'pr_created',
          'pr_creation_failed', 'rework_requested', 'status_changed'
        )
          AND (? IS NULL OR b.${beads.columns.rig_id} = ?)
          AND (? IS NULL OR ${bead_events.created_at} > ?)
        ORDER BY ${bead_events.created_at} DESC
        LIMIT ?
      `,
      [rigId, rigId, since, since, limit]
    ),
  ];

  const parsedEventRows = ActivityLogRow.array().parse(eventRows);

  const activityLog: ActivityLogEntry[] = parsedEventRows.map(eventRowToEntry);

  return {
    needsAttention: { openPRs, failedReviews, stalePRs },
    activityLog,
  };
}

function mrBeadRowToItem(row: z.output<typeof MrBeadRow>): MergeQueueItem {
  return {
    mrBead: {
      bead_id: row.bead_id,
      status: row.status,
      title: row.title,
      body: row.body,
      rig_id: row.rig_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      metadata: row.metadata,
    },
    reviewMetadata: {
      branch: row.branch,
      target_branch: row.target_branch,
      merge_commit: row.merge_commit,
      pr_url: row.pr_url,
      retry_count: row.retry_count,
    },
    sourceBead: row.source_bead_id
      ? {
          bead_id: row.source_bead_id,
          title: row.source_bead_title ?? '',
          status: row.source_bead_status ?? '',
          body: row.source_bead_body ?? null,
        }
      : null,
    convoy: row.convoy_id
      ? {
          convoy_id: row.convoy_id,
          title: row.convoy_title ?? '',
          total_beads: row.convoy_total_beads ?? 0,
          closed_beads: row.convoy_closed_beads ?? 0,
          feature_branch: row.convoy_feature_branch,
          merge_mode: row.convoy_merge_mode,
        }
      : null,
    agent: row.agent_id
      ? {
          agent_id: row.agent_id,
          name: row.agent_name ?? '',
          role: row.agent_role ?? '',
        }
      : null,
    rigName: row.rig_name,
    staleSince: null,
    failureReason: extractFailureMessage(row.status, row.failure_event_metadata),
  };
}

function eventRowToEntry(row: z.output<typeof ActivityLogRow>): ActivityLogEntry {
  // Source bead resolution:
  // - Events on MR beads (pr_created, pr_creation_failed, rework_requested):
  //   resolved via bead_dependencies LEFT JOIN (source_bead_id/title/status columns)
  // - Events on source beads (review_submitted, review_completed):
  //   the event's bead IS the source bead — use the bead columns directly
  const isMrBeadEvent = row.bead_type === 'merge_request';

  const resolvedSourceBead = isMrBeadEvent
    ? row.source_bead_id
      ? {
          bead_id: row.source_bead_id,
          title: row.source_bead_title ?? '',
          status: row.source_bead_status ?? '',
        }
      : null
    : row.bead_title
      ? {
          bead_id: row.bead_id,
          title: row.bead_title,
          status: row.bead_status ?? '',
        }
      : null;

  return {
    event: {
      bead_event_id: row.bead_event_id,
      bead_id: row.bead_id,
      agent_id: row.agent_id,
      event_type: row.event_type,
      old_value: row.old_value,
      new_value: row.new_value,
      metadata: row.event_metadata,
      created_at: row.event_created_at,
    },
    mrBead: row.bead_title
      ? {
          bead_id: row.bead_id,
          title: row.bead_title,
          type: row.bead_type ?? 'merge_request',
          status: row.bead_status ?? '',
          rig_id: row.bead_rig_id,
          metadata: row.bead_metadata,
        }
      : null,
    sourceBead: resolvedSourceBead,
    convoy: row.convoy_id
      ? {
          convoy_id: row.convoy_id,
          title: row.convoy_title ?? '',
          total_beads: row.convoy_total_beads ?? 0,
          closed_beads: row.convoy_closed_beads ?? 0,
          feature_branch: row.convoy_feature_branch,
          merge_mode: row.convoy_merge_mode,
        }
      : null,
    agent: row.agent_id
      ? {
          agent_id: row.agent_id,
          name: row.agent_name ?? '',
          role: row.agent_role ?? '',
        }
      : null,
    rigName: row.rig_name,
    reviewMetadata:
      row.rm_branch !== null
        ? {
            pr_url: row.rm_pr_url,
            branch: row.rm_branch,
            target_branch: row.rm_target_branch,
            merge_commit: row.rm_merge_commit,
          }
        : null,
  };
}

// ── Molecules ───────────────────────────────────────────────────────

/**
 * Create a molecule: a parent bead with type='molecule', child step beads
 * linked via parent_bead_id, and step ordering via bead_dependencies.
 */
export function createMolecule(sql: SqlStorage, beadId: string, formula: unknown): Molecule {
  const id = generateId();
  const timestamp = now();
  const formulaArr = Array.isArray(formula) ? formula : [];

  // Create the molecule parent bead
  query(
    sql,
    /* sql */ `
      INSERT INTO ${beads} (
        ${beads.columns.bead_id}, ${beads.columns.type}, ${beads.columns.status},
        ${beads.columns.title}, ${beads.columns.body}, ${beads.columns.rig_id},
        ${beads.columns.parent_bead_id}, ${beads.columns.assignee_agent_bead_id},
        ${beads.columns.priority}, ${beads.columns.labels}, ${beads.columns.metadata},
        ${beads.columns.created_by}, ${beads.columns.created_at}, ${beads.columns.updated_at},
        ${beads.columns.closed_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      'molecule',
      'open',
      `Molecule for bead ${beadId}`,
      null,
      null,
      null,
      null,
      'medium',
      JSON.stringify(['gt:molecule']),
      JSON.stringify({ source_bead_id: beadId, formula }),
      null,
      timestamp,
      timestamp,
      null,
    ]
  );

  // Create child step beads and dependency chain
  let prevStepId: string | null = null;
  for (let i = 0; i < formulaArr.length; i++) {
    const stepId = generateId();
    const step: unknown = formulaArr[i];

    query(
      sql,
      /* sql */ `
        INSERT INTO ${beads} (
          ${beads.columns.bead_id}, ${beads.columns.type}, ${beads.columns.status},
          ${beads.columns.title}, ${beads.columns.body}, ${beads.columns.rig_id},
          ${beads.columns.parent_bead_id}, ${beads.columns.assignee_agent_bead_id},
          ${beads.columns.priority}, ${beads.columns.labels}, ${beads.columns.metadata},
          ${beads.columns.created_by}, ${beads.columns.created_at}, ${beads.columns.updated_at},
          ${beads.columns.closed_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        stepId,
        'issue',
        'open',
        z.object({ title: z.string() }).safeParse(step).data?.title ?? `Step ${i + 1}`,
        typeof step === 'string' ? step : JSON.stringify(step),
        null,
        id,
        null,
        'medium',
        JSON.stringify([`gt:molecule-step`, `step:${i}`]),
        JSON.stringify({ step_index: i, step_data: step }),
        null,
        timestamp,
        timestamp,
        null,
      ]
    );

    // Chain dependencies: each step blocks on the previous
    if (prevStepId) {
      query(
        sql,
        /* sql */ `
          INSERT INTO ${bead_dependencies} (
            ${bead_dependencies.columns.bead_id},
            ${bead_dependencies.columns.depends_on_bead_id},
            ${bead_dependencies.columns.dependency_type}
          ) VALUES (?, ?, ?)
        `,
        [stepId, prevStepId, 'blocks']
      );
    }
    prevStepId = stepId;
  }

  // Link molecule to source bead in metadata
  query(
    sql,
    /* sql */ `
      UPDATE ${beads}
      SET ${beads.columns.metadata} = json_set(${beads.metadata}, '$.molecule_bead_id', ?)
      WHERE ${beads.bead_id} = ?
    `,
    [id, beadId]
  );

  const mol = getMolecule(sql, id);
  if (!mol) throw new Error('Failed to create molecule');
  return mol;
}

/**
 * Get a molecule by its bead_id. Derives current_step and status from children.
 */
export function getMolecule(sql: SqlStorage, moleculeId: string): Molecule | null {
  const bead = getBead(sql, moleculeId);
  if (!bead || bead.type !== 'molecule') return null;

  const steps = getStepBeads(sql, moleculeId);
  const closedCount = steps.filter(s => s.status === 'closed').length;
  const failedCount = steps.filter(s => s.status === 'failed').length;

  const currentStep = closedCount;
  const status =
    failedCount > 0
      ? 'failed'
      : closedCount >= steps.length && steps.length > 0
        ? 'completed'
        : 'active';

  const formula: unknown = bead.metadata?.formula ?? [];

  return {
    id: moleculeId,
    bead_id: String(bead.metadata?.source_bead_id ?? moleculeId),
    formula,
    current_step: currentStep,
    status,
    created_at: bead.created_at,
    updated_at: bead.updated_at,
  };
}

function getStepBeads(sql: SqlStorage, moleculeId: string): BeadRecord[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${beads}
        WHERE ${beads.parent_bead_id} = ?
        ORDER BY ${beads.created_at} ASC
      `,
      [moleculeId]
    ),
  ];
  return BeadRecord.array().parse(rows);
}

export function getMoleculeForBead(sql: SqlStorage, beadId: string): Molecule | null {
  const bead = getBead(sql, beadId);
  if (!bead) return null;
  const moleculeId: unknown = bead.metadata?.molecule_bead_id;
  if (typeof moleculeId !== 'string') return null;
  return getMolecule(sql, moleculeId);
}

export function getMoleculeCurrentStep(
  sql: SqlStorage,
  agentId: string
): { molecule: Molecule; step: unknown } | null {
  const agent = getAgent(sql, agentId);
  if (!agent?.current_hook_bead_id) return null;

  const mol = getMoleculeForBead(sql, agent.current_hook_bead_id);
  if (!mol || mol.status !== 'active') return null;

  const formula = mol.formula;
  if (!Array.isArray(formula)) return null;

  const step: unknown = (formula as unknown[])[mol.current_step] ?? null;
  return { molecule: mol, step };
}

export function advanceMoleculeStep(
  sql: SqlStorage,
  agentId: string,
  _summary: string
): Molecule | null {
  const current = getMoleculeCurrentStep(sql, agentId);
  if (!current) return null;

  const { molecule } = current;

  // Close the current step bead
  const steps = getStepBeads(sql, molecule.id);
  const currentStepBead = steps[molecule.current_step];
  if (currentStepBead) {
    const timestamp = now();
    query(
      sql,
      /* sql */ `
        UPDATE ${beads}
        SET ${beads.columns.status} = 'closed',
            ${beads.columns.closed_at} = ?,
            ${beads.columns.updated_at} = ?
        WHERE ${beads.bead_id} = ?
      `,
      [timestamp, timestamp, currentStepBead.bead_id]
    );
  }

  // Check if molecule is now complete
  const formula = molecule.formula;
  const nextStep = molecule.current_step + 1;
  const isComplete = !Array.isArray(formula) || nextStep >= formula.length;

  if (isComplete) {
    // Close the molecule bead itself
    const timestamp = now();
    query(
      sql,
      /* sql */ `
        UPDATE ${beads}
        SET ${beads.columns.status} = 'closed',
            ${beads.columns.closed_at} = ?,
            ${beads.columns.updated_at} = ?
        WHERE ${beads.bead_id} = ?
      `,
      [timestamp, timestamp, molecule.id]
    );
  }

  return getMolecule(sql, molecule.id);
}
