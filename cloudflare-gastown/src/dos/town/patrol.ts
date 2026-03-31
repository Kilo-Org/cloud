/**
 * Witness & Deacon patrol functions for the TownDO alarm handler.
 *
 * All mechanical checks run as deterministic code. Ambiguous situations
 * produce triage request beads (type='issue', label='gt:triage-request')
 * with structured context for an on-demand LLM triage agent to resolve.
 *
 * See #442 for the full design.
 */

import { z } from 'zod';
import { beads, BeadRecord as BeadRecordSchema } from '../../db/tables/beads.table';
import { query } from '../../util/query.util';
import { createBead } from './beads';

const LOG = '[patrol]';

// ── Thresholds ──────────────────────────────────────────────────────

/** First GUPP warning (existing behavior) */
export const GUPP_WARN_MS = 30 * 60_000; // 30 min
/** Escalate to mayor after second threshold */
export const GUPP_ESCALATE_MS = 60 * 60_000; // 1h
/** Force-stop agent after third threshold */
export const GUPP_FORCE_STOP_MS = 2 * 60 * 60_000; // 2h
/** Agents dead/completed for longer than this are GC'd */
export const AGENT_GC_RETENTION_MS = 24 * 60 * 60_000; // 24h

/** Maximum number of open triage request beads allowed at once */
export const MAX_OPEN_TRIAGE_REQUESTS = 5;

// ── Triage request types ────────────────────────────────────────────

export type TriageType =
  | 'dirty_polecat'
  | 'stuck_agent'
  | 'help_request'
  | 'zombie_confirm'
  | 'crash_loop'
  | 'escalation';

export type TriageRequestMetadata = {
  triage_type: TriageType;
  agent_bead_id: string | null;
  /** The bead the agent was hooked to when the triage request was created.
   *  Resolve actions should target this bead, not the agent's current hook
   *  (which may have changed by the time the triage agent resolves it). */
  hooked_bead_id: string | null;
  context: Record<string, unknown>;
  options: string[];
};

// ── Triage request creation ─────────────────────────────────────────

/** Label used to identify triage request beads (type='issue'). */
export const TRIAGE_REQUEST_LABEL = 'gt:triage-request';

/** Label used to identify the triage agent's batch bead. */
export const TRIAGE_BATCH_LABEL = 'gt:triage';

/** SQL LIKE pattern for querying triage request beads by label. */
export const TRIAGE_LABEL_LIKE = `%"${TRIAGE_REQUEST_LABEL}"%`;

/** Create a triage request bead for the LLM triage agent to resolve. */
export function createTriageRequest(
  sql: SqlStorage,
  params: {
    triageType: TriageType;
    agentBeadId: string | null;
    /** The bead the agent was hooked to at the time of the request. */
    hookedBeadId?: string | null;
    title: string;
    context: Record<string, unknown>;
    options: string[];
    rigId?: string;
  }
): void {
  // Deduplicate: skip if an open triage request of the same type already
  // exists for this agent
  if (params.agentBeadId) {
    const existing = [
      ...query(
        sql,
        /* sql */ `
          SELECT ${beads.bead_id} FROM ${beads}
          WHERE ${beads.type} = 'issue'
            AND ${beads.labels} LIKE ?
            AND ${beads.status} = 'open'
            AND ${beads.assignee_agent_bead_id} = ?
            AND json_extract(${beads.metadata}, '$.triage_type') = ?
          LIMIT 1
        `,
        [TRIAGE_LABEL_LIKE, params.agentBeadId, params.triageType]
      ),
    ];
    if (existing.length > 0) return;
  }

  // Global cap: skip if there are already too many open *automatic* triage
  // requests (patrol-generated). Escalations are exempt from both the gate
  // and the count — they are agent/user initiated and silently dropping
  // them would leave the escalation bead with no automated follow-up.
  if (params.triageType !== 'escalation') {
    const openCountRows = [
      ...query(
        sql,
        /* sql */ `
          SELECT COUNT(*) AS cnt FROM ${beads}
          WHERE ${beads.type} = 'issue'
            AND ${beads.labels} LIKE ?
            AND ${beads.status} = 'open'
            AND json_extract(${beads.metadata}, '$.triage_type') != 'escalation'
        `,
        [TRIAGE_LABEL_LIKE]
      ),
    ];
    const openCount = Number(z.object({ cnt: z.number() }).parse(openCountRows[0]).cnt);
    if (openCount >= MAX_OPEN_TRIAGE_REQUESTS) {
      console.warn(
        `${LOG} createTriageRequest: global cap reached (${openCount} open), skipping type=${params.triageType}`
      );
      return;
    }
  }

  const metadata: TriageRequestMetadata = {
    triage_type: params.triageType,
    agent_bead_id: params.agentBeadId,
    hooked_bead_id: params.hookedBeadId ?? null,
    context: params.context,
    options: params.options,
  };

  createBead(sql, {
    type: 'issue',
    title: params.title,
    body: JSON.stringify(params.context),
    priority: 'medium',
    metadata,
    labels: [TRIAGE_REQUEST_LABEL],
    assignee_agent_bead_id: params.agentBeadId ?? undefined,
    rig_id: params.rigId,
  });

  console.log(
    `${LOG} createTriageRequest: type=${params.triageType} agent=${params.agentBeadId ?? 'none'}`
  );
}

// ── Pending triage requests ─────────────────────────────────────────

/** Count open triage request beads (issue beads with gt:triage-request label). */
export function countPendingTriageRequests(sql: SqlStorage): number {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT COUNT(*) AS cnt FROM ${beads}
        WHERE ${beads.type} = 'issue'
          AND ${beads.labels} LIKE ?
          AND ${beads.status} = 'open'
      `,
      [TRIAGE_LABEL_LIKE]
    ),
  ];
  return Number(z.object({ cnt: z.number() }).parse(rows[0]).cnt);
}

/** List open triage request beads for the triage agent prompt. */
export function listPendingTriageRequests(sql: SqlStorage): z.output<typeof BeadRecordSchema>[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${beads}
        WHERE ${beads.type} = 'issue'
          AND ${beads.labels} LIKE ?
          AND ${beads.status} = 'open'
        ORDER BY ${beads.created_at} ASC
        LIMIT 20
      `,
      [TRIAGE_LABEL_LIKE]
    ),
  ];
  return BeadRecordSchema.array().parse(rows);
}
