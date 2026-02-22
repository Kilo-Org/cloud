/**
 * Inter-agent mail system for the Town DO.
 */

import {
  rig_mail,
  RigMailRecord,
  createTableRigMail,
  getIndexesRigMail,
} from '../../db/tables/rig-mail.table';
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

export function initMailTables(sql: SqlStorage): void {
  query(sql, createTableRigMail(), []);
  for (const idx of getIndexesRigMail()) {
    query(sql, idx, []);
  }
}

export function sendMail(sql: SqlStorage, input: SendMailInput): void {
  const id = generateId();
  const timestamp = now();

  query(
    sql,
    /* sql */ `
      INSERT INTO ${rig_mail} (
        ${rig_mail.columns.id},
        ${rig_mail.columns.from_agent_id},
        ${rig_mail.columns.to_agent_id},
        ${rig_mail.columns.subject},
        ${rig_mail.columns.body},
        ${rig_mail.columns.delivered},
        ${rig_mail.columns.created_at},
        ${rig_mail.columns.delivered_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [id, input.from_agent_id, input.to_agent_id, input.subject, input.body, 0, timestamp, null]
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
  // Read undelivered messages first
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${rig_mail}
        WHERE ${rig_mail.columns.to_agent_id} = ?
          AND ${rig_mail.columns.delivered} = 0
        ORDER BY ${rig_mail.columns.created_at} ASC
      `,
      [agentId]
    ),
  ];

  const messages = RigMailRecord.array().parse(rows);

  // Then mark them as delivered
  if (messages.length > 0) {
    query(
      sql,
      /* sql */ `
        UPDATE ${rig_mail}
        SET ${rig_mail.columns.delivered} = 1,
            ${rig_mail.columns.delivered_at} = ?
        WHERE ${rig_mail.columns.to_agent_id} = ?
          AND ${rig_mail.columns.delivered} = 0
      `,
      [now(), agentId]
    );
  }

  return messages;
}
