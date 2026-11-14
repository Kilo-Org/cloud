import { z } from 'zod';

import { SSH_FORWARD_DIRECTIONS } from '@/lib/persist/schema';

import {
  booleanColumn,
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

/**
 * A second forward on a bind address the host already forwards. The stored row
 * is `ssh_forwards_bind`'s unique key, so the refusal is the same whether it
 * comes from the check below or from the index under a race.
 */
export class SshForwardConflictError extends Error {
  override readonly name = 'SshForwardConflictError';
}

/**
 * Refuses a forward that would take a bind address another one holds. `id` is
 * the row being edited, so saving a forward unchanged is not a conflict with
 * itself.
 */
function assertBindAddressFree(
  db: SshDatabase,
  forward: z.infer<typeof forwardInputSchema>,
  id: string | null
): void {
  const taken = readRow({
    db,
    source: `select ${COLUMNS} from ssh_forwards
      where host_id = ? and direction = ? and bind_host = ? and bind_port = ? and id <> ?`,
    params: [forward.hostId, forward.direction, forward.bindHost, forward.bindPort, id ?? ''],
    schema: forwardRowSchema,
  });
  if (taken !== null) {
    throw new SshForwardConflictError(
      `ssh_forwards: ${forward.bindHost}:${forward.bindPort} is already forwarded`
    );
  }
}

/**
 * Runs a write that the unique index can also refuse, so a forward stored by
 * another write between the check and this one still reports the conflict
 * rather than a raw constraint failure.
 */
function asForwardWrite<T>(write: () => T): T {
  try {
    return write();
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      throw new SshForwardConflictError(error.message);
    }
    throw error;
  }
}

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

/** The forwards stored for one host, in the order the editor lists them. */
/**
 * What a row calls this forward: its own name, or the mapping it stands for
 * when it has none.
 */
export function forwardLabel(
  forward: Pick<
    SshForward,
    'label' | 'bindHost' | 'bindPort' | 'destinationHost' | 'destinationPort'
  >
): string {
  return (
    forward.label ??
    `${forward.bindHost}:${forward.bindPort} → ${forward.destinationHost}:${forward.destinationPort}`
  );
}

export function listForwardsForHost(db: SshDatabase, hostId: string): SshForward[] {
  return readRows({
    db,
    source: `select ${COLUMNS} from ssh_forwards where host_id = ? order by direction, bind_port`,
    params: [hostId],
    schema: forwardRowSchema,
  });
}

export function createForward(db: SshDatabase, input: SshForwardInput): SshForward {
  const forward = forwardInputSchema.parse(input);
  assertBindAddressFree(db, forward, null);
  const id = newId();
  asForwardWrite(() => {
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
  });
  const created = getForward(db, id);
  if (!created) {
    throw new Error(`ssh_forwards: row ${id} is missing after its own insert`);
  }
  return created;
}

export function updateForward(db: SshDatabase, id: string, input: SshForwardInput): SshForward {
  const forward = forwardInputSchema.parse(input);
  assertBindAddressFree(db, forward, id);
  asForwardWrite(() => {
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
        auto_start: Number(forward.autoStart),
        label: forward.label,
      },
    });
  });
  const updated = getForward(db, id);
  if (!updated) {
    throw new Error(`ssh_forwards: row ${id} is missing after its own update`);
  }
  return updated;
}

export function deleteForward(db: SshDatabase, id: string): void {
  db.runSync('delete from ssh_forwards where id = ?', [id]);
}
