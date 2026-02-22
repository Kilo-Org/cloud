/**
 * Review queue and molecule management for the Town DO.
 */

import {
  rig_review_queue,
  RigReviewQueueRecord,
  createTableRigReviewQueue,
} from '../../db/tables/rig-review-queue.table';
import {
  rig_molecules,
  RigMoleculeRecord,
  createTableRigMolecules,
} from '../../db/tables/rig-molecules.table';
import { rig_agents } from '../../db/tables/rig-agents.table';
import { rig_beads } from '../../db/tables/rig-beads.table';
import { query } from '../../util/query.util';
import { logBeadEvent, getBead, closeBead, updateBeadStatus, createBead } from './beads';
import { getAgent, unhookBead, hookBead } from './agents';
import type { ReviewQueueInput, ReviewQueueEntry, AgentDoneInput } from '../../types';

// Review entries stuck in 'running' past this timeout are reset to 'pending'
const REVIEW_RUNNING_TIMEOUT_MS = 5 * 60 * 1000;

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

export function initReviewQueueTables(sql: SqlStorage): void {
  query(sql, createTableRigReviewQueue(), []);
  query(sql, createTableRigMolecules(), []);
}

// ── Review Queue ────────────────────────────────────────────────────

export function submitToReviewQueue(sql: SqlStorage, input: ReviewQueueInput): void {
  const id = generateId();
  const timestamp = now();

  query(
    sql,
    /* sql */ `
      INSERT INTO ${rig_review_queue} (
        ${rig_review_queue.columns.id},
        ${rig_review_queue.columns.agent_id},
        ${rig_review_queue.columns.bead_id},
        ${rig_review_queue.columns.branch},
        ${rig_review_queue.columns.pr_url},
        ${rig_review_queue.columns.status},
        ${rig_review_queue.columns.summary},
        ${rig_review_queue.columns.created_at},
        ${rig_review_queue.columns.processed_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      input.agent_id,
      input.bead_id,
      input.branch,
      input.pr_url ?? null,
      'pending',
      input.summary ?? null,
      timestamp,
      null,
    ]
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
        SELECT * FROM ${rig_review_queue}
        WHERE ${rig_review_queue.columns.status} = 'pending'
        ORDER BY ${rig_review_queue.columns.created_at} ASC
        LIMIT 1
      `,
      []
    ),
  ];

  if (rows.length === 0) return null;
  const entry = RigReviewQueueRecord.parse(rows[0]);

  // Mark as running
  query(
    sql,
    /* sql */ `
      UPDATE ${rig_review_queue}
      SET ${rig_review_queue.columns.status} = 'running',
          ${rig_review_queue.columns.processed_at} = ?
      WHERE ${rig_review_queue.columns.id} = ?
    `,
    [now(), entry.id]
  );

  return RigReviewQueueRecord.parse({
    ...entry,
    status: 'running',
    processed_at: now(),
  });
}

export function completeReview(
  sql: SqlStorage,
  entryId: string,
  status: 'merged' | 'failed'
): void {
  query(
    sql,
    /* sql */ `
      UPDATE ${rig_review_queue}
      SET ${rig_review_queue.columns.status} = ?,
          ${rig_review_queue.columns.processed_at} = ?
      WHERE ${rig_review_queue.columns.id} = ?
    `,
    [status, now(), entryId]
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

  // Find the review entry to get bead/agent IDs
  const entryRows = [
    ...query(
      sql,
      /* sql */ `SELECT * FROM ${rig_review_queue} WHERE ${rig_review_queue.columns.id} = ?`,
      [input.entry_id]
    ),
  ];
  if (entryRows.length === 0) return;
  const entry = RigReviewQueueRecord.parse(entryRows[0]);

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
    closeBead(sql, entry.bead_id, entry.agent_id);
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
      UPDATE ${rig_review_queue}
      SET ${rig_review_queue.columns.status} = 'pending',
          ${rig_review_queue.columns.processed_at} = NULL
      WHERE ${rig_review_queue.columns.status} = 'running'
        AND ${rig_review_queue.columns.processed_at} < ?
    `,
    [timeout]
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
      UPDATE ${rig_agents}
      SET ${rig_agents.columns.status} = 'idle',
          ${rig_agents.columns.dispatch_attempts} = 0
      WHERE ${rig_agents.columns.id} = ?
    `,
    [agentId]
  );
}

// ── Molecules ───────────────────────────────────────────────────────

export function createMolecule(
  sql: SqlStorage,
  beadId: string,
  formula: unknown
): RigMoleculeRecord {
  const id = generateId();
  const timestamp = now();
  const formulaStr = JSON.stringify(formula);

  query(
    sql,
    /* sql */ `
      INSERT INTO ${rig_molecules} (
        ${rig_molecules.columns.id},
        ${rig_molecules.columns.bead_id},
        ${rig_molecules.columns.formula},
        ${rig_molecules.columns.current_step},
        ${rig_molecules.columns.status},
        ${rig_molecules.columns.created_at},
        ${rig_molecules.columns.updated_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [id, beadId, formulaStr, 0, 'active', timestamp, timestamp]
  );

  // Link molecule to bead
  query(
    sql,
    /* sql */ `
      UPDATE ${rig_beads}
      SET ${rig_beads.columns.molecule_id} = ?
      WHERE ${rig_beads.columns.id} = ?
    `,
    [id, beadId]
  );

  const mol = getMolecule(sql, id);
  if (!mol) throw new Error('Failed to create molecule');
  return mol;
}

export function getMolecule(sql: SqlStorage, moleculeId: string): RigMoleculeRecord | null {
  const rows = [
    ...query(
      sql,
      /* sql */ `SELECT * FROM ${rig_molecules} WHERE ${rig_molecules.columns.id} = ?`,
      [moleculeId]
    ),
  ];
  if (rows.length === 0) return null;
  return RigMoleculeRecord.parse(rows[0]);
}

export function getMoleculeForBead(sql: SqlStorage, beadId: string): RigMoleculeRecord | null {
  const rows = [
    ...query(
      sql,
      /* sql */ `SELECT * FROM ${rig_molecules} WHERE ${rig_molecules.columns.bead_id} = ?`,
      [beadId]
    ),
  ];
  if (rows.length === 0) return null;
  return RigMoleculeRecord.parse(rows[0]);
}

export function getMoleculeCurrentStep(
  sql: SqlStorage,
  agentId: string
): { molecule: RigMoleculeRecord; step: unknown } | null {
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
  summary: string
): RigMoleculeRecord | null {
  const current = getMoleculeCurrentStep(sql, agentId);
  if (!current) return null;

  const { molecule } = current;
  const formula = molecule.formula;
  const nextStep = molecule.current_step + 1;
  const isComplete = !Array.isArray(formula) || nextStep >= formula.length;
  const newStatus = isComplete ? 'completed' : 'active';

  query(
    sql,
    /* sql */ `
      UPDATE ${rig_molecules}
      SET ${rig_molecules.columns.current_step} = ?,
          ${rig_molecules.columns.status} = ?,
          ${rig_molecules.columns.updated_at} = ?
      WHERE ${rig_molecules.columns.id} = ?
    `,
    [nextStep, newStatus, now(), molecule.id]
  );

  return getMolecule(sql, molecule.id);
}
