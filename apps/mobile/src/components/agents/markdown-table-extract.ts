import { MarkedLexer as markedLexer, type Tokens } from 'react-native-marked';

/** One extracted GFM table, rendered behind the table chip. */
type MarkdownTableExtract = {
  type: 'table';
  raw: string;
  offset: number;
  key: string;
  columnCount: number;
  rowCount: number;
};

/** A run of non-table markdown between tables, rendered by the markdown path. */
type MarkdownTextExtract = {
  type: 'markdown';
  raw: string;
};

export type MarkdownSplitSegment = MarkdownTextExtract | MarkdownTableExtract;

type MarkdownSnapshot = {
  value: string;
  segments: readonly MarkdownSplitSegment[];
};

export function splitMarkdownTables(
  value: string,
  previous?: MarkdownSnapshot
): MarkdownSplitSegment[] {
  const tokens = markedLexer(value, { gfm: true });
  const segments: MarkdownSplitSegment[] = [];
  const previousTables = previous?.segments.filter(segment => segment.type === 'table') ?? [];
  let markdown = '';
  let offset = 0;
  let tableIndex = 0;
  for (const table of previousTables) {
    tableIndex = Math.max(tableIndex, Number(table.key.replace('md-table-', '')) + 1);
  }

  for (const token of tokens) {
    if (token.type === 'table') {
      if (markdown.length > 0) {
        segments.push({ type: 'markdown', raw: markdown });
        markdown = '';
      }
      const table = token as Tokens.Table;
      let columnCount = table.header.length;
      for (const row of table.rows) {
        if (row.length > columnCount) {
          columnCount = row.length;
        }
      }
      segments.push({
        type: 'table',
        raw: table.raw,
        offset,
        key: `md-table-${tableIndex}`,
        columnCount,
        rowCount: table.rows.length,
      });
      tableIndex += 1;
    } else {
      markdown += token.raw;
    }
    offset += token.raw.length;
  }

  if (markdown.length > 0) {
    segments.push({ type: 'markdown', raw: markdown });
  }

  const tables = segments.filter(segment => segment.type === 'table');
  if (previous && (value.startsWith(previous.value) || previous.value.startsWith(value))) {
    for (const [index, table] of tables.entries()) {
      const prior = previousTables[index];
      if (prior?.offset === table.offset) {
        const raw = table.raw.trimEnd();
        const before = prior.raw.trimEnd();
        if (before.startsWith(raw) || raw.startsWith(before)) {
          table.key = prior.key;
        }
      }
    }
    return segments;
  }

  const unmatched = new Set(tables);
  const available = new Set(previousTables);
  for (const exact of [true, false]) {
    for (const table of unmatched) {
      const raw = table.raw.trimEnd();
      const match = previousTables.find(candidate => {
        if (!available.has(candidate)) {
          return false;
        }
        const before = candidate.raw.trimEnd();
        return exact ? before === raw : before.startsWith(raw) || raw.startsWith(before);
      });
      if (match) {
        table.key = match.key;
        available.delete(match);
        unmatched.delete(table);
      }
    }
  }

  return segments;
}
