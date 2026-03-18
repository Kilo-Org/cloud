/**
 * Bead CRUD operations for the Town DO.
 * After the beads-centric refactor (#441), all object types are beads.
 */

import { z } from 'zod';
import { beads, BeadRecord, createTableBeads, getIndexesBeads } from '../../db/tables/beads.table';
import {
  bead_events,
  BeadEventRecord,
  createTableBeadEvents,
  getIndexesBeadEvents,
} from '../../db/tables/bead-events.table';
import {
  bead_dependencies,
  BeadDependencyRecord,
  createTableBeadDependencies,
  getIndexesBeadDependencies,
} from '../../db/tables/bead-dependencies.table';
import {
  agent_metadata,
  createTableAgentMetadata,
  migrateAgentMetadata,
} from '../../db/tables/agent-metadata.table';
import { review_metadata, createTableReviewMetadata } from '../../db/tables/review-metadata.table';
import {
  escalation_metadata,
  createTableEscalationMetadata,
} from '../../db/tables/escalation-metadata.table';
import {
  convoy_metadata,
  createTableConvoyMetadata,
  migrateConvoyMetadata,
} from '../../db/tables/convoy-metadata.table';
import { query } from '../../util/query.util';
import type {
  CreateBeadInput,
  BeadFilter,
  Bead,
  BeadStatus,
  BeadPriority,
  BeadType,
} from '../../types';
import type { BeadEventType } from '../../db/tables/bead-events.table';

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

export function initBeadTables(sql: SqlStorage): void {
  // Create all tables first (IF NOT EXISTS — safe for existing DOs)
  query(sql, createTableBeads(), []);
  query(sql, createTableBeadEvents(), []);
  query(sql, createTableBeadDependencies(), []);
  query(sql, createTableAgentMetadata(), []);
  query(sql, createTableReviewMetadata(), []);
  query(sql, createTableEscalationMetadata(), []);
  query(sql, createTableConvoyMetadata(), []);

  // Migration: drop CHECK constraints from existing tables.
  // Must run BEFORE index creation — rebuilding a table drops its indexes.
  dropCheckConstraints(sql);

  // Migrations: add columns to existing tables (idempotent)
  for (const stmt of [...migrateConvoyMetadata(), ...migrateAgentMetadata()]) {
    try {
      query(sql, stmt, []);
    } catch {
      // Column already exists — expected after first run
    }
  }

  // Create indexes after migrations (IF NOT EXISTS — idempotent)
  for (const idx of getIndexesBeads()) {
    query(sql, idx, []);
  }
  for (const idx of getIndexesBeadEvents()) {
    query(sql, idx, []);
  }
  for (const idx of getIndexesBeadDependencies()) {
    query(sql, idx, []);
  }
}

/**
 * Detect tables with CHECK constraints and recreate them without.
 * Uses SQLite's "CREATE TABLE ... AS SELECT" pattern to rebuild.
 *
 * Idempotent: if a table has no CHECK constraints, it's skipped.
 */
function dropCheckConstraints(sql: SqlStorage): void {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT name, sql as create_sql
        FROM sqlite_master
        WHERE type = 'table'
          AND sql LIKE '%check(%'
      `,
      []
    ),
  ];

  for (const row of rows) {
    if (typeof row.name !== 'string' || typeof row.create_sql !== 'string') continue;
    const tableName = row.name;
    const originalSql = row.create_sql;

    // Strip all check(...) clauses from the CREATE TABLE statement.
    // Handles nested parens like check(status in ('open', 'closed')).
    const cleanedSql = originalSql.replace(
      /,?\s*check\s*\((?:[^()]*|\((?:[^()]*|\([^()]*\))*\))*\)/gi,
      ''
    );

    // Skip if nothing changed (shouldn't happen given the WHERE clause)
    if (cleanedSql === originalSql) continue;

    // Rebuild the table: rename → recreate → copy → drop old
    const tmpName = `_${tableName}_migrate`;
    try {
      query(sql, /* sql */ `ALTER TABLE "${tableName}" RENAME TO "${tmpName}"`, []);
      query(sql, cleanedSql, []);
      query(sql, /* sql */ `INSERT INTO "${tableName}" SELECT * FROM "${tmpName}"`, []);
      query(sql, /* sql */ `DROP TABLE "${tmpName}"`, []);
    } catch (err) {
      // If migration fails mid-way, try to restore the original table
      try {
        query(sql, /* sql */ `DROP TABLE IF EXISTS "${tableName}"`, []);
        query(sql, /* sql */ `ALTER TABLE "${tmpName}" RENAME TO "${tableName}"`, []);
      } catch {
        // Best effort — the original table name should still be usable
      }
      console.warn(`[beads] CHECK constraint migration failed for ${tableName}:`, err);
    }
  }
}

export function createBead(sql: SqlStorage, input: CreateBeadInput): Bead {
  const id = generateId();
  const timestamp = now();

  const labels = JSON.stringify(input.labels ?? []);
  const metadata = JSON.stringify(input.metadata ?? {});

  query(
    sql,
    /* sql */ `
      INSERT INTO ${beads} (
        ${beads.columns.bead_id},
        ${beads.columns.type},
        ${beads.columns.status},
        ${beads.columns.title},
        ${beads.columns.body},
        ${beads.columns.rig_id},
        ${beads.columns.parent_bead_id},
        ${beads.columns.assignee_agent_bead_id},
        ${beads.columns.priority},
        ${beads.columns.labels},
        ${beads.columns.metadata},
        ${beads.columns.created_by},
        ${beads.columns.created_at},
        ${beads.columns.updated_at},
        ${beads.columns.closed_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      input.type,
      'open',
      input.title,
      input.body ?? null,
      input.rig_id ?? null,
      input.parent_bead_id ?? null,
      input.assignee_agent_bead_id ?? null,
      input.priority ?? 'medium',
      labels,
      metadata,
      input.created_by ?? null,
      timestamp,
      timestamp,
      null,
    ]
  );

  const bead = getBead(sql, id);
  if (!bead) throw new Error('Failed to create bead');

  logBeadEvent(sql, {
    beadId: id,
    agentId: input.assignee_agent_bead_id ?? null,
    eventType: 'created',
    newValue: 'open',
    metadata: { type: input.type, title: input.title },
  });

  return bead;
}

