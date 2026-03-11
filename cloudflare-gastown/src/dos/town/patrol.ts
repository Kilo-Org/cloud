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
import { agent_metadata, AgentMetadataRecord } from '../../db/tables/agent-metadata.table';
import { bead_dependencies } from '../../db/tables/bead-dependencies.table';
import { query } from '../../util/query.util';
import { sendMail } from './mail';
import { deleteAgent, getOrCreateAgent, hookBead, unhookBead } from './agents';
import { createBead, updateBeadStatus } from './beads';

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
/** Per-bead timeout (if metadata.timeout_ms is set) */
export const DEFAULT_BEAD_TIMEOUT_MS = 4 * 60 * 60_000; // 4h fallback
/** Hook considered stale after this duration with no dispatch activity */
export const STALE_HOOK_MS = 30 * 60_000; // 30 min
/** Agent failing repeatedly within this window is a crash loop */
export const CRASH_LOOP_WINDOW_MS = 30 * 60_000; // 30 min
/** Minimum failures within the window to flag a crash loop */
export const CRASH_LOOP_THRESHOLD = 3;
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

// ── Witness patrol sub-checks ───────────────────────────────────────

/**
 * Tiered GUPP violation handling:
 * - 30 min: send GUPP_CHECK mail (existing behavior)
 * - 1h: escalate to mayor
 * - 2h: force-stop agent, create triage request for dirty polecat
 *
 * Returns agent IDs that were force-stopped (caller should stop them
 * in the container).
 */
export function detectGUPPViolations(
  sql: SqlStorage,
  workingAgents: Array<{
    bead_id: string;
    current_hook_bead_id: string | null;
    last_activity_at: string | null;
  }>
): string[] {
  const nowMs = Date.now();
  const forceStopIds: string[] = [];

  for (const agent of workingAgents) {
    if (!agent.last_activity_at) continue;
    const staleMs = nowMs - new Date(agent.last_activity_at).getTime();

    if (staleMs >= GUPP_FORCE_STOP_MS) {
      // Tier 3: force-stop and flag for triage
      forceStopIds.push(agent.bead_id);

      createTriageRequest(sql, {
        triageType: 'stuck_agent',
        agentBeadId: agent.bead_id,
        hookedBeadId: agent.current_hook_bead_id,
        title: `Force-stopped agent after ${Math.round(staleMs / 60_000)}min GUPP violation`,
        context: {
          last_activity_at: agent.last_activity_at,
          stale_minutes: Math.round(staleMs / 60_000),
          action_taken: 'force_stop',
        },
        options: ['RESTART', 'ESCALATE_TO_MAYOR', 'CLOSE_BEAD'],
      });

      // Mark agent as stalled
      query(
        sql,
        /* sql */ `
          UPDATE ${agent_metadata}
          SET ${agent_metadata.columns.status} = 'stalled'
          WHERE ${agent_metadata.bead_id} = ?
        `,
        [agent.bead_id]
      );

      console.log(
        `${LOG} GUPP force-stop: agent=${agent.bead_id} stale=${Math.round(staleMs / 60_000)}min`
      );
    } else if (staleMs >= GUPP_ESCALATE_MS) {
      // Tier 2: create a triage request for the stuck agent. The triage
      // agent (or mayor, if escalated) will decide whether to restart,
      // nudge, or force-stop. Also warn the stuck agent directly.
      const existingEsc = [
        ...query(
          sql,
          /* sql */ `
            SELECT ${beads.bead_id} FROM ${beads}
            WHERE ${beads.type} = 'message'
              AND ${beads.assignee_agent_bead_id} = ?
              AND ${beads.title} = 'GUPP_ESCALATION'
              AND ${beads.status} = 'open'
            LIMIT 1
          `,
          [agent.bead_id]
        ),
      ];
      if (existingEsc.length === 0) {
        // Notify the stuck agent
        sendMail(sql, {
          from_agent_id: 'patrol',
          to_agent_id: agent.bead_id,
          subject: 'GUPP_ESCALATION',
          body: `You have been inactive for ${Math.round(staleMs / 60_000)} minutes. This has been escalated. You will be force-stopped if inactivity continues.`,
        });

        // Create a triage request so the triage agent (or mayor) is aware
        createTriageRequest(sql, {
          triageType: 'stuck_agent',
          agentBeadId: agent.bead_id,
          hookedBeadId: agent.current_hook_bead_id,
          title: `Agent inactive for ${Math.round(staleMs / 60_000)}min — GUPP escalation`,
          context: {
            last_activity_at: agent.last_activity_at,
            stale_minutes: Math.round(staleMs / 60_000),
            tier: 'escalation',
          },
          options: ['RESTART', 'NUDGE', 'ESCALATE_TO_MAYOR', 'CLOSE_BEAD'],
        });

        console.log(`${LOG} GUPP escalation: agent=${agent.bead_id}`);
      }
    } else if (staleMs >= GUPP_WARN_MS) {
      // Tier 1: send warning mail (existing behavior, idempotent)
      const existingGupp = [
        ...query(
          sql,
          /* sql */ `
            SELECT ${beads.bead_id} FROM ${beads}
            WHERE ${beads.type} = 'message'
              AND ${beads.assignee_agent_bead_id} = ?
              AND ${beads.title} = 'GUPP_CHECK'
              AND ${beads.status} = 'open'
            LIMIT 1
          `,
          [agent.bead_id]
        ),
      ];
      if (existingGupp.length === 0) {
        sendMail(sql, {
          from_agent_id: 'patrol',
          to_agent_id: agent.bead_id,
          subject: 'GUPP_CHECK',
          body: 'You have had work hooked for 30+ minutes with no activity. Are you stuck? If so, call gt_escalate.',
        });
      }
    }
  }

  return forceStopIds;
}

