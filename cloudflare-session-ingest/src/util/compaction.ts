import type { SessionDataItem } from '../types/session-sync';

export function getItemIdentity(item: SessionDataItem): {
  item_id: string;
  item_type: SessionDataItem['type'];
} {
  switch (item.type) {
    case 'session':
      return { item_id: 'session', item_type: 'session' };
    case 'message':
      return { item_id: `message/${item.data.id}`, item_type: 'message' };
    case 'part':
      return {
        item_id: `${item.data.messageID}/${item.data.id}`,
        item_type: 'part',
      };
    case 'session_diff':
      return { item_id: 'session_diff', item_type: 'session_diff' };
    case 'model':
      return { item_id: 'model', item_type: 'model' };
    case 'kilo_meta':
      return { item_id: 'kilo_meta', item_type: 'kilo_meta' };
    case 'session_open':
      return { item_id: 'session_open', item_type: 'session_open' };
    case 'session_close':
      return { item_id: 'session_close', item_type: 'session_close' };
    default:
      throw new Error(`Unknown item type: ${item['type']}`);
  }
}