export function getBead(sql: SqlStorage, beadId: string): Bead | null {
  const rows = [
    ...query(sql, /* sql */ `SELECT * FROM ${beads} WHERE ${beads.bead_id} = ?`, [beadId]),
  ];
  if (rows.length === 0) return null;
  return BeadRecord.parse(rows[0]);
}

export function listBeads(sql: SqlStorage, filter: BeadFilter): Bead[] {
  const limit = filter.limit ?? 100;
  const offset = filter.offset ?? 0;

  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${beads}
        WHERE (? IS NULL OR ${beads.status} = ?)
          AND (? IS NULL OR ${beads.type} = ?)
          AND (? IS NULL OR ${beads.assignee_agent_bead_id} = ?)
          AND (? IS NULL OR ${beads.parent_bead_id} = ?)
          AND (? IS NULL OR ${beads.rig_id} = ?)
        ORDER BY ${beads.created_at} DESC
        LIMIT ? OFFSET ?
      `,
      [
        filter.status ?? null,
        filter.status ?? null,
        filter.type ?? null,
        filter.type ?? null,
        filter.assignee_agent_bead_id ?? null,
        filter.assignee_agent_bead_id ?? null,
        filter.parent_bead_id ?? null,
        filter.parent_bead_id ?? null,
        filter.rig_id ?? null,
        filter.rig_id ?? null,
        limit,
        offset,
      ]
    ),
  ];

  return BeadRecord.array().parse(rows);
}

export function updateBeadStatus(
  sql: SqlStorage,
  beadId: string,
  status: string,
  agentId: string | null
): Bead {
  const bead = getBead(sql, beadId);
  if (!bead) throw new Error(`Bead ${beadId} not found`);

  // No-op if already in the target status — avoids redundant events
  if (bead.status === status) return bead;

  const oldStatus = bead.status;
  const timestamp = now();
  const closedAt = status === 'closed' ? timestamp : bead.closed_at;

  query(
    sql,
    /* sql */ `
      UPDATE ${beads}
      SET ${beads.columns.status} = ?,
          ${beads.columns.updated_at} = ?,
          ${beads.columns.closed_at} = ?
      WHERE ${beads.bead_id} = ?
    `,
    [status, timestamp, closedAt, beadId]
  );

  logBeadEvent(sql, {
    beadId,
    agentId,
    eventType: 'status_changed',
    oldValue: oldStatus,
    newValue: status,
  });

  // If the bead reached a terminal status and is tracked by a convoy,
  // update the convoy's closed_beads counter and auto-land if complete.
  if (status === 'closed' || status === 'failed') {
    updateConvoyProgress(sql, beadId, timestamp);
  }

  const updated = getBead(sql, beadId);
  if (!updated) throw new Error(`Bead ${beadId} not found after update`);
  return updated;
}

/**
 * If beadId is tracked by a convoy (via bead_dependencies 'tracks'),
 * recount closed beads and update convoy_metadata. Auto-lands the
 * convoy when all tracked beads are closed.
 */
export function updateConvoyProgress(sql: SqlStorage, beadId: string, timestamp: string): void {
  const convoyRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${bead_dependencies.depends_on_bead_id}
        FROM ${bead_dependencies}
        WHERE ${bead_dependencies.bead_id} = ?
          AND ${bead_dependencies.dependency_type} = 'tracks'
      `,
      [beadId]
    ),
  ];
  if (convoyRows.length === 0) return;

  for (const row of convoyRows) {
    const convoyId = z.object({ depends_on_bead_id: z.string() }).parse(row).depends_on_bead_id;

    // Skip if this isn't actually a convoy (e.g. MR bead 'tracks' its source bead,
    // which may not be a convoy). No convoy_metadata row → not a convoy.
    const metaCheck = [
      ...query(
        sql,
        /* sql */ `
          SELECT 1 FROM ${convoy_metadata}
          WHERE ${convoy_metadata.bead_id} = ?
        `,
        [convoyId]
      ),
    ];
    if (metaCheck.length === 0) continue;

    // Count tracked beads that are fully done: closed/failed AND have no
    // pending merge_request child beads. This prevents marking a convoy as
    // ready_to_land while reviews are still in flight.
    const countRows = [
      ...query(
        sql,
        /* sql */ `
          SELECT COUNT(1) AS count FROM ${bead_dependencies} AS tracked
          INNER JOIN ${beads} AS tracked_bead
            ON tracked.${bead_dependencies.columns.bead_id} = tracked_bead.${beads.columns.bead_id}
          WHERE tracked.${bead_dependencies.columns.depends_on_bead_id} = ?
            AND tracked.${bead_dependencies.columns.dependency_type} = 'tracks'
            AND tracked_bead.${beads.columns.status} IN ('closed', 'failed')
            AND NOT EXISTS (
              SELECT 1 FROM ${bead_dependencies} AS mr_dep
              INNER JOIN ${beads} AS mr_bead
                ON mr_dep.${bead_dependencies.columns.bead_id} = mr_bead.${beads.columns.bead_id}
              WHERE mr_dep.${bead_dependencies.columns.depends_on_bead_id} = tracked_bead.${beads.columns.bead_id}
                AND mr_dep.${bead_dependencies.columns.dependency_type} = 'tracks'
                AND mr_bead.${beads.columns.type} = 'merge_request'
                AND mr_bead.${beads.columns.status} IN ('open', 'in_progress')
            )
        `,
        [convoyId]
      ),
    ];
    const closedCount = z.object({ count: z.number() }).parse(countRows[0]).count;

    query(
      sql,
      /* sql */ `
        UPDATE ${convoy_metadata}
        SET ${convoy_metadata.columns.closed_beads} = ?
        WHERE ${convoy_metadata.bead_id} = ?
      `,
      [closedCount, convoyId]
    );

    // Check if convoy should auto-land
    const metaRows = [
      ...query(
        sql,
        /* sql */ `
          SELECT ${convoy_metadata.total_beads}
          FROM ${convoy_metadata}
          WHERE ${convoy_metadata.bead_id} = ?
        `,
        [convoyId]
      ),
    ];
    const totalBeads = z.object({ total_beads: z.number() }).parse(metaRows[0]).total_beads;

    if (closedCount >= totalBeads && totalBeads > 0) {
      // For review-then-land convoys with a feature branch, don't auto-close
      // the convoy yet — it needs a final merge of the feature branch into
      // main. For review-and-merge convoys (where each bead already landed
      // independently), auto-close immediately.
      const featureBranch = getConvoyFeatureBranch(sql, convoyId);
      const mergeMode = getConvoyMergeMode(sql, convoyId);

      if (featureBranch && mergeMode === 'review-then-land') {
        // Mark the convoy as ready to land by storing a flag in metadata.
        // The alarm loop's processReviewQueue will detect this and create
        // the final landing MR (feature branch → main).
        query(
          sql,
          /* sql */ `
            UPDATE ${beads}
            SET ${beads.columns.metadata} = json_set(COALESCE(${beads.metadata}, '{}'), '$.ready_to_land', 1),
                ${beads.columns.updated_at} = ?
            WHERE ${beads.bead_id} = ?
          `,
          [timestamp, convoyId]
        );
        query(
          sql,
          /* sql */ `
            UPDATE ${convoy_metadata}
            SET ${convoy_metadata.columns.closed_beads} = ?
            WHERE ${convoy_metadata.bead_id} = ?
          `,
          [closedCount, convoyId]
        );
      } else {
        // No feature branch — auto-land immediately (backwards compatible)
        query(
          sql,
          /* sql */ `
            UPDATE ${beads}
            SET ${beads.columns.status} = 'closed',
                ${beads.columns.closed_at} = ?,
                ${beads.columns.updated_at} = ?
            WHERE ${beads.bead_id} = ?
          `,
          [timestamp, timestamp, convoyId]
        );
        query(
          sql,
          /* sql */ `
            UPDATE ${convoy_metadata}
            SET ${convoy_metadata.columns.landed_at} = ?
            WHERE ${convoy_metadata.bead_id} = ?
          `,
          [timestamp, convoyId]
        );
      }
    }
  }
}

