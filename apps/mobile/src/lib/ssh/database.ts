import { z } from 'zod';

/** What SQLite takes as a bound value here: the ssh tables hold text, numbers, and nulls. */
export type SqlValue = string | number | null;

/** The part of an Expo database these stores use, so a test can supply one. */
export type SshDatabase = {
  readonly getAllSync: <T>(source: string, params: SqlValue[]) => T[];
  readonly runSync: (source: string, params: SqlValue[]) => void;
};

type ReadOptions<S extends z.ZodType> = {
  db: SshDatabase;
  source: string;
  schema: S;
  params?: SqlValue[];
};

export function readRows<S extends z.ZodType>({
  db,
  source,
  schema,
  params = [],
}: ReadOptions<S>): z.infer<S>[] {
  return db.getAllSync<unknown>(source, params).map(row => schema.parse(row));
}

export function readRow<S extends z.ZodType>(options: ReadOptions<S>): z.infer<S> | null {
  return readRows(options)[0] ?? null;
}

type UpdateOptions = {
  db: SshDatabase;
  table: 'ssh_keys' | 'ssh_hosts' | 'ssh_known_hosts' | 'ssh_snippets' | 'ssh_forwards';
  id: string;
  updates: Record<string, SqlValue | undefined>;
};

export function updateRow({ db, table, id, updates }: UpdateOptions): void {
  const entries = Object.entries(updates).filter(
    (entry): entry is [string, SqlValue] => entry[1] !== undefined
  );
  if (entries.length === 0) {
    return;
  }
  const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
  db.runSync(`update ${table} set ${assignments} where id = ?`, [
    ...entries.map(([, value]) => value),
    id,
  ]);
}

export const booleanColumn = z
  .number()
  .int()
  .transform(value => value !== 0);
export const portSchema = z.number().int().min(1).max(65535);

export function booleanValue(value: boolean | undefined): SqlValue | undefined {
  return value === undefined ? undefined : Number(value);
}