/**
 * Detect orphaned work: idle agents with a hooked bead but no recent
 * dispatch activity. These agents were assigned work but never started.
 *
 * Different from schedulePendingWork which handles the cooldown/retry
 * loop — this catches agents that have been idle+hooked for an
 * unreasonably long time (beyond what the scheduler would tolerate).
 */
export function detectOrphanedWork(sql: SqlStorage): void {
  const cutoff = new Date(Date.now() - STALE_HOOK_MS).toISOString();

  const rows = AgentMetadataRecord.pick({
    bead_id: true,
    current_hook_bead_id: true,
    dispatch_attempts: true,
    last_activity_at: true,
  })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
          SELECT ${agent_metadata.bead_id},
                 ${agent_metadata.current_hook_bead_id},
                 ${agent_metadata.dispatch_attempts},
                 ${agent_metadata.last_activity_at}
          FROM ${agent_metadata}
          WHERE ${agent_metadata.status} = 'idle'
            AND ${agent_metadata.current_hook_bead_id} IS NOT NULL
            AND ${agent_metadata.dispatch_attempts} >= 5
            AND (${agent_metadata.last_activity_at} IS NULL OR ${agent_metadata.last_activity_at} < ?)
        `,
        [cutoff]
      ),
    ]);

  for (const row of rows) {
    // These agents have exhausted dispatch attempts AND are still hooked.
    // schedulePendingWork should have failed the bead — this is a safety net.
    console.log(
      `${LOG} orphaned work detected: agent=${row.bead_id} hook=${row.current_hook_bead_id} attempts=${row.dispatch_attempts}`
    );

    // Actually fail the bead and unhook the agent (matching schedulePendingWork behavior)
    if (row.current_hook_bead_id) {
      updateBeadStatus(sql, row.current_hook_bead_id, 'failed', row.bead_id);
      unhookBead(sql, row.bead_id);
    }
  }
}

/**
 * Garbage-collect dead/completed agents past the retention period.
 * Agents in 'idle' status with no hooked bead whose creation time
 * exceeds the retention threshold and that have been idle for longer
 * than the retention period are deleted.
 *
 * Only targets polecats and refinery agents — the mayor singleton
 * is never GC'd.
 */
export function agentGC(sql: SqlStorage): number {
  const cutoff = new Date(Date.now() - AGENT_GC_RETENTION_MS).toISOString();

  // Find agents eligible for GC: idle polecats/refinery with no hook,
  // whose last activity is older than the retention period
  const rows = AgentMetadataRecord.pick({ bead_id: true })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
          SELECT ${agent_metadata.bead_id}
          FROM ${agent_metadata}
          WHERE ${agent_metadata.status} IN ('idle', 'dead')
            AND ${agent_metadata.current_hook_bead_id} IS NULL
            AND ${agent_metadata.role} IN ('polecat', 'refinery')
            AND (
              ${agent_metadata.last_activity_at} IS NOT NULL
              AND ${agent_metadata.last_activity_at} < ?
            )
        `,
        [cutoff]
      ),
    ]);

  for (const row of rows) {
    console.log(`${LOG} agentGC: deleting agent=${row.bead_id}`);
    deleteAgent(sql, row.bead_id);
  }

  return rows.length;
}

/**
 * Enforce per-bead timeouts. Beads with metadata.timeout_ms that have
 * been in_progress for longer than their timeout are failed.
 *
 * Returns timed-out bead IDs and their assigned agent IDs (so the
 * caller can stop the agent processes in the container).
 */
