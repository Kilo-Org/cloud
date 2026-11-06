import { sha256Hex } from '@kilocode/worker-utils';

import type { CloneBatchRow } from '../dos/SessionIngestDO';

/**
 * The one-line identity of a clone source row: item id, item type, and the
 * stored body reference (the R2 key for an offloaded body, the inline body
 * otherwise). Both the source window digest and the clone stage digest are
 * built from these lines, so a body change always changes the digest.
 */
export function cloneSourceDigestLine(row: CloneBatchRow): string {
  return `${row.itemId}:${row.itemType}:${row.itemDataR2Key ?? row.itemData}`;
}

/** Bytes one source row adds to a clone window. */
export function cloneSourceRowBytes(row: CloneBatchRow): number {
  const bodyBytes = row.itemDataR2Key === null ? utf8ByteLength(row.itemData) : 0;
  return utf8ByteLength(row.itemId) + utf8ByteLength(row.itemType) + bodyBytes;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Chain one clone window digest onto the digest of the windows before it.
 * `previous` is empty for the first window. The chain keeps a fixed amount of
 * memory and a fixed amount of state, so a resumed clone continues from the
 * digest the stage recorded and a verification pass can continue across
 * requests.
 */
export async function chainCloneWindowDigest(
  previous: string,
  windowDigest: string
): Promise<string> {
  return previous === '' ? windowDigest : sha256Hex(`${previous}\n${windowDigest}`);
}
