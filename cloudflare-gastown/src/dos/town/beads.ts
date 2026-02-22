/**
 * Bead CRUD operations for the Town DO.
 * After the beads-centric refactor (#441), all object types are beads.
 */

import { beads, BeadRecord, createTableBeads, getIndexesBeads } from '../../db/tables/beads.table';
import {
  bead_events,
  BeadEventRecord,
  createTableBeadEvents,
  getIndexesBeadEvents,
} from '../../db/tables/bead-events.table';
import {
  bead_dependencies,
  createTableBeadDependencies,
  getIndexesBeadDependencies,
} from '../../db/tables/bead-dependencies.table';
import { agent_metadata, createTableAgentMetadata } from '../../db/tables/agent-metadata.table';
import { review_metadata, createTableReviewMetadata } from '../../db/tables/review-metadata.table';
import {
  escalation_metadata,
  createTableEscalationMetadata,
} from '../../db/tables/escalation-metadata.table';
import { convoy_metadata, createTableConvoyMetadata } from '../../db/tables/convoy-metadata.table';
import { query } from '../../util/query.util';
import type { CreateBeadInput, BeadFilter, Bead } from '../../types';
import type { BeadEventType } from '../../db/tables/bead-events.table';

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

export function initBeadTables(sql: SqlStorage): void {
  query(sql, createTableBeads(), []);
  for (const idx of getIndexesBeads()) {
    query(sql, idx, []);
  }
  query(sql, createTableBeadEvents(), []);
  for (const idx of getIndexesBeadEvents()) {
    query(sql, idx, []);
  }
  query(sql, createTableBeadDependencies(), []);
  for (const idx of getIndexesBeadDependencies()) {
    query(sql, idx, []);
  }
  // Satellite metadata tables
  query(sql, createTableAgentMetadata(), []);
  query(sql, createTableReviewMetadata(), []);
  query(sql, createTableEscalationMetadata(), []);
  query(sql, createTableConvoyMetadata(), []);
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
  agentId: string
): Bead {
  const bead = getBead(sql, beadId);
  if (!bead) throw new Error(`Bead ${beadId} not found`);

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
