/**
 * Review queue and molecule management for the Town DO.
 *
 * After the beads-centric refactor (#441):
 * - Review queue entries are beads with type='merge_request' + review_metadata satellite
 * - Molecules are parent beads with type='molecule' + child step beads
 */

import { beads, BeadRecord, MergeRequestBeadRecord } from '../../db/tables/beads.table';
import { review_metadata } from '../../db/tables/review-metadata.table';
import { bead_dependencies } from '../../db/tables/bead-dependencies.table';
import { agent_metadata } from '../../db/tables/agent-metadata.table';
import { query } from '../../util/query.util';
import { logBeadEvent, getBead, closeBead, updateBeadStatus, createBead } from './beads';
import { getAgent, unhookBead } from './agents';
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
    agent_id: row.assignee_agent_bead_id ?? row.created_by ?? '',
    bead_id: row.bead_id,
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
      null,
      null,
      input.agent_id,
      'medium',
      JSON.stringify(['gt:merge-request']),
      JSON.stringify({ source_bead_id: input.bead_id }),
      input.agent_id,
      timestamp,
      timestamp,
      null,
    ]
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
    [id, input.branch, 'main', null, input.pr_url ?? null, 0]
  );

  logBeadEvent(sql, {
    beadId: input.bead_id,
    agentId: input.agent_id,
    eventType: 'review_submitted',
    newValue: input.branch,
    metadata: { branch: input.branch },
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
    // Find and close the source bead from metadata
    const sourceBeadRow = getBead(sql, entry.bead_id);
    const sourceBead = sourceBeadRow?.metadata?.source_bead_id;
    if (typeof sourceBead === 'string') {
      closeBead(sql, sourceBead, entry.agent_id);
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
  }
}

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
    `,
    [now(), timeout]
  );
}

// ── Agent Done ──────────────────────────────────────────────────────

export function agentDone(sql: SqlStorage, agentId: string, input: AgentDoneInput): void {
  const agent = getAgent(sql, agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  if (!agent.current_hook_bead_id) throw new Error(`Agent ${agentId} has no hooked bead`);

  submitToReviewQueue(sql, {
    agent_id: agentId,
    bead_id: agent.current_hook_bead_id,
    branch: input.branch,
    pr_url: input.pr_url,
    summary: input.summary,
  });

  unhookBead(sql, agentId);
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
    const step = formulaArr[i];

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
        typeof step === 'object' && step !== null && 'title' in step
          ? String((step as Record<string, unknown>).title)
          : `Step ${i + 1}`,
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

  const formula = bead.metadata?.formula ?? [];

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
  const moleculeId = bead.metadata?.molecule_bead_id;
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

  const step = formula[mol.current_step] ?? null;
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
