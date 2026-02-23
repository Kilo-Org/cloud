/**
 * Inter-agent mail system for the Town DO.
 *
 * After the beads-centric refactor (#441), mail messages are beads with
 * type='message'. The recipient is assignee_agent_bead_id, the sender
 * is stored in labels and metadata.
 */

import { beads, BeadRecord } from '../../db/tables/beads.table';
import { agent_metadata } from '../../db/tables/agent-metadata.table';
import { query } from '../../util/query.util';
import { logBeadEvent } from './beads';
import { getAgent } from './agents';
import type { SendMailInput, Mail } from '../../types';

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

export function initMailTables(_sql: SqlStorage): void {
  // Mail tables are now part of the beads table (type='message').
  // Initialization happens in beads.initBeadTables().
}

export function sendMail(sql: SqlStorage, input: SendMailInput): void {
  const id = generateId();
  const timestamp = now();

  const labels = JSON.stringify(['gt:message', `from:${input.from_agent_id}`]);
  const metadata = JSON.stringify({
    from_agent_id: input.from_agent_id,
    to_agent_id: input.to_agent_id,
  });

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
      'message',
      'open',
      input.subject,
      input.body,
      null,
      null,
      input.to_agent_id,
      'medium',
      labels,
      metadata,
      input.from_agent_id,
      timestamp,
      timestamp,
      null,
    ]
  );

  // Log bead event if the recipient has a hooked bead
  const recipient = getAgent(sql, input.to_agent_id);
  if (recipient?.current_hook_bead_id) {
    logBeadEvent(sql, {
      beadId: recipient.current_hook_bead_id,
      agentId: input.from_agent_id,
      eventType: 'mail_sent',
      metadata: { subject: input.subject, to: input.to_agent_id },
    });
  }
}

/**
 * Read and deliver undelivered mail for an agent.
 * Returns the mail items and batch-closes the message beads in a single UPDATE.
 */
export function readAndDeliverMail(sql: SqlStorage, agentId: string): Mail[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${beads}
        WHERE ${beads.type} = 'message'
          AND ${beads.assignee_agent_bead_id} = ?
          AND ${beads.status} = 'open'
        ORDER BY ${beads.created_at} ASC
      `,
      [agentId]
    ),
  ];

  const mailBeads = BeadRecord.array().parse(rows);
  if (mailBeads.length === 0) return [];

  const messages: Mail[] = mailBeads.map(mb => ({
    id: mb.bead_id,
    from_agent_id: String(mb.metadata?.from_agent_id ?? mb.created_by ?? ''),
    to_agent_id: agentId,
    subject: mb.title,
    body: mb.body ?? '',
    delivered: false,
    created_at: mb.created_at,
    delivered_at: null,
  }));

  // Batch-close all open message beads for this agent in a single UPDATE
  const timestamp = now();
  query(
    sql,
    /* sql */ `
      UPDATE ${beads}
      SET ${beads.columns.status} = 'closed',
          ${beads.columns.closed_at} = ?,
          ${beads.columns.updated_at} = ?
      WHERE ${beads.type} = 'message'
        AND ${beads.assignee_agent_bead_id} = ?
        AND ${beads.status} = 'open'
    `,
    [timestamp, timestamp, agentId]
  );

  return messages;
}

export function checkMail(sql: SqlStorage, agentId: string): Mail[] {
  return readAndDeliverMail(sql, agentId);
}

/**
 * Find open mail addressed to agents that are currently working.
 * Returns a map of agentId → Mail[] so the caller can push each batch
 * to the corresponding container process.
 *
 * Calling this does NOT mark mail as delivered — the caller should call
 * `readAndDeliverMail` after successfully pushing the messages.
 */
export function getPendingMailForWorkingAgents(sql: SqlStorage): Map<string, Mail[]> {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${beads}.*
        FROM ${beads}
        INNER JOIN ${agent_metadata}
          ON ${beads.assignee_agent_bead_id} = ${agent_metadata.bead_id}
        WHERE ${beads.type} = 'message'
          AND ${beads.status} = 'open'
          AND ${agent_metadata.status} = 'working'
        ORDER BY ${beads.created_at} ASC
      `,
      []
    ),
  ];

  const mailBeads = BeadRecord.array().parse(rows);
  const grouped = new Map<string, Mail[]>();

  for (const mb of mailBeads) {
    const recipientId = mb.assignee_agent_bead_id ?? '';
    if (!recipientId) continue;

    const m: Mail = {
      id: mb.bead_id,
      from_agent_id: String(mb.metadata?.from_agent_id ?? mb.created_by ?? ''),
      to_agent_id: recipientId,
      subject: mb.title,
      body: mb.body ?? '',
      delivered: false,
      created_at: mb.created_at,
      delivered_at: null,
    };

    const existing = grouped.get(recipientId);
    if (existing) {
      existing.push(m);
    } else {
      grouped.set(recipientId, [m]);
    }
  }

  return grouped;
}
