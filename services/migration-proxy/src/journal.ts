import { z } from 'zod';

/**
 * drizzle's `meta/_journal.json` at the run's commit (contract §5 step 4). drizzle applies the
 * entries in journal order, each whose `when` is newer than the database's newest `created_at`.
 * `when` need not rise across the whole journal (it falls at 0034 → 0035 on main); only the
 * pending entries must rise, which the container checks once it knows the database (§6 step 5).
 */

export const MIGRATION_TAG = /^\d{4}_[a-z0-9_-]+$/;

const JournalSchema = z.object({
  dialect: z.literal('postgresql'),
  entries: z.array(
    z.object({
      idx: z.number().int().nonnegative(),
      when: z.number().int().positive(),
      tag: z.string(),
    })
  ),
});

export type JournalEntry = { idx: number; when: number; tag: string };

export type JournalResult = { ok: true; entries: JournalEntry[] } | { ok: false; problem: string };

/**
 * Parses the journal: dialect `postgresql`, `idx` equal to the position, tags matching
 * `^\d{4}_[a-z0-9_-]+$`, unique tags and unique `when` values, and a `<tag>.sql` for every tag.
 */
export function parseJournal(text: string, sqlFiles: ReadonlySet<string>): JournalResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'not JSON' };
  }
  const parsed = JournalSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problem: 'not a postgresql journal' };
  const tags = new Set<string>();
  const whens = new Set<number>();
  for (const [position, entry] of parsed.data.entries.entries()) {
    if (entry.idx !== position) return { ok: false, problem: `idx ${entry.idx} at ${position}` };
    if (!MIGRATION_TAG.test(entry.tag)) return { ok: false, problem: `tag ${entry.tag}` };
    if (tags.has(entry.tag)) return { ok: false, problem: `duplicate tag ${entry.tag}` };
    if (whens.has(entry.when)) return { ok: false, problem: `duplicate when at ${entry.tag}` };
    if (!sqlFiles.has(`${entry.tag}.sql`))
      return { ok: false, problem: `no file for ${entry.tag}` };
    tags.add(entry.tag);
    whens.add(entry.when);
  }
  return {
    ok: true,
    entries: parsed.data.entries.map(({ idx, when, tag }) => ({ idx, when, tag })),
  };
}
