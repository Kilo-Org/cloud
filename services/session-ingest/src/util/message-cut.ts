/**
 * Inclusive message cut shared by session clone and session export.
 *
 * With a cut, a transcript keeps the session row, every message whose ID is
 * <= `upToMessageId` (message IDs are ascending, compared as strings), and the
 * parts of those messages. The session diff is always dropped: it describes the
 * whole session, so files are rebuilt from the kept messages' summary diffs.
 *
 * The test reads only the ingest item identity (`message/{messageId}` for
 * messages, `{messageId}/{partId}` for parts), never the item body, so it works
 * the same for inline and R2-backed rows.
 */
export function isItemWithinMessageCut(
  item: { itemType: string; itemId: string },
  upToMessageId: string
): boolean {
  switch (item.itemType) {
    case 'session':
      return true;
    case 'message':
      return item.itemId.slice('message/'.length) <= upToMessageId;
    case 'part':
      return item.itemId.split('/', 1)[0] <= upToMessageId;
    default:
      return false;
  }
}
