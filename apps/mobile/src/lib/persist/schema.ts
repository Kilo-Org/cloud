import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * The encrypted key-value table (DEC-01). Drizzle owns this schema: the
 * `drizzle/` migrations are generated from it, and
 * `src/lib/persist/encrypted-kv.ts` runs them on every open.
 */
export const kv = sqliteTable(
  'kv',
  {
    scope: text('scope').notNull(),
    k: text('k').notNull(),
    v: text('v').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  table => [primaryKey({ columns: [table.scope, table.k] })]
);

/**
 * One row per chat, which is what the chat list is drawn from.
 *
 * The conversation itself is not here: the harness SDK keeps the turns in its
 * own tables on this same database, and it knows nothing about who is signed in
 * or which organization they are in. So the app keeps what the SDK has no
 * business holding — the scope a chat belongs to, when it last moved, which
 * is the order a list of conversations is read in, and the name a person gave it.
 */
export const chats = sqliteTable(
  'chats',
  {
    /** The harness session this chat is, at the moment. A model switch moves it. */
    sessionId: text('session_id').primaryKey(),
    /** The account and organization it belongs to. See `chatScope`. */
    scope: text('scope').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** The name the person gave the chat. Null means the first thing they said names it. */
    title: text('title'),
    /**
     * When the chat was started. A model switch keeps it, because it moves this
     * row rather than adding one. Null for a chat started before it was kept,
     * which is also a chat whose usage was not counted from its first answer.
     */
    createdAt: integer('created_at'),
    /** What the chat has used, per model, as JSON. See `src/lib/chat/chat-usage.ts`. */
    usage: text('usage'),
  },
  table => [index('chats_scope_updated_at').on(table.scope, table.updatedAt)]
);

export const SSH_KEY_ALGORITHMS = ['ed25519', 'rsa', 'ecdsa'] as const;
export const SSH_KEY_SOURCES = ['generated', 'imported'] as const;
export const SSH_AUTH_METHODS = ['password', 'key', 'keyboard_interactive'] as const;
export const SSH_FORWARD_DIRECTIONS = ['local', 'remote'] as const;

/**
 * The keys the user can authenticate with. The private key is here, in the
 * SQLCipher database, because an RSA key is larger than the keychain accepts.
 */
export const sshKeys = sqliteTable('ssh_keys', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  algorithm: text('algorithm', { enum: SSH_KEY_ALGORITHMS }).notNull(),
  source: text('source', { enum: SSH_KEY_SOURCES }).notNull(),
  privateKeyOpenssh: text('private_key_openssh').notNull(),
  publicKeyOpenssh: text('public_key_openssh').notNull(),
  fingerprintSha256: text('fingerprint_sha256').notNull(),
  /** Present only when the user chose to keep it beside the key. */
  passphrase: text('passphrase'),
  createdAt: integer('created_at').notNull(),
});

export const sshHosts = sqliteTable(
  'ssh_hosts',
  {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    hostname: text('hostname').notNull(),
    port: integer('port').notNull().default(22),
    username: text('username').notNull(),
    authMethod: text('auth_method', { enum: SSH_AUTH_METHODS }).notNull(),
    password: text('password'),
    keyId: text('key_id').references(() => sshKeys.id, { onDelete: 'set null' }),
    jumpHostId: text('jump_host_id').references((): AnySQLiteColumn => sshHosts.id, {
      onDelete: 'set null',
    }),
    tmuxAttach: integer('tmux_attach', { mode: 'boolean' }).notNull().default(false),
    tmuxSessionName: text('tmux_session_name'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastConnectedAt: integer('last_connected_at'),
  },
  table => [index('ssh_hosts_sort_order').on(table.sortOrder, table.label)]
);

/**
 * One trusted host key. `host_pattern` is the OpenSSH form: `hostname` on the
 * default port, `[hostname]:port` otherwise.
 */
export const sshKnownHosts = sqliteTable(
  'ssh_known_hosts',
  {
    id: text('id').primaryKey(),
    hostPattern: text('host_pattern').notNull(),
    keyAlgorithm: text('key_algorithm').notNull(),
    publicKeyBase64: text('public_key_base64').notNull(),
    fingerprintSha256: text('fingerprint_sha256').notNull(),
    addedAt: integer('added_at').notNull(),
  },
  table => [uniqueIndex('ssh_known_hosts_host_key').on(table.hostPattern, table.keyAlgorithm)]
);

export const sshSnippets = sqliteTable(
  'ssh_snippets',
  {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    command: text('command').notNull(),
    appendNewline: integer('append_newline', { mode: 'boolean' }).notNull().default(true),
    hostId: text('host_id').references(() => sshHosts.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  table => [index('ssh_snippets_sort_order').on(table.hostId, table.sortOrder)]
);

export const sshForwards = sqliteTable(
  'ssh_forwards',
  {
    id: text('id').primaryKey(),
    hostId: text('host_id')
      .notNull()
      .references(() => sshHosts.id, { onDelete: 'cascade' }),
    direction: text('direction', { enum: SSH_FORWARD_DIRECTIONS }).notNull(),
    bindHost: text('bind_host').notNull().default('127.0.0.1'),
    bindPort: integer('bind_port').notNull(),
    destinationHost: text('destination_host').notNull(),
    destinationPort: integer('destination_port').notNull(),
    autoStart: integer('auto_start', { mode: 'boolean' }).notNull().default(false),
    label: text('label'),
  },
  table => [index('ssh_forwards_host').on(table.hostId)]
);
