import { query } from '../../util/query.util';
import {
  createTableWastelandWantedBoard,
  wasteland_wanted_board,
  WastelandWantedBoardRecord,
} from '../../db/tables/wasteland-wanted-board.table';

export type WantedItemResult = {
  item_id: string;
  title: string;
  description: string;
  status: 'open' | 'claimed' | 'done';
  priority: 'low' | 'medium' | 'high' | 'critical';
  type: 'feature' | 'bug' | 'docs' | 'other';
  claimed_by: string | null;
  evidence: string | null;
  created_at: string;
  updated_at: string;
};

export function initializeDatabase(sql: SqlStorage): void {
  query(sql, createTableWastelandWantedBoard(), []);
}

export function getWantedBoard(sql: SqlStorage, wastelandId: string): WantedItemResult[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_wanted_board}
        WHERE ${wasteland_wanted_board.wasteland_id} = ?
        ORDER BY ${wasteland_wanted_board.columns.created_at} DESC
      `,
      [wastelandId]
    ),
  ];
  return WastelandWantedBoardRecord.array().parse(rows);
}

export function refreshWantedBoard(sql: SqlStorage, wastelandId: string): WantedItemResult[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_wanted_board}
        WHERE ${wasteland_wanted_board.wasteland_id} = ?
        ORDER BY ${wasteland_wanted_board.columns.created_at} DESC
      `,
      [wastelandId]
    ),
  ];
  return WastelandWantedBoardRecord.array().parse(rows);
}