export function checkTimerGates(
  sql: SqlStorage
): Array<{ beadId: string; agentId: string | null }> {
  const nowMs = Date.now();
  const timedOut: Array<{ beadId: string; agentId: string | null }> = [];

  // Find in_progress beads with a timeout_ms in metadata
  const rows = BeadRecordSchema.pick({
    bead_id: true,
    metadata: true,
    updated_at: true,
    assignee_agent_bead_id: true,
  })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
          SELECT ${beads.bead_id}, ${beads.metadata}, ${beads.updated_at}, ${beads.assignee_agent_bead_id}
          FROM ${beads}
          WHERE ${beads.status} = 'in_progress'
            AND ${beads.type} IN ('issue', 'molecule')
            AND json_extract(${beads.metadata}, '$.timeout_ms') IS NOT NULL
        `,
        []
      ),
    ]);

  for (const row of rows) {
    const timeoutMs = Number(row.metadata?.timeout_ms ?? DEFAULT_BEAD_TIMEOUT_MS);
    if (!timeoutMs || isNaN(timeoutMs) || timeoutMs <= 0) continue;

    const elapsedMs = nowMs - new Date(row.updated_at).getTime();
    if (elapsedMs > timeoutMs) {
      // Fail the bead and unhook the assigned agent so the scheduler
      // can recover the slot (matching schedulePendingWork's failure path).
      // updateBeadStatus already logs a status_changed event internally,
      // so no additional logBeadEvent call is needed here.
      updateBeadStatus(sql, row.bead_id, 'failed', row.assignee_agent_bead_id ?? 'patrol');

      if (row.assignee_agent_bead_id) {
        unhookBead(sql, row.assignee_agent_bead_id);
      }

      timedOut.push({ beadId: row.bead_id, agentId: row.assignee_agent_bead_id ?? null });
      console.log(
        `${LOG} checkTimerGates: bead=${row.bead_id} timed out after ${Math.round(elapsedMs / 60_000)}min (limit=${Math.round(timeoutMs / 60_000)}min)`
      );
    }
  }

  return timedOut;
}

// ── Deacon patrol sub-checks ────────────────────────────────────────

/**
 * Detect stale hooks: agents that have been idle with a hook for an
 * extended period without any dispatch activity. This catches cases
 * where schedulePendingWork's cooldown/retry loop failed silently.
 *
 * Different from detectOrphanedWork (which catches exhausted retries) —
 * this catches agents that are hooked+idle but haven't even been
 * attempted recently.
 */
export function detectStaleHooks(sql: SqlStorage): void {
  const cutoff = new Date(Date.now() - STALE_HOOK_MS).toISOString();

  const rows = AgentMetadataRecord.pick({
    bead_id: true,
    current_hook_bead_id: true,
    dispatch_attempts: true,
    last_activity_at: true,
  })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
          SELECT ${agent_metadata.bead_id},
                 ${agent_metadata.current_hook_bead_id},
                 ${agent_metadata.dispatch_attempts},
                 ${agent_metadata.last_activity_at}
          FROM ${agent_metadata}
          WHERE ${agent_metadata.status} = 'idle'
            AND ${agent_metadata.current_hook_bead_id} IS NOT NULL
            AND ${agent_metadata.dispatch_attempts} < 5
            AND (${agent_metadata.last_activity_at} IS NULL OR ${agent_metadata.last_activity_at} < ?)
        `,
        [cutoff]
      ),
    ]);

  for (const row of rows) {
    // Reset last_activity_at to trigger schedulePendingWork to pick it up
    // on the next alarm cycle (it skips agents with recent activity).
    query(
      sql,
      /* sql */ `
        UPDATE ${agent_metadata}
        SET ${agent_metadata.columns.last_activity_at} = NULL
        WHERE ${agent_metadata.bead_id} = ?
      `,
      [row.bead_id]
    );

    console.log(
      `${LOG} stale hook nudge: agent=${row.bead_id} hook=${row.current_hook_bead_id} attempts=${row.dispatch_attempts}`
    );
  }
}

/**
 * Feed stranded convoys: find active convoys that have open beads with
 * no assigned agent. Auto-sling by assigning idle polecats.
 */
