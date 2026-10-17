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

/** Maximum subject length for a mail message. */
export const MAIL_SUBJECT_MAX_LENGTH = 200;
/** Maximum body length for a mail message. */
export const MAIL_BODY_MAX_LENGTH = 4000;
/** Maximum number of open message beads a single recipient can hold. */
export const MAX_OPEN_MESSAGES_PER_RECIPIENT = 50;
/** Delivery batch size for readAndDeliverMail and getPendingMailForWorkingAgents. */
export const MAIL_DELIVERY_BATCH = 50;
/** Open message beads older than this are closed by the alarm sweep. Matches event pruning. */
export const MAIL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type MailValidationError =
  | 'UNKNOWN_RECIPIENT'
  | 'MAIL_TOO_LARGE'
  | 'MAILBOX_FULL';

/**
 * Thrown by sendMail when the message violates a mail rule.
 * Carries a stable code for programmatic handling at the RPC boundary.
 */
export class MailRuleError extends Error {
  constructor(
    readonly code: MailValidationError,
    message: string
  ) {
    super(message);
    this.name = 'MailRuleError';
  }
}

export function sendMail(sql: SqlStorage, input: SendMailInput): void {
  const recipient = getAgent(sql, input.to_agent_id);
  if (!recipient) {
    throw new MailRuleError(
      'UNKNOWN_RECIPIENT',
      `Recipient agent ${input.to_agent_id} does not exist in this town`
    );
  }

  if (input.subject.length > MAIL_SUBJECT_MAX_LENGTH || input.body.length > MAIL_BODY_MAX_LENGTH) {
    throw new MailRuleError(
      'MAIL_TOO_LARGE',
      `Mail exceeds size limits (subject <= ${MAIL_SUBJECT_MAX_LENGTH}, body <= ${MAIL_BODY_MAX_LENGTH})`
    );
  }

  const openRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT count(*) AS cnt FROM ${beads}
        WHERE ${beads.type} = 'message'
          AND ${beads.assignee_agent_bead_id} = ?
          AND ${beads.status} = 'open'
      `,
      [input.to_agent_id]
    ),
  ];
  const openCount = typeof openRows[0]?.cnt === 'number' ? openRows[0].cnt : 0;
  if (openCount >= MAX_OPEN_MESSAGES_PER_RECIPIENT) {
    throw new MailRuleError(
      'MAILBOX_FULL',
      `Recipient ${input.to_agent_id} already holds ${openCount} open message(s)`
    );
  }

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
        LIMIT ?
      `,
      [agentId, MAIL_DELIVERY_BATCH]
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
        LIMIT ?
      `,
      [MAIL_DELIVERY_BATCH]
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

/**
 * Close open message beads that can never be delivered:
 * - the recipient agent no longer exists, or
 * - the message is older than the retention window (recipient never read it).
 * Returns the number of beads closed. Runs on the Town DO alarm.
 */
export function sweepStaleMail(sql: SqlStorage, retentionMs: number = MAIL_RETENTION_MS): number {
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  const timestamp = now();

  const closed = [
    ...query(
      sql,
      /* sql */ `
        UPDATE ${beads}
        SET ${beads.columns.status} = 'closed',
            ${beads.columns.closed_at} = ?,
            ${beads.columns.updated_at} = ?
        WHERE ${beads.type} = 'message'
          AND ${beads.status} = 'open'
          AND (
            NOT EXISTS (
              SELECT 1 FROM ${agent_metadata}
              WHERE ${agent_metadata.bead_id} = ${beads.assignee_agent_bead_id}
            )
            OR ${beads.created_at} < ?
          )
      `,
      [timestamp, timestamp, cutoff]
    ),
  ];

  return closed.length;
}