/**
 * Check if a bead has unresolved 'blocks' dependencies.
 *
 * A blocker is resolved only when:
 * 1. The blocker bead itself is closed or failed, AND
 * 2. The blocker has no pending merge_request child beads (open/in_progress).
 *
 * Condition (2) prevents dispatching downstream beads before the refinery
 * has reviewed and merged the upstream bead's work. Without this, the
 * downstream polecat would start on a codebase missing the upstream changes.
 */
export function hasUnresolvedBlockers(sql: SqlStorage, beadId: string): boolean {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT COUNT(1) AS count
        FROM ${bead_dependencies} AS dep
        INNER JOIN ${beads} AS blocker
          ON dep.${bead_dependencies.columns.depends_on_bead_id} = blocker.${beads.columns.bead_id}
        WHERE dep.${bead_dependencies.columns.bead_id} = ?
          AND dep.${bead_dependencies.columns.dependency_type} = 'blocks'
          AND (
            blocker.${beads.columns.status} NOT IN ('closed', 'failed')
            OR EXISTS (
              SELECT 1 FROM ${bead_dependencies} AS mr_dep
              INNER JOIN ${beads} AS mr_bead
                ON mr_dep.${bead_dependencies.columns.bead_id} = mr_bead.${beads.columns.bead_id}
              WHERE mr_dep.${bead_dependencies.columns.depends_on_bead_id} = blocker.${beads.columns.bead_id}
                AND mr_dep.${bead_dependencies.columns.dependency_type} = 'tracks'
                AND mr_bead.${beads.columns.type} = 'merge_request'
                AND mr_bead.${beads.columns.status} IN ('open', 'in_progress')
            )
          )
      `,
      [beadId]
    ),
  ];
  return z.object({ count: z.number() }).parse(rows[0]).count > 0;
}

/**
 * Find beads that were blocked by `closedBeadId` and are now fully unblocked
 * (all their 'blocks' dependencies are resolved).
 */
export function getNewlyUnblockedBeads(sql: SqlStorage, closedBeadId: string): string[] {
  // Find beads that depend on the closed bead via 'blocks'
  const dependentRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${bead_dependencies.bead_id}
        FROM ${bead_dependencies}
        WHERE ${bead_dependencies.depends_on_bead_id} = ?
          AND ${bead_dependencies.dependency_type} = 'blocks'
      `,
      [closedBeadId]
    ),
  ];

  const dependentIds = z
    .object({ bead_id: z.string() })
    .array()
    .parse(dependentRows)
    .map(r => r.bead_id);

  // For each dependent, check if ALL blockers are now resolved
  return dependentIds.filter(id => !hasUnresolvedBlockers(sql, id));
}

