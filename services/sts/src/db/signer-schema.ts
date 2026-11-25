import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * One row, id 1: the ECDSA P-256 key STS signs its manager login JWTs with. The private JWK
 * stays in this Durable Object's storage; only the public half is served.
 */
export const signingKey = sqliteTable('signing_key', {
  id: integer('id').primaryKey(),
  kid: text('kid').notNull(),
  privateJwk: text('private_jwk').notNull(),
  publicJwk: text('public_jwk').notNull(),
  createdAt: integer('created_at').notNull(),
});
