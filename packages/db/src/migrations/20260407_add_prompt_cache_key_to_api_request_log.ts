import { Migration } from 'drizzle-orm/pg-knex';

export const migration: Migration = {
  name: 'add_prompt_cache_key_to_api_request_log',
  upQuery: `
    ALTER TABLE api_request_log ADD COLUMN prompt_cache_key TEXT NULL;
  `,
  downQuery: `
    ALTER TABLE api_request_log DROP COLUMN prompt_cache_key;
  `,
  // skipSeed: true,
};