/**
 * Partial update of a bead's editable fields.
 * Only fields explicitly provided in `fields` are updated.
 * Writes a `fields_updated` bead_event for auditability.
 */
export function updateBeadFields(
  sql: SqlStorage,
  beadId: string,
  fields: Partial<{
    title: string;
    body: string | null;
    priority: BeadPriority;
    labels: string[];
    status: BeadStatus;
    metadata: Record<string, unknown>;
    type: BeadType;
    rig_id: string | null;
    parent_bead_id: string | null;
  }>,
  actorId: string
): Bead {
  const bead = getBead(sql, beadId);
  if (!bead) throw new Error(`Bead ${beadId} not found`);

  const timestamp = now();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (fields.title !== undefined) {
    setClauses.push(`${beads.columns.title} = ?`);
    values.push(fields.title);
  }
  if (fields.body !== undefined) {
    setClauses.push(`${beads.columns.body} = ?`);
    values.push(fields.body);
  }
  if (fields.priority !== undefined) {
    setClauses.push(`${beads.columns.priority} = ?`);
    values.push(fields.priority);
  }
  if (fields.labels !== undefined) {
    setClauses.push(`${beads.columns.labels} = ?`);
    values.push(JSON.stringify(fields.labels));
  }
  if (fields.status !== undefined) {
    setClauses.push(`${beads.columns.status} = ?`);
    values.push(fields.status);
    if (fields.status === 'closed') {
      // Set closed_at when transitioning to closed (preserve existing if already set)
      setClauses.push(`${beads.columns.closed_at} = ?`);
      values.push(bead.closed_at ?? timestamp);
    } else if (bead.closed_at) {
      // Clear closed_at when reopening a previously-closed bead
      setClauses.push(`${beads.columns.closed_at} = ?`);
      values.push(null);
    }
  }
  if (fields.metadata !== undefined) {
    setClauses.push(`${beads.columns.metadata} = ?`);
    values.push(JSON.stringify(fields.metadata));
  }
  if (fields.type !== undefined) {
    setClauses.push(`${beads.columns.type} = ?`);
    values.push(fields.type);
  }
  if (fields.rig_id !== undefined) {
    setClauses.push(`${beads.columns.rig_id} = ?`);
    values.push(fields.rig_id);
  }
  if (fields.parent_bead_id !== undefined) {
    setClauses.push(`${beads.columns.parent_bead_id} = ?`);
    values.push(fields.parent_bead_id);
  }

  if (setClauses.length === 0) return bead;

  setClauses.push(`${beads.columns.updated_at} = ?`);
  values.push(timestamp);
  values.push(beadId);

  // Dynamic SET clause — query() can't statically verify param count here,
  // so use sql.exec() directly. The early return above guarantees values is non-empty.
  sql.exec(
    /* sql */ `UPDATE ${beads} SET ${setClauses.join(', ')} WHERE ${beads.bead_id} = ?`,
    ...values
  );

  const changedFields = Object.keys(fields);
  logBeadEvent(sql, {
    beadId,
    agentId: actorId,
    eventType: 'fields_updated',
    newValue: changedFields.join(','),
    metadata: { changed: changedFields, actor: actorId },
  });

  // If status was updated to a terminal value, run convoy progress logic
  if (fields.status === 'closed' || fields.status === 'failed') {
    updateConvoyProgress(sql, beadId, timestamp);
  }

  const updated = getBead(sql, beadId);
  if (!updated) throw new Error(`Bead ${beadId} not found after update`);
  return updated;
}

export function closeBead(sql: SqlStorage, beadId: string, agentId: string): Bead {
  return updateBeadStatus(sql, beadId, 'closed', agentId);
}

