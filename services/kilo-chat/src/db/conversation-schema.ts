import {
  sqliteTable,
  text,
  integer,
  check,
  foreignKey,
  index,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const members = sqliteTable(
  'members',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    joined_at: integer('joined_at').notNull(),
    left_at: integer('left_at'),
  },
  table => ({
    kindCheck: check('members_kind_check', sql`${table.kind} IN ('user', 'bot')`),
  })
);

export const conversation = sqliteTable(
  'conversation',
  {
    id: text('id').primaryKey(),
    title: text('title'),
    created_by: text('created_by').notNull(),
    created_at: integer('created_at').notNull(),
  },
  table => ({
    createdByFk: foreignKey({
      columns: [table.created_by],
      foreignColumns: [members.id],
    }),
  })
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sender_id: text('sender_id').notNull(),
    content: text('content').notNull(),
    in_reply_to_message_id: text('in_reply_to_message_id'),
    version: integer('version').notNull().default(1),
    updated_at: integer('updated_at'),
    client_updated_at: integer('client_updated_at'),
    deleted: integer('deleted').notNull().default(0),
    delivery_failed: integer('delivery_failed').notNull().default(0),
  },
  table => ({
    senderFk: foreignKey({
      columns: [table.sender_id],
      foreignColumns: [members.id],
    }),
    replyFk: foreignKey({
      columns: [table.in_reply_to_message_id],
      foreignColumns: [table.id],
    }),
    senderIdx: index('messages_sender_id_idx').on(table.sender_id),
    deletedCheck: check('messages_deleted_check', sql`${table.deleted} IN (0, 1)`),
    versionCheck: check('messages_version_check', sql`${table.version} >= 1`),
  })
);

export const botMessageNotifications = sqliteTable(
  'bot_message_notifications',
  {
    message_id: text('message_id').primaryKey(),
    bot_id: text('bot_id').notNull(),
    content: text('content').notNull(),
    created_at: integer('created_at').notNull(),
    notify_after: integer('notify_after').notNull(),
    notified_at: integer('notified_at'),
    notified_reason: text('notified_reason'),
  },
  table => ({
    messageFk: foreignKey({
      columns: [table.message_id],
      foreignColumns: [messages.id],
    }),
    botFk: foreignKey({
      columns: [table.bot_id],
      foreignColumns: [members.id],
    }),
    pendingByNotifyAfter: index('bot_message_notifications_pending_by_notify_after_idx')
      .on(table.notify_after)
      .where(sql`${table.notified_at} IS NULL`),
    pendingByBot: index('bot_message_notifications_pending_by_bot_idx')
      .on(table.bot_id, table.created_at)
      .where(sql`${table.notified_at} IS NULL`),
    notifiedReasonCheck: check(
      'bot_message_notifications_notified_reason_check',
      sql`${table.notified_reason} IS NULL
          OR ${table.notified_reason} IN ('length', 'typing_stop', 'timeout')`
    ),
  })
);

export const reactions = sqliteTable(
  'reactions',
  {
    message_id: text('message_id').notNull(),
    member_id: text('member_id').notNull(),
    emoji: text('emoji').notNull(),
    id: text('id').notNull(),
    added_at: integer('added_at').notNull(),
    deleted_at: integer('deleted_at'),
    removed_id: text('removed_id'),
  },
  table => ({
    pk: primaryKey({ columns: [table.message_id, table.member_id, table.emoji] }),
    messageFk: foreignKey({
      columns: [table.message_id],
      foreignColumns: [messages.id],
    }),
    memberFk: foreignKey({
      columns: [table.member_id],
      foreignColumns: [members.id],
    }),
    liveStateCheck: check(
      'reactions_live_state_check',
      sql`(${table.deleted_at} IS NULL AND ${table.removed_id} IS NULL)
          OR (${table.deleted_at} IS NOT NULL AND ${table.removed_id} IS NOT NULL)`
    ),
    byId: index('reactions_by_id').on(table.id),
    byRemovedId: index('reactions_by_removed_id').on(table.removed_id),
    byMessageLive: index('reactions_by_message_live')
      .on(table.message_id)
      .where(sql`${table.deleted_at} IS NULL`),
  })
);
