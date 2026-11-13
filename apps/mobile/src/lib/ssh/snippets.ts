import { z } from 'zod';

import {
  booleanColumn,
  booleanValue,
  readRow,
  readRows,
  type SshDatabase,
  updateRow,
} from './database';
import { newId } from './id';

const COLUMNS = `
  id, label, command, append_newline as appendNewline, host_id as hostId,
  sort_order as sortOrder, created_at as createdAt, updated_at as updatedAt
`;

const snippetRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  appendNewline: booleanColumn,
  hostId: z.string().nullable(),
  sortOrder: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type SshSnippet = z.infer<typeof snippetRowSchema>;

const snippetFields = {
  label: z.string().min(1),
  command: z.string().min(1),
  hostId: z.string().nullable(),
  sortOrder: z.number().int(),
};

const snippetInputSchema = z.object({
  ...snippetFields,
  appendNewline: z.boolean().default(true),
  hostId: snippetFields.hostId.default(null),
  sortOrder: snippetFields.sortOrder.default(0),
});

export type SshSnippetInput = z.input<typeof snippetInputSchema>;

const snippetPatchSchema = z
  .object({
    ...snippetFields,
    appendNewline: z.boolean(),
  })
  .partial();

export type SshSnippetPatch = z.input<typeof snippetPatchSchema>;

export function listSnippets(db: SshDatabase): SshSnippet[] {
  return readRows({
    db,
    source: `select ${COLUMNS} from ssh_snippets order by sort_order, label`,
    schema: snippetRowSchema,
  });
}

export function getSnippet(db: SshDatabase, id: string): SshSnippet | null {
  return readRow({
    db,
    source: `select ${COLUMNS} from ssh_snippets where id = ?`,
    params: [id],
    schema: snippetRowSchema,
  });
}

export function createSnippet(
  db: SshDatabase,
  input: SshSnippetInput,
  at: number = Date.now()
): SshSnippet {
  const snippet = snippetInputSchema.parse(input);
  const id = newId();
  db.runSync(
    `insert into ssh_snippets (id, label, command, append_newline, host_id, sort_order,
       created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      snippet.label,
      snippet.command,
      Number(snippet.appendNewline),
      snippet.hostId,
      snippet.sortOrder,
      at,
      at,
    ]
  );
  const created = getSnippet(db, id);
  if (!created) {
    throw new Error(`ssh_snippets: row ${id} is missing after its own insert`);
  }
  return created;
}

export function updateSnippet(
  db: SshDatabase,
  id: string,
  patch: SshSnippetPatch
): SshSnippet | null {
  const snippet = snippetPatchSchema.parse(patch);
  updateRow({
    db,
    table: 'ssh_snippets',
    id,
    updates: {
      label: snippet.label,
      command: snippet.command,
      append_newline: booleanValue(snippet.appendNewline),
      host_id: snippet.hostId,
      sort_order: snippet.sortOrder,
      updated_at: Date.now(),
    },
  });
  return getSnippet(db, id);
}

export function deleteSnippet(db: SshDatabase, id: string): void {
  db.runSync('delete from ssh_snippets where id = ?', [id]);
}