export function deleteBead(sql: SqlStorage, beadId: string): void {
  // Recursively delete child beads (e.g. molecule steps) before the parent
  const children = BeadRecord.pick({ bead_id: true })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `SELECT ${beads.bead_id} FROM ${beads} WHERE ${beads.parent_bead_id} = ?`,
        [beadId]
      ),
    ]);
  for (const { bead_id } of children) {
    deleteBead(sql, bead_id);
  }

  // Unhook any agent assigned to this bead
  query(
    sql,
    /* sql */ `
      UPDATE ${agent_metadata}
      SET ${agent_metadata.columns.current_hook_bead_id} = NULL,
          ${agent_metadata.columns.status} = 'idle'
      WHERE ${agent_metadata.current_hook_bead_id} = ?
    `,
    [beadId]
  );

  // Delete dependencies referencing this bead
  query(
    sql,
    /* sql */ `DELETE FROM ${bead_dependencies} WHERE ${bead_dependencies.bead_id} = ? OR ${bead_dependencies.depends_on_bead_id} = ?`,
    [beadId, beadId]
  );

  query(sql, /* sql */ `DELETE FROM ${bead_events} WHERE ${bead_events.bead_id} = ?`, [beadId]);

  // Delete satellite metadata if present
  query(sql, /* sql */ `DELETE FROM ${agent_metadata} WHERE ${agent_metadata.bead_id} = ?`, [
    beadId,
  ]);
  query(sql, /* sql */ `DELETE FROM ${review_metadata} WHERE ${review_metadata.bead_id} = ?`, [
    beadId,
  ]);
  query(
    sql,
    /* sql */ `DELETE FROM ${escalation_metadata} WHERE ${escalation_metadata.bead_id} = ?`,
    [beadId]
  );
  query(sql, /* sql */ `DELETE FROM ${convoy_metadata} WHERE ${convoy_metadata.bead_id} = ?`, [
    beadId,
  ]);

  query(sql, /* sql */ `DELETE FROM ${beads} WHERE ${beads.bead_id} = ?`, [beadId]);
}

// ── Bead Events ─────────────────────────────────────────────────────

export function logBeadEvent(
  sql: SqlStorage,
  params: {
    beadId: string;
    agentId: string | null;
    eventType: BeadEventType;
    oldValue?: string | null;
    newValue?: string | null;
    metadata?: Record<string, unknown>;
  }
): void {
  query(
    sql,
    /* sql */ `
      INSERT INTO ${bead_events} (
        ${bead_events.columns.bead_event_id},
        ${bead_events.columns.bead_id},
        ${bead_events.columns.agent_id},
        ${bead_events.columns.event_type},
        ${bead_events.columns.old_value},
        ${bead_events.columns.new_value},
        ${bead_events.columns.metadata},
        ${bead_events.columns.created_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      generateId(),
      params.beadId,
      params.agentId,
      params.eventType,
      params.oldValue ?? null,
      params.newValue ?? null,
      JSON.stringify(params.metadata ?? {}),
      now(),
    ]
  );
}

export function listBeadEvents(
  sql: SqlStorage,
  options: {
    beadId?: string;
    since?: string;
    limit?: number;
  }
): BeadEventRecord[] {
  const limit = options.limit ?? 100;
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${bead_events}
        WHERE (? IS NULL OR ${bead_events.bead_id} = ?)
          AND (? IS NULL OR ${bead_events.created_at} > ?)
        ORDER BY ${bead_events.created_at} DESC
        LIMIT ?
      `,
      [
        options.beadId ?? null,
        options.beadId ?? null,
        options.since ?? null,
        options.since ?? null,
        limit,
      ]
    ),
  ];
  return BeadEventRecord.array().parse(rows);
}

// ── Bead Dependencies (DAG queries) ─────────────────────────────────

/**
 * Return all dependency edges for a given bead (both directions).
 * - blockers: beads that block this bead (this bead depends_on them)
 * - blocked_by_this: beads that this bead blocks (they depend_on this bead)
 * - tracks: convoys this bead is tracked by
 */
export function getBeadDependencies(
  sql: SqlStorage,
  beadId: string
): {
  blockers: Array<{ bead_id: string; depends_on_bead_id: string; dependency_type: string }>;
  dependents: Array<{ bead_id: string; depends_on_bead_id: string; dependency_type: string }>;
} {
  const DependencyRow = z.object({
    bead_id: z.string(),
    depends_on_bead_id: z.string(),
    dependency_type: z.string(),
  });

  // Forward: beads this bead depends on (its blockers / the convoys it tracks)
  const blockerRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${bead_dependencies.bead_id}, ${bead_dependencies.depends_on_bead_id},
               ${bead_dependencies.dependency_type}
        FROM ${bead_dependencies}
        WHERE ${bead_dependencies.bead_id} = ?
      `,
      [beadId]
    ),
  ];

  // Reverse: beads that depend on this bead
  const dependentRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${bead_dependencies.bead_id}, ${bead_dependencies.depends_on_bead_id},
               ${bead_dependencies.dependency_type}
        FROM ${bead_dependencies}
        WHERE ${bead_dependencies.depends_on_bead_id} = ?
      `,
      [beadId]
    ),
  ];

  return {
    blockers: DependencyRow.array().parse(blockerRows),
    dependents: DependencyRow.array().parse(dependentRows),
  };
}

