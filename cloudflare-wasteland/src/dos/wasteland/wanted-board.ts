import { query } from '../../util/query.util';
import {
  wasteland_wanted_items,
  WastelandWantedItemRecord,
  createTableWastelandWantedItems,
} from '../../db/tables/wasteland-wanted-items.table';

export function initWantedItemsTable(sql: SqlStorage): void {
  query(sql, createTableWastelandWantedItems(), []);
}

export function getWantedBoard(sql: SqlStorage): WastelandWantedItemRecord[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_wanted_items}
        ORDER BY ${wasteland_wanted_items.updated_at} DESC
      `,
      []
    ),
  ];
  return WastelandWantedItemRecord.array().parse(rows);
}

/**
 * Refresh the wanted board cache. In a full implementation this would
 * fetch from the DoltHub upstream and upsert rows. For now it returns
 * the current cached state — the container-side mutations (claim, post,
 * done) update DoltHub directly, and the alarm loop will eventually
 * sync the cache.
 */
export function refreshWantedBoard(sql: SqlStorage): WastelandWantedItemRecord[] {
  return getWantedBoard(sql);
}