export function feedStrandedConvoys(sql: SqlStorage, townId: string): void {
  // Find open issue beads that:
  // 1. Belong to an active convoy (tracked by a convoy bead)
  // 2. Have no assigned agent
  const StrandedBeadRow = z.object({
    bead_id: z.string(),
    rig_id: z.string().nullable(),
    convoy_bead_id: z.string(),
  });

  const rows = StrandedBeadRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${beads.bead_id},
               ${beads.rig_id},
               ${bead_dependencies.depends_on_bead_id} AS convoy_bead_id
        FROM ${bead_dependencies}
        INNER JOIN ${beads} ON ${bead_dependencies.bead_id} = ${beads.bead_id}
        INNER JOIN ${beads} AS convoy ON ${bead_dependencies.depends_on_bead_id} = convoy.${beads.columns.bead_id}
        WHERE ${bead_dependencies.dependency_type} = 'tracks'
          AND convoy.${beads.columns.type} = 'convoy'
          AND convoy.${beads.columns.status} = 'open'
          AND ${beads.status} = 'open'
          AND ${beads.type} = 'issue'
          AND ${beads.assignee_agent_bead_id} IS NULL
      `,
      []
    ),
  ]);

  if (rows.length === 0) return;

  console.log(`${LOG} feedStrandedConvoys: found ${rows.length} unassigned convoy bead(s)`);

  // For each stranded bead, find or create an idle polecat in the same rig
  // and hook it. The next schedulePendingWork cycle will dispatch it.
  // We import getOrCreateAgent inline to avoid circular dependency issues.
  for (const row of rows) {
    const rigId = row.rig_id;
    if (!rigId) continue;

    try {
      const agent = getOrCreateAgent(sql, 'polecat', rigId, townId);
      hookBead(sql, agent.id, row.bead_id);
      // Clear last_activity_at so schedulePendingWork picks this up on
      // the next alarm tick instead of waiting for the dispatch cooldown.
      query(
        sql,
        /* sql */ `
          UPDATE ${agent_metadata}
          SET ${agent_metadata.columns.last_activity_at} = NULL
          WHERE ${agent_metadata.bead_id} = ?
        `,
        [agent.id]
      );
      console.log(
        `${LOG} feedStrandedConvoys: assigned agent=${agent.id} to bead=${row.bead_id} in convoy=${row.convoy_bead_id}`
      );
    } catch (err) {
      console.warn(
        `${LOG} feedStrandedConvoys: failed to assign agent to bead=${row.bead_id}:`,
        err
      );
    }
  }
}

/**
 * Detect crash loops: agents that have failed repeatedly within a
 * short window. Creates a triage request for LLM assessment.
 *
 * Crash loop detection uses the bead_events table to count recent
 * status_changed events to 'failed' for each agent.
 */
export function detectCrashLoops(sql: SqlStorage): void {
  const windowCutoff = new Date(Date.now() - CRASH_LOOP_WINDOW_MS).toISOString();

  // Count recent failure events per agent
  const CrashRow = z.object({
    agent_id: z.string(),
    fail_count: z.number(),
  });

  // Exclude triage agents from crash loop detection — their failures must
  // not create new triage requests, which would feed the feedback loop.
  // Two complementary checks:
  //  1. The failed bead itself carries a triage label (covers triage batch
  //     bead failures, stable after unhook clears current_hook_bead_id).
  //  2. The agent is currently hooked to a triage-labeled bead (covers
  //     resolveTriage actions like CLOSE_BEAD that fail ordinary beads
  //     while the triage agent is still working its batch).
  const TRIAGE_LABEL_ANY = `%"gt:triage%`;

  const rows = CrashRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT be.agent_id, COUNT(*) AS fail_count
        FROM bead_events AS be
        WHERE be.event_type = 'status_changed'
          AND be.new_value = 'failed'
          AND be.agent_id IS NOT NULL
          AND be.created_at > ?
          AND NOT EXISTS (
            SELECT 1 FROM ${beads} AS failed_bead
            WHERE failed_bead.${beads.columns.bead_id} = be.bead_id
              AND failed_bead.${beads.columns.labels} LIKE ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${agent_metadata}
            INNER JOIN ${beads} AS hooked
              ON ${agent_metadata.current_hook_bead_id} = hooked.${beads.columns.bead_id}
            WHERE ${agent_metadata.bead_id} = be.agent_id
              AND hooked.${beads.columns.labels} LIKE ?
          )
        GROUP BY be.agent_id
        HAVING fail_count >= ?
      `,
      [windowCutoff, TRIAGE_LABEL_ANY, TRIAGE_LABEL_ANY, CRASH_LOOP_THRESHOLD]
    ),
  ]);

  for (const row of rows) {
    createTriageRequest(sql, {
      triageType: 'crash_loop',
      agentBeadId: row.agent_id,
      title: `Crash loop detected: ${row.fail_count} failures in ${CRASH_LOOP_WINDOW_MS / 60_000}min`,
      context: {
        agent_id: row.agent_id,
        fail_count: row.fail_count,
        window_minutes: CRASH_LOOP_WINDOW_MS / 60_000,
      },
      options: ['RESTART_WITH_BACKOFF', 'REASSIGN_BEAD', 'ESCALATE_TO_MAYOR'],
    });

    console.log(
      `${LOG} crash loop: agent=${row.agent_id} failures=${row.fail_count} in ${CRASH_LOOP_WINDOW_MS / 60_000}min`
    );
  }
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