/**
 * Return all 'blocks' dependency edges for beads tracked by a convoy.
 * Used to render the DAG in the convoy UI.
 */
export function getConvoyDependencyEdges(
  sql: SqlStorage,
  convoyId: string
): Array<{ bead_id: string; depends_on_bead_id: string }> {
  const EdgeRow = z.object({
    bead_id: z.string(),
    depends_on_bead_id: z.string(),
  });

  // First get all bead IDs tracked by this convoy
  // Then get all 'blocks' edges between those beads
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT dep.${bead_dependencies.columns.bead_id},
               dep.${bead_dependencies.columns.depends_on_bead_id}
        FROM ${bead_dependencies} AS dep
        WHERE dep.${bead_dependencies.columns.dependency_type} = 'blocks'
          AND dep.${bead_dependencies.columns.bead_id} IN (
            SELECT tracked.${bead_dependencies.columns.bead_id}
            FROM ${bead_dependencies} AS tracked
            WHERE tracked.${bead_dependencies.columns.depends_on_bead_id} = ?
              AND tracked.${bead_dependencies.columns.dependency_type} = 'tracks'
          )
          AND dep.${bead_dependencies.columns.depends_on_bead_id} IN (
            SELECT tracked2.${bead_dependencies.columns.bead_id}
            FROM ${bead_dependencies} AS tracked2
            WHERE tracked2.${bead_dependencies.columns.depends_on_bead_id} = ?
              AND tracked2.${bead_dependencies.columns.dependency_type} = 'tracks'
          )
      `,
      [convoyId, convoyId]
    ),
  ];

  return EdgeRow.array().parse(rows);
}

/**
 * Find the convoy a bead belongs to (if any) via 'tracks' dependencies.
 * Returns the convoy bead_id or null.
 */
export function getConvoyForBead(sql: SqlStorage, beadId: string): string | null {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${bead_dependencies.depends_on_bead_id}
        FROM ${bead_dependencies}
        WHERE ${bead_dependencies.bead_id} = ?
          AND ${bead_dependencies.dependency_type} = 'tracks'
      `,
      [beadId]
    ),
  ];
  if (rows.length === 0) return null;
  return z.object({ depends_on_bead_id: z.string() }).parse(rows[0]).depends_on_bead_id;
}

/**
 * Get the merge_mode for a convoy from convoy_metadata.
 * Defaults to 'review-then-land' if not set.
 */
export function getConvoyMergeMode(
  sql: SqlStorage,
  convoyId: string
): 'review-then-land' | 'review-and-merge' {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${convoy_metadata.merge_mode}
        FROM ${convoy_metadata}
        WHERE ${convoy_metadata.bead_id} = ?
      `,
      [convoyId]
    ),
  ];
  if (rows.length === 0) return 'review-then-land';
  const mode = z.object({ merge_mode: z.string().nullable() }).parse(rows[0]).merge_mode;
  if (mode === 'review-and-merge') return 'review-and-merge';
  return 'review-then-land';
}

/**
 * Get the feature_branch for a convoy from convoy_metadata.
 */
export function getConvoyFeatureBranch(sql: SqlStorage, convoyId: string): string | null {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${convoy_metadata.feature_branch}
        FROM ${convoy_metadata}
        WHERE ${convoy_metadata.bead_id} = ?
      `,
      [convoyId]
    ),
  ];
  if (rows.length === 0) return null;
  return z.object({ feature_branch: z.string().nullable() }).parse(rows[0]).feature_branch;
}

/**
 * Recount closed_beads for a convoy using the same logic as
 * updateConvoyProgress: a tracked bead counts as closed only when
 * it is closed/failed AND has no pending merge_request child beads.
 */
