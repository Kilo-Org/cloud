import { MarkedLexer as markedLexer, type Tokens } from 'react-native-marked';

// Splits a markdown value into table and non-table segments before the
// renderer runs. `react-native-marked`'s Parser always builds every cell's
// ReactNode tree before it calls `table()`, so a chat transcript that streams
// a large table pays the cell parse on every keystroke even while the table
// stays behind a chip. Lexing here instead gives each table its raw source,
// shape, and a stable ordinal key up front; the cells are parsed only when the
// table modal opens (see MarkdownTableBody).

/** One extracted GFM table, rendered behind the table chip. */
export type MarkdownTableExtract = {
  type: 'table';
  raw: string;
  /** Stable ordinal key `md-table-${n}` matching the renderer's old host key. */
  key: string;
  columnCount: number;
  rowCount: number;
};

/** A run of non-table markdown between tables, rendered by the markdown path. */
export type MarkdownTextExtract = {
  type: 'markdown';
  raw: string;
};

export type MarkdownSplitSegment = MarkdownTextExtract | MarkdownTableExtract;

export function splitMarkdownTables(value: string): MarkdownSplitSegment[] {
  const tokens = markedLexer(value, { gfm: true });
  const segments: MarkdownSplitSegment[] = [];
  let markdown = '';
  let tableIndex = 0;

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
        key: `md-table-${tableIndex}`,
        columnCount,
        rowCount: table.rows.length,
      });
      tableIndex += 1;
    } else {
      markdown += token.raw;
    }
  }

  if (markdown.length > 0) {
    segments.push({ type: 'markdown', raw: markdown });
  }

  return segments;
}
