import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Legacy: an earlier revision kept the manager login key here. `SignerDO` moves a row it finds to
 * KV storage once and deletes it; nothing writes this table, so no SQL statement binds a key.
 */
export const signingKey = sqliteTable('signing_key', {
  id: integer('id').primaryKey(),
  kid: text('kid').notNull(),
  privateJwk: text('private_jwk').notNull(),
  publicJwk: text('public_jwk').notNull(),
  createdAt: integer('created_at').notNull(),
});