function recountConvoyClosedBeads(sql: SqlStorage, convoyId: string): void {
  const countRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT COUNT(1) AS count FROM ${bead_dependencies} AS tracked
        INNER JOIN ${beads} AS tracked_bead
          ON tracked.${bead_dependencies.columns.bead_id} = tracked_bead.${beads.columns.bead_id}
        WHERE tracked.${bead_dependencies.columns.depends_on_bead_id} = ?
          AND tracked.${bead_dependencies.columns.dependency_type} = 'tracks'
          AND tracked_bead.${beads.columns.status} IN ('closed', 'failed')
          AND NOT EXISTS (
            SELECT 1 FROM ${bead_dependencies} AS mr_dep
            INNER JOIN ${beads} AS mr_bead
              ON mr_dep.${bead_dependencies.columns.bead_id} = mr_bead.${beads.columns.bead_id}
            WHERE mr_dep.${bead_dependencies.columns.depends_on_bead_id} = tracked_bead.${beads.columns.bead_id}
              AND mr_dep.${bead_dependencies.columns.dependency_type} = 'tracks'
              AND mr_bead.${beads.columns.type} = 'merge_request'
              AND mr_bead.${beads.columns.status} IN ('open', 'in_progress')
          )
      `,
      [convoyId]
    ),
  ];
  const closedCount = z.object({ count: z.number() }).parse(countRows[0]).count;

  query(
    sql,
    /* sql */ `
      UPDATE ${convoy_metadata}
      SET ${convoy_metadata.columns.closed_beads} = ?
      WHERE ${convoy_metadata.bead_id} = ?
    `,
    [closedCount, convoyId]
  );
}

// ── Convoy Membership ───────────────────────────────────────────────

/**
 * Add a bead to an existing convoy. Creates the 'tracks' dependency,
 * merges convoy_id + feature_branch into the bead's metadata, and
 * increments the convoy's total_beads counter.
 *
 * No-ops if the bead already tracks this convoy.
 */
export function addBeadToConvoy(sql: SqlStorage, beadId: string, convoyId: string): void {
  // Verify both exist
  const bead = getBead(sql, beadId);
  if (!bead) throw new Error(`Bead ${beadId} not found`);

  const convoyBead = getBead(sql, convoyId);
  if (!convoyBead) throw new Error(`Convoy ${convoyId} not found`);
  if (convoyBead.type !== 'convoy') {
    throw new Error(`Bead ${convoyId} is not a convoy (type: ${convoyBead.type})`);
  }

  // Check if already tracked
  const existing = getConvoyForBead(sql, beadId);
  if (existing === convoyId) return; // already a member
  if (existing) {
    throw new Error(
      `Bead ${beadId} already belongs to convoy ${existing}. Remove it first before adding to a different convoy.`
    );
  }

  // Insert 'tracks' dependency
  query(
    sql,
    /* sql */ `
      INSERT INTO ${bead_dependencies} (
        ${bead_dependencies.columns.bead_id},
        ${bead_dependencies.columns.depends_on_bead_id},
        ${bead_dependencies.columns.dependency_type}
      ) VALUES (?, ?, 'tracks')
      ON CONFLICT DO NOTHING
    `,
    [beadId, convoyId]
  );

  // Merge convoy_id + feature_branch into bead metadata
  const featureBranch = getConvoyFeatureBranch(sql, convoyId);
  const timestamp = now();
  const metadataPatch: Record<string, unknown> = { convoy_id: convoyId };
  if (featureBranch) metadataPatch.feature_branch = featureBranch;

  const existingMetadata: Record<string, unknown> =
    typeof bead.metadata === 'string' ? JSON.parse(bead.metadata) : (bead.metadata ?? {});
  const merged = { ...existingMetadata, ...metadataPatch };

  query(
    sql,
    /* sql */ `
      UPDATE ${beads}
      SET ${beads.columns.metadata} = ?,
          ${beads.columns.updated_at} = ?
      WHERE ${beads.bead_id} = ?
    `,
    [JSON.stringify(merged), timestamp, beadId]
  );

  // Increment total_beads and recount closed_beads (the bead may already
  // be closed/failed, so a naive +1 on total_beads alone would leave
  // closed_beads stale).
  query(
    sql,
    /* sql */ `
      UPDATE ${convoy_metadata}
      SET ${convoy_metadata.columns.total_beads} = ${convoy_metadata.columns.total_beads} + 1
      WHERE ${convoy_metadata.bead_id} = ?
    `,
    [convoyId]
  );
  recountConvoyClosedBeads(sql, convoyId);

  // If the bead is still open, clear the ready_to_land flag on the convoy
  // in case it was already set — a new open bead means the convoy is not
  // complete and must not submit the final landing MR.
  if (bead.status !== 'closed' && bead.status !== 'failed') {
    query(
      sql,
      /* sql */ `
        UPDATE ${beads}
        SET ${beads.columns.metadata} = json_remove(COALESCE(${beads.metadata}, '{}'), '$.ready_to_land'),
            ${beads.columns.updated_at} = ?
        WHERE ${beads.bead_id} = ?
      `,
      [timestamp, convoyId]
    );
  }
}

/**
 * Remove a bead from its convoy. Deletes the 'tracks' dependency,
 * strips convoy_id + feature_branch from metadata, and decrements
 * the convoy's total_beads counter.
 *
 * No-ops if the bead is not in any convoy.
 */
export function removeBeadFromConvoy(sql: SqlStorage, beadId: string): string | null {
  const convoyId = getConvoyForBead(sql, beadId);
  if (!convoyId) return null;

  // Remove 'tracks' dependency
  query(
    sql,
    /* sql */ `
      DELETE FROM ${bead_dependencies}
      WHERE ${bead_dependencies.bead_id} = ?
        AND ${bead_dependencies.depends_on_bead_id} = ?
        AND ${bead_dependencies.dependency_type} = 'tracks'
    `,
    [beadId, convoyId]
  );

  // Strip convoy_id + feature_branch from metadata
  const bead = getBead(sql, beadId);
  if (bead) {
    const existingMetadata: Record<string, unknown> =
      typeof bead.metadata === 'string' ? JSON.parse(bead.metadata) : (bead.metadata ?? {});
    delete existingMetadata.convoy_id;
    delete existingMetadata.feature_branch;
    const timestamp = now();

    query(
      sql,
      /* sql */ `
        UPDATE ${beads}
        SET ${beads.columns.metadata} = ?,
            ${beads.columns.updated_at} = ?
        WHERE ${beads.bead_id} = ?
      `,
      [JSON.stringify(existingMetadata), timestamp, beadId]
    );
  }

  // Decrement total_beads and recount closed_beads. A naive decrement of
  // closed_beads is unreliable because updateConvoyProgress excludes beads
  // with pending MR children from the count — a bead that is closed but
  // mid-review was never counted, so decrementing would undercount.
  query(
    sql,
    /* sql */ `
      UPDATE ${convoy_metadata}
      SET ${convoy_metadata.columns.total_beads} = MAX(${convoy_metadata.columns.total_beads} - 1, 0)
      WHERE ${convoy_metadata.bead_id} = ?
    `,
    [convoyId]
  );
  recountConvoyClosedBeads(sql, convoyId);

  return convoyId;
}

// ── Bead Dependency Editing ─────────────────────────────────────────

/**
 * Add a dependency edge between two beads.
 *
 * - Validates self-reference (`beadId !== dependsOnBeadId`)
 * - Checks both beads exist
 * - Runs cycle detection for 'blocks' dependencies (DFS from `dependsOnBeadId`
 *   — if you can reach `beadId`, adding the edge would create a cycle)
 * - Uses `ON CONFLICT DO NOTHING` so duplicate adds are a no-op
 */
export function addBeadDependency(
  sql: SqlStorage,
  beadId: string,
  dependsOnBeadId: string,
  type: 'blocks' | 'tracks' | 'parent-child'
): void {
  if (beadId === dependsOnBeadId) {
    throw new Error('A bead cannot depend on itself');
  }

  // Verify both beads exist
  const existCheck = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${beads.bead_id}
        FROM ${beads}
        WHERE ${beads.bead_id} IN (?, ?)
      `,
      [beadId, dependsOnBeadId]
    ),
  ];
  const foundIds = new Set(
    z
      .object({ bead_id: z.string() })
      .array()
      .parse(existCheck)
      .map(r => r.bead_id)
  );
  if (!foundIds.has(beadId)) throw new Error(`Bead ${beadId} not found`);
  if (!foundIds.has(dependsOnBeadId)) throw new Error(`Bead ${dependsOnBeadId} not found`);

  // Cycle detection for 'blocks' dependencies: DFS from dependsOnBeadId
  // following existing 'blocks' edges. If we can reach beadId, adding
  // this edge would create a cycle.
  if (type === 'blocks') {
    const adjacency = new Map<string, string[]>();
    const edgeRows = [
      ...query(
        sql,
        /* sql */ `
          SELECT ${bead_dependencies.bead_id}, ${bead_dependencies.depends_on_bead_id}
          FROM ${bead_dependencies}
          WHERE ${bead_dependencies.dependency_type} = 'blocks'
        `,
        []
      ),
    ];
    const edges = BeadDependencyRecord.pick({ bead_id: true, depends_on_bead_id: true })
      .array()
      .parse(edgeRows);
    for (const edge of edges) {
      const neighbors = adjacency.get(edge.bead_id) ?? [];
      neighbors.push(edge.depends_on_bead_id);
      adjacency.set(edge.bead_id, neighbors);
    }

    // DFS from dependsOnBeadId following the direction: bead_id → depends_on_bead_id
    // We want to check: can dependsOnBeadId reach beadId through existing edges?
    // The graph direction is: beadId depends on dependsOnBeadId.
    // A cycle means: dependsOnBeadId already (transitively) depends on beadId.
    // So we follow edges from dependsOnBeadId: check dependsOnBeadId's own
    // depends_on edges to see if beadId is reachable.
    const visited = new Set<string>();
    const stack = [dependsOnBeadId];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      if (current === beadId) {
        throw new Error(
          `Adding dependency would create a cycle: ${beadId} → ${dependsOnBeadId} → ... → ${beadId}`
        );
      }
      if (visited.has(current)) continue;
      visited.add(current);
      const neighbors = adjacency.get(current);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) stack.push(neighbor);
        }
      }
    }
  }

  query(
    sql,
    /* sql */ `
      INSERT INTO ${bead_dependencies} (
        ${bead_dependencies.columns.bead_id},
        ${bead_dependencies.columns.depends_on_bead_id},
        ${bead_dependencies.columns.dependency_type}
      ) VALUES (?, ?, ?)
      ON CONFLICT DO NOTHING
    `,
    [beadId, dependsOnBeadId, type]
  );
}

/**
 * Remove a dependency edge between two beads.
 * Does NOT allow removing 'tracks' dependencies (system-managed convoy edges).
 * Returns true if a row was actually deleted, false otherwise.
 */
export function removeBeadDependency(
  sql: SqlStorage,
  beadId: string,
  dependsOnBeadId: string
): boolean {
  const result = [
    ...query(
      sql,
      /* sql */ `
        DELETE FROM ${bead_dependencies}
        WHERE ${bead_dependencies.bead_id} = ?
          AND ${bead_dependencies.depends_on_bead_id} = ?
          AND ${bead_dependencies.dependency_type} != 'tracks'
        RETURNING ${bead_dependencies.bead_id}
      `,
      [beadId, dependsOnBeadId]
    ),
  ];
  return result.length > 0;
}
