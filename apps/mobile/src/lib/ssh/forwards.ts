import { z } from 'zod';

import { SSH_FORWARD_DIRECTIONS } from '@/lib/persist/schema';

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
  id, host_id as hostId, direction, bind_host as bindHost, bind_port as bindPort,
  destination_host as destinationHost, destination_port as destinationPort,
  auto_start as autoStart, label
`;

const forwardRowSchema = z.object({
  id: z.string(),
  hostId: z.string(),
  direction: z.enum(SSH_FORWARD_DIRECTIONS),
  bindHost: z.string(),
  bindPort: z.number().int(),
  destinationHost: z.string(),
  destinationPort: z.number().int(),
  autoStart: booleanColumn,
  label: z.string().nullable(),
});

export type SshForward = z.infer<typeof forwardRowSchema>;

const forwardFields = {
  hostId: z.string().min(1),
  direction: z.enum(SSH_FORWARD_DIRECTIONS),
  bindHost: z.string().min(1),
  bindPort: portSchema,
  destinationHost: z.string().min(1),
  destinationPort: portSchema,
  autoStart: z.boolean(),
  label: z.string().nullable(),
};

const forwardInputSchema = z.object({
  ...forwardFields,
  bindHost: forwardFields.bindHost.default('127.0.0.1'),
  autoStart: forwardFields.autoStart.default(false),
  label: forwardFields.label.default(null),
});

export type SshForwardInput = z.input<typeof forwardInputSchema>;

const forwardPatchSchema = z.object(forwardFields).partial();

export type SshForwardPatch = z.input<typeof forwardPatchSchema>;

export function listForwards(db: SshDatabase): SshForward[] {
  return readRows({
    db,
    source: `select ${COLUMNS} from ssh_forwards order by host_id, bind_port`,
    schema: forwardRowSchema,
  });
}

export function getForward(db: SshDatabase, id: string): SshForward | null {
  return readRow({
    db,
    source: `select ${COLUMNS} from ssh_forwards where id = ?`,
    params: [id],
    schema: forwardRowSchema,
  });
}

export function createForward(db: SshDatabase, input: SshForwardInput): SshForward {
  const forward = forwardInputSchema.parse(input);
  const id = newId();
  db.runSync(
    `insert into ssh_forwards (id, host_id, direction, bind_host, bind_port,
       destination_host, destination_port, auto_start, label)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      forward.hostId,
      forward.direction,
      forward.bindHost,
      forward.bindPort,
      forward.destinationHost,
      forward.destinationPort,
      Number(forward.autoStart),
      forward.label,
    ]
  );
  const created = getForward(db, id);
  if (!created) {
    throw new Error(`ssh_forwards: row ${id} is missing after its own insert`);
  }
  return created;
}

export function updateForward(
  db: SshDatabase,
  id: string,
  patch: SshForwardPatch
): SshForward | null {
  const forward = forwardPatchSchema.parse(patch);
  updateRow({
    db,
    table: 'ssh_forwards',
    id,
    updates: {
      host_id: forward.hostId,
      direction: forward.direction,
      bind_host: forward.bindHost,
      bind_port: forward.bindPort,
      destination_host: forward.destinationHost,
      destination_port: forward.destinationPort,
      auto_start: booleanValue(forward.autoStart),
      label: forward.label,
    },
  });
  return getForward(db, id);
}

export function deleteForward(db: SshDatabase, id: string): void {
  db.runSync('delete from ssh_forwards where id = ?', [id]);
}
