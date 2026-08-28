import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { Run, ToolCall } from '@kilocode/agent-harness/contracts';

// One database belongs to an existing PostgreSQL thread. This row never creates thread authority.
export const conversation = sqliteTable(
  'conversation',
  {
    singleton: integer('singleton').primaryKey().default(1),
    id: text('id').notNull().unique(),
    ownerUserId: text('owner_user_id').notNull(),
    context: text('context', { mode: 'json' }).$type<unknown>().notNull(),
    permissionMode: text('permission_mode', { enum: ['ask', 'yolo'] })
      .notNull()
      .default('ask'),
    permissionRevision: integer('permission_revision').notNull().default(0),
    sequence: integer('sequence').notNull().default(0),
    compactedThrough: integer('compacted_through').notNull().default(0),
    activeRunId: text('active_run_id'),
    legacyCursor: integer('legacy_cursor').notNull().default(0),
  },
  table => [check('one_conversation', sql`${table.singleton} = 1`)]
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sequence: integer('sequence').notNull().unique(),
    createdAt: text('created_at').notNull(),
    // Full normalized parts remain recoverable after their display events are compacted.
    data: text('data', { mode: 'json' }).$type<unknown>().notNull(),
  },
  table => [index('message_history').on(table.createdAt, table.id)]
);

export const commands = sqliteTable('commands', {
  id: text('id').primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  reply: text('reply', { mode: 'json' }).$type<unknown>().notNull(),
  sequence: integer('sequence').notNull(),
});

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    position: integer('position').notNull().unique(),
    status: text('status').$type<Run['state']['status']>().notNull(),
    data: text('data', { mode: 'json' }).$type<unknown>().notNull(),
    revision: integer('revision').notNull().default(0),
    step: integer('step').notNull().default(0),
    activeSlot: integer('active_slot').unique(),
  },
  table => [
    index('run_queue').on(table.status, table.position),
    check(
      'active_run_slot',
      sql`(${table.status} IN ('running', 'waiting', 'stopping') AND ${table.activeSlot} IS 1) OR (${table.status} NOT IN ('running', 'waiting', 'stopping') AND ${table.activeSlot} IS NULL)`
    ),
  ]
);

export const checkpoints = sqliteTable(
  'checkpoints',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    step: integer('step').notNull(),
    status: text('status', { enum: ['partial', 'complete', 'failed'] }).notNull(),
    data: text('data', { mode: 'json' }).$type<unknown>().notNull(),
    definitionVersions: text('definition_versions', { mode: 'json' }).$type<unknown>().notNull(),
  },
  table => [uniqueIndex('checkpoint_step').on(table.runId, table.step)]
);

export const calls = sqliteTable(
  'calls',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    checkpointId: text('checkpoint_id')
      .notNull()
      .references(() => checkpoints.id),
    position: integer('position').notNull(),
    inputDigest: text('input_digest').notNull(),
    data: text('data', { mode: 'json' }).$type<unknown>().notNull(),
    policy: text('policy', { mode: 'json' }).$type<unknown>().notNull(),
    state: text('state').$type<ToolCall['state']>().notNull(),
    revision: integer('revision').notNull().default(0),
  },
  table => [uniqueIndex('call_order').on(table.runId, table.position)]
);

export const interactions = sqliteTable(
  'interactions',
  {
    id: text('id').primaryKey(),
    sequence: integer('sequence').notNull(),
    resolved: integer('resolved', { mode: 'boolean' }).notNull(),
    data: text('data', { mode: 'json' }).$type<unknown>().notNull(),
  },
  table => [index('unresolved_interactions').on(table.resolved, table.sequence)]
);

export const grants = sqliteTable(
  'grants',
  {
    id: text('id').primaryKey(),
    toolCallId: text('tool_call_id')
      .notNull()
      .references(() => calls.id),
    generation: integer('generation').notNull(),
    data: text('data', { mode: 'json' }).$type<unknown>().notNull(),
  },
  table => [uniqueIndex('grant_generation').on(table.toolCallId, table.generation)]
);

export const attempts = sqliteTable(
  'attempts',
  {
    id: text('id').primaryKey(),
    toolCallId: text('tool_call_id')
      .notNull()
      .references(() => calls.id),
    generation: integer('generation').notNull(),
    // Intent includes the immutable call, digest, policy, and grant before an external effect.
    intent: text('intent', { mode: 'json' }).$type<unknown>().notNull(),
    outcome: text('outcome', { mode: 'json' }).$type<unknown>(),
    providerReference: text('provider_reference'),
  },
  table => [uniqueIndex('attempt_generation').on(table.toolCallId, table.generation)]
);

export const clientActions = sqliteTable('client_actions', {
  toolCallId: text('tool_call_id').primaryKey(),
  sequence: integer('sequence').notNull(),
  data: text('data', { mode: 'json' }).$type<unknown>().notNull(),
});

export const events = sqliteTable('events', {
  sequence: integer('sequence').primaryKey(),
  data: text('data', { mode: 'json' }).$type<unknown>().notNull(),
});

export const snapshots = sqliteTable(
  'snapshots',
  {
    singleton: integer('singleton').primaryKey().default(1),
    cursor: integer('cursor').notNull(),
    data: text('data', { mode: 'json' }).$type<unknown>().notNull(),
  },
  table => [check('one_snapshot', sql`${table.singleton} = 1`)]
);

export const projectionWork = sqliteTable(
  'projection_work',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull(),
    data: text('data', { mode: 'json' }).$type<unknown>().notNull(),
    revision: integer('revision').notNull().default(0),
    dueAt: integer('due_at').notNull(),
    acknowledgedAt: text('acknowledged_at'),
  },
  table => [index('due_projections').on(table.acknowledgedAt, table.dueAt, table.id)]
);
