import { sqliteTable, text, integer, index, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const requests = sqliteTable(
  'requests',
  {
    id: text('id').primaryKey(),
    timestamp: text('timestamp').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    query_string: text('query_string'),
    headers: text('headers').notNull(),
    body: text('body').notNull(),
    content_type: text('content_type'),
    source_ip: text('source_ip'),
    created_at: integer('created_at')
      .notNull()
      .default(sql`(unixepoch())`),
    started_at: text('started_at'),
    completed_at: text('completed_at'),
    process_status: text('process_status', {
      enum: ['captured', 'inprogress', 'success', 'failed'],
    })
      .notNull()
      .default('captured'),
    cloud_agent_session_id: text('cloud_agent_session_id'),
    error_message: text('error_message'),
  },
  table => [
    index('idx_requests_timestamp').on(sql`${table.timestamp} desc`),
    index('idx_requests_status').on(table.process_status),
    index('idx_requests_session').on(table.cloud_agent_session_id),
    check(
      'process_status_check',
      sql`process_status in ('captured', 'inprogress', 'success', 'failed')`
    ),
  ]
);

export const triggerConfig = sqliteTable('trigger_config', {
  trigger_id: text('trigger_id').primaryKey(),
  namespace: text('namespace').notNull(),
  user_id: text('user_id'),
  org_id: text('org_id'),
  created_at: text('created_at').notNull(),
  is_active: integer('is_active').notNull().default(1),
  github_repo: text('github_repo').notNull(),
  mode: text('mode').notNull(),
  model: text('model').notNull(),
  prompt_template: text('prompt_template').notNull(),
  profile_id: text('profile_id').notNull(),
  auto_commit: integer('auto_commit'),
  condense_on_complete: integer('condense_on_complete'),
  webhook_auth_header: text('webhook_auth_header'),
  webhook_auth_secret_hash: text('webhook_auth_secret_hash'),
});
