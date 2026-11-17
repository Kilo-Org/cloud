import type { MessageInfo } from '../types';

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

type OrderRow = {
  id: string;
  /** Rank key: the row's server time, or its array position when times cannot be read. */
  key: number;
  /** A client row without a server time; its turn sorts after every placed turn. */
  unplaced: boolean;
  /** Array position of the row that opens this row's turn. */
  turn: number;
};

/**
 * The transcript's row order, one turn after another.
 *
 * A turn is a user row and the assistant rows that answer it (`parentID`,
 * followed through assistant parents). Turns are ordered by the time of the
 * row that opens them, and the other rows of a turn follow it in their own time
 * order. So a turn stays together: a prompt queued while an earlier turn still
 * runs sorts after every step of that turn, and a reply never sorts above the
 * prompt it answers. An assistant row whose prompt is not in the store (an
 * older page, another session) opens a turn of its own.
 *
 * The store keeps `messageIds` sorted by id because that order is the only one
 * it can maintain incrementally. A session written by another client, an
 * import, or an older id scheme holds ids in any order, and the worker's
 * history read orders every page by `time.created`
 * (`compareKiloSdkMessageInfo`), so the id order never stands in for the
 * transcript's order.
 *
 * A row is placed by server time: `time.created` of a stored row, and
 * `queuedAt` (the server queue time) of a client-materialised `synthetic` row.
 * A synthetic row without `queuedAt` carries only the device clock, which
 * cannot be ranked against server times. It is the newest submission, so its
 * turn sorts after every placed turn.
 *
 * Returns `ids` itself while the array already follows that order, so an
 * unchanged transcript keeps its reference. While a placed row has no readable
 * time, turns keep the array's order: the wire boundary rejects such a row,
 * and a guess would reorder a transcript on data the store cannot place.
 */
function orderMessageIds(
  ids: readonly string[],
  messages: ReadonlyMap<string, MessageInfo>
): readonly string[] {
  const positions = new Map<string, number>();
  for (let index = 0; index < ids.length; index += 1) positions.set(ids[index] ?? '', index);

  const times: Array<{ time: number; unplaced: boolean } | undefined> = [];
  let timesReadable = true;
  for (const id of ids) {
    const placement = readPlacement(messages.get(id));
    if (placement === undefined) timesReadable = false;
    times.push(placement);
  }

  const rows: OrderRow[] = ids.map((id, index) => {
    const placement = times[index];
    return {
      id,
      key: timesReadable && placement ? placement.time : index,
      unplaced: timesReadable && placement?.unplaced === true,
      turn: turnStart(index, ids, positions, messages),
    };
  });

  const compare = (left: OrderRow, right: OrderRow): number => {
    const leftTurn = rows[left.turn];
    const rightTurn = rows[right.turn];
    if (leftTurn === undefined || rightTurn === undefined) return 0;
    if (leftTurn !== rightTurn) return compareOrderRows(leftTurn, rightTurn);
    if (left === right) return 0;
    if (left === leftTurn) return -1;
    if (right === rightTurn) return 1;
    return compareOrderRows(left, right);
  };
  if (rows.every((row, index) => index === 0 || compare(rows[index - 1] ?? row, row) <= 0)) {
    return ids;
  }
  const ordered = [...rows].sort(compare);
  return ordered.every((row, index) => row.id === ids[index]) ? ids : ordered.map(row => row.id);
}

function readPlacement(
  info: MessageInfo | undefined
): { time: number; unplaced: boolean } | undefined {
  const created: unknown = info?.time?.created;
  const readableCreated = typeof created === 'number' && Number.isFinite(created) ? created : 0;
  if (info?.role === 'user' && info.synthetic === true) {
    const queuedAt: unknown = info.queuedAt;
    return typeof queuedAt === 'number' && Number.isFinite(queuedAt)
      ? { time: queuedAt, unplaced: false }
      : { time: readableCreated, unplaced: true };
  }
  if (typeof created !== 'number' || !Number.isFinite(created)) return undefined;
  return { time: created, unplaced: false };
}

/**
 * The array position of the row that opens the turn of the row at `index`. A
 * missing parent, a self reference, a parent in another session, or a parent
 * cycle ends the chain at the row itself, so no row is ever hidden.
 */
function turnStart(
  index: number,
  ids: readonly string[],
  positions: ReadonlyMap<string, number>,
  messages: ReadonlyMap<string, MessageInfo>
): number {
  let current = index;
  for (let steps = 0; steps <= ids.length; steps += 1) {
    const info = messages.get(ids[current] ?? '');
    if (info?.role !== 'assistant') return current;
    const parent = positions.get(info.parentID);
    if (parent === undefined || parent === current) return current;
    if (messages.get(ids[parent] ?? '')?.sessionID !== info.sessionID) return current;
    current = parent;
  }
  return index;
}

function compareOrderRows(left: OrderRow, right: OrderRow): number {
  if (left.unplaced !== right.unplaced) return left.unplaced ? 1 : -1;
  if (left.key !== right.key) return left.key < right.key ? -1 : 1;
  return compareIds(left.id, right.id);
}

export { orderMessageIds };
