/**
 * Bead CRUD operations for the Town DO.
 * Beads are scoped to a rig via rig_id column (added in the town-centric refactor).
 */

import { z } from 'zod';
import {
  rig_beads,
  RigBeadRecord,
  createTableRigBeads,
  getIndexesRigBeads,
} from '../../db/tables/rig-beads.table';
import {
  rig_bead_events,
  RigBeadEventRecord,
  createTableRigBeadEvents,
  getIndexesRigBeadEvents,
} from '../../db/tables/rig-bead-events.table';
import { rig_agents } from '../../db/tables/rig-agents.table';
import { query } from '../../util/query.util';
import type { CreateBeadInput, BeadFilter, Bead } from '../../types';
import type { BeadEventType } from '../../db/tables/rig-bead-events.table';

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

export function initBeadTables(sql: SqlStorage): void {
  query(sql, createTableRigBeads(), []);
  for (const idx of getIndexesRigBeads()) {
    query(sql, idx, []);
  }
  query(sql, createTableRigBeadEvents(), []);
  for (const idx of getIndexesRigBeadEvents()) {
    query(sql, idx, []);
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
      INSERT INTO ${rig_beads} (
        ${rig_beads.columns.id},
        ${rig_beads.columns.type},
        ${rig_beads.columns.status},
        ${rig_beads.columns.title},
        ${rig_beads.columns.body},
        ${rig_beads.columns.assignee_agent_id},
        ${rig_beads.columns.convoy_id},
        ${rig_beads.columns.molecule_id},
        ${rig_beads.columns.priority},
        ${rig_beads.columns.labels},
        ${rig_beads.columns.metadata},
        ${rig_beads.columns.created_at},
        ${rig_beads.columns.updated_at},
        ${rig_beads.columns.closed_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      input.type,
      'open',
      input.title,
      input.body ?? null,
      input.assignee_agent_id ?? null,
      input.convoy_id ?? null,
      null,
      input.priority ?? 'medium',
      labels,
      metadata,
      timestamp,
      timestamp,
      null,
    ]
  );

  const bead = getBead(sql, id);
  if (!bead) throw new Error('Failed to create bead');

  logBeadEvent(sql, {
    beadId: id,
    agentId: input.assignee_agent_id ?? null,
    eventType: 'created',
    newValue: 'open',
    metadata: { type: input.type, title: input.title },
  });

  return bead;
}

export function getBead(sql: SqlStorage, beadId: string): Bead | null {
  const rows = [
    ...query(sql, /* sql */ `SELECT * FROM ${rig_beads} WHERE ${rig_beads.columns.id} = ?`, [
      beadId,
    ]),
  ];
  if (rows.length === 0) return null;
  return RigBeadRecord.parse(rows[0]);
}

export function listBeads(sql: SqlStorage, filter: BeadFilter): Bead[] {
  const limit = filter.limit ?? 100;
  const offset = filter.offset ?? 0;

  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${rig_beads}
        WHERE (? IS NULL OR ${rig_beads.columns.status} = ?)
          AND (? IS NULL OR ${rig_beads.columns.type} = ?)
          AND (? IS NULL OR ${rig_beads.columns.assignee_agent_id} = ?)
          AND (? IS NULL OR ${rig_beads.columns.convoy_id} = ?)
        ORDER BY ${rig_beads.columns.created_at} DESC
        LIMIT ? OFFSET ?
      `,
      [
        filter.status ?? null,
        filter.status ?? null,
        filter.type ?? null,
        filter.type ?? null,
        filter.assignee_agent_id ?? null,
        filter.assignee_agent_id ?? null,
        filter.convoy_id ?? null,
        filter.convoy_id ?? null,
        limit,
        offset,
      ]
    ),
  ];

  return RigBeadRecord.array().parse(rows);
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
      UPDATE ${rig_beads}
      SET ${rig_beads.columns.status} = ?,
          ${rig_beads.columns.updated_at} = ?,
          ${rig_beads.columns.closed_at} = ?
      WHERE ${rig_beads.columns.id} = ?
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
  // Unhook any agent assigned to this bead
  query(
    sql,
    /* sql */ `
      UPDATE ${rig_agents}
      SET ${rig_agents.columns.current_hook_bead_id} = NULL,
          ${rig_agents.columns.status} = 'idle'
      WHERE ${rig_agents.columns.current_hook_bead_id} = ?
    `,
    [beadId]
  );

  query(sql, /* sql */ `DELETE FROM ${rig_beads} WHERE ${rig_beads.columns.id} = ?`, [beadId]);
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
      INSERT INTO ${rig_bead_events} (
        ${rig_bead_events.columns.id},
        ${rig_bead_events.columns.bead_id},
        ${rig_bead_events.columns.agent_id},
        ${rig_bead_events.columns.event_type},
        ${rig_bead_events.columns.old_value},
        ${rig_bead_events.columns.new_value},
        ${rig_bead_events.columns.metadata},
        ${rig_bead_events.columns.created_at}
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
): RigBeadEventRecord[] {
  const limit = options.limit ?? 100;
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${rig_bead_events}
        WHERE (? IS NULL OR ${rig_bead_events.columns.bead_id} = ?)
          AND (? IS NULL OR ${rig_bead_events.columns.created_at} > ?)
        ORDER BY ${rig_bead_events.columns.created_at} DESC
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
  return RigBeadEventRecord.array().parse(rows);
}
