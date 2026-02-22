/**
 * Inter-agent mail system for the Town DO.
 *
 * After the beads-centric refactor (#441), mail messages are beads with
 * type='message'. The recipient is assignee_agent_bead_id, the sender
 * is stored in labels and metadata.
 */

import { beads, BeadRecord } from '../../db/tables/beads.table';
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

export function checkMail(sql: SqlStorage, agentId: string): Mail[] {
  // Read undelivered message beads assigned to this agent
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

  // Mark as delivered by closing the message beads
  if (mailBeads.length > 0) {
    const timestamp = now();
    for (const mb of mailBeads) {
      query(
        sql,
        /* sql */ `
          UPDATE ${beads}
          SET ${beads.columns.status} = 'closed',
              ${beads.columns.closed_at} = ?,
              ${beads.columns.updated_at} = ?
          WHERE ${beads.bead_id} = ?
        `,
        [timestamp, timestamp, mb.bead_id]
      );
    }
  }

  return messages;
}
