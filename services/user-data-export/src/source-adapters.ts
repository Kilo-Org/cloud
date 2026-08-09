import type { ExportCursor } from './contracts';

export type ExportRecord = { source: string; field: string; value: string | null };
export type SourcePage = { records: ExportRecord[]; nextCursor: ExportCursor | null };

export type ReplicaQuery = (text: string, values: unknown[]) => Promise<Record<string, unknown>[]>;

export type SourceAdapter = {
  name: string;
  disabledReason?: string;
  readPage?: (input: {
    kiloUserId: string;
    snapshotAt: string;
    cursor: ExportCursor | null;
    limit: number;
  }) => Promise<SourcePage>;
};

const projectQuery = `SELECT id, title, created_at
FROM app_builder_projects
WHERE owned_by_user_id = $1
  AND created_at <= $2
  AND ($3::timestamptz IS NULL OR created_at > $3::timestamptz OR (created_at = $3::timestamptz AND id > $4))
ORDER BY created_at, id
LIMIT $5`;

const promptQuery = `SELECT mu.id, mu.created_at, meta.user_prompt_prefix, spp.system_prompt_prefix
FROM microdollar_usage AS mu
JOIN microdollar_usage_metadata AS meta ON meta.id = mu.id
LEFT JOIN system_prompt_prefix AS spp ON spp.system_prompt_prefix_id = meta.system_prompt_prefix_id
WHERE mu.kilo_user_id = $1
  AND mu.created_at <= $2
  AND ($3::timestamptz IS NULL OR mu.created_at > $3::timestamptz OR (mu.created_at = $3::timestamptz AND mu.id > $4))
ORDER BY mu.created_at, mu.id
LIMIT $5`;

function cursorFor(row: Record<string, unknown>): ExportCursor {
  return { createdAt: new Date(String(row.created_at)).toISOString(), id: String(row.id) };
}

type ProjectRow = { id: string; title: string | null; created_at: string };
type PromptRow = {
  id: string;
  created_at: string;
  user_prompt_prefix: string | null;
  system_prompt_prefix: string | null;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Replica row has invalid ${field}`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

export function createSourceAdapters(query: ReplicaQuery): SourceAdapter[] {
  return [
    {
      name: 'app_builder_projects',
      async readPage(input): Promise<SourcePage> {
        const rows: ProjectRow[] = await query(projectQuery, [
          input.kiloUserId,
          input.snapshotAt,
          input.cursor?.createdAt ?? null,
          input.cursor?.id ?? null,
          input.limit,
        ]).then(result =>
          result.map(row => ({
            id: requiredString(row.id, 'id'),
            title: nullableString(row.title, 'title'),
            created_at: requiredString(row.created_at, 'created_at'),
          }))
        );
        const lastRow = rows.at(-1);
        return {
          records: rows.map(row => ({
            source: 'app_builder_projects',
            field: 'title',
            value: row.title == null ? null : String(row.title),
          })),
          nextCursor: rows.length === input.limit && lastRow ? cursorFor(lastRow) : null,
        };
      },
    },
    {
      name: 'microdollar_usage_prompts',
      async readPage(input): Promise<SourcePage> {
        const rows: PromptRow[] = await query(promptQuery, [
          input.kiloUserId,
          input.snapshotAt,
          input.cursor?.createdAt ?? null,
          input.cursor?.id ?? null,
          input.limit,
        ]).then(result =>
          result.map(row => ({
            id: requiredString(row.id, 'id'),
            created_at: requiredString(row.created_at, 'created_at'),
            user_prompt_prefix: nullableString(row.user_prompt_prefix, 'user_prompt_prefix'),
            system_prompt_prefix: nullableString(row.system_prompt_prefix, 'system_prompt_prefix'),
          }))
        );
        const records = rows.flatMap(row => [
          {
            source: 'microdollar_usage_metadata',
            field: 'user_prompt_prefix',
            value: row.user_prompt_prefix == null ? null : String(row.user_prompt_prefix),
          },
          {
            source: 'system_prompt_prefix',
            field: 'system_prompt_prefix',
            value: row.system_prompt_prefix == null ? null : String(row.system_prompt_prefix),
          },
        ]);
        const lastRow = rows.at(-1);
        return {
          records,
          nextCursor: rows.length === input.limit && lastRow ? cursorFor(lastRow) : null,
        };
      },
    },
    { name: 'app_builder_messages', disabledReason: 'source_table_dropped' },
    { name: 'numbered_cli_journal', disabledReason: 'source_not_found' },
  ];
}

export const sourceQueries = { projectQuery, promptQuery };
