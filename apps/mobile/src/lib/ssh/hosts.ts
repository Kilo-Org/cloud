import { z } from 'zod';

import { SSH_AUTH_METHODS } from '@/lib/persist/schema';

import {
  booleanColumn,
  booleanValue,
  portSchema,
  readRow,
  readRows,
  type SshDatabase,
  updateRow,
} from './database';
import { newId } from './id';

const COLUMNS = `
  id, label, hostname, port, username, auth_method as authMethod, password,
  key_id as keyId, jump_host_id as jumpHostId, tmux_attach as tmuxAttach,
  tmux_session_name as tmuxSessionName, sort_order as sortOrder,
  created_at as createdAt, updated_at as updatedAt,
  last_connected_at as lastConnectedAt
`;

const hostRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  hostname: z.string(),
  port: z.number().int(),
  username: z.string(),
  authMethod: z.enum(SSH_AUTH_METHODS),
  password: z.string().nullable(),
  keyId: z.string().nullable(),
  jumpHostId: z.string().nullable(),
  tmuxAttach: booleanColumn,
  tmuxSessionName: z.string().nullable(),
  sortOrder: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastConnectedAt: z.number().nullable(),
});

export type SshHost = z.infer<typeof hostRowSchema>;

const hostFields = {
  label: z.string().min(1),
  hostname: z.string().min(1),
  username: z.string().min(1),
  authMethod: z.enum(SSH_AUTH_METHODS),
  password: z.string().nullable(),
  keyId: z.string().nullable(),
  jumpHostId: z.string().nullable(),
  tmuxAttach: z.boolean(),
  tmuxSessionName: z.string().nullable(),
  sortOrder: z.number().int(),
  lastConnectedAt: z.number().nullable(),
};

const hostInputSchema = z.object({
  ...hostFields,
  port: portSchema.default(22),
  password: hostFields.password.default(null),
  keyId: hostFields.keyId.default(null),
  jumpHostId: hostFields.jumpHostId.default(null),
  tmuxAttach: hostFields.tmuxAttach.default(false),
  tmuxSessionName: hostFields.tmuxSessionName.default(null),
  sortOrder: hostFields.sortOrder.default(0),
  lastConnectedAt: hostFields.lastConnectedAt.default(null),
});

export type SshHostInput = z.input<typeof hostInputSchema>;

const hostPatchSchema = z
  .object({
    ...hostFields,
    port: portSchema,
  })
  .partial();

export type SshHostPatch = z.input<typeof hostPatchSchema>;

export function listHosts(db: SshDatabase): SshHost[] {
  return readRows({
    db,
    source: `select ${COLUMNS} from ssh_hosts order by sort_order, label`,
    schema: hostRowSchema,
  });
}

export function getHost(db: SshDatabase, id: string): SshHost | null {
  return readRow({
    db,
    source: `select ${COLUMNS} from ssh_hosts where id = ?`,
    params: [id],
    schema: hostRowSchema,
  });
}

export function createHost(db: SshDatabase, input: SshHostInput, at: number = Date.now()): SshHost {
  const host = hostInputSchema.parse(input);
  const id = newId();
  db.runSync(
    `insert into ssh_hosts (id, label, hostname, port, username, auth_method, password,
       key_id, jump_host_id, tmux_attach, tmux_session_name, sort_order,
       created_at, updated_at, last_connected_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      host.label,
      host.hostname,
      host.port,
      host.username,
      host.authMethod,
      host.password,
      host.keyId,
      host.jumpHostId,
      Number(host.tmuxAttach),
      host.tmuxSessionName,
      host.sortOrder,
      at,
      at,
      host.lastConnectedAt,
    ]
  );
  const created = getHost(db, id);
  if (!created) {
    throw new Error(`ssh_hosts: row ${id} is missing after its own insert`);
  }
  return created;
}

export function updateHost(db: SshDatabase, id: string, patch: SshHostPatch): SshHost | null {
  const host = hostPatchSchema.parse(patch);
  updateRow({
    db,
    table: 'ssh_hosts',
    id,
    updates: {
      label: host.label,
      hostname: host.hostname,
      port: host.port,
      username: host.username,
      auth_method: host.authMethod,
      password: host.password,
      key_id: host.keyId,
      jump_host_id: host.jumpHostId,
      tmux_attach: booleanValue(host.tmuxAttach),
      tmux_session_name: host.tmuxSessionName,
      sort_order: host.sortOrder,
      last_connected_at: host.lastConnectedAt,
      updated_at: Date.now(),
    },
  });
  return getHost(db, id);
}

export function deleteHost(db: SshDatabase, id: string): void {
  db.runSync('delete from ssh_hosts where id = ?', [id]);
}
