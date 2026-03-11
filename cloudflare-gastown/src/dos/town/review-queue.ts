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
import { getAgent, unhookBead } from './agents';
import { getRig } from './rigs';
import type { ReviewQueueInput, ReviewQueueEntry, AgentDoneInput, Molecule } from '../../types';

// Review entries stuck in 'running' past this timeout are reset to 'pending'
const REVIEW_RUNNING_TIMEOUT_MS = 5 * 60 * 1000;

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
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
         ${review_metadata.retry_count}
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
  const rows = [
    ...query(
      sql,
      /* sql */ `
        ${REVIEW_JOIN}
        WHERE ${beads.status} = 'open'
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
  const timestamp = now();
  query(
    sql,
    /* sql */ `
      UPDATE ${beads}
      SET ${beads.columns.status} = ?,
          ${beads.columns.updated_at} = ?,
          ${beads.columns.closed_at} = ?
      WHERE ${beads.bead_id} = ?
    `,
    [beadStatus, timestamp, beadStatus === 'closed' ? timestamp : null, entryId]
  );
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
    closeBead(sql, entry.bead_id, entry.agent_id);

    // Explicitly trigger convoy progress for the source bead after the MR closes.
    // closeBead → updateBeadStatus → updateConvoyProgress, but only if the source
    // bead's status actually changes. If the polecat already closed the source bead
    // before submitting to the review queue, the guard in updateBeadStatus short-
    // circuits and updateConvoyProgress is never called. Calling it here directly
    // ensures the convoy recounts after the MR bead is now closed (not in-flight),
    // so the source bead passes the NOT EXISTS guard and counts toward closedCount.
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
    // Return source bead to in_progress so the polecat can be re-dispatched
    // to resolve the conflict (in_review → in_progress rework flow).
    updateBeadStatus(sql, entry.bead_id, 'in_progress', entry.agent_id);
  } else if (input.status === 'failed') {
    // Review failed (rework requested): return source bead to in_progress
    // so it can be re-dispatched (in_review → in_progress rework flow).
    updateBeadStatus(sql, entry.bead_id, 'in_progress', entry.agent_id);
  }
}

/**
 * Set the platform PR/MR URL on an MR bead's review_metadata and bead metadata.
 * Called after a PR is created in the 'pr' merge strategy path.
 * Writes to both review_metadata.pr_url (for query) and beads.metadata.pr_url
 * (so the URL is available via the standard bead list endpoint).
 */
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

/**
 * List MR beads that are in_progress and have a pr_url (PR-strategy merges
 * waiting for external review). Used by the alarm to poll PR status.
 */
export function listPendingPRReviews(sql: SqlStorage): MergeRequestBeadRecord[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        ${REVIEW_JOIN}
        WHERE ${beads.status} = 'in_progress'
          AND ${review_metadata.pr_url} IS NOT NULL
      `,
      []
    ),
  ];
  return MergeRequestBeadRecord.array().parse(rows);
}

/**
 * Reset MR beads stuck in 'in_progress' back to 'open' so they can be
 * re-processed. Excludes beads that have a pr_url set — those are
 * legitimately waiting for external human review (PR strategy) and may
 * take hours or days.
 */
export function recoverStuckReviews(sql: SqlStorage): void {
  const timeout = new Date(Date.now() - REVIEW_RUNNING_TIMEOUT_MS).toISOString();
  query(
    sql,
    /* sql */ `
      UPDATE ${beads}
      SET ${beads.columns.status} = 'open',
          ${beads.columns.updated_at} = ?
      WHERE ${beads.type} = 'merge_request'
        AND ${beads.status} = 'in_progress'
        AND ${beads.updated_at} < ?
        AND ${beads.bead_id} NOT IN (
          SELECT ${review_metadata.bead_id}
          FROM ${review_metadata}
          WHERE ${review_metadata.pr_url} IS NOT NULL
        )
    `,
    [now(), timeout]
  );
}

/**
 * Close MR beads that are stuck waiting for a PR review but whose assigned
 * agent is no longer active. After a container restart, agents lose their
 * in-memory state — the PR review will never complete. Close these beads
 * so they don't block convoy progress indefinitely.
 *
 * Only affects beads with a pr_url (excluded by recoverStuckReviews) that
 * are stale (>30 min) and whose agent is idle/dead/missing.
 */
const ORPHAN_REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

export function closeOrphanedReviewBeads(sql: SqlStorage): void {
  const cutoff = new Date(Date.now() - ORPHAN_REVIEW_TIMEOUT_MS).toISOString();

  const orphanRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${beads.bead_id}, ${beads.assignee_agent_bead_id}
        FROM ${beads}
        INNER JOIN ${review_metadata} ON ${beads.bead_id} = ${review_metadata.bead_id}
        LEFT JOIN ${agent_metadata} ON ${beads.assignee_agent_bead_id} = ${agent_metadata.bead_id}
        WHERE ${beads.type} = 'merge_request'
          AND ${beads.status} = 'open'
          AND ${review_metadata.pr_url} IS NOT NULL
          AND ${beads.updated_at} < ?
          AND (
            ${agent_metadata.bead_id} IS NULL
            OR ${agent_metadata.status} IN ('idle', 'dead')
          )
      `,
      [cutoff]
    ),
  ];

  for (const row of orphanRows) {
    const parsed = z
      .object({ bead_id: z.string(), assignee_agent_bead_id: z.string().nullable() })
      .parse(row);
    try {
      closeBead(sql, parsed.bead_id, parsed.assignee_agent_bead_id ?? 'system');
      console.log(
        `[review-queue] closeOrphanedReviewBeads: closed orphaned MR bead=${parsed.bead_id}`
      );
    } catch (err) {
      console.warn(
        `[review-queue] closeOrphanedReviewBeads: failed to close bead=${parsed.bead_id}`,
        err
      );
    }
  }
}

// ── Agent Done ──────────────────────────────────────────────────────

export function agentDone(sql: SqlStorage, agentId: string, input: AgentDoneInput): void {
  const agent = getAgent(sql, agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  if (!agent.current_hook_bead_id) throw new Error(`Agent ${agentId} has no hooked bead`);

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
 * Called by the container when an agent process completes (or fails).
 * Closes/fails the bead and unhooks the agent.
 */
export function agentCompleted(
  sql: SqlStorage,
  agentId: string,
  input: { status: 'completed' | 'failed'; reason?: string }
): void {
  const agent = getAgent(sql, agentId);
  if (!agent) return;

  if (agent.current_hook_bead_id) {
    const beadStatus = input.status === 'completed' ? 'closed' : 'failed';
    updateBeadStatus(sql, agent.current_hook_bead_id, beadStatus, agentId);
    unhookBead(sql, agentId);
  }

  // Mark agent idle
  query(
    sql,
    /* sql */ `
      UPDATE ${agent_metadata}
      SET ${agent_metadata.columns.status} = 'idle',
          ${agent_metadata.columns.dispatch_attempts} = 0
      WHERE ${agent_metadata.bead_id} = ?
    `,
    [agentId]
  );
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
